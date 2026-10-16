// The shape of the two things a room stores, and the rules for what counts
// as a valid one. The browser and the Cloudflare Worker both import this
// file, so a record the client will send is exactly a record the server
// will accept. Keep it free of DOM and of Worker APIs.

export const LIMITS = {
  /**
   * Room-wide ceiling, counted on the encrypted bytes actually stored.
   * Sealing and base64 cost about 90 bytes on top of each expense, so this
   * is roughly 7,000 of them: sixty years at a hundred a month.
   */
  roomBytes: 2 * 1024 * 1024,
  /** One record can never be worth more than this on its own, sealed. */
  recordBytes: 2048,
  /** Belt and braces. The byte cap bites long before this one does. */
  roomRecords: 20000,
  /** Ops accepted in one message. Import chunks itself to stay under it. */
  batchOps: 400,
  /** Tombstones older than this are pruned; nothing syncs that late. */
  tombstoneDays: 90,

  nameChars: 40,
  descriptionChars: 80,
  /** ~99 billion RON. Above this an amount is a typo, not a rent payment. */
  maxAmount: 9999999999999,
};

const MONTH_ID = /^(\d{4})-(\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isMonthId(id) {
  const m = MONTH_ID.exec(typeof id === 'string' ? id : '');
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/** Ids are ours, but they arrive over a socket, so treat them as input. */
export function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function text(value, maxChars) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxChars);
}

/**
 * @returns {{id: string, name: string}|null} null when the input is not a
 *   person at all. A blank name is not a person.
 */
export function normalizePerson(raw) {
  if (!raw || !isId(raw.id)) return null;
  const name = text(raw.name, LIMITS.nameChars);
  if (!name) return null;
  return { id: raw.id, name };
}

/**
 * @returns {{id, month, amount, payerId, description, date}|null}
 *   The month rides inside the record so one op carries everything the
 *   server needs to file it, with no ambient "current month" state.
 */
export function normalizeExpense(raw) {
  if (!raw || !isId(raw.id) || !isId(raw.payerId) || !isMonthId(raw.month)) return null;
  if (!Number.isInteger(raw.amount) || raw.amount <= 0 || raw.amount > LIMITS.maxAmount) {
    return null;
  }
  return {
    id: raw.id,
    month: raw.month,
    amount: raw.amount,
    payerId: raw.payerId,
    description: text(raw.description, LIMITS.descriptionChars),
    date: typeof raw.date === 'string' && ISO_DATE.test(raw.date) ? raw.date : '',
  };
}

