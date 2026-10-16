// The boundary between the app's ops and what goes on the wire. Above this
// file everything is a plain record; below it everything is a blob.
//
// Note that decrypted records are validated on the way in, exactly as if
// they had arrived in the clear. Holding the key gets you in; it does not
// buy you the right to put nonsense in the other person's roster.

import { seal, unseal } from './crypto.js';
import { normalizeOp } from './ops.js';

export async function sealOp(dataKey, op) {
  if (op.type === 'del') {
    return { kind: op.kind, type: 'del', at: op.at, id: op.id };
  }
  return {
    kind: op.kind,
    type: 'put',
    at: op.at,
    id: op.record.id,
    blob: await seal(dataKey, op.record),
  };
}

export function sealOps(dataKey, ops) {
  return Promise.all(ops.map((op) => sealOp(dataKey, op)));
}

/** @returns {Promise<object|null>} null for a blob this key cannot open. */
export async function openOp(dataKey, item) {
  if (item.type === 'del') {
    return normalizeOp({ kind: item.kind, type: 'del', at: item.at, id: item.id });
  }
  const record = await unseal(dataKey, item.blob);
  if (!record) return null;
  return normalizeOp({ kind: item.kind, type: 'put', at: item.at, record });
}

export async function openOps(dataKey, items) {
  const opened = await Promise.all(items.map((item) => openOp(dataKey, item)));
  return opened.filter(Boolean);
}

/**
 * A room handover, decrypted and sorted into the two shapes the store
 * wants. Records that will not open are dropped rather than thrown on:
 * one unreadable row should not cost you the other four hundred.
 *
 * @returns {Promise<{people: object[], expenses: object[], failed: number}>}
 */
export async function openSnapshot(dataKey, items) {
  const puts = items.filter((item) => item && item.type === 'put');
  const opened = await Promise.all(puts.map((item) => openOp(dataKey, item)));

  const people = [];
  const expenses = [];
  let failed = 0;
  for (const op of opened) {
    if (!op) {
      failed += 1;
      continue;
    }
    if (op.kind === 'person') people.push(op.record);
    else expenses.push(op.record);
  }
  return { people, expenses, failed };
}
