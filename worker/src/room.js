// One room, one Durable Object. It holds the records and every socket
// currently looking at them, which is why "in real time" is barely any
// code: the object that decides a write is the object holding the
// listeners to tell about it.
//
// It cannot read any of it. Each record arrives already encrypted by the
// browser that wrote it, and this file only ever sees an opaque string, an
// id, and a timestamp. The timestamp is the one thing that has to stay in
// the clear, because deciding which of two conflicting writes wins is the
// whole job here and that comparison cannot happen on ciphertext.
//
// Records are stored one key each, never as a single document, so two
// people writing at the same moment touch different keys and neither can
// overwrite the other's work.

import { LIMITS } from '../../src/records.js';
import { normalizeSealedOps, sealedBytes } from '../../src/ops.js';

/** Records per handover message, to stay well under any frame limit. */
const SNAPSHOT_CHUNK = 400;

/** Two phones, two laptops, and room to spare. */
const MAX_SOCKETS = 16;

/** Ops per window, per connection. A person types far below this. */
const RATE_OPS = 240;
const RATE_WINDOW_MS = 10000;

/** Durable Object storage takes at most this many keys in one call. */
const KEYS_PER_CALL = 128;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Rate buckets are per socket and deliberately forgettable: losing
    // them when the object hibernates just hands out a fresh allowance.
    this.buckets = new WeakMap();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').pop();

    if (action === 'init') return this.init(await body(request));

    const meta = await this.meta();
    if (!meta) return json({ error: 'not_found' }, 404);

    if (action === 'lock') {
      return request.method === 'POST'
        ? this.changeLock(await body(request))
        : json({ ok: true, lock: publicLock(meta.lock) });
    }

    if (action === 'usage') return json({ ok: true, usage: usageOf(meta) });

    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'expected_websocket' }, 426);
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return json({ error: 'too_many_clients' }, 429);
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // Both run after this response, so the client is listening by then.
    this.ctx.waitUntil(this.prune(meta).then(() => this.sendRoom(pair[1])));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * A room only exists once this has run, which is what stops anyone from
   * conjuring one by guessing at the socket route: a guessed id has no
   * meta, so it is refused before a single byte is written.
   */
  async init(payload) {
    const existing = await this.meta();
    if (existing) return json({ ok: true, usage: usageOf(existing) });
    if (!isLock(payload.lock)) return json({ error: 'bad_lock' }, 400);

    const meta = {
      version: 1,
      createdAt: Date.now(),
      prunedAt: Date.now(),
      bytes: 0,
      records: 0,
      lock: payload.lock,
    };
    await this.ctx.storage.put('meta', meta);
    return json({ ok: true, usage: usageOf(meta) });
  }

  /**
   * Changing the password re-wraps the same data key, so the new lock has
   * to carry the same proof the old one did. Without that check, anyone
   * holding the link could swap in a lock of their own and shut both of
   * you out of a room they still could not read.
   */
  async changeLock(payload) {
    const meta = await this.meta();
    if (!isLock(payload.lock)) return json({ error: 'bad_lock' }, 400);
    if (payload.lock.verifier !== meta.lock.verifier) return json({ error: 'forbidden' }, 403);
    await this.ctx.storage.put('meta', Object.assign({}, meta, { lock: payload.lock }));
    return json({ ok: true });
  }

  meta() {
    return this.ctx.storage.get('meta');
  }

  // ----------------------------------------------------------- the records

  /** Every key under a prefix, paged, because a room holds thousands. */
  async *entries(prefix) {
    let options = { prefix, limit: 1000 };
    for (;;) {
      const page = await this.ctx.storage.list(options);
      if (page.size === 0) return;
      let last = null;
      for (const entry of page) {
        yield entry;
        last = entry[0];
      }
      if (page.size < options.limit) return;
      options = { prefix, limit: 1000, startAfter: last };
    }
  }

  async sendRoom(ws) {
    const meta = await this.meta();
    if (!meta) return;
    send(ws, { type: 'hello', usage: usageOf(meta), serverTime: Date.now() });

    let items = [];
    const flush = (last) => {
      send(ws, { type: 'records', items, last });
      items = [];
    };

    for (const prefix of ['p:', 'e:']) {
      const kind = prefix === 'p:' ? 'person' : 'expense';
      for await (const [key, stored] of this.entries(prefix)) {
        items.push({ kind, id: key.slice(2), at: stored.at, type: 'put', blob: stored.blob });
        if (items.length >= SNAPSHOT_CHUNK) flush(false);
      }
    }
    flush(true);
  }

  /** One read per batch instead of one per op. */
  async readAll(keys) {
    const found = new Map();
    for (let i = 0; i < keys.length; i += KEYS_PER_CALL) {
      const page = await this.ctx.storage.get(keys.slice(i, i + KEYS_PER_CALL));
      for (const [key, value] of page) found.set(key, value);
    }
    return found;
  }

  /**
   * Work out what a batch would cost before writing any of it, so a batch
   * that would burst the room is refused whole rather than half-applied.
   */
  async plan(ops, meta, at) {
    const keys = new Set();
    for (const op of ops) {
      const key = keyFor(op.kind, op.id);
      keys.add(key);
      keys.add('x:' + key);
    }
    const stored = await this.readAll([...keys]);

    const writes = new Map();
    const deletes = new Set();
    let bytes = meta.bytes;
    let records = meta.records;

    for (const op of ops) {
      const key = keyFor(op.kind, op.id);
      const tomb = stored.get('x:' + key);
      const current = writes.has(key)
        ? writes.get(key).stored
        : deletes.has(key)
          ? null
          : stored.get(key);

      // Older than what is already here loses. Clocks between two phones
      // differ by seconds, so this only decides genuine conflicts.
      if (current && current.at > at) continue;
      if (op.type === 'put' && tomb && tomb.at > at) continue;

      if (op.type === 'del') {
        if (!current) continue;
        bytes -= sealedBytes(op.kind, op.id, current.blob);
        records -= 1;
        if (!tomb) bytes += tombBytes(op.id);
        deletes.add(key);
        writes.delete(key);
        continue;
      }

      bytes += sealedBytes(op.kind, op.id, op.blob);
      if (current) bytes -= sealedBytes(op.kind, op.id, current.blob);
      else records += 1;
      if (tomb) bytes -= tombBytes(op.id);
      writes.set(key, { stored: { blob: op.blob, at }, op });
      deletes.delete(key);
    }

    return { writes, deletes, bytes, records };
  }

  async apply(ops, at) {
    const meta = await this.meta();
    if (!meta) return { ok: false, reason: 'gone', message: 'This room no longer exists.' };

    const plan = await this.plan(ops, meta, at);

    if (plan.bytes > LIMITS.roomBytes || plan.records > LIMITS.roomRecords) {
      return {
        ok: false,
        reason: 'full',
        message: 'This tracker is full. Export a copy, then delete some months.',
        usage: usageOf(meta),
      };
    }

    const puts = {};
    const accepted = [];

    for (const [key, entry] of plan.writes) {
      puts[key] = entry.stored;
      accepted.push({ kind: entry.op.kind, type: 'put', at, id: entry.op.id, blob: entry.op.blob });
    }
    for (const key of plan.deletes) {
      puts['x:' + key] = { at };
      accepted.push({ kind: kindOf(key), type: 'del', at, id: key.slice(2) });
    }

    const next = Object.assign({}, meta, { bytes: plan.bytes, records: plan.records });
    await this.writeAll(puts, next);
    if (plan.deletes.size > 0) await this.deleteAll([...plan.deletes]);

    return { ok: true, accepted, usage: usageOf(next) };
  }

  async writeAll(puts, meta) {
    const keys = Object.keys(puts);
    for (let i = 0; i < keys.length; i += KEYS_PER_CALL) {
      const chunk = {};
      for (const key of keys.slice(i, i + KEYS_PER_CALL)) chunk[key] = puts[key];
      await this.ctx.storage.put(chunk);
    }
    // Counted last, so a room can never think it holds less than it does.
    await this.ctx.storage.put('meta', meta);
  }

  async deleteAll(keys) {
    for (let i = 0; i < keys.length; i += KEYS_PER_CALL) {
      await this.ctx.storage.delete(keys.slice(i, i + KEYS_PER_CALL));
    }
  }

  /**
   * Tombstones exist so a device that was offline for a week cannot push a
   * deleted expense back into the room. After three months nothing is
   * still carrying an op that old, so they are dead weight against the cap.
   */
  async prune(meta) {
    if (Date.now() - (meta.prunedAt || 0) < PRUNE_EVERY_MS) return;
    const cutoff = Date.now() - LIMITS.tombstoneDays * DAY_MS;
    const gone = [];
    let freed = 0;
    for await (const [key, stored] of this.entries('x:')) {
      if (stored && stored.at < cutoff) {
        gone.push(key);
        freed += tombBytes(key.slice(4));
      }
    }
    if (gone.length === 0) {
      await this.ctx.storage.put('meta', Object.assign({}, meta, { prunedAt: Date.now() }));
      return;
    }
    await this.deleteAll(gone);
    await this.ctx.storage.put(
      'meta',
      Object.assign({}, meta, { prunedAt: Date.now(), bytes: Math.max(0, meta.bytes - freed) })
    );
  }

  // --------------------------------------------------------------- sockets

  async webSocketMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (message.type === 'ping') return send(ws, { type: 'pong' });
    if (message.type === 'resync') return this.sendRoom(ws);
    if (message.type !== 'push') return;

    const seq = Number.isFinite(message.seq) ? message.seq : 0;
    const ops = normalizeSealedOps(message.ops);
    if (ops === null) {
      return send(ws, {
        type: 'reject',
        seq,
        reason: 'too_many',
        message: 'That was too much to send at once.',
      });
    }
    if (ops.length === 0) return send(ws, { type: 'ack', seq });

    if (!this.allow(ws, ops.length)) {
      return send(ws, {
        type: 'reject',
        seq,
        reason: 'rate',
        message: 'Too many changes at once. Wait a moment and try again.',
      });
    }

    // A clock running fast would otherwise let one device win every
    // conflict forever, so nothing is ever newer than the server's now.
    const at = Math.min(newestClock(ops), Date.now());
    const result = await this.apply(ops, at);

    if (!result.ok) {
      return send(ws, {
        type: 'reject',
        seq,
        reason: result.reason,
        message: result.message,
        usage: result.usage,
      });
    }

    send(ws, { type: 'ack', seq, usage: result.usage });
    if (result.accepted.length === 0) return;
    const payload = JSON.stringify({ type: 'ops', ops: result.accepted });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) trySend(other, payload);
    }
  }

  webSocketClose(ws) {
    this.buckets.delete(ws);
  }

  webSocketError(ws) {
    this.buckets.delete(ws);
  }

  allow(ws, count) {
    const now = Date.now();
    const bucket = this.buckets.get(ws) || { start: now, used: 0 };
    if (now - bucket.start > RATE_WINDOW_MS) {
      bucket.start = now;
      bucket.used = 0;
    }
    bucket.used += count;
    this.buckets.set(ws, bucket);
    return bucket.used <= RATE_OPS;
  }
}

