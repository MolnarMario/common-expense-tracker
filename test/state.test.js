import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/state.js';
import { currentMonthId, shiftMonth, monthLabel, parseMonthId, defaultDateFor } from '../src/months.js';

/** A storage double that behaves like localStorage without a browser. */
function fakeStorage(seed = null) {
  let raw = seed ? JSON.stringify(seed) : null;
  return {
    load: () => (raw ? JSON.parse(raw) : null),
    save: (state) => {
      raw = JSON.stringify(state);
      return true;
    },
    dump: () => (raw ? JSON.parse(raw) : null),
  };
}

const names = (store) => store.getPeople().map((p) => p.name);

test('a fresh store opens the current calendar month with nobody on it', () => {
  const store = createStore(fakeStorage());
  const month = store.getCurrentMonth();
  assert.equal(month.id, currentMonthId());
  assert.deepEqual(month.expenses, []);
  assert.deepEqual(store.getPeople(), [], 'no default people, ever');
});

test('people are added, renamed, and refused when duplicated', () => {
  const store = createStore(fakeStorage());
  const added = store.addPerson('Alex');
  assert.ok(added.ok);

  assert.equal(store.addPerson('  ').ok, false);
  assert.equal(store.addPerson('alex').ok, false, 'duplicate names are rejected case-insensitively');

  assert.ok(store.renamePerson(added.person.id, 'Alexandra').ok);
  assert.deepEqual(names(store), ['Alexandra']);
  assert.equal(store.renamePerson(added.person.id, '').ok, false);
  assert.equal(store.renamePerson('ghost', 'Nobody').ok, false);
});

test('the roster is global: every month shares it and no month seeds itself', () => {
  const store = createStore(fakeStorage());
  store.goToMonth('2026-01');
  const alex = store.addPerson('Alex').person;
  store.addExpense({ amount: 20000, payerId: alex.id });

  store.goToMonth('2026-02');
  assert.deepEqual(names(store), ['Alex'], 'the same list, not a copy');
  assert.deepEqual(store.getCurrentMonth().expenses, [], 'expenses stay in their month');

  // A rename is a rename everywhere, because there is only one Alex.
  store.renamePerson(alex.id, 'Alexandra');
  store.goToMonth('2026-01');
  assert.deepEqual(names(store), ['Alexandra']);
  assert.equal(store.getCurrentMonth().expenses[0].payerId, alex.id);
});

test('expenses require a positive amount and a real payer', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;

  assert.equal(store.addExpense({ amount: 0, payerId: alex.id }).ok, false);
  assert.equal(store.addExpense({ amount: -100, payerId: alex.id }).ok, false);
  assert.equal(store.addExpense({ amount: 12.5, payerId: alex.id }).ok, false, 'minor units only');
  assert.equal(store.addExpense({ amount: 1000, payerId: 'nobody' }).ok, false);

  assert.ok(store.addExpense({ amount: 1000, payerId: alex.id, description: ' milk ' }).ok);
  assert.equal(store.getCurrentMonth().expenses[0].description, 'milk');
});

test('an expense lands in the month that is open', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;

  store.goToMonth('2026-04');
  store.addExpense({ amount: 1000, payerId: alex.id });
  store.goToMonth('2026-05');
  store.addExpense({ amount: 2000, payerId: alex.id });

  assert.equal(store.getState().months['2026-04'].expenses.length, 1);
  assert.equal(store.getState().months['2026-05'].expenses[0].amount, 2000);
});

test('editing and deleting an expense', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;
  const maria = store.addPerson('Maria').person;
  const id = store.addExpense({ amount: 5000, payerId: alex.id }).expense.id;

  assert.ok(store.updateExpense(id, { amount: 7500, payerId: maria.id, description: 'dinner' }).ok);
  const updated = store.getCurrentMonth().expenses[0];
  assert.equal(updated.amount, 7500);
  assert.equal(updated.payerId, maria.id);
  assert.equal(updated.id, id, 'the id survives an edit');

  assert.equal(store.updateExpense('missing', { amount: 100, payerId: alex.id }).ok, false);
  assert.ok(store.deleteExpense(id).ok);
  assert.equal(store.deleteExpense(id).ok, false);
});

