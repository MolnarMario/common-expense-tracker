import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exportableMonths,
  toJSON,
  toCSV,
  buildExport,
  parseImportFile,
  parseCsvRows,
  previewImport,
} from '../src/transfer.js';
import { createStore } from '../src/state.js';

/** A storage double that behaves like localStorage without a browser. */
function fakeStorage(seed = null) {
  let raw = seed ? JSON.stringify(seed) : null;
  return {
    load: () => (raw ? JSON.parse(raw) : null),
    save: (state) => {
      raw = JSON.stringify(state);
      return true;
    },
  };
}

/** Three months of data with a stable shape the assertions can lean on. */
function seeded() {
  return {
    version: 3,
    currentMonthId: '2026-08',
    theme: 'light',
    settlementOpen: false,
    people: [
      { id: 'p-ana', name: 'Ana' },
      { id: 'p-dan', name: 'Dan' },
      { id: 'p-idle', name: 'Sorin' },
    ],
    months: {
      '2026-06': {
        id: '2026-06',
        expenses: [
          { id: 'e1', amount: 10000, payerId: 'p-ana', description: 'June rent', date: '2026-06-02' },
        ],
      },
      '2026-07': {
        id: '2026-07',
        expenses: [
          { id: 'e2', amount: 4250, payerId: 'p-ana', description: 'groceries', date: '2026-07-03' },
          { id: 'e3', amount: 1999, payerId: 'p-dan', description: '', date: '2026-07-01' },
        ],
      },
      '2026-08': {
        id: '2026-08',
        expenses: [
          { id: 'e4', amount: 240092400, payerId: 'p-dan', description: 'car, "the good one"', date: '' },
        ],
      },
      '2026-09': { id: '2026-09', expenses: [] },
    },
  };
}

const state = () => createStore(fakeStorage(seeded())).getState();

// ------------------------------------------------------------------ export

test('only months holding expenses can be exported, oldest first', () => {
  assert.deepEqual(exportableMonths(state()), ['2026-06', '2026-07', '2026-08']);
});

test('exporting two months leaves the third out of the file', () => {
  const parsed = JSON.parse(toJSON(state(), ['2026-07', '2026-08']));
  assert.deepEqual(Object.keys(parsed.months).sort(), ['2026-07', '2026-08']);
  assert.equal(parsed.months['2026-07'].expenses.length, 2);
});

test('the whole roster travels, including someone who paid for nothing', () => {
  const parsed = JSON.parse(toJSON(state(), ['2026-07']));
  assert.deepEqual(parsed.people, ['Ana', 'Dan', 'Sorin']);
});

test('JSON names the payer instead of leaking an internal id', () => {
  const parsed = JSON.parse(toJSON(state(), ['2026-07']));
  const [first] = parsed.months['2026-07'].expenses;
  assert.equal(first.paidBy, 'Dan', 'sorted by date, so the 1st comes first');
  assert.equal(first.amount, 1999);
  assert.equal(first.payerId, undefined);
});

test('CSV writes lei with a dot and quotes anything holding a comma or quote', () => {
  const csv = toCSV(state(), ['2026-08']);
  const [header, row] = csv.trim().split('\r\n');
  assert.equal(header, 'month,date,description,paid_by,amount_ron');
  assert.equal(row, '2026-08,,"car, ""the good one""",Dan,2400924.00');
});

test('the filename says which months are inside', () => {
  const one = buildExport(state(), ['2026-07'], 'csv');
  assert.equal(one.filename, 'expenses-2026-07.csv');

  const many = buildExport(state(), ['2026-06', '2026-08'], 'json');
  assert.equal(many.filename, 'expenses-2026-06-to-2026-08.json');
});

test('exporting nothing is refused rather than writing an empty file', () => {
  assert.equal(buildExport(state(), [], 'json').ok, false);
  assert.equal(buildExport(state(), ['2026-09'], 'json').ok, false, 'empty month');
});

// ------------------------------------------------------------------ import

test('a JSON export reads back as the same amounts and payers', () => {
  const payload = parseImportFile(toJSON(state(), ['2026-07', '2026-08']));
  assert.equal(payload.ok, true);
  assert.deepEqual(Object.keys(payload.months).sort(), ['2026-07', '2026-08']);
  assert.deepEqual(payload.months['2026-08'], [
    { amount: 240092400, paidBy: 'Dan', date: '', description: 'car, "the good one"' },
  ]);
  assert.deepEqual(payload.people, ['Ana', 'Dan', 'Sorin']);
});

test('a CSV export reads back as the same amounts and payers', () => {
  const payload = parseImportFile(toCSV(state(), ['2026-07', '2026-08']));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.months['2026-08'], [
    { amount: 240092400, paidBy: 'Dan', date: '', description: 'car, "the good one"' },
  ]);
  assert.deepEqual(
    payload.months['2026-07'].map((e) => e.amount),
    [1999, 4250]
  );
});

test('a raw copy of what the app saves to localStorage imports too', () => {
  const payload = parseImportFile(JSON.stringify(seeded()));
  assert.equal(payload.ok, true);
  assert.equal(payload.months['2026-06'][0].paidBy, 'Ana', 'payerId resolved through the roster');
});

test('CSV rows survive quotes, embedded newlines, and doubled quotes', () => {
  const rows = parseCsvRows('a,b\r\n"x,1","line\nbreak"\r\n"say ""hi""",z\r\n', ',');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,1', 'line\nbreak'],
    ['say "hi"', 'z'],
  ]);
});

