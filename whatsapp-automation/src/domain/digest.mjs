/*
 * digest.mjs — summarize a day's automation activity into one line (pure).
 * Counts are derived from the order tags this service writes, so the digest is
 * reconstructable from Shopify without a separate counter store.
 */
import { hasTag, hasRtoTag } from './order.mjs';

const RULES_TAGS = [
  ['cod', 'wa-cod-sent'],
  ['confirmed', 'wa-confirmed'],
  ['converted', 'wa-prepaid-converted'],
  ['cancelled', 'wa-cancelled'],
  ['holds', 'wa-hold-unconfirmed'],
  ['delivered', 'wa-review-asked'], // review asked == delivered-and-eligible
  ['reviewed', 'wa-reviewed'],
  ['ndr', 'wa-ndr'],
  ['rto', null], // real RTO tag only; see hasRtoTag (a substring match on 'RTO' hits every '* RTO Risk' order)
  ['noPhone', 'wa-no-verified-phone'],
  // Written when a delivery status comes back failed. Counted separately from
  // the "asked" tags because those only mean WhatsApp accepted the send: a
  // digest built from them alone reported customers as reached who never were.
  ['undelivered', 'wa-undeliverable'],
];

/** @param {{tags:string[]}[]} orders  orders updated in the window */
export function summarizeDigest(orders) {
  const counts = {};
  for (const [k] of RULES_TAGS) counts[k] = 0;
  for (const o of orders) {
    for (const [k, tag] of RULES_TAGS) if (tag === null ? hasRtoTag(o.tags) : hasTag(o.tags, tag)) counts[k] += 1;
  }
  const line =
    `${counts.cod} COD asked, ${counts.confirmed} confirmed, ${counts.converted} prepaid, ` +
    `${counts.cancelled} cancelled, ${counts.holds} held, ${counts.delivered} delivered, ` +
    `${counts.reviewed} reviews, ${counts.ndr} NDR, ${counts.rto} RTO, ${counts.noPhone} no-verified-phone, ` +
    `${counts.undelivered} NOT reached`;
  return { counts, line };
}
