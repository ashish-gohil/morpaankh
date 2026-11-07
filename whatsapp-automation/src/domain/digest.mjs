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
 * N9. What WhatsApp cost this month, in one line.
 *
 * Nothing said what the service spends. The owner could read it in WhatsApp
 * Manager, a screen they do not otherwise use, so the largest variable cost in
 * the automation was invisible beside freight and COGS.
 *
 * MONTH TO DATE, not yesterday, because that is the number a decision is made
 * against: the free service allowance resets monthly and the marketing cost is
 * only alarming in aggregate.
 *
 * Self-silencing: a month with nothing counted adds nothing to the digest.
 *
 * @param {Record<string, number>} counts  WACOUNT sort key -> count
 * @param {Record<string, number>} rates   category -> rupees per billable message
 */
export function waSpendLine(counts, rates = {}) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return '';

  let tenThousandths = 0;
  const byCategory = {};
  let refused = 0;
  let service = 0;

  for (const [sk, n] of entries) {
    if (!n) continue;
    if (sk === 'SERVICE') { service = n; continue; }
    if (sk.startsWith('REFUSED#')) { refused += n; continue; }
    const [category, billable] = sk.split('#');
    byCategory[category] = (byCategory[category] || 0) + n;
    if (billable === 'billable') {
      /*
       * Accumulated in TEN-THOUSANDTHS OF A RUPEE, which is the smallest unit
       * the rate card uses, and only converted to paise at the end.
       *
       * Rounding the rate to whole paise first is wrong and quietly so: the
       * utility rate is 11.5 paise, Math.round takes it to 12, and 200
       * messages then read as Rs 24 instead of Rs 23. Over a month that is a
       * cost line that is confidently several percent out.
       */
      tenThousandths += Math.round((rates[category] || 0) * 10000) * n;
    }
  }

  const parts = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${n} ${c}`);
  if (service) parts.push(`${service} free-form (${service} of 1,000 free this month)`);
  if (!parts.length && !refused) return '';

  const paise = Math.round(tenThousandths / 100);
  const cost = paise ? `, about ${formatINR(paise)}` : '';
  const ref = refused ? `; refused by Meta: ${refused}` : '';
  return `. WhatsApp this month: ${parts.join(', ')}${cost}${ref}`;
}

/**
 * Yesterday's EVENTS, counted off the timestamps this service writes.
 *
 * THE DIGEST USED TO COUNT TAGS ON ORDERS SHOPIFY REPORTED AS UPDATED.
 *
 * Every tag this service writes updates the order, and so does every courier
 * scan, so an order confirmed a fortnight ago and merely touched yesterday was
 * counted as yesterday's confirmation. The numbers grew with the age of the
 * catalogue rather than with the day's work, and the same order was counted
 * again every time anything happened to it.
 *
 * NDR is the clearest case. It was counted off `wa-ndr`, and nothing wrote that
 * tag when a prompt was SENT: it was only written when the customer replied. So
 * the digest reported zero failed deliveries on days when three parcels had
 * failed, which is what let Flow C go unnoticed for the whole life of the
 * service. F9 writes the tag on the prompt; this counts the prompts themselves,
 * one per attempt day, which is the number the owner actually wants.
 *
 * Pure: the caller does the scan and the IST window.
 *
 * @param {any[]} states  STATE rows
 * @param {{fromISO: string, toISO: string}} window  [from, to), IST day bounds as UTC ISO
 */
export function countEvents(states, { fromISO, toISO }) {
  const inWin = (v) => typeof v === 'string' && v >= fromISO && v < toISO;
  const c = {
    cod: 0, confirmed: 0, converted: 0, cancelled: 0, holds: 0,
    delivered: 0, reviewed: 0, ndr: 0, rto: 0, noPhone: 0, undelivered: 0,
  };
  for (const st of states || []) {
    // A missing row must not take the whole digest down with it: this is the
    // one place in the service that reads every STATE row at once, so one odd
    // item would cost the owner the entire day's summary.
    if (!st) continue;
    const a = st.flowA || {};
    const b = st.flowB || {};
    const f = st.flowC || {};
    // "COD asked" is the COD chase specifically; a PREPAID order's plain
    // thank-you is not a question and was never meant to be in this count.
    if (inWin(a.codConfirmAt) && (st.class || 'COD') === 'COD') c.cod += 1;
    if (inWin(a.confirmedAt)) c.confirmed += 1;
    if (inWin(a.convertedAt)) c.converted += 1;
    if (inWin(a.cancelledAt)) c.cancelled += 1;
    if (inWin(a.heldAt)) c.holds += 1;
    if (inWin(a.undeliverableAt)) c.undelivered += 1;
    if (inWin(a.codSkipAt) && a.codSkip === 'no-phone-anywhere') c.noPhone += 1;
    // The review ASK is the delivery signal the owner reads: it only goes out
    // on an order the courier confirmed and that is eligible to be asked.
    if (inWin(b.askedAt)) c.delivered += 1;
    if (inWin(b.reviewedAt)) c.reviewed += 1;
    if (inWin(f.rtoAt)) c.rto += 1;
    // One per ATTEMPT DAY, not one per order: an order can fail delivery three
    // times and each failure is a thing that happened that day.
    for (const at of Object.values(f.ndrAsked || {})) if (inWin(at)) c.ndr += 1;
  }
  return c;
}

/**
 * @param {{tags:string[]}[]} orders  orders updated in the window
 * @param {{cartsMessaged?: number,
 *           replacements?: {orderName?: string, state?: string, nextAction?: string}[],
 *           templateProblems?: {name?: string, status?: string}[],
 *           subscribers?: {sent?: number, whatsapp?: number, email?: number, parked?: number,
 *                          converted?: number, revenuePaise?: number,
 *                          skips?: {reason: string, count: number}[]},
 *           events?: Record<string, number>,
 *           waCounts?: Record<string, number>, waRates?: Record<string, number>}} [extra]
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
  /*
   * The tag counts above are kept for ONE number, cartsRecovered, which is the
   * only one with no event stamp anywhere: an order that came back from a cart
   * message is identified by its tag and nothing else. Everything else is
   * overwritten by countEvents, which counts what happened yesterday instead of
   * what is tagged today. See countEvents for why that mattered.
   */
  if (extra.events) Object.assign(counts, extra.events);
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
      + waSpendLine(extra.waCounts || {}, extra.waRates || {})
      + subscriberOffersLine(extra.subscribers)
      + openReplacementsLine(extra.replacements)
      + templateProblemsLine(extra.templateProblems),
  };
}
