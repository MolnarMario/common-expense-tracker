import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLock,
  fromBase64,
  fromRecoveryKey,
  generateDataKey,
  openLock,
  seal,
  toBase64,
  toRecoveryKey,
  unseal,
  verifierFor,
} from '../src/crypto.js';
import { openOps, openSnapshot, sealOps } from '../src/envelope.js';
import { putExpense, putPerson, delExpense } from '../src/ops.js';

/** Real rooms use 600,000. The tests only care that it round trips. */
const FAST = 10000;

const expense = {
  id: 'e1',
  month: '2026-08',
  amount: 124500,
  payerId: 'p1',
  description: 'rent',
  date: '2026-08-01',
};

test('the password opens the room and anything else does not', async () => {
  const key = await generateDataKey();
  const lock = await createLock(key, 'a good long password', FAST);

  assert.equal(await openLock(lock, 'a good long passwerd'), null);
  assert.equal(await openLock(lock, ''), null);
  assert.ok(await openLock(lock, 'a good long password'));
});

test('what the server holds says nothing about the password', async () => {
  const key = await generateDataKey();
  const lock = await createLock(key, 'hunter2 hunter2', FAST);
  const asStored = JSON.stringify(lock);

  assert.equal(asStored.includes('hunter2'), false);
  assert.deepEqual(Object.keys(lock).sort(), ['iterations', 'salt', 'v', 'verifier', 'wrapped']);
});

test('two rooms with the same password do not share a wrapped key', async () => {
  const password = 'the same password twice';
  const a = await createLock(await generateDataKey(), password, FAST);
  const b = await createLock(await generateDataKey(), password, FAST);

  assert.notEqual(a.salt, b.salt, 'a fresh salt each time');
  assert.notEqual(a.wrapped, b.wrapped);
});

test('a record round trips, and a tampered one refuses to open', async () => {
  const key = await generateDataKey();
  const blob = await seal(key, expense);

  assert.deepEqual(await unseal(key, blob), expense);
  assert.equal(await unseal(await generateDataKey(), blob), null, 'wrong key, no data');

  // Flip one byte of the ciphertext. AES-GCM authenticates, so this is
  // caught rather than quietly producing a different amount.
  const bytes = fromBase64(blob);
  bytes[bytes.length - 5] ^= 0xff;
  assert.equal(await unseal(key, toBase64(bytes)), null);
});

test('the same record sealed twice looks different both times', async () => {
  const key = await generateDataKey();
  assert.notEqual(await seal(key, expense), await seal(key, expense), 'a fresh IV every time');
});

test('the recovery key is the way back in, however it was written down', async () => {
  const key = await generateDataKey();
  const blob = await seal(key, expense);
  const written = await toRecoveryKey(key);

  const retyped = await fromRecoveryKey(written.toUpperCase().replace(/-/g, ' '));
  assert.deepEqual(await unseal(retyped, blob), expense);

  assert.equal(await fromRecoveryKey('not a key'), null);
  assert.equal(await fromRecoveryKey(''), null);
});

test('the verifier proves the key without being the key', async () => {
  const key = await generateDataKey();
  const again = await fromRecoveryKey(await toRecoveryKey(key));

  assert.equal(await verifierFor(key), await verifierFor(again));
  assert.notEqual(await verifierFor(key), await verifierFor(await generateDataKey()));
});

test('ops go out sealed and come back whole', async () => {
  const key = await generateDataKey();
  const ops = [
    putPerson({ id: 'p1', name: 'Ana' }, 5),
    putExpense('2026-08', expense, 6),
    delExpense('e2', 7),
  ];

  const wire = await sealOps(key, ops);
  assert.equal(
    JSON.stringify(wire).includes('Ana'),
    false,
    'no name, no amount, not even the month leaves the browser'
  );
  assert.equal(wire[2].blob, undefined, 'a delete is only an id and a time');

  assert.deepEqual(await openOps(key, wire), ops);
});

test('a handover with one unreadable row still delivers the rest', async () => {
  const key = await generateDataKey();
  const wire = await sealOps(key, [putPerson({ id: 'p1', name: 'Ana' }, 5), putExpense('2026-08', expense, 6)]);
  wire.push({ kind: 'expense', type: 'put', at: 7, id: 'e9', blob: 'bm90IG1pbmU=' });

  const snapshot = await openSnapshot(key, wire);
  assert.equal(snapshot.people.length, 1);
  assert.equal(snapshot.expenses.length, 1);
  assert.equal(snapshot.failed, 1, 'and the app is told, rather than quietly showing less');
});

test('holding the key does not buy the right to store nonsense', async () => {
  const key = await generateDataKey();
  const wire = [
    { kind: 'expense', type: 'put', at: 5, id: 'e1', blob: await seal(key, { id: 'e1', amount: -900 }) },
    { kind: 'person', type: 'put', at: 5, id: 'p1', blob: await seal(key, { id: 'p1', name: '' }) },
  ];

  assert.deepEqual(await openOps(key, wire), [], 'decrypted records are validated like any other');
});
