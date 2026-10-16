// Every change to shared data is one op against one record. That is the
// whole reason sharing works: two people adding expenses at the same
// moment touch different records and neither write can swallow the other.
//
// Ops are absolute, never deltas. A put carries the finished record, so
// applying the same op twice, or applying your own op again when the
// server echoes it back, changes nothing. Delivery only has to be
// at-least-once, which is the easy kind to build.
//
// Imported by the browser and by the Worker. No DOM, no Worker APIs.

import { LIMITS, isId, normalizeExpense, normalizePerson } from './records.js';

export const KINDS = ['person', 'expense'];
export const TYPES = ['put', 'del'];

export function putPerson(person, at = Date.now()) {
  return { kind: 'person', type: 'put', at, record: { id: person.id, name: person.name } };
}

export function delPerson(id, at = Date.now()) {
  return { kind: 'person', type: 'del', at, id };
}

export function putExpense(month, expense, at = Date.now()) {
  return {
    kind: 'expense',
    type: 'put',
    at,
    record: {
      id: expense.id,
      month,
      amount: expense.amount,
      payerId: expense.payerId,
      description: expense.description || '',
      date: expense.date || '',
    },
  };
}

export function delExpense(id, at = Date.now()) {
  return { kind: 'expense', type: 'del', at, id };
}

/**
 * Anything arriving over the socket goes through here first, in both
 * directions. Returns a clean op or null; there is no half-valid op.
 */
export function normalizeOp(raw) {
  if (!raw || !KINDS.includes(raw.kind) || !TYPES.includes(raw.type)) return null;
  const at = Number.isFinite(raw.at) ? raw.at : Date.now();

  if (raw.type === 'del') {
    return isId(raw.id) ? { kind: raw.kind, type: 'del', at, id: raw.id } : null;
  }

  const record =
    raw.kind === 'person' ? normalizePerson(raw.record) : normalizeExpense(raw.record);
  return record ? { kind: raw.kind, type: 'put', at, record } : null;
}

export function normalizeOps(list) {
  if (!Array.isArray(list) || list.length > LIMITS.batchOps) return null;
  const ops = [];
  for (const raw of list) {
    const op = normalizeOp(raw);
    if (op) ops.push(op);
  }
  return ops;
}

/** The id an op is about, whichever form it takes. */
export function opId(op) {
  return op.type === 'del' ? op.id : op.record.id;
}

// ------------------------------------------------------- ops on the wire

// What actually crosses the network is a sealed op: the record is one
// opaque blob the server cannot read. Only the parts the server has to act
// on are left in the clear, and each of them is deliberate.
//
//   kind  which shelf to file it on, and whether a room has 3 people or
//         300, which the record count would give away anyway
//   id    a random uuid, meaningful to nobody
//   at    the timestamp that decides which of two conflicting writes wins,
//         which the server has to compare and so cannot be sealed
//
// Everything a person typed, the amounts, names, dates, descriptions, and
// even which month an expense belongs to, is inside the blob.

/** Server-side validation. Pure: the Worker imports this and no crypto. */
export function normalizeSealedOp(raw) {
  if (!raw || !KINDS.includes(raw.kind) || !TYPES.includes(raw.type)) return null;
  if (!isId(raw.id) || !Number.isFinite(raw.at)) return null;

  if (raw.type === 'del') return { kind: raw.kind, type: 'del', at: raw.at, id: raw.id };
  if (typeof raw.blob !== 'string' || raw.blob.length === 0) return null;
  if (raw.blob.length > LIMITS.recordBytes) return null;
  return { kind: raw.kind, type: 'put', at: raw.at, id: raw.id, blob: raw.blob };
}

export function normalizeSealedOps(list) {
  if (!Array.isArray(list) || list.length > LIMITS.batchOps) return null;
  const ops = [];
  for (const raw of list) {
    const op = normalizeSealedOp(raw);
    if (op) ops.push(op);
  }
  return ops;
}

/** What a sealed record costs a room, key included. */
export function sealedBytes(kind, id, blob) {
  return 2 + id.length + (blob ? blob.length : 0);
}

