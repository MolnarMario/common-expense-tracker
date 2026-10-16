import { createStorage } from './storage.js';
import { currentMonthId, parseMonthId } from './months.js';
import {
  applyOps,
  applySnapshot,
  delExpense,
  delPerson,
  putExpense,
  putPerson,
  stateToOps,
} from './ops.js';
import { LIMITS } from './records.js';

/** The switch has two positions and nothing else. */
export const THEMES = ['light', 'dark'];

export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

function emptyMonth(id) {
  return { id, expenses: [] };
}

function cleanPeople(raw) {
  const people = [];
  const seenIds = new Set();
  const seenNames = new Set();

  for (const person of Array.isArray(raw) ? raw : []) {
    if (!person || typeof person.id !== 'string' || typeof person.name !== 'string') continue;
    const name = person.name.trim();
    const key = name.toLowerCase();
    if (!name || seenIds.has(person.id) || seenNames.has(key)) continue;
    seenIds.add(person.id);
    seenNames.add(key);
    people.push({ id: person.id, name });
  }
  return people;
}

/**
 * Drop anything that does not look like our data instead of trusting the
 * blob. Version 1 kept a separate list of people inside every month; those
 * lists are merged into the one roster here. Version 2 kept a per-month
 * currency; the app is RON only now, so that key is dropped on load.
 */
function sanitize(raw, defaultTheme) {
  const carriedOver = [];
  const rawMonths = raw && typeof raw.months === 'object' && raw.months ? raw.months : {};
  for (const month of Object.values(rawMonths)) {
    if (month && Array.isArray(month.people)) carriedOver.push(...month.people);
  }
  const people = cleanPeople([...(Array.isArray(raw?.people) ? raw.people : []), ...carriedOver]);
  const known = new Set(people.map((p) => p.id));

  const months = {};
  for (const [id, month] of Object.entries(rawMonths)) {
    if (!parseMonthId(id) || !month || typeof month !== 'object') continue;

    const expenses = Array.isArray(month.expenses)
      ? month.expenses
          .filter(
            (e) =>
              e &&
              typeof e.id === 'string' &&
              Number.isInteger(e.amount) &&
              e.amount > 0 &&
              known.has(e.payerId)
          )
          .map((e) => ({
            id: e.id,
            amount: e.amount,
            payerId: e.payerId,
            description: typeof e.description === 'string' ? e.description : '',
            date: typeof e.date === 'string' ? e.date : '',
          }))
      : [];

    months[id] = { id, expenses };
  }

  const current =
    raw && parseMonthId(raw.currentMonthId) ? raw.currentMonthId : currentMonthId();
  const theme = raw && THEMES.includes(raw.theme) ? raw.theme : defaultTheme;
  // Folded away by default: the settlement is an end-of-month question,
  // not something to stare at every time you log a coffee.
  const settlementOpen = raw ? raw.settlementOpen === true : false;
  return { version: 3, currentMonthId: current, theme, settlementOpen, people, months };
}

/**
 * @param {{load: Function, save: Function}} storage
 * @param {{defaultTheme?: 'light'|'dark', onOps?: (ops: object[]) => void}} options
 *   defaultTheme is what a first-time visitor gets; the caller reads it
 *   off the operating system so this file stays free of browser APIs.
 *
 *   onOps receives the ops behind every local change to shared data, which
 *   is what the sync layer puts on the wire. Nothing calls it for the
 *   private preferences: your theme is not the room's business.
 */
