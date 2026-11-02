/*
 * eligibility.mjs — order-level gates, pure. Phone-level gates (opt-out, valid
 * verified phone, caps, human takeover) are checked against the phone profile at
 * send time; these are the order facts.
 */
import { hasTag } from './order.mjs';

/**
 * Excluded from ALL flows: cancelled, COD-Cancelled, or a test order not allowlisted.
 * @param {any} n @param {{orderAllowlist?: string[]}} [opts]
 */
export function excludeFromAll(n, { orderAllowlist = [] } = {}) {
  if (n.cancelledAt) return { excluded: true, reason: 'cancelled' };
  if (hasTag(n.tags, 'COD-Cancelled')) return { excluded: true, reason: 'cod-cancelled-tag' };
  if (n.isTest && !orderAllowlist.includes(n.numericId)) return { excluded: true, reason: 'test-order' };
  return { excluded: false };
}

/** True only for orders created on/after an ISO `startAt`. No startAt => nothing qualifies. */
export function afterStart(n, startAt) {
  if (!startAt) return false;
  return new Date(n.createdAt).getTime() >= new Date(startAt).getTime();
}

/**
 * Flow A order-level eligibility. cls is the STORED classification.
 *
 * EVERY class qualifies, UNKNOWN included. Only COD gets the confirm-and-convert
 * chase; PREPAID, PARTIAL and UNKNOWN get a plain order confirmation, which
 * names the items, the total and the packing team and promises nothing about
 * payment. PREPAID and PARTIAL were rejected here once, so a customer who paid
 * online received nothing; UNKNOWN was rejected until 2026-11-02, so an order
 * whose gateway we could not read received nothing either (#1175, #1239).
 *
 * The class list is kept rather than dropped so a class name added later has to
 * be considered here instead of silently inheriting a confirmation.
 *
 * @param {any} n @param {string} cls @param {{startAt?: string, orderAllowlist?: string[]}} [opts]
 * @returns {{ok:boolean, reason?:string}}
 */
export function flowAEligible(n, cls, { startAt, orderAllowlist = [] } = {}) {
  const ex = excludeFromAll(n, { orderAllowlist });
  if (ex.excluded) return { ok: false, reason: ex.reason };
  if (!['COD', 'PREPAID', 'PARTIAL', 'UNKNOWN'].includes(cls)) return { ok: false, reason: `class-${cls}` };
  if (!afterStart(n, startAt)) return { ok: false, reason: 'before-startAt' };
  return { ok: true };
}
