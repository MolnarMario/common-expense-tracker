// Moving months in and out of the app as files. Everything here is pure:
// text and plain objects in, text and plain objects out. No DOM, no
// storage, no store.
//
// Both file formats identify people by name rather than by id. A CSV only
// has names anyway, the roster already forbids two people sharing one, and
// a name survives being edited by hand in a spreadsheet where a uuid does
// not.

import { parseAmount } from './money.js';
import { parseMonthId, monthLabel } from './months.js';

const FILE_TAG = 'common-expense-tracker';
const FORMAT_VERSION = 1;

// Column order of an exported CSV. The importer matches on the header
// names below, not on position, so a spreadsheet that reorders columns
// still comes back in.
const CSV_HEADER = ['month', 'date', 'description', 'paid_by', 'amount_ron'];

// What each column may be called in a file somebody else made.
const CSV_ALIASES = {
  month: ['month', 'luna', 'period'],
  date: ['date', 'day', 'data'],
  description: ['description', 'note', 'notes', 'what', 'details', 'descriere'],
  paid_by: ['paid_by', 'payer', 'paidby', 'who_paid', 'who', 'paid', 'platit_de'],
  amount_ron: ['amount_ron', 'amount', 'sum', 'value', 'total', 'suma', 'ron'],
};

// --------------------------------------------------------------- exporting

/** Month ids that hold at least one expense, oldest first. */
export function exportableMonths(state) {
  return Object.values(state?.months ?? {})
    .filter((m) => m && Array.isArray(m.expenses) && m.expenses.length > 0)
    .map((m) => m.id)
    .filter((id) => parseMonthId(id))
    .sort();
}