export function createStore(storage = createStorage(), options = {}) {
  const defaultTheme = THEMES.includes(options.defaultTheme) ? options.defaultTheme : 'light';
  const emit = typeof options.onOps === 'function' ? options.onOps : () => {};

  let backend = storage;
  let state = sanitize(backend.load(), defaultTheme);

  const listeners = new Set();

  function ensureCurrentMonth() {
    if (!state.months[state.currentMonthId]) {
      state.months[state.currentMonthId] = emptyMonth(state.currentMonthId);
    }
  }

  ensureCurrentMonth();

  function notify() {
    for (const fn of listeners) fn(state);
  }

  /** @param {object[]} [ops] the shared changes this commit represents. */
  function commit(ops) {
    backend.save(state);
    if (ops && ops.length > 0) emit(ops);
    notify();
  }

  /**
   * Read-write handle on one month, created on demand and always empty:
   * nobody gets people or expenses they did not enter.
   */
  function monthOf(id) {
    if (!state.months[id]) state.months[id] = emptyMonth(id);
    return state.months[id];
  }

  function everyExpense() {
    return Object.values(state.months).flatMap((m) => m.expenses);
  }

  function monthIdOf(expenseId) {
    for (const month of Object.values(state.months)) {
      if (month.expenses.some((e) => e.id === expenseId)) return month.id;
    }
    return null;
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    getState: () => state,
    getCurrentMonth: () => monthOf(state.currentMonthId),

    /** One roster shared by every month. */
    getPeople: () => state.people,

    // --------------------------------------------------------- sync inbound

    /**
     * Ops the server accepted, from this device or the other one. They are
     * already resolved, so they land as they are and never come back out
     * through onOps.
     */
    applyRemoteOps(ops) {
      const changed = applyOps(state, ops);
      ensureCurrentMonth();
      backend.save(state);
      if (changed) notify();
      return changed;
    },

    /**
     * A whole room, as sent on connect. Replaces the shared half and keeps
     * this device's private half untouched.
     */
    applyRoomSnapshot(snapshot) {
      applySnapshot(state, snapshot);
      ensureCurrentMonth();
      backend.save(state);
      notify();
      return { ok: true };
    },

    /** Everything here, as the ops that would recreate it in a room. */
    toOps() {
      return stateToOps(state);
    },

    /**
     * Ops that came from this device but not from one of the methods
     * below: moving your own months into a room is the only case. They
     * apply here and go out on the wire, unlike remote ops, which only
     * apply.
     */
    ingestOps(ops) {
      applyOps(state, ops);
      ensureCurrentMonth();
      commit(ops);
      return { ok: true, ops: ops.length };
    },

    /**
     * Point the store at different storage, for moving between this
     * device's own data and a room. The theme follows you across, because
     * it belongs to the screen you are looking at.
     */
    rebind(nextStorage) {
      backend = nextStorage;
      state = sanitize(backend.load(), state.theme);
      ensureCurrentMonth();
      notify();
    },

    // ----------------------------------------------- private to this device

    setTheme(theme) {
      if (!THEMES.includes(theme)) return { ok: false, error: 'Unknown theme.' };
      state.theme = theme;
      commit();
      return { ok: true };
    },

    setSettlementOpen(open) {
      state.settlementOpen = open === true;
      commit();
      return { ok: true };
    },

    goToMonth(id) {
      if (!parseMonthId(id)) return { ok: false, error: 'That is not a valid month.' };
      // Switching never rewrites the month we are leaving: every month is
      // its own object under its own key.
      monthOf(id);
      state.currentMonthId = id;
      commit();
      return { ok: true };
    },

    // ------------------------------------------------------ shared changes

    /**
     * Merge a parsed file in. Only the months named in the payload are
     * touched, and each of those is replaced wholesale: a file holding
     * July and August cannot disturb a June that is already here.
     *
     * People are matched by name, case-insensitively, so importing your
     * own export back does not clone the roster.
     *
     * @param {{people?: string[], months: Record<string, {amount:number,paidBy:string,date?:string,description?:string}[]>}} payload
     */
    importMonths(payload) {
      const rawMonths = payload && payload.months;
      if (!rawMonths || typeof rawMonths !== 'object') {
        return { ok: false, error: 'There is nothing in that file to import.' };
      }

      const ids = Object.keys(rawMonths).filter((id) => parseMonthId(id));
      if (ids.length === 0) return { ok: false, error: 'That file has no months in it.' };

      const ops = [];
      const idByName = new Map(state.people.map((p) => [p.name.toLowerCase(), p.id]));
      const ensurePerson = (rawName) => {
        const name = String(rawName == null ? '' : rawName).trim();
        if (!name) return null;
        const key = name.toLowerCase();
        if (idByName.has(key)) return idByName.get(key);
        const person = { id: newId(), name };
        state.people.push(person);
        idByName.set(key, person.id);
        ops.push(putPerson(person));
        return person.id;
      };

      for (const name of Array.isArray(payload.people) ? payload.people : []) ensurePerson(name);

      let imported = 0;
      for (const id of ids) {
        // The month is replaced, so everything already in it goes. In a
        // room that has to travel as one delete each, or the other device
        // keeps showing rows this one just dropped.
        for (const gone of state.months[id] ? state.months[id].expenses : []) {
          ops.push(delExpense(gone.id));
        }

        const expenses = [];
        for (const e of rawMonths[id]) {
          if (!e || !Number.isInteger(e.amount) || e.amount <= 0) continue;
          const payerId = ensurePerson(e.paidBy);
          if (!payerId) continue;
          const expense = {
            id: newId(),
            amount: e.amount,
            payerId,
            description: typeof e.description === 'string' ? e.description : '',
            date: typeof e.date === 'string' ? e.date : '',
          };
          expenses.push(expense);
          ops.push(putExpense(id, expense));
        }
        state.months[id] = { id, expenses };
        imported += expenses.length;
      }

      // Land on something the user can actually see the result of.
      const newest = ids.slice().sort().pop();
      if (!ids.includes(state.currentMonthId) && newest) state.currentMonthId = newest;
      monthOf(state.currentMonthId);

      commit(ops);
      return { ok: true, months: ids.length, expenses: imported };
    },

    addPerson(rawName) {
      const name = String(rawName == null ? '' : rawName).trim();
      if (!name) return { ok: false, error: 'Enter a name.' };
      if (name.length > LIMITS.nameChars) return { ok: false, error: 'That name is too long.' };
      if (state.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: name + ' is already on the list.' };
      }
      const person = { id: newId(), name };
      state.people.push(person);
      commit([putPerson(person)]);
      return { ok: true, person };
    },

    renamePerson(personId, rawName) {
      const name = String(rawName == null ? '' : rawName).trim();
      if (!name) return { ok: false, error: 'Enter a name.' };
      if (name.length > LIMITS.nameChars) return { ok: false, error: 'That name is too long.' };
      const person = state.people.find((p) => p.id === personId);
      if (!person) return { ok: false, error: 'That person is no longer on the list.' };
      const clash = state.people.some(
        (p) => p.id !== personId && p.name.toLowerCase() === name.toLowerCase()
      );
      if (clash) return { ok: false, error: name + ' is already on the list.' };
      person.name = name;
      commit([putPerson(person)]);
      return { ok: true };
    },

    /**
     * Removing someone affects every month they ever paid in, not just the
     * one on screen, so the counts come back for the dialog to spell out.
     * @param {string} personId
     * @param {{mode?: 'reassign'|'delete', targetId?: string}} options
     */
    removePerson(personId, options = {}) {
      const person = state.people.find((p) => p.id === personId);
      if (!person) return { ok: false, error: 'That person is no longer on the list.' };

      const ops = [];
      const theirs = everyExpense().filter((e) => e.payerId === personId);
      if (theirs.length > 0) {
        if (options.mode === 'delete') {
          for (const month of Object.values(state.months)) {
            for (const e of month.expenses) {
              if (e.payerId === personId) ops.push(delExpense(e.id));
            }
            month.expenses = month.expenses.filter((e) => e.payerId !== personId);
          }
        } else if (options.mode === 'reassign') {
          const target = state.people.find((p) => p.id === options.targetId && p.id !== personId);
          if (!target) return { ok: false, error: 'Choose who those expenses belong to.' };
          for (const month of Object.values(state.months)) {
            for (const e of month.expenses) {
              if (e.payerId !== personId) continue;
              e.payerId = target.id;
              ops.push(putExpense(month.id, e));
            }
          }
        } else {
          // Caller has to decide first. The UI turns this into a dialog.
          const months = Object.values(state.months).filter((m) =>
            m.expenses.some((e) => e.payerId === personId)
          );
          return {
            ok: false,
            needsDecision: true,
            expenseCount: theirs.length,
            monthCount: months.length,
            error: person.name + ' has recorded expenses.',
          };
        }
      }

      state.people = state.people.filter((p) => p.id !== personId);
      ops.push(delPerson(personId));
      commit(ops);
      return { ok: true };
    },

    addExpense(input) {
      const validated = validateExpense(input, state.people);
      if (!validated.ok) return validated;
      const expense = Object.assign({ id: newId() }, validated.value);
      const monthId = state.currentMonthId;
      monthOf(monthId).expenses.push(expense);
      commit([putExpense(monthId, expense)]);
      return { ok: true, expense };
    },

    updateExpense(expenseId, input) {
      const month = monthOf(state.currentMonthId);
      const index = month.expenses.findIndex((e) => e.id === expenseId);
      if (index === -1) return { ok: false, error: 'That expense no longer exists.' };
      const validated = validateExpense(input, state.people);
      if (!validated.ok) return validated;
      const expense = Object.assign({ id: expenseId }, validated.value);
      month.expenses[index] = expense;
      commit([putExpense(month.id, expense)]);
      return { ok: true };
    },

    deleteExpense(expenseId) {
      const monthId = monthIdOf(expenseId) || state.currentMonthId;
      const month = monthOf(monthId);
      const before = month.expenses.length;
      month.expenses = month.expenses.filter((e) => e.id !== expenseId);
      if (month.expenses.length === before) {
        return { ok: false, error: 'That expense no longer exists.' };
      }
      commit([delExpense(expenseId)]);
      return { ok: true };
    },
  };
}

/** Shared by add and update so both reject the same things. */
function validateExpense(input, people) {
  const amount = input && input.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.', field: 'amount' };
  }
  if (amount > LIMITS.maxAmount) {
    return { ok: false, error: 'That amount is too large.', field: 'amount' };
  }
  if (!people.some((p) => p.id === (input && input.payerId))) {
    return { ok: false, error: 'Choose who paid.', field: 'payer' };
  }
  return {
    ok: true,
    value: {
      amount,
      payerId: input.payerId,
      description: String(input.description == null ? '' : input.description).trim(),
      date: typeof input.date === 'string' ? input.date : '',
    },
  };
}