test('removing a person weighs up every month, not just the open one', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;
  store.addPerson('Maria');

  store.goToMonth('2026-01');
  store.addExpense({ amount: 5000, payerId: alex.id });
  store.goToMonth('2026-02');
  store.addExpense({ amount: 3000, payerId: alex.id });
  store.goToMonth('2026-03');

  const blocked = store.removePerson(alex.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needsDecision, true);
  assert.equal(blocked.expenseCount, 2);
  assert.equal(blocked.monthCount, 2);
  assert.deepEqual(names(store), ['Alex', 'Maria'], 'nothing changed yet');
});

test('reassigning moves the expenses in every month', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;
  const maria = store.addPerson('Maria').person;

  store.goToMonth('2026-01');
  store.addExpense({ amount: 5000, payerId: alex.id });
  store.goToMonth('2026-02');
  store.addExpense({ amount: 3000, payerId: alex.id });

  assert.ok(store.removePerson(alex.id, { mode: 'reassign', targetId: maria.id }).ok);
  assert.deepEqual(names(store), ['Maria']);
  const all = Object.values(store.getState().months).flatMap((m) => m.expenses);
  assert.ok(all.every((e) => e.payerId === maria.id));
  assert.equal(all.length, 2);
});

test('deleting instead drops those expenses everywhere', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;
  const maria = store.addPerson('Maria').person;

  store.goToMonth('2026-01');
  store.addExpense({ amount: 5000, payerId: alex.id });
  store.addExpense({ amount: 100, payerId: maria.id });
  store.goToMonth('2026-02');
  store.addExpense({ amount: 3000, payerId: alex.id });

  assert.ok(store.removePerson(alex.id, { mode: 'delete' }).ok);
  const all = Object.values(store.getState().months).flatMap((m) => m.expenses);
  assert.equal(all.length, 1);
  assert.equal(all[0].payerId, maria.id);
});

test('reassigning needs a real target', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;
  store.addExpense({ amount: 5000, payerId: alex.id });

  assert.equal(store.removePerson(alex.id, { mode: 'reassign', targetId: alex.id }).ok, false);
  assert.equal(store.removePerson(alex.id, { mode: 'reassign', targetId: 'ghost' }).ok, false);
  assert.deepEqual(names(store), ['Alex']);
});

test('a person with no expenses is removed straight away', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;
  assert.ok(store.removePerson(alex.id).ok);
  assert.deepEqual(store.getPeople(), []);
});

test('PRD 12.6 — January to February and back restores January exactly', () => {
  const store = createStore(fakeStorage());

  store.goToMonth('2026-01');
  const alex = store.addPerson('Alex').person;
  store.addExpense({ amount: 20000, payerId: alex.id, description: 'rent', date: '2026-01-05' });
  const januarySnapshot = JSON.stringify(store.getCurrentMonth());

  store.goToMonth('2026-02');
  store.addExpense({ amount: 900, payerId: alex.id });

  store.goToMonth('2026-01');
  assert.equal(JSON.stringify(store.getCurrentMonth()), januarySnapshot);
});

test('a month carries amounts and nothing else: there is no currency to switch', () => {
  const store = createStore(fakeStorage());
  const alex = store.addPerson('Alex').person;
  store.addExpense({ amount: 12345, payerId: alex.id });

  assert.equal(typeof store.setCurrency, 'undefined');
  assert.equal(store.getCurrentMonth().expenses[0].amount, 12345);
  assert.deepEqual(Object.keys(store.getCurrentMonth()).sort(), ['expenses', 'id']);
});

test('everything survives a reload through storage', () => {
  const storage = fakeStorage();
  const first = createStore(storage);
  first.goToMonth('2025-11');
  const alex = first.addPerson('Alex').person;
  first.addExpense({ amount: 9999, payerId: alex.id, description: 'gas', date: '2025-11-09' });

  const second = createStore(storage);
  const month = second.getCurrentMonth();
  assert.equal(month.id, '2025-11');
  assert.deepEqual(names(second), ['Alex']);
  assert.equal(month.expenses[0].amount, 9999);
});

