// Pure settlement math. No DOM, no storage, no imports from the UI.
// All amounts in and out are integer minor units.

/**
 * Split a total into n shares that sum back to exactly the total.
 * The remainder (at most n-1 minor units) goes one unit at a time to the
 * first people in the list, so the split is deterministic and reconciles.
 * @param {number} total integer minor units
 * @param {number} n number of people
 * @returns {number[]}
 */
export function splitEvenly(total, n) {
  if (n <= 0) return [];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / n);
  const remainder = abs - base * n;
  return Array.from({ length: n }, (_, i) => sign * (base + (i < remainder ? 1 : 0)));
}

/**
 * Turn net balances into a short list of transfers.
 * Greedy largest-debtor to largest-creditor. That is not provably the
 * global minimum (the exact problem is NP-hard), but it never produces
 * more than people-1 transfers and lands on the obvious answer for the
 * shapes real households hit.
 * @param {{id: string, net: number}[]} balances
 * @returns {{fromId: string, toId: string, amount: number}[]}
 */
export function minimizeTransfers(balances) {
  const debtors = balances
    .filter((b) => b.net < 0)
    .map((b) => ({ id: b.id, amount: -b.net }))
    .sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1));
  const creditors = balances
    .filter((b) => b.net > 0)
    .map((b) => ({ id: b.id, amount: b.net }))
    .sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1));

  const transfers = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].amount, creditors[c].amount);
    if (amount > 0) {
      transfers.push({ fromId: debtors[d].id, toId: creditors[c].id, amount });
    }
    debtors[d].amount -= amount;
    creditors[c].amount -= amount;
    if (debtors[d].amount === 0) d += 1;
    if (creditors[c].amount === 0) c += 1;
  }
  return transfers;
}

/**
 * Full picture for one month.
 * @param {{people: {id:string,name:string}[], expenses: {amount:number,payerId:string}[]}} month
 * @returns {{
 *   total: number,
 *   people: {id:string,name:string,paid:number,share:number,net:number}[],
 *   transfers: {fromId:string,toId:string,amount:number}[]
 * }}
 */
export function computeSettlement(month) {
  const people = month.people ?? [];
  const expenses = month.expenses ?? [];

  const paidBy = new Map(people.map((p) => [p.id, 0]));
  let total = 0;
  for (const e of expenses) {
    // An expense whose payer left the month still counts toward the
    // total; the UI blocks that state, this is belt and braces.
    total += e.amount;
    if (paidBy.has(e.payerId)) paidBy.set(e.payerId, paidBy.get(e.payerId) + e.amount);
  }

  if (people.length === 0) {
    return { total, people: [], transfers: [] };
  }

  const shares = splitEvenly(total, people.length);
  const rows = people.map((p, i) => {
    const paid = paidBy.get(p.id) ?? 0;
    return { id: p.id, name: p.name, paid, share: shares[i], net: paid - shares[i] };
  });

  return { total, people: rows, transfers: minimizeTransfers(rows) };
}

/**
 * Geometry for the balance bar. The bar is the whole month's spending laid
 * out left to right. Each person gets a slice as wide as what they paid,
 * overpayers first, and a ruler of fair-share ticks sits on top of it.
 *
 * The tick where the overpayers end is the one that matters: the colour
 * boundary always lands to the right of it, and the distance between the
 * two is exactly the money that has to change hands.
 *
 * Positions come back as fractions of the total, 0 to 1, so the renderer
 * can turn them into percentages without knowing any pixel widths.
 *
 * @param {ReturnType<typeof computeSettlement>} settlement
 * @returns {{
 *   total: number,
 *   segments: {id:string,name:string,colorIndex:number,paid:number,share:number,net:number,start:number,width:number}[],
 *   ticks: {at: number, isCrossing: boolean}[],
 *   crossing: {at: number, boundary: number, amount: number} | null
 * }}
 */
export function balanceBar(settlement) {
  const people = settlement?.people ?? [];
  const total = settlement?.total ?? 0;
  const empty = { total, segments: [], ticks: [], crossing: null };
  if (people.length === 0 || total <= 0) return empty;

  // Overpayers first, biggest first; the deepest debtor ends up on the far
  // right. Ties keep roster order so the bar does not reshuffle itself
  // every time an expense is added.
  const order = people
    .map((person, colorIndex) => ({ ...person, colorIndex }))
    .sort((a, b) => b.net - a.net || a.colorIndex - b.colorIndex);

  const segments = [];
  const ticks = [];
  let crossing = null;
  let paidSoFar = 0;
  let shareSoFar = 0;

  for (let i = 0; i < order.length; i += 1) {
    const person = order[i];
    segments.push({
      id: person.id,
      name: person.name,
      colorIndex: person.colorIndex,
      paid: person.paid,
      share: person.share,
      net: person.net,
      start: paidSoFar / total,
      // Slices can add up to less than the whole bar if an expense was left
      // behind by a payer who is no longer on the list. The UI blocks that,
      // and the leftover just reads as an unclaimed tail.
      width: person.paid / total,
    });

    paidSoFar += person.paid;
    shareSoFar += person.share;

    // Nets always sum to zero or less, so the last slice is never an
    // overpayer and there is always a tick to hang the crossing on.
    const isLast = i === order.length - 1;
    const crossesHere = !isLast && person.net > 0 && order[i + 1].net <= 0;
    if (crossesHere) {
      crossing = {
        at: shareSoFar / total,
        boundary: paidSoFar / total,
        amount: paidSoFar - shareSoFar,
      };
    }
    if (!isLast) ticks.push({ at: shareSoFar / total, isCrossing: crossesHere });
  }

  return { total, segments, ticks, crossing };
}
