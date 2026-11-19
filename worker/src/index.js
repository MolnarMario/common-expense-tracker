// The API in front of the rooms.
//
// Nobody can make a room by asking nicely. Creating one takes either the
// admin token, which only you have, or an invite code, which you minted
// and handed to someone. Anyone can ask for a code, though: the request
// waits until you approve it, and then the requester's browser picks the
// code up. Everything else here is routing.

import { Room } from './room.js';
import { Registry, normalizeCode } from './registry.js';

export { Room, Registry };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';

    try {
      const response = await route(request, env, path, ctx);
      // A 101 hands back an immutable response, and a socket that came
      // through the upgrade needs no CORS header anyway.
      if (response.status === 101 || response.webSocket) return response;
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    } catch (error) {
      // Never hand an internal message back to a stranger.
      console.error('unhandled', error && error.stack);
      return json({ error: 'server_error' }, 500, cors);
    }
  },
};

async function route(request, env, path, ctx) {
  if (path === '/health') return json({ ok: true });

  // POST /api/rooms  — the only way a room comes into being.
  if (path === '/rooms' && request.method === 'POST') return createRoom(request, env);

  // GET /api/rooms  — what exists, for whoever runs this.
  if (path === '/rooms' && request.method === 'GET') {
    if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403);
    return registryCall(env, '/rooms');
  }

  if (path === '/invites') {
    if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403);
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return registryCall(env, '/mint', body);
    }
    return registryCall(env, '/codes');
  }

  // POST /api/requests  — someone without a code asks for one.
  if (path === '/requests' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const answer = await registryJson(env, '/request', {
      name: body.name,
      message: body.message,
      ip: request.headers.get('CF-Connecting-IP') || '',
    });
    if (!answer.ok) {
      const status = answer.error === 'rate' ? 429 : answer.error === 'busy' ? 503 : 400;
      return json({ error: answer.error }, status);
    }
    // Optional heads-up to whoever runs this. It says only that one
    // arrived: what they wrote stays here, behind the admin token.
    if (env.NOTIFY_URL && ctx) {
      ctx.waitUntil(
        fetch(env.NOTIFY_URL, {
          method: 'POST',
          body: 'New access request for the expense tracker',
        }).catch(() => {})
      );
    }
    return json({ ok: true, id: answer.id, secret: answer.secret });
  }

  // POST /api/requests/status  — the requester's browser asking how it went.
  if (path === '/requests/status' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const answer = await registryJson(env, '/request-status', { id: body.id, secret: body.secret });
    if (!answer.ok) return json({ error: answer.error }, 404);
    return json(answer);
  }

  // GET /api/requests  — what is waiting, for whoever runs this.
  if (path === '/requests' && request.method === 'GET') {
    if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403);
    return registryCall(env, '/requests');
  }

  // POST /api/requests/:id/approve and /decline
  const decision = /^\/requests\/([a-z2-7]{16})\/(approve|decline)$/.exec(path);
  if (decision && request.method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403);
    const answer = await registryJson(env, '/decide', {
      id: decision[1],
      approve: decision[2] === 'approve',
    });
    return json(answer, answer.ok ? 200 : answer.error === 'not_found' ? 404 : 409);
  }

  const room = /^\/rooms\/([a-z2-7]{32})\/(socket|usage|lock)$/.exec(path);
  if (room) {
    const [, roomId, action] = room;
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    return stub.fetch(new Request('https://room/' + action, request));
  }

  return json({ error: 'not_found' }, 404);
}

/**
 * Two doors into the same place. The admin token makes a room outright,
 * which is the "I set this up for a friend" path. An invite code makes one
 * and burns itself, which is the same gate without you in the loop.
 */
async function createRoom(request, env) {
  const body = await request.json().catch(() => ({}));
  const note = typeof body.note === 'string' ? body.note.slice(0, 120) : '';

  // The browser locks the room before it asks for one. Arriving without a
  // lock would mean a room with no password, which this does not make.
  if (!body.lock || typeof body.lock.wrapped !== 'string') {
    return json({ error: 'bad_lock' }, 400);
  }

  let minted;
  if (isAdmin(request, env)) {
    minted = await registryJson(env, '/adopt', { note });
  } else {
    if (!normalizeCode(body.code)) return json({ error: 'bad_code' }, 400);
    minted = await registryJson(env, '/claim', {
      code: body.code,
      ip: request.headers.get('CF-Connecting-IP') || '',
    });
  }

  if (!minted.ok) {
    const status = minted.error === 'rate' ? 429 : 400;
    return json({ error: minted.error }, status);
  }

  // The room object writes its own header here. Until that lands, a
  // connection to this id is refused, which is what stops someone from
  // conjuring rooms by guessing at the socket route.
  const stub = env.ROOM.get(env.ROOM.idFromName(minted.roomId));
  const created = await stub.fetch(
    new Request('https://room/init', {
      method: 'POST',
      body: JSON.stringify({ note, lock: body.lock }),
      headers: { 'Content-Type': 'application/json' },
    })
  );
  if (!created.ok) return json({ error: 'bad_lock' }, 400);

  return json({ ok: true, roomId: minted.roomId });
}

function registryStub(env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
}

function registryCall(env, path, body) {
  return registryStub(env).fetch(
    new Request('https://registry' + path, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

async function registryJson(env, path, body) {
  const response = await registryCall(env, path, body || {});
  return response.json();
}

/**
 * Compared in full every time rather than bailing on the first wrong
 * character, so the time it takes says nothing about how close a guess was.
 */
function isAdmin(request, env) {
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = env.ADMIN_TOKEN || '';
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Nothing by default. The page and the API share a hostname in the setup
 * this is built for, so there is no cross-origin request to permit, and a
 * wildcard would only invite one.
 */
function corsHeaders(request, env) {
  const allowed = env.ALLOWED_ORIGIN;
  const origin = request.headers.get('Origin');
  if (!allowed || !origin || origin !== allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
  });
}

