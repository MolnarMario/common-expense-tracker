// End-to-end encryption for a room.
//
// Two keys, not one. Every record is encrypted with a random 256-bit data
// key. That data key is itself encrypted with a key derived from the
// password, and only the wrapped result is uploaded. The server stores
// ciphertext, a salt, and a wrapped blob it cannot open. Neither the
// password nor the data key ever leaves the browser.
//
// The two-key arrangement is what makes changing the password cheap: the
// password wraps one small blob, so changing it re-wraps that blob instead
// of re-encrypting every expense in the room.
//
// What this does not protect: this device. The unlocked data key and the
// decrypted cache both sit in localStorage, because that is what "type the
// password once per device" means. Encryption here is about the server and
// the wire, not about someone holding your unlocked laptop.

/** OWASP's floor for PBKDF2-SHA256. About a second on a mid-range phone. */
export const ITERATIONS = 600000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function subtle() {
  const api = typeof crypto !== 'undefined' && crypto.subtle;
  if (!api) throw new Error('no-subtle-crypto');
  return api;
}

/**
 * WebCrypto is only handed out in a secure context, so an http:// page or
 * a file:// one cannot do any of this. Sharing is switched off there
 * rather than left to fail at the worst moment.
 */
export function canEncrypt() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && !!crypto.getRandomValues;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

// ------------------------------------------------------------------- keys

export function generateDataKey() {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function importDataKey(raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function exportDataKey(key) {
  return new Uint8Array(await subtle().exportKey('raw', key));
}

/**
 * Password to wrapping key. Slow on purpose: the whole point is that
 * guessing at the password costs real time even with the wrapped blob in
 * hand. The iteration count travels with the room so it can be raised
 * later without stranding rooms made today.
 */
async function wrappingKey(password, salt, iterations) {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * The blob the server holds for a room. Everything in it is safe to hand
 * to anyone: without the password it is noise.
 *
 * @returns {{v: number, salt: string, iterations: number, wrapped: string, verifier: string}}
 */
export async function createLock(dataKey, password, iterations = ITERATIONS) {
  const salt = randomBytes(SALT_BYTES);
  const wrapper = await wrappingKey(password, salt, iterations);
  const raw = await exportDataKey(dataKey);
  const iv = randomBytes(IV_BYTES);
  const wrapped = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv }, wrapper, raw)
  );
  return {
    v: 1,
    salt: toBase64(salt),
    iterations,
    wrapped: toBase64(join(iv, wrapped)),
    verifier: await verifierFor(dataKey),
  };
}

/**
 * @returns {Promise<CryptoKey|null>} null means the password was wrong.
 *   AES-GCM authenticates, so a wrong key fails to decrypt rather than
 *   producing plausible-looking rubbish. No separate password check needed.
 */
export async function openLock(lock, password) {
  if (!lock || typeof lock.wrapped !== 'string' || typeof lock.salt !== 'string') return null;
  const iterations = Number.isFinite(lock.iterations) ? lock.iterations : ITERATIONS;
  try {
    const wrapper = await wrappingKey(password, fromBase64(lock.salt), iterations);
    const blob = fromBase64(lock.wrapped);
    const raw = await subtle().decrypt(
      { name: 'AES-GCM', iv: blob.slice(0, IV_BYTES) },
      wrapper,
      blob.slice(IV_BYTES)
    );
    return importDataKey(new Uint8Array(raw));
  } catch {
    return null;
  }
}

/**
 * Proof that you hold the data key, without revealing it. Changing a
 * room's password takes this, so someone who only has the link can
 * replace the lock and lock everyone out.
 */
export async function verifierFor(dataKey) {
  const raw = await exportDataKey(dataKey);
  const digest = await subtle().digest('SHA-256', join(raw, new TextEncoder().encode('verify')));
  return toBase64(new Uint8Array(digest));
}

// -------------------------------------------------------------- records

/** @returns {Promise<string>} base64 of iv || ciphertext. */
export async function seal(dataKey, value) {
  const iv = randomBytes(IV_BYTES);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv }, dataKey, plain)
  );
  return toBase64(join(iv, sealed));
}

/** @returns {Promise<object|null>} null for anything that will not open. */
export async function unseal(dataKey, blob) {
  if (typeof blob !== 'string' || blob.length < 16) return null;
  try {
    const bytes = fromBase64(blob);
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
      dataKey,
      bytes.slice(IV_BYTES)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

// ----------------------------------------------------- the recovery key

/**
 * The data key itself, written out for a human. Whoever has this string
 * is in, password or no password, which is exactly why it is shown once
 * and belongs somewhere other than the browser that made it.
 */
export async function toRecoveryKey(dataKey) {
  const raw = await exportDataKey(dataKey);
  return groups(base32Encode(raw), 4);
}

export async function fromRecoveryKey(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z2-7]/g, '');
  const raw = base32Decode(cleaned);
  if (!raw || raw.length !== 32) return null;
  try {
    return await importDataKey(raw);
  } catch {
    return null;
  }
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function groups(text, size) {
  return (text.match(new RegExp('.{1,' + size + '}', 'g')) || []).join('-');
}

// ------------------------------------------------------------- plumbing

function join(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
