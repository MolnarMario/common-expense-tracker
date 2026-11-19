// Who is allowed to make a room, and what rooms exist.
//
// There is exactly one of these objects, so "has this invite code already
// been used" has a single answer arrived at in one place. A key-value
// store spread across data centres would answer that question twice
// during a race and hand out two rooms for one code.

const ROOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_CHARS = 16;

/** Well-formed guesses one address gets per window before it is ignored. */
const CLAIM_TRIES = 12;
const CLAIM_WINDOW_MS = 60 * 60 * 1000;

/** Access requests one address can send per day. */
const REQUEST_TRIES = 3;
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Requests held at once, waiting or answered. Bounds what a flood can store. */
const REQUEST_CAP = 200;
/** Answered or ignored requests are forgotten after this. */
const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REQUEST_LIMITS = { name: 60, message: 500 };

export class Registry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    switch (url.pathname.replace(/^.*\/registry/, '')) {
      case '/claim':
        return json(await this.claim(body));
      case '/mint':
        return json(await this.mint(body));
      case '/adopt':
        return json(await this.adopt(body));
      case '/codes':
        return json(await this.listCodes());
      case '/rooms':
        return json(await this.listRooms());
      case '/request':
        return json(await this.request(body));
      case '/request-status':
        return json(await this.requestStatus(body));
      case '/requests':
        return json(await this.listRequests());
      case '/decide':
        return json(await this.decide(body));
      default:
        return json({ error: 'not_found' }, 404);
    }
  }

  /**
   * Burn a code and hand back a fresh room id. The code is marked used
   * before anything else happens, so two people racing the same code get
   * one room between them and the loser is told the code is spent.
   */
  async claim(body) {
    const code = normalizeCode(body.code);
    if (!code) return { ok: false, error: 'bad_code' };
    if (!(await this.underLimit(body.ip))) return { ok: false, error: 'rate' };

    const entry = await this.ctx.storage.get('code:' + code);
    if (!entry) return { ok: false, error: 'bad_code' };
    if (entry.usedAt) return { ok: false, error: 'used_code', roomId: entry.roomId };

    const roomId = newRoomId();
    await this.ctx.storage.put({
      ['code:' + code]: Object.assign({}, entry, { usedAt: Date.now(), roomId }),
      ['room:' + roomId]: { createdAt: Date.now(), via: 'invite', note: entry.note || '' },
    });
    return { ok: true, roomId };
  }

  /**
   * A code is 78 bits, so nobody is guessing one. This is here for the
   * bot that will try anyway: it caps how fast one address can find that
   * out, and keeps the storage writes that come with it bounded.
   */
  async underLimit(ip, prefix = 'rl:', tries = CLAIM_TRIES, windowMs = CLAIM_WINDOW_MS) {
    if (!ip) return true;
    const key = prefix + ip;
    const now = Date.now();
    const bucket = (await this.ctx.storage.get(key)) || { start: now, tries: 0 };
    if (now - bucket.start > windowMs) {
      bucket.start = now;
      bucket.tries = 0;
    }
    bucket.tries += 1;
    await this.ctx.storage.put(key, bucket);
    return bucket.tries <= tries;
  }

  // ------------------------------------------------------ access requests
  //
  // Someone without a code asks for one. They leave a name and a line about
  // who they are, and nothing else: no email. Their browser keeps a secret
  // only it holds and asks back later. Once you approve, the answer it gets
  // carries a fresh invite code, so the code never travels by email.

  /** A request from a stranger. Returns the id and the secret to ask back with. */
  async request(body) {
    const name = cleanText(body.name, REQUEST_LIMITS.name);
    const message = cleanText(body.message, REQUEST_LIMITS.message);
    if (!message) return { ok: false, error: 'bad_request' };
    if (!(await this.underLimit(body.ip, 'rq:', REQUEST_TRIES, REQUEST_WINDOW_MS))) {
      return { ok: false, error: 'rate' };
    }

    await this.sweepRequests();
    const held = await this.ctx.storage.list({ prefix: 'req:', limit: REQUEST_CAP + 1 });
    if (held.size >= REQUEST_CAP) return { ok: false, error: 'busy' };

    const id = pick(ROOM_ALPHABET, 16);
    const secret = pick(ROOM_ALPHABET, 32);
    await this.ctx.storage.put('req:' + id, {
      createdAt: Date.now(),
      name,
      message,
      // Only a hash: reading storage is not enough to answer as them.
      secretHash: await sha256(secret),
      status: 'pending',
      code: null,
      decidedAt: null,
    });
    return { ok: true, id, secret };
  }

  /** The requester's browser asking how it went. Only it is ever handed the code. */
  async requestStatus(body) {
    const entry = await this.findRequest(body.id);
    if (!entry || typeof body.secret !== 'string') return { ok: false, error: 'not_found' };
    if ((await sha256(body.secret)) !== entry.secretHash) return { ok: false, error: 'not_found' };
    return {
      ok: true,
      status: entry.status,
      code: entry.status === 'approved' ? entry.code : null,
    };
  }

  /** Approve, which mints one code for them, or decline. Admin token only. */
  async decide(body) {
    const entry = await this.findRequest(body.id);
    if (!entry) return { ok: false, error: 'not_found' };
    if (entry.status !== 'pending') return { ok: false, error: 'already_' + entry.status };

    const next = Object.assign({}, entry, { decidedAt: Date.now() });
    const puts = {};
    if (body.approve === true) {
      const code = newCode();
      puts['code:' + code] = {
        createdAt: Date.now(),
        note: ('request: ' + (entry.name || body.id)).slice(0, 120),
        usedAt: null,
        roomId: null,
      };
      next.status = 'approved';
      next.code = code;
    } else {
      next.status = 'declined';
    }
    puts['req:' + body.id] = next;
    await this.ctx.storage.put(puts);
    return { ok: true, id: body.id, status: next.status, code: next.code };
  }

  async findRequest(id) {
    if (typeof id !== 'string' || !/^[a-z2-7]{16}$/.test(id)) return null;
    return (await this.ctx.storage.get('req:' + id)) || null;
  }

  async listRequests() {
    await this.sweepRequests();
    const out = [];
    const page = await this.ctx.storage.list({ prefix: 'req:', limit: 500 });
    for (const [key, value] of page) {
      out.push({
        id: key.slice(4),
        createdAt: value.createdAt,
        name: value.name,
        message: value.message,
        status: value.status,
        code: value.code,
        decidedAt: value.decidedAt,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, requests: out };
  }

  async sweepRequests() {
    const cutoff = Date.now() - REQUEST_TTL_MS;
    const stale = [];
    const page = await this.ctx.storage.list({ prefix: 'req:', limit: 500 });
    for (const [key, value] of page) {
      if (!value || (value.decidedAt || value.createdAt) < cutoff) stale.push(key);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  /** Codes to hand out. Only the admin token reaches this. */
  async mint(body) {
    // Minting is rare and manual, so it is a good moment to sweep up the
    // rate-limit counters left behind by addresses nobody will see again.
    await this.sweep();
    const count = clamp(Number(body.count) || 1, 1, 50);
    const note = typeof body.note === 'string' ? body.note.slice(0, 120) : '';
    const codes = [];
    const puts = {};
    for (let i = 0; i < count; i += 1) {
      const code = newCode();
      codes.push(code);
      puts['code:' + code] = { createdAt: Date.now(), note, usedAt: null, roomId: null };
    }
    await this.ctx.storage.put(puts);
    return { ok: true, codes };
  }

  /** A room the admin minted directly, with no code in the story. */
  async adopt(body) {
    const roomId = newRoomId();
    const note = typeof body.note === 'string' ? body.note.slice(0, 120) : '';
    await this.ctx.storage.put('room:' + roomId, {
      createdAt: Date.now(),
      via: 'admin',
      note,
    });
    return { ok: true, roomId };
  }

  async sweep() {
    const stale = [];
    const cutoff = Date.now() - CLAIM_WINDOW_MS;
    const page = await this.ctx.storage.list({ prefix: 'rl:', limit: 500 });
    for (const [key, value] of page) {
      if (!value || value.start < cutoff) stale.push(key);
    }
    const dayAgo = Date.now() - REQUEST_WINDOW_MS;
    const asked = await this.ctx.storage.list({ prefix: 'rq:', limit: 500 });
    for (const [key, value] of asked) {
      if (!value || value.start < dayAgo) stale.push(key);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  async listCodes() {
    const out = [];
    const page = await this.ctx.storage.list({ prefix: 'code:', limit: 500 });
    for (const [key, value] of page) {
      out.push({
        // Stored keys already carry the grouped form, so this is the code
        // as it was handed out, not something to group again.
        code: key.slice(5),
        note: value.note || '',
        createdAt: value.createdAt,
        usedAt: value.usedAt,
        roomId: value.roomId,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, codes: out };
  }

  async listRooms() {
    const out = [];
    const page = await this.ctx.storage.list({ prefix: 'room:', limit: 500 });
    for (const [key, value] of page) {
      out.push({ id: key.slice(5), createdAt: value.createdAt, via: value.via, note: value.note });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, rooms: out };
  }
}

function pick(alphabet, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  // The alphabets are 30 and 32 long; 256 is not a multiple of 30, so the
  // codes are very slightly biased. They are unguessable either way, and
  // the room id, which is the one doing security work, is unbiased.
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function newRoomId() {
  return pick(ROOM_ALPHABET, 32);
}

export function newCode() {
  return format(pick(CODE_ALPHABET, CODE_CHARS));
}

function format(raw) {
  return (raw.match(/.{1,4}/g) || []).join('-');
}

/** People retype these, so accept any spacing, dashes, and lower case. */
export function normalizeCode(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return cleaned.length === CODE_CHARS ? format(cleaned) : null;
}

/** Trimmed, control characters dropped, cut to length. Empty when not a string. */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
