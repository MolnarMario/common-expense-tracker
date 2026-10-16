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
  async underLimit(ip) {
    if (!ip) return true;
    const key = 'rl:' + ip;
    const now = Date.now();
    const bucket = (await this.ctx.storage.get(key)) || { start: now, tries: 0 };
    if (now - bucket.start > CLAIM_WINDOW_MS) {
      bucket.start = now;
      bucket.tries = 0;
    }
    bucket.tries += 1;
    await this.ctx.storage.put(key, bucket);
    return bucket.tries <= CLAIM_TRIES;
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

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