test('version 1 data, with people inside each month, is merged into one roster', () => {
  const v1 = fakeStorage({
    version: 1,
    currentMonthId: '2026-02',
    months: {
      '2026-01': {
        currency: 'RON',
        people: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Maria' }],
        expenses: [{ id: 'e1', amount: 5000, payerId: 'p1' }],
      },
      '2026-02': {
        currency: 'EUR',
        people: [{ id: 'p1', name: 'Alex' }, { id: 'p3', name: 'Dan' }],
        expenses: [{ id: 'e2', amount: 2500, payerId: 'p3' }],
      },
    },
  });

  const store = createStore(v1);
  assert.deepEqual(names(store), ['Alex', 'Maria', 'Dan'], 'merged, deduplicated, order kept');
  assert.equal(store.getState().version, 3);
  assert.equal(store.getState().months['2026-01'].expenses.length, 1, 'expenses still resolve');
  assert.equal(store.getState().months['2026-02'].expenses[0].payerId, 'p3');
});

test('a currency stored by version 2 is dropped on load', () => {
  const v2 = fakeStorage({
    version: 2,
    currentMonthId: '2026-04',
    people: [{ id: 'p1', name: 'Alex' }],
    months: { '2026-04': { id: '2026-04', currency: 'EUR', expenses: [] } },
  });

  const store = createStore(v2);
  assert.equal('currency' in store.getCurrentMonth(), false);
});

test('corrupt or hostile stored data is dropped, not crashed on', () => {
  const junk = fakeStorage({
    people: [{ id: 'p1', name: 'Ok' }, { nope: true }, { id: 'p2', name: '   ' }],
    months: {
      'not-a-month': { expenses: [] },
      '2026-03': {
        currency: 'GBP',
        expenses: [
          { id: 'e1', amount: 100, payerId: 'p1' },
          { id: 'e2', amount: -5, payerId: 'p1' },
          { id: 'e3', amount: 100, payerId: 'ghost' },
          { id: 'e4', amount: 1.5, payerId: 'p1' },
        ],
      },
    },
    currentMonthId: '2026-03',
  });

  const store = createStore(junk);
  assert.deepEqual(Object.keys(store.getState().months), ['2026-03']);
  assert.deepEqual(names(store), ['Ok'], 'blank and malformed people are dropped');
  assert.deepEqual(store.getCurrentMonth().expenses.map((e) => e.id), ['e1']);
});

test('the theme switch has exactly two positions', () => {
  const storage = fakeStorage();
  const store = createStore(storage, { defaultTheme: 'dark' });
  assert.equal(store.getState().theme, 'dark', 'the caller supplies the first-run default');

  assert.ok(store.setTheme('light').ok);
  assert.equal(store.getState().theme, 'light');
  for (const rejected of ['system', 'auto', 'sepia', '', null]) {
    assert.equal(store.setTheme(rejected).ok, false, JSON.stringify(rejected));
  }
  assert.equal(store.getState().theme, 'light', 'a bad value changes nothing');
  assert.equal(createStore(storage).getState().theme, 'light', 'it survives a reload');
});

test('a store with no default asked for falls back to light', () => {
  assert.equal(createStore(fakeStorage()).getState().theme, 'light');
});

test('the settlement panel starts folded away and remembers being opened', () => {
  const storage = fakeStorage();
  const store = createStore(storage);
  assert.equal(store.getState().settlementOpen, false);

  store.setSettlementOpen(true);
  assert.equal(createStore(storage).getState().settlementOpen, true);

  store.setSettlementOpen(false);
  assert.equal(createStore(storage).getState().settlementOpen, false);
});

test('subscribers fire on every change', () => {
  const store = createStore(fakeStorage());
  let calls = 0;
  const off = store.subscribe(() => {
    calls += 1;
  });
  store.addPerson('Alex');
  store.addPerson('Dan');
  assert.equal(calls, 2);
  off();
  store.addPerson('Maria');
  assert.equal(calls, 2, 'unsubscribing stops the callbacks');
});

test('month arithmetic wraps years in both directions', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.equal(shiftMonth('2026-06', 12), '2027-06');
  assert.equal(shiftMonth('2026-06', -18), '2024-12');
});

test('month ids are validated and labelled', () => {
  assert.deepEqual(parseMonthId('2026-08'), { year: 2026, month: 8 });
  assert.equal(parseMonthId('2026-13'), null);
  assert.equal(parseMonthId('2026-8'), null);
  assert.equal(parseMonthId(''), null);
  assert.equal(monthLabel('2026-08'), 'August 2026');
});

test('a new expense defaults to today only inside the current month', () => {
  const now = new Date(2026, 7, 30);
  assert.equal(defaultDateFor('2026-08', now), '2026-08-30');
  assert.equal(defaultDateFor('2026-05', now), '2026-05-01');
});
