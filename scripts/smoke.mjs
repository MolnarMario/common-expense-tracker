// End to end against a running Worker, using the same modules the browser
// uses. Unit tests cover the pieces; this covers the thing the pieces are
// for: two devices, one room, and neither of them trusting the server with
// anything it could read.
//
//   terminal one   npm run api
//   terminal two   npm run smoke
//
// ADMIN_TOKEN has to match the one wrangler dev was started with.

import { createLock, generateDataKey, openLock } from '../src/crypto.js';
import { openOps, openSnapshot, sealOps } from '../src/envelope.js';
import { delExpense, putExpense, putPerson } from '../src/ops.js';

const API = process.env.API ?? 'http://127.0.0.1:8787/api';
const ADMIN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const PASSWORD = 'a good long password';

let failures = 0;

function check(what, condition) {
  const mark = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures += 1;
  console.log('  ' + mark + '  ' + what);
}

async function json(path, options = {}) {
  const response = await fetch(API + path, options);
  return { status: response.status, body: await response.json().catch(() => null) };
}

function post(path, body, token) {
  return json(path, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: JSON.stringify(body),
  });
}

/** A browser tab: a socket, a key, and whatever it has decrypted so far. */
function client(name, roomId, key) {
  const socket = new WebSocket(API.replace(/^http/, 'ws') + '/rooms/' + roomId + '/socket');
  const waiting = [];
  const state = { name, snapshot: null, ops: [], rejects: [], acks: [], chunks: [] };

  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'records') {
      state.chunks.push(...message.items);
      if (message.last) {
        state.snapshot = await openSnapshot(key, state.chunks);
        state.chunks = [];
      }
    }
    if (message.type === 'ops') state.ops.push(...(await openOps(key, message.ops)));
    if (message.type === 'ack') state.acks.push(message);
    if (message.type === 'reject') state.rejects.push(message);
    for (const [predicate, resolve] of waiting.slice()) {
      if (predicate(state, message)) {
        waiting.splice(waiting.indexOf([predicate, resolve]), 1);
        resolve(message);
      }
    }
  });

  return {
    state,
    open: () =>
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      }),
    async push(seq, ops) {
      socket.send(JSON.stringify({ type: 'push', seq, ops: await sealOps(key, ops) }));
    },
    raw: (message) => socket.send(JSON.stringify(message)),
    until(predicate, label) {
      return new Promise((resolve, reject) => {
        if (predicate(state)) return resolve();
        const entry = [predicate, resolve];
        waiting.push(entry);
        setTimeout(() => reject(new Error('timed out waiting for ' + label)), 5000);
      });
    },
    close: () => socket.close(),
  };
}

const ana = { id: 'p-ana', name: 'Ana' };
const rent = { id: 'e-rent', amount: 240000, payerId: ana.id, description: 'rent', date: '2026-08-01' };

async function main() {
  console.log('\ngetting in');

  const health = await json('/health');
  if (health.status !== 200) throw new Error('no API at ' + API + '. Run npm run api first.');

  const noCode = await post('/rooms', { lock: { wrapped: 'x' } });
  check('a room cannot be had without a code', noCode.status === 400);

  const guessed = await json('/rooms/' + 'a'.repeat(32) + '/lock');
  check('a guessed room id is not a room', guessed.status === 404);

  const minted = await post('/invites', { count: 1, note: 'smoke test' }, ADMIN);
  check('the admin token mints invite codes', minted.body?.codes?.length === 1);
  const code = minted.body.codes[0];

  const unauthorised = await post('/invites', { count: 1 }, 'wrong-token');
  check('a wrong admin token mints nothing', unauthorised.status === 403);

  console.log('\nmaking a room');

  const key = await generateDataKey();
  const lock = await createLock(key, PASSWORD);
  const made = await post('/rooms', { code, lock });
  check('the code buys exactly one room', made.body?.ok === true);
  const roomId = made.body.roomId;

  const reused = await post('/rooms', { code, lock });
  check('and cannot be spent twice', reused.body?.error === 'used_code');

  // The other door: a room you make yourself and hand over, no code in it.
  const byHand = await post('/rooms', { lock, note: 'made by hand' }, ADMIN);
  check('the admin token makes a room with no code at all', byHand.body?.ok === true);
  const handedOver = await json('/rooms/' + byHand.body.roomId + '/lock');
  check(
    'and the person you hand it to can open it with the password',
    (await openLock(handedOver.body.lock, PASSWORD)) !== null
  );

  console.log('\ndevice one');

  const one = client('one', roomId, key);
  await one.open();
  await one.until((s) => s.snapshot !== null, 'the empty room');
  check('an empty room arrives as an empty room', one.state.snapshot.expenses.length === 0);

  await one.push(1, [putPerson(ana), putExpense('2026-08', rent)]);
  await one.until((s) => s.acks.length === 1, 'the ack');
  check('two records land', one.state.acks[0].usage.records === 2);

  console.log('\ndevice two, which has never seen this room');

  const fetched = await json('/rooms/' + roomId + '/lock');
  check('the lock is public', fetched.body?.lock?.wrapped === lock.wrapped);
  check('and keeps the proof to itself', fetched.body?.lock?.verifier === undefined);

  check('a wrong password opens nothing', (await openLock(fetched.body.lock, 'nope')) === null);
  const key2 = await openLock(fetched.body.lock, PASSWORD);
  check('the right one opens it', key2 !== null);

  const two = client('two', roomId, key2);
  await two.open();
  await two.until((s) => s.snapshot !== null, 'the handover');
  check('device two sees the roster', two.state.snapshot.people[0].name === 'Ana');
  check('and the expense, decrypted', two.state.snapshot.expenses[0].amount === 240000);
  check('including the month, which never left in the clear', two.state.snapshot.expenses[0].month === '2026-08');

  console.log('\nboth at once');

  await two.push(1, [putExpense('2026-08', { id: 'e-gas', amount: 8900, payerId: ana.id, description: 'gas' })]);
  await one.until((s) => s.ops.some((op) => op.record?.id === 'e-gas'), 'the live update');
  check('what device two adds shows up on device one', true);

  await one.push(2, [delExpense('e-rent')]);
  await two.until((s) => s.ops.some((op) => op.type === 'del' && op.id === 'e-rent'), 'the delete');
  check('and a delete travels the other way', true);

  const stale = { kind: 'expense', type: 'put', at: 1, id: 'e-rent', blob: (await sealOps(key, [putExpense('2026-08', rent, 1)]))[0].blob };
  two.raw({ type: 'push', seq: 99, ops: [stale] });
  await two.until((s) => s.acks.some((a) => a.seq === 99), 'the stale ack');
  const after = await json('/rooms/' + roomId + '/usage');
  check('an op older than the delete does not resurrect it', after.body.usage.records === 2);

  console.log('\nwhat the server actually holds');
  const wrongKey = await generateDataKey();
  const blind = client('blind', roomId, wrongKey);
  await blind.open();
  await blind.until((s) => s.snapshot !== null, 'the ciphertext');
  check(
    'the same bytes with the wrong key decrypt to nothing',
    blind.state.snapshot.expenses.length === 0 && blind.state.snapshot.failed === 2
  );

  one.close();
  two.close();
  blind.close();

  console.log('\n' + (failures === 0 ? 'all good' : failures + ' failed'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n' + error.message);
  process.exit(1);
});
