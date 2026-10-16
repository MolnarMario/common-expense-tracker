import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitEvenly,
  minimizeTransfers,
  computeSettlement,
  balanceBar,
} from '../src/settlement.js';

const RON = (major) => Math.round(major * 100);

function people(...names) {
  return names.map((name) => ({ id: name.toLowerCase(), name }));
}

function expense(payerId, major) {
  return { id: payerId + '-' + major, payerId, amount: RON(major), description: '', date: '' };
}

function transfersAsText(result) {
  const nameById = new Map(result.people.map((p) => [p.id, p.name]));
  return result.transfers.map(
    (t) => nameById.get(t.fromId) + '->' + nameById.get(t.toId) + ':' + t.amount
  );
}

test('splitEvenly always sums back to the total', () => {
  for (const total of [0, 1, 2, 99, 100, 10000, 33333, 500000]) {
    for (const n of [1, 2, 3, 4, 7, 11]) {
      const shares = splitEvenly(total, n);
      assert.equal(shares.length, n);
      assert.equal(
        shares.reduce((a, b) => a + b, 0),
        total,
        `total ${total} across ${n}`
      );
      const spread = Math.max(...shares) - Math.min(...shares);
      assert.ok(spread <= 1, 'shares differ by at most one minor unit');
    }
  }
});

test('splitEvenly with no people returns nothing', () => {
  assert.deepEqual(splitEvenly(1000, 0), []);
});

test('minimizeTransfers never emits more than people minus one', () => {
  const balances = [
    { id: 'a', net: 500 },
    { id: 'b', net: -200 },
    { id: 'c', net: -100 },
    { id: 'd', net: -200 },
  ];
  const transfers = minimizeTransfers(balances);
  assert.ok(transfers.length <= balances.length - 1);
  assert.equal(
    transfers.reduce((sum, t) => sum + t.amount, 0),
    500
  );
});

test('PRD 12.1 — two people, A pays 200 and B pays 300, A owes B 50', () => {
  const result = computeSettlement({
    people: people('A', 'B'),
    expenses: [expense('a', 100), expense('a', 100), expense('b', 100), expense('b', 100), expense('b', 100)],
  });

  assert.equal(result.total, RON(500));
  assert.deepEqual(
    result.people.map((p) => [p.name, p.paid, p.share, p.net]),
    [
      ['A', RON(200), RON(250), RON(-50)],
      ['B', RON(300), RON(250), RON(50)],
    ]
  );
  assert.deepEqual(transfersAsText(result), ['A->B:' + RON(50)]);
});

test('PRD 12.2 — equal payments need no transfer', () => {
  const result = computeSettlement({
    people: people('A', 'B'),
    expenses: [expense('a', 100), expense('b', 100)],
  });
  assert.deepEqual(result.transfers, []);
  assert.ok(result.people.every((p) => p.net === 0));
});

test('PRD 12.3 — three people, only A pays 300', () => {
  const result = computeSettlement({
    people: people('A', 'B', 'C'),
    expenses: [expense('a', 300)],
  });
  assert.deepEqual(transfersAsText(result).sort(), ['B->A:' + RON(100), 'C->A:' + RON(100)]);
});

test('PRD 12.4 — three people, A pays 200, B pays 100, C pays nothing', () => {
  const result = computeSettlement({
    people: people('A', 'B', 'C'),
    expenses: [expense('a', 200), expense('b', 100)],
  });
  assert.deepEqual(
    result.people.map((p) => [p.name, p.net]),
    [
      ['A', RON(100)],
      ['B', 0],
      ['C', RON(-100)],
    ]
  );
  assert.deepEqual(transfersAsText(result), ['C->A:' + RON(100)]);
});

test('PRD 12.5 — no expenses means zero total and everyone settled', () => {
  const result = computeSettlement({ people: people('A', 'B', 'C'), expenses: [] });
  assert.equal(result.total, 0);
  assert.deepEqual(result.transfers, []);
  assert.ok(result.people.every((p) => p.paid === 0 && p.share === 0 && p.net === 0));
});

test('a single person owes nothing because they carry the whole month', () => {
  const result = computeSettlement({ people: people('Solo'), expenses: [expense('solo', 123.45)] });
  assert.equal(result.people[0].net, 0);
  assert.deepEqual(result.transfers, []);
});

test('zero people produces no settlement rows', () => {
  const result = computeSettlement({ people: [], expenses: [] });
  assert.deepEqual(result.people, []);
  assert.deepEqual(result.transfers, []);
});

test('an amount that will not divide evenly still reconciles to the cent', () => {
  // 10,00 across 3 people is 3,34 / 3,33 / 3,33.
  const result = computeSettlement({
    people: people('A', 'B', 'C'),
    expenses: [expense('a', 10)],
  });
  assert.equal(
    result.people.reduce((sum, p) => sum + p.share, 0),
    RON(10)
  );
  assert.equal(
    result.people.reduce((sum, p) => sum + p.net, 0),
    0
  );
  assert.equal(
    result.transfers.reduce((sum, t) => sum + t.amount, 0),
    result.people.filter((p) => p.net > 0).reduce((sum, p) => sum + p.net, 0)
  );
});

