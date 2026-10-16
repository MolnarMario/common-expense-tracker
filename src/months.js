// Month ids are "YYYY-MM" strings. They sort lexicographically, which is
// the whole reason for the format.

const LABEL = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

export function currentMonthId(now = new Date()) {
  return toMonthId(now.getFullYear(), now.getMonth() + 1);
}

export function toMonthId(year, month) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function parseMonthId(id) {
  const m = /^(\d{4})-(\d{2})$/.exec(id ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function shiftMonth(id, delta) {
  const parsed = parseMonthId(id);
  if (!parsed) return id;
  const zeroBased = parsed.year * 12 + (parsed.month - 1) + delta;
  return toMonthId(Math.floor(zeroBased / 12), (zeroBased % 12) + 1);
}

export function monthLabel(id) {
  const parsed = parseMonthId(id);
  if (!parsed) return id;
  return LABEL.format(new Date(parsed.year, parsed.month - 1, 1));
}

/** Default date for a new expense: today if we are in that month, else the 1st. */
export function defaultDateFor(id, now = new Date()) {
  const parsed = parseMonthId(id);
  if (!parsed) return '';
  if (currentMonthId(now) === id) return isoDate(now);
  return `${id}-01`;
}

export function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