function collect(state, monthIds) {
  const wanted = new Set(monthIds ?? []);
  const nameById = new Map((state?.people ?? []).map((p) => [p.id, p.name]));
  const ids = exportableMonths(state).filter((id) => wanted.has(id));

  return ids.map((id) => ({
    id,
    expenses: [...(state.months[id].expenses ?? [])]
      .sort((a, b) => (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99'))
      .map((e) => ({
        date: e.date || '',
        description: e.description || '',
        paidBy: nameById.get(e.payerId) || '',
        amount: e.amount,
      })),
  }));
}

export function toJSON(state, monthIds, now = new Date()) {
  const months = {};
  for (const month of collect(state, monthIds)) months[month.id] = { expenses: month.expenses };

  return (
    JSON.stringify(
      {
        app: FILE_TAG,
        formatVersion: FORMAT_VERSION,
        exportedAt: now.toISOString(),
        currency: 'RON',
        amountUnit: 'bani, a hundredth of a leu, so 4250 means 42,50 RON',
        // The whole roster travels, so somebody who paid for nothing this
        // month still lands on the other side.
        people: (state?.people ?? []).map((p) => p.name),
        months,
      },
      null,
      2
    ) + '\n'
  );
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function toCSV(state, monthIds) {
  const lines = [CSV_HEADER.join(',')];
  for (const month of collect(state, monthIds)) {
    for (const e of month.expenses) {
      lines.push(
        [month.id, e.date, e.description, e.paidBy, (e.amount / 100).toFixed(2)]
          .map(csvCell)
          .join(',')
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

/** Ready-to-download file for the chosen months. */
export function buildExport(state, monthIds, format, now = new Date()) {
  const ids = exportableMonths(state).filter((id) => (monthIds ?? []).includes(id));
  if (ids.length === 0) return { ok: false, error: 'Pick at least one month to export.' };

  const stem = ids.length === 1 ? ids[0] : ids[0] + '-to-' + ids[ids.length - 1];
  const csv = format === 'csv';

  return {
    ok: true,
    filename: 'expenses-' + stem + (csv ? '.csv' : '.json'),
    mime: csv ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    text: csv ? toCSV(state, ids) : toJSON(state, ids, now),
  };
}

// --------------------------------------------------------------- importing

function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

/**
 * Read a file the user picked. Both formats normalise to the same shape:
 *
 *   { ok, people: string[], months: { "2026-07": [{amount, paidBy, date, description}] } }
 *
 * so the merge downstream never has to care which one it came from.
 */
export function parseImportFile(text) {
  const clean = stripBom(text).trim();
  if (!clean) return { ok: false, error: 'That file is empty.' };
  return /^[{[]/.test(clean) ? parseJsonPayload(clean) : parseCsvPayload(clean);
}

function parseJsonPayload(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON. Was it edited by hand?' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'That JSON file is not an export from this app.' };
  }
  const rawMonths = raw.months && typeof raw.months === 'object' ? raw.months : null;
  if (!rawMonths) return { ok: false, error: 'That file has no months in it.' };

  // A raw copy of what the app saves is a valid import too: there, people
  // are {id, name} objects and expenses carry payerId. Accept that shape
  // alongside the tidy exported one.
  const nameById = new Map();
  const people = [];
  for (const person of Array.isArray(raw.people) ? raw.people : []) {
    if (typeof person === 'string') {
      if (person.trim()) people.push(person.trim());
    } else if (person && typeof person.name === 'string' && person.name.trim()) {
      people.push(person.name.trim());
      if (typeof person.id === 'string') nameById.set(person.id, person.name.trim());
    }
  }

  const months = {};
  for (const [id, month] of Object.entries(rawMonths)) {
    if (!parseMonthId(id)) continue;
    const list = Array.isArray(month)
      ? month
      : Array.isArray(month?.expenses)
        ? month.expenses
        : [];

    const expenses = [];
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const amount = readAmount(e.amount);
      if (amount === null) continue;
      const paidBy =
        pick(e.paidBy) || pick(e.payer) || nameById.get(e.payerId) || '';
      if (!paidBy) continue;
      expenses.push({
        amount,
        paidBy,
        date: readDate(e.date),
        description: typeof e.description === 'string' ? e.description.trim() : '',
      });
    }
    months[id] = expenses;
  }

  if (Object.keys(months).length === 0) {
    return { ok: false, error: 'No month in that file could be read.' };
  }
  return { ok: true, people, months, skipped: [] };
}

function pick(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Amounts are integer bani. A hand-edited file with 42.5 in it means lei,
 * so take that reading instead of throwing the row away.
 */
function readAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const minor = Number.isInteger(value) ? value : Math.round(value * 100);
    return minor > 0 ? minor : null;
  }
  if (typeof value === 'string') {
    const parsed = parseAmount(value);
    return parsed !== null && parsed > 0 ? parsed : null;
  }
  return null;
}

function readDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

// ------------------------------------------------------------------ CSV in

/** Whichever of these appears most often on the header line wins. */
function sniffDelimiter(firstLine) {
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** RFC 4180 rows: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsvRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function normaliseHeader(cell) {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z_]/g, '');
}

function parseCsvPayload(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const rows = parseCsvRows(text, sniffDelimiter(firstLine));
  if (rows.length === 0) return { ok: false, error: 'That file is empty.' };

  const header = rows[0].map(normaliseHeader);
  const column = {};
  for (const [key, aliases] of Object.entries(CSV_ALIASES)) {
    column[key] = header.findIndex((cell) => aliases.includes(cell));
  }

  if (column.amount_ron === -1 || column.paid_by === -1) {
    return {
      ok: false,
      error: 'That CSV needs a header row with an amount column and a "paid by" column.',
    };
  }
  if (column.month === -1 && column.date === -1) {
    return { ok: false, error: 'That CSV needs either a month column or a date column.' };
  }

  const months = {};
  const skipped = [];

  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const at = (index) => (index === -1 ? '' : (cells[index] ?? '').trim());
    const line = i + 1;

    const date = at(column.date);
    const monthId = at(column.month) || date.slice(0, 7);
    if (!parseMonthId(monthId)) {
      skipped.push('line ' + line + ': "' + (at(column.month) || date) + '" is not a month');
      continue;
    }

    const amount = parseAmount(at(column.amount_ron));
    if (amount === null || amount <= 0) {
      skipped.push('line ' + line + ': "' + at(column.amount_ron) + '" is not an amount');
      continue;
    }

    const paidBy = at(column.paid_by);
    if (!paidBy) {
      skipped.push('line ' + line + ': nobody is named as the payer');
      continue;
    }

    if (!months[monthId]) months[monthId] = [];
    months[monthId].push({
      amount,
      paidBy,
      date: readDate(date),
      description: at(column.description),
    });
  }

  if (Object.keys(months).length === 0) {
    return {
      ok: false,
      error: 'No row in that CSV could be read.' + (skipped.length ? ' ' + skipped[0] + '.' : ''),
    };
  }
  return { ok: true, people: [], months, skipped };
}

// -------------------------------------------------------- what will change

/**
 * What the merge is about to do, so the confirm dialog can spell it out
 * before anything is overwritten.
 */
export function previewImport(state, payload) {
  const known = new Set((state?.people ?? []).map((p) => p.name.toLowerCase()));
  const seen = new Set();
  const newPeople = [];

  const names = [...(payload.people ?? [])];
  for (const expenses of Object.values(payload.months)) {
    for (const e of expenses) names.push(e.paidBy);
  }
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || known.has(key)) continue;
    seen.add(key);
    newPeople.push(name);
  }

  const ids = Object.keys(payload.months)
    .filter((id) => parseMonthId(id))
    .sort();

  const months = ids.map((id) => ({
    id,
    label: monthLabel(id),
    incoming: payload.months[id].length,
    existing: state?.months?.[id]?.expenses?.length ?? 0,
    total: payload.months[id].reduce((sum, e) => sum + e.amount, 0),
  }));

  const untouched = Object.values(state?.months ?? {})
    .filter((m) => m.expenses.length > 0 && !ids.includes(m.id))
    .map((m) => m.id)
    .sort();

  return {
    months,
    newPeople,
    untouched,
    replacing: months.filter((m) => m.existing > 0).length,
    totalExpenses: months.reduce((sum, m) => sum + m.incoming, 0),
  };
}