test('transfers always clear every balance exactly', () => {
  const cases = [
    [12.34, 0, 99.99, 4.5],
    [1000, 1000.01, 0, 0, 0.01],
    [7.77, 3.33, 0.02],
    [0.01, 0, 0],
  ];

  for (const payments of cases) {
    const names = payments.map((_, i) => 'P' + i);
    const month = {
      people: people(...names),
      expenses: payments
        .map((amount, i) => (amount > 0 ? expense('p' + i, amount) : null))
        .filter(Boolean),
    };
    const result = computeSettlement(month);

    const after = new Map(result.people.map((p) => [p.id, p.net]));
    for (const t of result.transfers) {
      after.set(t.fromId, after.get(t.fromId) + t.amount);
      after.set(t.toId, after.get(t.toId) - t.amount);
    }
    for (const [id, net] of after) {
      assert.equal(net, 0, `${id} is not settled for ${JSON.stringify(payments)}`);
    }
    assert.ok(result.transfers.length <= result.people.length - 1);
  }
});

test('a big month stays exact, no floating-point drift', () => {
  const names = Array.from({ length: 9 }, (_, i) => 'Person' + i);
  const expenses = Array.from({ length: 500 }, (_, i) => ({
    id: 'e' + i,
    payerId: names[i % names.length].toLowerCase(),
    amount: 1 + ((i * 37) % 9999),
    description: '',
    date: '',
  }));
  const result = computeSettlement({ people: people(...names), expenses });

  assert.equal(
    result.people.reduce((sum, p) => sum + p.paid, 0),
    result.total
  );
  assert.equal(
    result.people.reduce((sum, p) => sum + p.share, 0),
    result.total
  );
  assert.equal(
    result.people.reduce((sum, p) => sum + p.net, 0),
    0
  );
});

// ------------------------------------------------------------- balance bar

test('balanceBar puts the fair-share tick at the midpoint for two people', () => {
  const result = computeSettlement({
    people: people('Ana', 'Bogdan'),
    expenses: [expense('ana', 120), expense('bogdan', 80)],
  });
  const bar = balanceBar(result);

  assert.deepEqual(
    bar.segments.map((s) => s.name),
    ['Ana', 'Bogdan']
  );
  assert.equal(bar.segments[0].start, 0);
  assert.equal(bar.segments[0].width, 0.6);
  assert.equal(bar.segments[1].start, 0.6);
  assert.equal(bar.segments[1].width, 0.4);

  assert.equal(bar.ticks.length, 1);
  assert.equal(bar.ticks[0].at, 0.5);
  assert.equal(bar.ticks[0].isCrossing, true);

  // The colour boundary sits 10% right of the fair line, and 10% of a
  // 200 RON month is the 20 RON Bogdan owes Ana.
  assert.equal(bar.crossing.at, 0.5);
  assert.equal(bar.crossing.boundary, 0.6);
  assert.equal(bar.crossing.amount, RON(20));
  assert.equal(bar.crossing.amount, result.transfers[0].amount);
});

test('balanceBar sorts overpayers to the left and keeps each person colour', () => {
  const result = computeSettlement({
    people: people('Ana', 'Bogdan', 'Carmen'),
    expenses: [expense('bogdan', 300), expense('carmen', 60)],
  });
  const bar = balanceBar(result);

  assert.deepEqual(
    bar.segments.map((s) => s.name),
    ['Bogdan', 'Carmen', 'Ana']
  );
  // Colour follows the person's place in the roster, not their rank here.
  assert.deepEqual(
    bar.segments.map((s) => s.colorIndex),
    [1, 2, 0]
  );
  assert.equal(bar.segments[2].width, 0, 'Ana paid nothing, so her slice is flat');
});

test('balanceBar gap equals the total money that has to move', () => {
  const result = computeSettlement({
    people: people('Ana', 'Bogdan', 'Carmen', 'Dan'),
    expenses: [expense('ana', 400), expense('bogdan', 200), expense('carmen', 200)],
  });
  const bar = balanceBar(result);
  const moving = result.transfers.reduce((sum, t) => sum + t.amount, 0);

  assert.equal(Math.round((bar.crossing.boundary - bar.crossing.at) * result.total), moving);
  assert.equal(bar.crossing.amount, moving);
  assert.equal(bar.ticks.filter((t) => t.isCrossing).length, 1);
});

test('balanceBar reports no crossing when everyone is even', () => {
  const result = computeSettlement({
    people: people('Ana', 'Bogdan'),
    expenses: [expense('ana', 50), expense('bogdan', 50)],
  });
  const bar = balanceBar(result);

  assert.equal(bar.crossing, null);
  assert.equal(bar.segments[0].width, 0.5);
  assert.equal(bar.ticks[0].at, 0.5);
  assert.equal(bar.ticks[0].isCrossing, false);
});

test('balanceBar is empty with no people or no spending', () => {
  assert.deepEqual(balanceBar({ total: 0, people: [], transfers: [] }).segments, []);
  const nothingSpent = computeSettlement({ people: people('Ana', 'Bogdan'), expenses: [] });
  assert.deepEqual(balanceBar(nothingSpent).segments, []);
  assert.equal(balanceBar(nothingSpent).crossing, null);
});

test('balanceBar ticks stay in order and inside the bar for odd splits', () => {
  const result = computeSettlement({
    people: people('Ana', 'Bogdan', 'Carmen'),
    expenses: [expense('ana', 10), expense('bogdan', 0.01)],
  });
  const bar = balanceBar(result);

  assert.equal(bar.ticks.length, 2);
  for (const tick of bar.ticks) {
    assert.ok(tick.at > 0 && tick.at < 1, 'tick ' + tick.at + ' is inside the bar');
  }
  assert.ok(bar.ticks[0].at < bar.ticks[1].at);
  assert.ok(bar.crossing.boundary > bar.crossing.at);
  const widths = bar.segments.reduce((sum, s) => sum + s.width, 0);
  assert.ok(Math.abs(widths - 1) < 1e-9, 'slices fill the bar');
});