function keyFor(kind, id) {
  return (kind === 'person' ? 'p:' : 'e:') + id;
}

function kindOf(key) {
  return key.startsWith('p:') ? 'person' : 'expense';
}

/** "x:" + "p:" + id, holding {at}. Small, but it counts against the cap. */
function tombBytes(id) {
  return 4 + id.length + 20;
}

/** The newest clock reading in the batch, so one batch lands as one moment. */
function newestClock(ops) {
  let at = 0;
  for (const op of ops) at = Math.max(at, op.at);
  return at || Date.now();
}

function isLock(lock) {
  return (
    lock &&
    typeof lock.salt === 'string' &&
    typeof lock.wrapped === 'string' &&
    typeof lock.verifier === 'string' &&
    Number.isFinite(lock.iterations) &&
    lock.salt.length <= 64 &&
    lock.wrapped.length <= 256 &&
    lock.verifier.length <= 64
  );
}

/**
 * The verifier stays here. It proves you hold the data key, so handing it
 * to anyone who asks would hand them the ability to change the password.
 */
function publicLock(lock) {
  return { v: lock.v || 1, salt: lock.salt, iterations: lock.iterations, wrapped: lock.wrapped };
}

function usageOf(meta) {
  return {
    bytes: meta.bytes,
    records: meta.records,
    limitBytes: LIMITS.roomBytes,
    limitRecords: LIMITS.roomRecords,
  };
}

function body(request) {
  return request.json().catch(() => ({}));
}

function send(ws, message) {
  trySend(ws, JSON.stringify(message));
}

function trySend(ws, payload) {
  try {
    ws.send(payload);
  } catch {
    // The socket went away between getWebSockets() and here. Nothing to do.
  }
}

function json(body_, status = 200) {
  return new Response(JSON.stringify(body_), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
