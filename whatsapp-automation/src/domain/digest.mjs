/*
 * digest.mjs — summarize a day's automation activity into one line (pure).
 * Counts are derived from the order tags this service writes, so the digest is
 * reconstructable from Shopify without a separate counter store.
 */
import { hasTag, hasRtoTag } from './order.mjs';
import { formatINR } from '../lib/money.mjs';

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

/*
 * Flow W's day, and the reason it is capped.
 *
 * The WHOLE digest is ONE WhatsApp body parameter, `ops_digest.summary`.
 * sanitizeParam does not truncate, and Meta answers an over-long hydrated body
 * with 132005, which is in TEMPLATE_UNUSABLE: an over-long digest does not
 * arrive shortened, it makes the template unsendable and takes the whole
 * digest with it. So the skip reasons are capped at the TWO biggest, counted,
 * and every label is a known outcome string rather than anything interpolated
 * from a customer.
 *
 * Self-silencing: a day with no welcome offers adds nothing at all.
 *
 * @param {{sent?: number, whatsapp?: number, email?: number, parked?: number,
 *          converted?: number, revenuePaise?: number,
 *          skips?: {reason: string, count: number}[]}} [s]
 */
function subscriberOffersLine(s) {
  if (!s) return '';
  const sent = s.sent || 0;
  const skips = (s.skips || []).filter((x) => x && x.reason);
  if (!sent && !s.parked && !s.converted && !skips.length) return '';

  const parts = [`${sent} sent`];
  // The channel split matters: "all by email" means WhatsApp is refusing us.
  if (sent) parts.push(`${s.whatsapp || 0} WhatsApp, ${s.email || 0} email`);
  if (s.parked) parts.push(`${s.parked} parked`);
  if (s.converted) {
    // formatINR, not a second spelling of money: the owner reads the rupee
    // symbol everywhere else in this service.
    parts.push(s.revenuePaise ? `${s.converted} converted ${formatINR(s.revenuePaise)}` : `${s.converted} converted`);
  }
  const top = skips
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((x) => `${String(x.reason).slice(0, 24)} ${x.count}`);
  const rest = skips.length - top.length;
  const skipText = top.length ? `. Top welcome skips: ${top.join(', ')}${rest > 0 ? `, and ${rest} more reasons` : ''}` : '';
  return `. Welcome offers: ${parts.join(', ')}${skipText}`;
}

/**
 * @param {{tags:string[]}[]} orders  orders updated in the window
 * @param {{cartsMessaged?: number,
 *           replacements?: {orderName?: string, state?: string, nextAction?: string}[],
 *           templateProblems?: {name?: string, status?: string}[],
 *           subscribers?: {sent?: number, whatsapp?: number, email?: number, parked?: number,
 *                          converted?: number, revenuePaise?: number,
 *                          skips?: {reason: string, count: number}[]}}} [extra]
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
    line:
      line
      + subscriberOffersLine(extra.subscribers)
      + openReplacementsLine(extra.replacements)
      + templateProblemsLine(extra.templateProblems),
  };
}
