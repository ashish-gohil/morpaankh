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
 * Every known class qualifies. Only COD gets the confirm-and-convert chase;
 * PREPAID and PARTIAL get a plain order confirmation, which is why they are no
 * longer rejected here. Before this they were, so a customer who paid online at
 * checkout received nothing at all. UNKNOWN still gets no message, because we
 * cannot say anything true about an order we cannot read.
 *
 * @param {any} n @param {string} cls @param {{startAt?: string, orderAllowlist?: string[]}} [opts]
 * @returns {{ok:boolean, reason?:string}}
 */
export function flowAEligible(n, cls, { startAt, orderAllowlist = [] } = {}) {
  const ex = excludeFromAll(n, { orderAllowlist });
  if (ex.excluded) return { ok: false, reason: ex.reason };
  if (!['COD', 'PREPAID', 'PARTIAL'].includes(cls)) return { ok: false, reason: `class-${cls}` };
  if (!afterStart(n, startAt)) return { ok: false, reason: 'before-startAt' };
  return { ok: true };
}
