// Asking for an invite code: the registry's half and the browser's half,
// wired together through a stand-in for fetch and Durable Object storage.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../worker/src/registry.js';
import { createAccessRequests, ACCESS } from '../src/access.js';

function fakeStorage() {
  const map = new Map();
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  return {
    async get(key) {
      return clone(map.get(key));
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
    async list({ prefix = '', limit = 1000 } = {}) {
      const out = new Map();
      for (const k of [...map.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit)) {
        out.set(k, clone(map.get(k)));
      }
      return out;
    },
    raw: map,
  };
}

function newRegistry() {
  const storage = fakeStorage();
  return { registry: new Registry({ storage }, {}), storage };
}

function memoryStore() {
  let value = null;
  return {
    load: () => (value ? JSON.parse(value) : null),
    save: (v) => {
      value = JSON.stringify(v);
      return true;
    },
    clear: () => {
      value = null;
      return true;
    },
  };
}

/** fetch, answered by the registry the way worker/src/index.js routes it. */
function fakeFetch(registry) {
  return async (url, options) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    const body = JSON.parse(options.body);
    const answer =
      path === '/requests'
        ? await registry.request(Object.assign({ ip: '1.2.3.4' }, body))
        : await registry.requestStatus(body);
    const status = answer.ok ? 200 : answer.error === 'not_found' ? 404 : 400;
    return { ok: answer.ok, status, json: async () => answer };
  };
}

test('a request needs something written about who is asking', async () => {
  const { registry } = newRegistry();
  assert.deepEqual(await registry.request({ name: 'Ana', message: '   ' }), {
    ok: false,
    error: 'bad_request',
  });
});

test('a request is held with a hash of its secret, never the secret', async () => {
  const { registry, storage } = newRegistry();
  const sent = await registry.request({ name: 'Ana', message: 'flat on Main St', ip: 'a' });
  assert.equal(sent.ok, true);
  const stored = storage.raw.get('req:' + sent.id);
  assert.equal(stored.status, 'pending');
  assert.ok(!JSON.stringify(stored).includes(sent.secret));

  const { requests } = await registry.listRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message, 'flat on Main St');
  assert.ok(!('secretHash' in requests[0]));
});

test('only the right secret learns how a request went', async () => {
  const { registry } = newRegistry();
  const { id, secret } = await registry.request({ message: 'hi', ip: 'a' });
  assert.deepEqual(await registry.requestStatus({ id, secret: 'x'.repeat(32) }), {
    ok: false,
    error: 'not_found',
  });
  assert.deepEqual(await registry.requestStatus({ id, secret }), {
    ok: true,
    status: 'pending',
    code: null,
  });
});

test('approving mints a working invite code and hands it to the requester', async () => {
  const { registry } = newRegistry();
  const { id, secret } = await registry.request({ name: 'Ana', message: 'hi', ip: 'a' });
  const decided = await registry.decide({ id, approve: true });
  assert.equal(decided.status, 'approved');

  const status = await registry.requestStatus({ id, secret });
  assert.equal(status.code, decided.code);

  const claimed = await registry.claim({ code: status.code, ip: 'a' });
  assert.equal(claimed.ok, true);
  assert.deepEqual(await registry.decide({ id, approve: false }), {
    ok: false,
    error: 'already_approved',
  });
});

test('declining hands back no code', async () => {
  const { registry } = newRegistry();
  const { id, secret } = await registry.request({ message: 'hi', ip: 'a' });
  await registry.decide({ id, approve: false });
  assert.deepEqual(await registry.requestStatus({ id, secret }), {
    ok: true,
    status: 'declined',
    code: null,
  });
});

test('one address gets three requests a day', async () => {
  const { registry } = newRegistry();
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await registry.request({ message: 'hi', ip: 'same' })).ok, true);
  }
  assert.deepEqual(await registry.request({ message: 'hi', ip: 'same' }), {
    ok: false,
    error: 'rate',
  });
  assert.equal((await registry.request({ message: 'hi', ip: 'other' })).ok, true);
});

test('requests older than 30 days are swept up', async () => {
  const { registry, storage } = newRegistry();
  const { id } = await registry.request({ message: 'hi', ip: 'a' });
  storage.raw.get('req:' + id).createdAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const { requests } = await registry.listRequests();
  assert.equal(requests.length, 0);
});

test('the browser sends, waits, and picks up the approved code', async () => {
  const { registry } = newRegistry();
  const access = createAccessRequests({
    endpoint: 'https://x.test/api',
    request: fakeFetch(registry),
    storage: memoryStore(),
  });

  assert.equal(access.current().status, ACCESS.none);
  assert.equal((await access.send('', '  ')).ok, false);
  assert.equal((await access.send('Ana', 'flat on Main St')).ok, true);
  assert.equal((await access.check()).status, ACCESS.pending);

  const [only] = (await registry.listRequests()).requests;
  const { code } = await registry.decide({ id: only.id, approve: true });

  const checked = await access.check();
  assert.equal(checked.status, ACCESS.approved);
  assert.equal(checked.code, code);
  assert.equal(access.current().code, code);
});

test('a request the server no longer has is forgotten', async () => {
  const { registry, storage } = newRegistry();
  const access = createAccessRequests({
    endpoint: 'https://x.test/api',
    request: fakeFetch(registry),
    storage: memoryStore(),
  });
  await access.send('Ana', 'hi');
  storage.raw.clear();
  assert.deepEqual(await access.check(), { status: ACCESS.none, expired: true });
  assert.equal(access.current().status, ACCESS.none);
});
