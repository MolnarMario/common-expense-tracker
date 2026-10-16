// Money helpers. The app is RON only. Everything is stored and calculated
// in bani as plain integers, so no float ever touches a balance.

export const CURRENCY = 'RON';

/** What one hundredth of a leu is called, for rounding copy. */
export const MINOR_UNIT = 'ban';

/** Digits and separators only. Everything else the user types is dropped. */
export function sanitizeAmountInput(raw) {
  return String(raw == null ? '' : raw).replace(/[^\d.,\s]/g, '');
}

/**
 * Parse user input into minor units.
 *
 * Accepts what a person types ("12", "12.5", "12,50", "1 234,56") and what
 * this app itself prints ("240.924,00"), which matters because the amount
 * field reformats on blur and then has to read its own output back.
 *
 * The last separator decides: one or two digits after it make it the
 * decimal point, exactly three make it a thousands separator.
 *
 * @param {string|number} input
 * @returns {number|null} integer minor units, or null if it is not an amount
 */
export function parseAmount(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return roundToMinor(input);
  }
  if (typeof input !== 'string') return null;

  const s = input.replace(/[\s  ]/g, '');
  if (s === '' || !/^[\d.,]+$/.test(s)) return null;

  const lastSeparator = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let whole = s;
  let frac = '';

  if (lastSeparator !== -1) {
    const tail = s.slice(lastSeparator + 1);
    if (!/^\d+$/.test(tail)) return null;
    if (tail.length <= 2) {
      whole = s.slice(0, lastSeparator);
      frac = tail;
    } else if (tail.length === 3) {
      // Grouping, so the whole string is the integer part.
      whole = s;
    } else {
      // More than two decimals is not a money amount.
      return null;
    }
  }

  // What is left must be plain digits, optionally grouped in threes.
  if (!/^(\d+([.,]\d{3})*)?$/.test(whole)) return null;

  const digits = whole.replace(/[.,]/g, '') || '0';
  if (digits === '0' && frac === '') return 0;

  const minor = Number(digits) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

function roundToMinor(major) {
  return Math.round((major + Number.EPSILON) * 100);
}

/** Minor units back to a major-unit number, for display only. */
export function toMajor(minor) {
  return minor / 100;
}

/** "1.234,56" style, no currency symbol. Used inside inputs. */
export function formatPlain(minor) {
  return new Intl.NumberFormat('ro-RO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toMajor(minor));
}

/** "1.234,56 RON". The space is non-breaking so the unit never wraps off. */
export function formatMoney(minor) {
  return formatPlain(minor) + '\u00a0' + CURRENCY;
}

/** Bare number with an explicit + or -, for columns already labelled RON. */
export function formatSignedPlain(minor) {
  const sign = minor > 0 ? '+' : minor < 0 ? '−' : '';
  return sign + formatPlain(Math.abs(minor));
}
