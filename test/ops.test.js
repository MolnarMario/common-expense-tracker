import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOp,
  applyOps,
  applySnapshot,
  chunkOps,
  delExpense,
  delPerson,
  normalizeOp,
  normalizeOps,
  normalizeSealedOp,
  normalizeSealedOps,
  putExpense,
  putPerson,
  stateToOps,
} from '../src/ops.js';
import { LIMITS } from '../src/records.js';
import { createStore } from '../src/state.js';

function blank() {
  return { version: 3, currentMonthId: '2026-08', theme: 'light', settlementOpen: false, people: [], months: {} };
}

function fakeStorage() {
  let raw = null;
  return {
    load: () => (raw === null ? null : JSON.parse(raw)),
    save: (state) => {
      raw = JSON.stringify(state);
      return true;
    },
    clear: () => {
      raw = null;
    },
  };
}

test('a put is absolute, so applying it twice changes nothing the second time', () => {
  const state = blank();
  const op = putPerson({ id: 'p1', name: 'Ana' }, 10);

  assert.equal(applyOp(state, op), true);
  assert.equal(applyOp(state, op), false, 'the echo of our own op is a no-op');
  assert.deepEqual(state.people, [{ id: 'p1', name: 'Ana' }]);
});

test('two people adding expenses at once do not collide', () => {
  const mine = blank();
  const theirs = blank();

  applyOp(mine, putPerson({ id: 'p1', name: 'Ana' }, 1));
  applyOp(theirs, putPerson({ id: 'p1', name: 'Ana' }, 1));

  const a = putExpense('2026-08', { id: 'e1', amount: 500, payerId: 'p1', description: 'bread' }, 20);
  const b = putExpense('2026-08', { id: 'e2', amount: 900, payerId: 'p1', description: 'milk' }, 21);

  // Each side applies its own, then receives the other's.
  applyOp(mine, a);
  applyOp(theirs, b);
  applyOp(mine, b);
  applyOp(theirs, a);

  assert.equal(mine.months['2026-08'].expenses.length, 2);
  assert.deepEqual(
    mine.months['2026-08'].expenses.map((e) => e.id).sort(),
    theirs.months['2026-08'].expenses.map((e) => e.id).sort()
  );
});

test('an expense that moves months leaves no ghost behind', () => {
  const state = blank();
  applyOp(state, putPerson({ id: 'p1', name: 'Ana' }, 1));
  applyOp(state, putExpense('2026-07', { id: 'e1', amount: 100, payerId: 'p1' }, 2));
  applyOp(state, putExpense('2026-08', { id: 'e1', amount: 100, payerId: 'p1' }, 3));

  assert.deepEqual(state.months['2026-07'].expenses, []);
  assert.equal(state.months['2026-08'].expenses.length, 1);
});

test('a delete finds the expense whichever month it is in', () => {
  const state = blank();
  applyOp(state, putPerson({ id: 'p1', name: 'Ana' }, 1));
  applyOp(state, putExpense('2026-03', { id: 'e1', amount: 100, payerId: 'p1' }, 2));

  assert.equal(applyOp(state, delExpense('e1', 3)), true);
  assert.equal(state.months['2026-03'].expenses.length, 0);
  assert.equal(applyOp(state, delExpense('e1', 4)), false, 'deleting twice is not a change');
});

test('removing a person does not silently take their expenses with it', () => {
  const state = blank();
  applyOp(state, putPerson({ id: 'p1', name: 'Ana' }, 1));
  applyOp(state, putExpense('2026-08', { id: 'e1', amount: 100, payerId: 'p1' }, 2));
  applyOp(state, delPerson('p1', 3));

  assert.deepEqual(state.people, []);
  assert.equal(
    state.months['2026-08'].expenses.length,
    1,
    'the store sends explicit expense ops alongside; the op itself only removes the person'
  );
});