test('a semicolon file with Romanian decimals and reordered columns still reads', () => {
  const payload = parseImportFile(
    'Suma;Platit de;Data;Descriere\r\n1.234,56;Ana;2026-07-04;chirie\r\n'
  );
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.months['2026-07'], [
    { amount: 123456, paidBy: 'Ana', date: '2026-07-04', description: 'chirie' },
  ]);
});

test('a CSV with no month column takes the month from the date', () => {
  const payload = parseImportFile('date,paid_by,amount\n2026-05-09,Ana,12.50\n');
  assert.equal(payload.ok, true);
  assert.deepEqual(Object.keys(payload.months), ['2026-05']);
  assert.equal(payload.months['2026-05'][0].amount, 1250);
});

test('unreadable rows are counted and skipped, not silently dropped', () => {
  const payload = parseImportFile(
    'month,paid_by,amount\n2026-07,Ana,10\nnot-a-month,Ana,10\n2026-07,,10\n2026-07,Dan,abc\n'
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.months['2026-07'].length, 1);
  assert.equal(payload.skipped.length, 3);
});

test('junk in, a message out, never a half import', () => {
  assert.equal(parseImportFile('').ok, false);
  assert.equal(parseImportFile('{ oh dear').ok, false);
  assert.equal(parseImportFile('{"hello":"world"}').ok, false);
  assert.equal(parseImportFile('one,two\n1,2\n').ok, false, 'no amount or payer column');
});

// ----------------------------------------------------------------- merging

test('the preview says what is replaced, what is new, and what is left alone', () => {
  const store = createStore(fakeStorage(seeded()));
  const payload = parseImportFile(
    'month,paid_by,amount,description\n2026-07,Ana,10\n2026-10,Ioana,25\n'
  );
  const preview = previewImport(store.getState(), payload);

  assert.deepEqual(
    preview.months.map((m) => [m.id, m.incoming, m.existing]),
    [
      ['2026-07', 1, 2],
      ['2026-10', 1, 0],
    ]
  );
  assert.equal(preview.replacing, 1);
  assert.deepEqual(preview.newPeople, ['Ioana']);
  assert.deepEqual(preview.untouched, ['2026-06', '2026-08']);
});

test('importing July and August does not touch June', () => {
  const store = createStore(fakeStorage(seeded()));
  const before = store.getState().months['2026-06'].expenses.map((e) => e.id);

  const payload = parseImportFile(
    'month,paid_by,amount\n2026-07,Ana,10\n2026-08,Ana,20\n2026-08,Dan,30\n'
  );
  const result = store.importMonths(payload);

  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, months: 2, expenses: 3 });
  assert.deepEqual(
    store.getState().months['2026-06'].expenses.map((e) => e.id),
    before,
    'June is untouched, ids and all'
  );
  assert.equal(store.getState().months['2026-07'].expenses.length, 1, 'July replaced, not merged');
  assert.equal(store.getState().months['2026-08'].expenses.length, 2);
});

test('a name already on the list is reused instead of duplicated', () => {
  const store = createStore(fakeStorage(seeded()));
  store.importMonths(parseImportFile('month,paid_by,amount\n2026-11,ANA,10\n2026-11,Ioana,5\n'));

  assert.deepEqual(
    store.getPeople().map((p) => p.name),
    ['Ana', 'Dan', 'Sorin', 'Ioana']
  );
  const ana = store.getPeople().find((p) => p.name === 'Ana');
  assert.equal(store.getState().months['2026-11'].expenses[0].payerId, ana.id);
});

test('importing lands you on a month you can actually see', () => {
  const store = createStore(fakeStorage(seeded()));
  assert.equal(store.getState().currentMonthId, '2026-08');
  store.importMonths(parseImportFile('month,paid_by,amount\n2026-01,Ana,10\n2026-02,Ana,10\n'));
  assert.equal(store.getState().currentMonthId, '2026-02', 'newest month in the file');
});

test('the month on screen is kept when the file also covers it', () => {
  const store = createStore(fakeStorage(seeded()));
  store.importMonths(parseImportFile('month,paid_by,amount\n2026-08,Ana,10\n2026-12,Ana,10\n'));
  assert.equal(store.getState().currentMonthId, '2026-08');
});

test('a full round trip through JSON reproduces every amount', () => {
  const original = createStore(fakeStorage(seeded()));
  const file = toJSON(original.getState(), ['2026-06', '2026-07', '2026-08']);

  const fresh = createStore(fakeStorage());
  fresh.importMonths(parseImportFile(file));

  const totals = (store) =>
    Object.values(store.getState().months)
      .filter((m) => m.expenses.length)
      .map((m) => [m.id, m.expenses.reduce((sum, e) => sum + e.amount, 0)])
      .sort();

  assert.deepEqual(totals(fresh), totals(original));
  assert.deepEqual(
    fresh.getPeople().map((p) => p.name),
    ['Ana', 'Dan', 'Sorin']
  );
});

test('a file the store cannot use is refused before anything changes', () => {
  const store = createStore(fakeStorage(seeded()));
  assert.equal(store.importMonths(null).ok, false);
  assert.equal(store.importMonths({ months: {} }).ok, false);
  assert.equal(store.importMonths({ months: { nope: [] } }).ok, false);
  assert.equal(store.getState().months['2026-07'].expenses.length, 2);
});
