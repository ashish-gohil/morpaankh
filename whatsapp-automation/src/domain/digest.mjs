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
  ['cartsRecovered', 'wa-cart-recovered'],
];


/*
 * The open replacements, named, with what a human has to do next.
 *
 * Named rather than counted: "2 replacements open" tells the owner a number
 * they cannot act on, while "#1234 add the new parcel to a pickup" is the
 * actual task. Capped at three because this goes into one template parameter
 * alongside everything else, and a digest nobody finishes reading is a digest
 * that stops being read.
 */
function openReplacementsLine(replacements) {
  const open = (replacements || []).filter((r) => r && r.orderName);
  if (!open.length) return '';
  const shown = open.slice(0, 3).map((r) => `${r.orderName} ${r.nextAction || r.state || 'open'}`);
  const rest = open.length - shown.length;
  return `. Replacements open: ${shown.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}`;
}

/*
 * Templates the sender can reach that Meta will not currently accept.
 *
 * Last, and unmissable, because it is the only item here that is about the
 * service being broken rather than about the day's orders. A template that is
 * missing, PENDING or REJECTED means every send through it to a customer whose
 * 24 hour window has closed goes nowhere, and there is no second route to
 * them. replacement_raised_v1 sat unsubmitted through a whole build, test and
 * deploy without one line anywhere saying so.
 *
 * Named, never counted, for the same reason as the replacements above: "1
 * template problem" is not something the owner can act on.
 */
function templateProblemsLine(problems) {
  const bad = (problems || []).filter((p) => p && p.name);
  if (!bad.length) return '';
  const shown = bad.slice(0, 3).map((p) => `${p.name} is ${p.status || 'missing'}`);
  const rest = bad.length - shown.length;
  return `. TEMPLATE NOT USABLE: ${shown.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}`;
}

/**
 * @param {{tags:string[]}[]} orders  orders updated in the window
 * @param {{cartsMessaged?: number,
 *           replacements?: {orderName?: string, state?: string, nextAction?: string}[],
 *           templateProblems?: {name?: string, status?: string}[]}} [extra]
 *   Counts that cannot be derived from a tag. "carts messaged" is one of them:
 *   an abandoned checkout has no order to tag, so it is counted off the Flow R
 *   records instead. "recovered" IS a tag, so it still comes from Shopify.
 *
 *   `replacements` is the same kind of thing and for a sharper reason: a
 *   replacement writes NOTHING to Shopify at all, by design, so there is no tag
 *   anywhere that could reveal one. An open replacement is a parcel the courier
 *   is holding and a customer who has been promised something, and the only
 *   place it exists is the REPL# rows. Left out of the digest it would be the
 *   one part of this service with no daily visibility, which is exactly how the
 *   half-finished ones get forgotten. Each entry is
 *   `{ orderName, state, nextAction }`.
 */
export function summarizeDigest(orders, extra = {}) {
  const counts = {};
  for (const [k] of RULES_TAGS) counts[k] = 0;
  for (const o of orders) {
    for (const [k, tag] of RULES_TAGS) if (tag === null ? hasRtoTag(o.tags) : hasTag(o.tags, tag)) counts[k] += 1;
  }
  const line =
    `${counts.cod} COD asked, ${counts.confirmed} confirmed, ${counts.converted} prepaid, ` +
    `${counts.cancelled} cancelled, ${counts.holds} held, ${counts.delivered} delivered, ` +
    `${counts.reviewed} reviews, ${counts.ndr} NDR, ${counts.rto} RTO, ${counts.noPhone} no-verified-phone, ` +
    `${counts.undelivered} NOT reached, ` +
    `${extra.cartsMessaged || 0} carts messaged, ${counts.cartsRecovered} recovered`;
  return {
    counts,
    line: line + openReplacementsLine(extra.replacements) + templateProblemsLine(extra.templateProblems),
  };
}
