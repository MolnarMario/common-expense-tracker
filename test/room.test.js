// The server's half: what it accepts, what it refuses, and how it settles
// two devices writing to the same record. The Room class only touches
// Cloudflare APIs inside fetch(), so everything below drives it directly
// with a stand-in for Durable Object storage.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../worker/src/room.js';
import { LIMITS } from '../src/records.js';

function fakeCtx() {
  const map = new Map();
  const sockets = [];
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  return {
    sockets,
    storage: {
      async get(key) {
        if (!Array.isArray(key)) return clone(map.get(key));
        const out = new Map();
        for (const one of key) if (map.has(one)) out.set(one, clone(map.get(one)));
        return out;
      },
      async put(key, value) {
        if (key && typeof key === 'object') {
          for (const [k, v] of Object.entries(key)) map.set(k, clone(v));
          return;
        }
        map.set(key, clone(value));
      },
      async delete(keys) {
        for (const one of Array.isArray(keys) ? keys : [keys]) map.delete(one);
      },
      async list({ prefix = '', limit = 1000, startAfter } = {}) {
        const keys = [...map.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort()
          .filter((k) => (startAfter ? k > startAfter : true));
        const out = new Map();
        for (const k of keys.slice(0, limit)) out.set(k, clone(map.get(k)));
        return out;
      },
      raw: map,
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
  };
}

const LOCK = { v: 1, salt: 'c2FsdA==', iterations: 600000, wrapped: 'd3JhcA==', verifier: 'dg==' };

async function newRoom() {
  const ctx = fakeCtx();
  const room = new Room(ctx, {});
  const response = await room.init({ lock: LOCK });
  assert.equal(response.status, 200);
  return { room, ctx };
}

const put = (id, at, blob = 'blob-' + id, kind = 'expense') => ({ kind, type: 'put', at, id, blob });
const del = (id, at, kind = 'expense') => ({ kind, type: 'del', at, id });

test('a room that was never created refuses everything', async () => {
  const room = new Room(fakeCtx(), {});
  const result = await room.apply([put('e1', 10)], 10);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gone');
});

test('creating a room needs a lock, because there are no unlocked rooms', async () => {
  const room = new Room(fakeCtx(), {});
  assert.equal((await room.init({})).status, 400);
  assert.equal((await room.init({ lock: { salt: 'x' } })).status, 400);
});

test('records go in and come back out, and the server never sees inside them', async () => {
  const { room, ctx } = await newRoom();
  const result = await room.apply([put('e1', 10), put('p1', 10, 'blob-p1', 'person')], 10);

  assert.equal(result.ok, true);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.usage.records, 2);
  assert.equal(ctx.storage.raw.get('e:e1').blob, 'blob-e1');
  assert.equal(
    JSON.stringify([...ctx.storage.raw.values()]).includes('amount'),
    false,
    'nothing readable is stored anywhere'
  );
});

test('the newer write wins and the older one is dropped', async () => {
  const { room, ctx } = await newRoom();
  await room.apply([put('e1', 200, 'newer')], 200);
  const late = await room.apply([put('e1', 100, 'older')], 100);

  assert.equal(late.ok, true);
  assert.equal(late.accepted.length, 0, 'nothing to tell the other device about');
  assert.equal(ctx.storage.raw.get('e:e1').blob, 'newer');
});

test('a phone that was offline for a week cannot resurrect a deleted expense', async () => {
  const { room, ctx } = await newRoom();
  await room.apply([put('e1', 100)], 100);
  await room.apply([del('e1', 500)], 500);

  const stale = await room.apply([put('e1', 200, 'from-the-past')], 200);
  assert.equal(stale.accepted.length, 0);
  assert.equal(ctx.storage.raw.has('e:e1'), false);
  assert.equal(ctx.storage.raw.has('x:e:e1'), true, 'the tombstone is what remembers');

  // A genuinely newer edit is a different story and does come back.
  const revived = await room.apply([put('e1', 900, 'edited-again')], 900);
  assert.equal(revived.accepted.length, 1);
  assert.equal(ctx.storage.raw.get('e:e1').blob, 'edited-again');
});

test('deleting frees the bytes it was using', async () => {
  const { room } = await newRoom();
  const filled = await room.apply([put('e1', 10, 'x'.repeat(400))], 10);
  const emptied = await room.apply([del('e1', 20)], 20);

  assert.ok(filled.usage.bytes > 400);
  assert.ok(emptied.usage.bytes < filled.usage.bytes);
  assert.equal(emptied.usage.records, 0);
});

test('a batch that would burst the room is refused whole, not half applied', async () => {
  const { room, ctx } = await newRoom();
  const big = 'x'.repeat(LIMITS.recordBytes - 40);
  const perRecord = big.length + 40;
  const count = Math.ceil(LIMITS.roomBytes / perRecord) + 2;

  const ops = Array.from({ length: Math.min(count, LIMITS.batchOps) }, (_, i) =>
    put('e' + i, 10, big)
  );
  // One batch is not enough to fill a 2MB room, so fill it in several.
  let last = null;
  for (let round = 0; round < 40; round += 1) {
    last = await room.apply(
      ops.map((op) => Object.assign({}, op, { id: 'r' + round + '-' + op.id })),
      10 + round
    );
    if (!last.ok) break;
  }

  assert.equal(last.ok, false, 'it eventually says no');
  assert.equal(last.reason, 'full');
  assert.ok(last.message.includes('Export'), 'and says what to do about it');

  const stored = [...ctx.storage.raw.keys()].filter((k) => k.startsWith('e:')).length;
  const counted = (await room.meta()).records;
  assert.equal(stored, counted, 'nothing from the refused batch was written');
});

test('one record cannot be worth a whole room', async () => {
  const { room } = await newRoom();
  // normalizeSealedOps is what enforces this, on the way in off the socket.
  const ws = fakeSocket();
  await room.webSocketMessage(
    ws,
    JSON.stringify({
      type: 'push',
      seq: 1,
      ops: [put('e1', 10, 'x'.repeat(LIMITS.recordBytes + 1))],
    })
  );
  assert.equal(ws.sent[0].type, 'ack', 'the oversized op is dropped');
  assert.equal((await room.meta()).records, 0);
});

test('the sender is told it landed and everyone else is told what changed', async () => {
  const { room, ctx } = await newRoom();
  const mine = fakeSocket();
  const theirs = fakeSocket();
  ctx.sockets.push(mine, theirs);

  await room.webSocketMessage(
    mine,
    JSON.stringify({ type: 'push', seq: 7, ops: [put('e1', 10)] })
  );

  assert.equal(mine.sent[0].type, 'ack');
  assert.equal(mine.sent[0].seq, 7);
  assert.equal(mine.sent.length, 1, 'the sender already drew it, so no echo');
  assert.equal(theirs.sent[0].type, 'ops');
  assert.equal(theirs.sent[0].ops[0].blob, 'blob-e1');
});

test('a device with a fast clock cannot win every conflict forever', async () => {
  const { room, ctx } = await newRoom();
  const ws = fakeSocket();
  ctx.sockets.push(ws);

  const yearAhead = Date.now() + 365 * 24 * 60 * 60 * 1000;
  await room.webSocketMessage(
    ws,
    JSON.stringify({ type: 'push', seq: 1, ops: [put('e1', yearAhead)] })
  );

  assert.ok(ctx.storage.raw.get('e:e1').at <= Date.now(), 'stamped with the server clock instead');
});

test('a flood from one connection is cut off', async () => {
  const { room, ctx } = await newRoom();
  const ws = fakeSocket();
  ctx.sockets.push(ws);

  let rejected = null;
  for (let i = 0; i < 4 && !rejected; i += 1) {
    await room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'push',
        seq: i,
        ops: Array.from({ length: 200 }, (_, n) => put('e' + i + '-' + n, 10)),
      })
    );
    rejected = ws.sent.find((m) => m.type === 'reject' && m.reason === 'rate');
  }
  assert.ok(rejected, 'the bucket runs dry');
});