// ------------------------------------------------------------ applying ops

function monthOf(state, id) {
  if (!state.months[id]) state.months[id] = { id, expenses: [] };
  return state.months[id];
}

/**
 * Fold one op into a state object, in place.
 *
 * @returns {boolean} whether anything actually changed, so a batch of
 *   echoes the client already applied optimistically does not repaint.
 */
export function applyOp(state, op) {
  if (op.kind === 'person') return op.type === 'put' ? putPersonIn(state, op) : delPersonIn(state, op);
  return op.type === 'put' ? putExpenseIn(state, op) : delExpenseIn(state, op);
}

export function applyOps(state, ops) {
  let changed = false;
  for (const op of ops) changed = applyOp(state, op) || changed;
  return changed;
}

function putPersonIn(state, op) {
  const existing = state.people.find((p) => p.id === op.record.id);
  if (existing) {
    if (existing.name === op.record.name) return false;
    existing.name = op.record.name;
    return true;
  }
  // A name clash from the other side is not an error here. The server
  // took the write; refusing to show it would only hide what is there.
  state.people.push({ id: op.record.id, name: op.record.name });
  return true;
}

function delPersonIn(state, op) {
  const before = state.people.length;
  state.people = state.people.filter((p) => p.id !== op.id);
  return state.people.length !== before;
}

function putExpenseIn(state, op) {
  const { id, month } = op.record;
  const value = {
    id,
    amount: op.record.amount,
    payerId: op.record.payerId,
    description: op.record.description,
    date: op.record.date,
  };

  let changed = false;
  // An expense that moved months has to leave the old one behind, or the
  // month it moved out of keeps a ghost copy.
  for (const other of Object.values(state.months)) {
    if (other.id === month) continue;
    const before = other.expenses.length;
    other.expenses = other.expenses.filter((e) => e.id !== id);
    if (other.expenses.length !== before) changed = true;
  }

  const target = monthOf(state, month);
  const at = target.expenses.findIndex((e) => e.id === id);
  if (at === -1) {
    target.expenses.push(value);
    return true;
  }
  if (same(target.expenses[at], value)) return changed;
  target.expenses[at] = value;
  return true;
}

function delExpenseIn(state, op) {
  let changed = false;
  for (const month of Object.values(state.months)) {
    const before = month.expenses.length;
    month.expenses = month.expenses.filter((e) => e.id !== op.id);
    if (month.expenses.length !== before) changed = true;
  }
  return changed;
}

function same(a, b) {
  return (
    a.amount === b.amount &&
    a.payerId === b.payerId &&
    a.description === b.description &&
    a.date === b.date
  );
}

// ------------------------------------------------- states, rooms, snapshots

/**
 * Every record in a state as the ops that would recreate it. This is what
 * "move my data into the room" sends, and what the server would need to
 * rebuild a room from a backup.
 */
export function stateToOps(state, at = Date.now()) {
  const ops = state.people.map((person) => putPerson(person, at));
  for (const month of Object.values(state.months)) {
    for (const expense of month.expenses) ops.push(putExpense(month.id, expense, at));
  }
  return ops;
}

/** Chunk a long op list into messages the server will accept. */
export function chunkOps(ops, size = LIMITS.batchOps) {
  const out = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}

/**
 * Rebuild the shared half of a state from a room snapshot, leaving the
 * private half (theme, which month is open, whether the panel is folded)
 * exactly as it was. Those are this device's business, not the room's.
 */
export function applySnapshot(state, snapshot) {
  state.people = [];
  state.months = {};
  const people = Array.isArray(snapshot && snapshot.people) ? snapshot.people : [];
  const expenses = Array.isArray(snapshot && snapshot.expenses) ? snapshot.expenses : [];

  for (const raw of people) {
    const person = normalizePerson(raw);
    if (person) state.people.push(person);
  }
  for (const raw of expenses) {
    const expense = normalizeExpense(raw);
    if (expense) applyOp(state, { kind: 'expense', type: 'put', at: 0, record: expense });
  }
  return state;
}