test('a state survives the round trip through ops', () => {
  const store = createStore(fakeStorage());
  store.addPerson('Ana');
  store.addPerson('Bogdan');
  const [ana] = store.getPeople();
  // The store opens on the current month, so pin it or the test breaks in September.
  store.goToMonth('2026-08');
  store.addExpense({ amount: 4500, payerId: ana.id, description: 'rent', date: '2026-08-01' });
  store.goToMonth('2026-07');
  store.addExpense({ amount: 1200, payerId: ana.id, description: 'gas', date: '2026-07-12' });

  const rebuilt = blank();
  applyOps(rebuilt, stateToOps(store.getState()));

  assert.equal(rebuilt.people.length, 2);
  assert.equal(rebuilt.months['2026-08'].expenses[0].description, 'rent');
  assert.equal(rebuilt.months['2026-07'].expenses[0].amount, 1200);
});

test('a snapshot replaces the shared half and leaves the private half alone', () => {
  const state = blank();
  state.theme = 'dark';
  state.currentMonthId = '2026-05';
  state.settlementOpen = true;
  applyOp(state, putPerson({ id: 'old', name: 'Gone' }, 1));

  applySnapshot(state, {
    people: [{ id: 'p2', name: 'Ioana' }],
    expenses: [{ id: 'e9', month: '2026-08', amount: 700, payerId: 'p2', description: '', date: '' }],
  });

  assert.deepEqual(state.people, [{ id: 'p2', name: 'Ioana' }]);
  assert.equal(state.months['2026-08'].expenses.length, 1);
  assert.equal(state.theme, 'dark');
  assert.equal(state.currentMonthId, '2026-05');
  assert.equal(state.settlementOpen, true);
});

test('junk arriving over the socket is refused, not applied', () => {
  assert.equal(normalizeOp(null), null);
  assert.equal(normalizeOp({ kind: 'nope', type: 'put' }), null);
  assert.equal(normalizeOp({ kind: 'expense', type: 'put', record: { id: 'e', amount: -5 } }), null);
  assert.equal(normalizeOp({ kind: 'person', type: 'put', record: { id: 'p', name: '   ' } }), null);
  assert.equal(normalizeOp({ kind: 'expense', type: 'del', id: '' }), null);

  const ok = normalizeOp({
    kind: 'expense',
    type: 'put',
    at: 5,
    record: { id: 'e', month: '2026-08', amount: 100, payerId: 'p', description: 'x'.repeat(500) },
  });
  assert.equal(ok.record.description.length, LIMITS.descriptionChars, 'long text is cut, not refused');
});

test('a batch bigger than the limit is refused whole', () => {
  const many = Array.from({ length: LIMITS.batchOps + 1 }, (_, i) =>
    putPerson({ id: 'p' + i, name: 'P' + i }, 1)
  );
  assert.equal(normalizeOps(many), null);
  assert.equal(chunkOps(many).length, 2, 'so the client chunks before sending');
  assert.equal(normalizeOps(chunkOps(many)[0]).length, LIMITS.batchOps);
});

test('the server validates a sealed op without being able to read it', () => {
  const good = { kind: 'expense', type: 'put', at: 7, id: 'e1', blob: 'c2VhbGVk' };
  assert.deepEqual(normalizeSealedOp(good), good);

  assert.equal(normalizeSealedOp({ ...good, blob: '' }), null);
  assert.equal(normalizeSealedOp({ ...good, at: 'soon' }), null);
  assert.equal(normalizeSealedOp({ ...good, id: '' }), null);
  assert.equal(
    normalizeSealedOp({ ...good, blob: 'x'.repeat(LIMITS.recordBytes + 1) }),
    null,
    'one record cannot be worth a whole room'
  );

  const del = { kind: 'person', type: 'del', at: 7, id: 'p1' };
  assert.deepEqual(normalizeSealedOp(del), del);
  assert.equal(normalizeSealedOps([good, null, del]).length, 2);
});