test('changing the password takes proof you can already read the room', async () => {
  const { room } = await newRoom();
  const impostor = await room.changeLock({
    lock: Object.assign({}, LOCK, { wrapped: 'bXluZQ==', verifier: 'ZGlmZmVyZW50' }),
  });
  assert.equal(impostor.status, 403, 'holding the link is not enough to lock people out');

  const owner = await room.changeLock({
    lock: Object.assign({}, LOCK, { wrapped: 'bmV3d3JhcA==' }),
  });
  assert.equal(owner.status, 200);
  assert.equal((await room.meta()).lock.wrapped, 'bmV3d3JhcA==');
});

test('the lock handed to a stranger keeps the proof to itself', async () => {
  const { room } = await newRoom();
  const response = await room.fetch(new Request('https://room/lock'));
  const body = await response.json();

  assert.equal(body.lock.wrapped, LOCK.wrapped);
  assert.equal(body.lock.salt, LOCK.salt);
  assert.equal(body.lock.verifier, undefined);
});

test('old tombstones are swept up so they stop counting against the cap', async () => {
  const { room, ctx } = await newRoom();
  await room.apply([put('e1', 100)], 100);
  await room.apply([del('e1', 200)], 200);

  const ancient = Date.now() - (LIMITS.tombstoneDays + 1) * 24 * 60 * 60 * 1000;
  ctx.storage.raw.set('x:e:e1', { at: ancient });
  await room.ctx.storage.put('meta', Object.assign({}, await room.meta(), { prunedAt: 0 }));

  await room.prune(await room.meta());
  assert.equal(ctx.storage.raw.has('x:e:e1'), false);
});

function fakeSocket() {
  const sent = [];
  return {
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}
