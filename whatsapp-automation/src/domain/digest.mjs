/*
 * digest.mjs — summarize a day's automation activity into one line (pure).
 * Counts are derived from the order tags this service writes, so the digest is
 * reconstructable from Shopify without a separate counter store.
 */
import { hasTag } from './order.mjs';

const RULES_TAGS = [
  ['cod', 'wa-cod-sent'],
  ['confirmed', 'wa-confirmed'],
  ['converted', 'wa-prepaid-converted'],
  ['cancelled', 'wa-cancelled'],
  ['holds', 'wa-hold-unconfirmed'],
  ['delivered', 'wa-review-asked'], // review asked == delivered-and-eligible
  ['reviewed', 'wa-reviewed'],
  ['ndr', 'wa-ndr'],
  ['rto', 'RTO'],
  ['noPhone', 'wa-no-verified-phone'],
];

/** @param {{tags:string[]}[]} orders  orders updated in the window */
export function summarizeDigest(orders) {
  const counts = {};
  for (const [k] of RULES_TAGS) counts[k] = 0;
  for (const o of orders) {
    for (const [k, tag] of RULES_TAGS) if (hasTag(o.tags, tag)) counts[k] += 1;
  }
  const line =
    `${counts.cod} COD asked, ${counts.confirmed} confirmed, ${counts.converted} prepaid, ` +
    `${counts.cancelled} cancelled, ${counts.holds} held, ${counts.delivered} delivered, ` +
    `${counts.reviewed} reviews, ${counts.ndr} NDR, ${counts.rto} RTO, ${counts.noPhone} no-verified-phone`;
  return { counts, line };
}
