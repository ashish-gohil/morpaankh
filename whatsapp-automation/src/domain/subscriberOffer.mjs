/*
 * subscriberOffer.mjs — Flow W (the 24 hour private welcome offer) domain
 * logic. Pure, and in the jsconfig include list, so it is type-checked under
 * `strict`.
 *
 * Money is integer PAISE here, like the rest of the service. Everything that
 * Flow R already does is REUSED rather than restated: the code format comes
 * from personalCodeName + cartCode, the offer floor from bestPublicSavingPaise,
 * the ceiling from tierMaxPaise, the closing time from formatExpiresAt, and the
 * recipient's number from normalizeVerifiedPhone. Two copies of any of those
 * would drift, and each of them is money or a message.
 */
import { createHash, randomInt } from 'node:crypto';
import { istParts, fromISTWall, addDays } from '../lib/time.mjs';
import { normalizeVerifiedPhone } from '../lib/phone.mjs';
import { formatINR } from '../lib/money.mjs';
import { afterStart } from './eligibility.mjs';
import {
  bestPublicSavingPaise, tierMaxPaise, personalCodeName, cartCode, properFirstName, formatExpiresAt,
} from './cart.mjs';

const pad = (x) => String(x).padStart(2, '0');

/**
 * Yesterday as one IST CALENDAR DAY, half open: [yesterday 00:00, today 00:00).
 *
 * THIS IS THE WHOLE DEFINITION OF "YESTERDAY'S SIGNUPS". A 24 hour lookback
 * from the 11:00 run would reach half of today as well, so someone who joined
 * at 09:00 this morning would be offered a welcome code before the day they
 * joined is over, and then counted again tomorrow. The window is expressed in
 * UTC as an 18:30 to 18:30 pair because IST is a fixed +05:30 with no DST.
 *
 * @param {Date} now
 * @returns {{date: string, startISO: string, endISO: string}} `date` is the IST
 *   calendar day the window covers, which is also the sweep's day marker.
 */
export function istYesterdayWindow(now) {
  const p = istParts(now);
  const end = fromISTWall(p.y, p.mon, p.day, 0, 0); // today 00:00 IST, exclusive
  const start = addDays(end, -1);
  const s = istParts(start);
  return {
    date: `${s.y}-${pad(s.mon + 1)}-${pad(s.day)}`,
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

/**
 * A Shopify Customer node in the shape the gates and the copy need.
 *
 * @param {any} c a Customer node from the Admin API
 */
export function normalizeCustomer(c) {
  if (!c) return null;
  const email = normalizeEmail(c.defaultEmailAddress?.emailAddress);
  /*
   * THE RECIPIENT. Owner's decision, 2026-10-24: Flow W messages
   * Customer.defaultPhoneNumber, because a candidate has no order and
   * therefore no COD King `_otpVerifiedPhoneNumber`. See the exception
   * recorded at the top of src/lib/phone.mjs.
   *
   * The RAW value is kept beside the normalised one because the two mean
   * different things downstream: nothing on file is WhatsApp being impossible
   * (fall back to email, quietly), while a number we hold and cannot use is
   * worth recording as a reason (phoneSkipReason).
   */
  const rawPhone = c.defaultPhoneNumber?.phoneNumber || null;
  const rawFirstName = c.firstName || '';
  return {
    gid: c.id,
    numericId: String(c.id || '').split('/').pop(),
    createdAt: c.createdAt,
    /*
     * A NUMBER. Shopify sends numberOfOrders as the STRING "0" (it is an
     * UnsignedInt64), and `'0' === 0` is false, so an order gate written
     * against the raw value would pass every single zero-order customer
     * straight through the check that is supposed to stop them.
     */
    numberOfOrders: Number(c.numberOfOrders || 0),
    email,
    emailKey: email ? emailKey(email) : null,
    emailMarketingState: c.defaultEmailAddress?.marketingState || null,
    /*
     * Shopify's own answer to "can this address receive at all". Carried
     * through rather than re-derived: a regex of ours would disagree with
     * theirs, and only theirs is the one SES will bounce.
     */
    emailValidFormat: c.defaultEmailAddress?.validFormat,
    unsubscribeUrl: c.defaultEmailAddress?.marketingUnsubscribeUrl || null,
    rawPhone,
    phone: normalizeVerifiedPhone(rawPhone),
    rawFirstName,
    firstName: properFirstName(rawFirstName),
    // Lower-cased, so a tag check cannot be defeated by capitals: the owner
    // types these by hand in the admin and "No-Marketing" is one keystroke away.
    tags: (c.tags || []).map((t) => String(t).toLowerCase()),
  };
}

/**
 * Why we are not messaging this candidate's phone, for the record only.
 *
 * NEVER an outcome. SPEC section 10 is "email only when WhatsApp is impossible
 * or refused", and a number that is absent, malformed, a landline or not Indian
 * is precisely WhatsApp being impossible: it is a reason to use the other
 * channel, not a reason to drop the person. This string exists so that
 * `subscriber-offer.mjs preview` can answer "why did this person get an email
 * rather than a WhatsApp".
 *
 * @param {any} n a normalized customer
 * @returns {'no-phone'|'bad-phone'|'non-india'|null}
 */
export function phoneSkipReason(n) {
  if (!n?.rawPhone) return 'no-phone';
  if (n.phone) return null;
  const raw = String(n.rawPhone).trim();
  // A real international number, written as one. The countryPrefixes rule
  // exists to stop us PAYING to WhatsApp a number outside India, which is a
  // different fact from a typo and is worth saying separately.
  if (raw.startsWith('+') && !raw.replace(/\D/g, '').startsWith('91')) return 'non-india';
  return 'bad-phone';
}

/**
 * Which channel can actually reach this person.
 *
 * @param {any} n a normalized customer
 * @param {{rules: any}} opts
 * @returns {{channel: 'whatsapp'|'email'|'none', reason?: string}}
 */
export function chooseChannel(n, { rules }) {
  const w = rules.subscriberOffer;
  /*
   * The +91 rule is read from RULES rather than assumed from the normaliser,
   * so the figure in the rules file is the one that decides. normalizeVerified
   * Phone already only ever answers +91, so this is a belt; it is here because
   * SECURITY names "cost runaway (non +91 numbers)" and a silent agreement
   * between two files is not a rule.
   */
  if (n?.phone && (w.countryPrefixes || []).some((p) => String(n.phone).startsWith(p))) {
    return { channel: 'whatsapp' };
  }
  if (!n?.email) return { channel: 'none' };
  /*
   * UNSUBSCRIBED ONLY. Owner's decision, 2026-10-24: the customer record is
   * itself the consent, so NOT_SUBSCRIBED, PENDING and INVALID all still
   * receive. An address that cannot deliver is not screened out here, it is
   * screened by Shopify's own validFormat and then by SES.
   */
  if (n.emailMarketingState === 'UNSUBSCRIBED') return { channel: 'none', reason: 'email-unsubscribed' };
  return { channel: 'email' };
}

/**
 * Can this customer be offered a welcome code at all? Record facts only; the
 * phone-level gates (opt-out, undeliverable, the lifetime lock, the marketing
 * cap) and every Shopify lookup are the worker's.
 *
 * `now` is accepted and deliberately unused: every gate here is about facts on
 * the record rather than about the hour, and the one time-based gate Flow W has
 * (the send window) is the worker's, because it WAITS rather than refusing.
 *
 * @param {any} n a normalized customer
 * @param {{now?: Date, startAt?: string, rules: any}} opts
 * @returns {{ok: boolean, reason?: string}}
 */
export function subscriberEligible(n, { startAt, rules }) {
  if (!n) return { ok: false, reason: 'not-found' };
  const w = rules.subscriberOffer;
  // Before the start gate, because an unreadable creation time is a different
  // fact from "they joined too early" and reads as a data problem, not a rule.
  if (!n.createdAt || !Number.isFinite(Date.parse(n.createdAt))) return { ok: false, reason: 'no-created-at' };
  if (!afterStart({ createdAt: n.createdAt }, startAt || '')) return { ok: false, reason: 'before-start' };
  if (n.numberOfOrders > 0) return { ok: false, reason: 'already-ordered' };
  if ((w.excludeTags || []).some((t) => n.tags.includes(String(t).toLowerCase()))) {
    return { ok: false, reason: 'excluded-tag' };
  }
  /*
   * An EMPTY requireAnyTag means everyone, which is the shipped default: every
   * new customer record counts as a signup. Filling it in narrows the flow to
   * the popup subscribers without a code change.
   */
  const need = w.requireAnyTag || [];
  if (need.length && !need.some((t) => n.tags.includes(String(t).toLowerCase()))) {
    return { ok: false, reason: 'not-a-subscriber' };
  }
  const ch = chooseChannel(n, { rules });
  if (ch.channel === 'none') return { ok: false, reason: ch.reason || 'no-channel' };
  return { ok: true };
}

/**
 * Is this offer worth sending at all?
 *
 * Measured against the code's OWN MINIMUM rather than a bag, because Flow W is
 * sent before there is any bag: the minimum is the smallest order the code can
 * be used on, so it is the only basket size we know anything about. Both
 * bounds come from Flow R's rules, not from a second set of numbers:
 *
 *   floor = the best live PUBLIC code on that basket, beaten by beatPublicByInr
 *           (in RUPEES, hence the x100). Equal is not better: a private code
 *           worth the same as one printed on the cart page is worse than
 *           silence.
 *   cap   = tierMaxPaise for that basket, the hard rupee ceiling the owner set
 *           on 2026-10-20 after a Rs 200 code went out on a Rs 1,249 bag.
 *
 * WITH THE SHIPPED DEFAULTS BOTH BOUNDS ARE EQUALITIES: Rs 200 is exactly
 * WELCOME150 + Rs 50, and exactly the Rs 2,000 tier's ceiling. That is
 * deliberate (it is the most generous offer the rules allow) and it is why
 * the unit test asserts the paise and not just `ok`. At a FLAT Rs 1,500
 * minimum the ceiling drops to Rs 160 and this flow would send nothing, ever,
 * with outcome public-offer-better. The .01 on the minimum is load-bearing.
 *
 * @param {{amountPaise: number, minimumPaise: number, publicCodes?: any[], rules: any}} args
 */
export function subscriberOfferGuard({ amountPaise, minimumPaise, publicCodes = [], rules }) {
  const r = rules.cartRecovery;
  // Quantity 1: the minimum is one order, and that is what makes BUY2 and BUY3
  // score nothing here (their minQuantity is 2 and 3).
  const publicBestPaise = bestPublicSavingPaise(publicCodes, minimumPaise, 1);
  const floorPaise = publicBestPaise + r.beatPublicByInr * 100;
  const capPaise = tierMaxPaise(minimumPaise, r);
  const out = { publicBestPaise, floorPaise, capPaise };
  if (amountPaise < floorPaise) return { ...out, ok: false, reason: 'public-offer-better' };
  if (amountPaise > capPaise) return { ...out, ok: false, reason: 'above-tier-ceiling' };
  return { ...out, ok: true };
}

/**
 * A random number in [0, 1) from the CSPRNG.
 *
 * cartCode and codeDigits default their rng to Math.random, which is fine for
 * a cart and not fine here: this code is the only thing between a stranger and
 * Rs 200, Math.random is seeded per process, and a handful of outputs is
 * enough to predict the rest. 2**32 is divisible by the eight digits 2-9, so
 * the draw stays exactly uniform.
 */
export function cryptoRng() {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

/**
 * MORPAANKH + the customer's name + four digits from 2-9.
 *
 * The FORMAT is Flow R's, shared through cartCode, and it has to be: the theme
 * decides whether to leave a link-supplied code alone by testing it against
 * /^MORPAANKH[A-Z]*\d+$/ (theme/assets/tapi-offers.js), and a code that does
 * not match is silently swapped for the biggest public one the moment the
 * customer reaches the cart.
 *
 * @param {string} rawName @param {any} rules @param {{rng?: () => number}} [opts]
 */
export function subscriberCode(rawName, rules, { rng = cryptoRng } = {}) {
  return cartCode(personalCodeName(rawName, rules), rules.subscriberOffer.codeDigits, rules, rng);
}

/**
 * Where the "Shop best sellers" button lands: apply the code, then forward to
 * the collection, tagged with the channel that carried the link.
 *
 * /discount/<CODE>?redirect=<path> and not ?discount=, measured on this store
 * on 13 Oct: the /discount/ form answers 302 and sets the discount_code
 * cookie, which is what survives into checkout, and ?discount= sets nothing.
 *
 * The redirect is ONE query parameter, so its own `&` separators are
 * percent-encoded. Unencoded, utm_medium and utm_campaign would be read as
 * parameters of /discount and the campaign would vanish from GA4.
 *
 * @param {{code: string, channel: string, rules: any, host: string}} args
 */
export function landingUrl({ code, channel, rules, host }) {
  const w = rules.subscriberOffer;
  const redirect = `/collections/${w.collectionHandle}?utm_source=${channel}&utm_medium=automation&utm_campaign=welcome_24h`;
  // encodeURIComponent on the CODE as well: the code is generated, so there is
  // nothing hostile in it today, but the record is the only input the /w route
  // trusts and "trusted" must not come to mean "interpolated raw".
  return `${host}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(redirect)}`;
}

/**
 * One address, one spelling.
 *
 * CR and LF are CUT, not replaced: this value goes into a To: header, and a
 * bare CRLF there appends headers of somebody else's choosing to our message.
 * @param {string|null|undefined} raw
 */
export function normalizeEmail(raw) {
  if (raw == null) return '';
  return String(raw).split(/[\r\n]/)[0].trim().toLowerCase();
}

/**
 * sha256 of the NORMALISED address, hex.
 *
 * A hash and never the address itself, because this lands in a DynamoDB
 * partition key and in an SQS message group id, and both are read back in
 * logs. Normalising first is what makes one person one key.
 * @param {string|null|undefined} raw
 */
export function emailKey(raw) {
  return createHash('sha256').update(normalizeEmail(raw)).digest('hex');
}

/** Escape a value for HTML text or an attribute. Ampersand FIRST, or an escape
 * would itself be escaped a second time. @param {any} v */
export function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * "Khili Dhoop, Bandhan and Morani" from the collection's best sellers.
 *
 * Only pieces somebody can actually buy: naming a sold-out or unpublished one
 * in the message that is supposed to welcome them is the worst possible first
 * impression. Falls back rather than leaving a hole, because a blank where a
 * product name goes reads as a broken message.
 * @param {any[]|null|undefined} items
 */
export function topPicks(items) {
  const names = (items || [])
    .filter((p) => p && p.title && p.availableForSale !== false && (p.status == null || p.status === 'ACTIVE'))
    .slice(0, 3)
    .map((p) => String(p.title));
  if (!names.length) return 'our best sellers';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/*
 * A WhatsApp body parameter may not contain a newline, a tab, or a run of four
 * or more spaces: Meta refuses the send outright. sanitizeParam in
 * templates.mjs collapses a run of FIVE to four, which is still four, so every
 * value here goes through its own collapse to a single space. The cap is
 * because `summary`-style over-long text comes back as 132005 ("hydrated text
 * too long"), which is in TEMPLATE_UNUSABLE and makes the whole template
 * unsendable rather than just ugly.
 */
const PARAM_MAX = 300;
const param = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, PARAM_MAX);

/**
 * The six body parameters subscriber_offer takes, in the copy's own words.
 *
 * min_order shows the WHOLE rupee figure the customer reads, not the Shopify
 * minimum: the code's own minimum carries an extra paisa so that "above
 * Rs 1,500" is literally true of every order it works on, and printing
 * Rs 1,500.01 in a message would be correct and unreadable.
 *
 * @param {{n: any, rec: any, topPicks: string, now: Date, rules: any}} args
 */
export function subscriberVars({ n, rec, topPicks: picks, now, rules }) {
  const w = rules.subscriberOffer;
  return {
    customer_name: param(n.firstName),
    code: param(rec.code),
    saving: param(formatINR(w.amountInr * 100)),
    min_order: param(formatINR(w.minOrderAboveInr * 100)),
    expires_at: param(formatExpiresAt(new Date(rec.codeEndsAt), now)),
    top_picks: param(picks) || 'our best sellers',
  };
}

/**
 * The Shopify minimum for the code, in rupees: a paisa above the figure in the
 * copy, so "above Rs 1,500" is true rather than "at or above". It is also what
 * lands the offer guard in the Rs 2,000 tier instead of the Rs 1,500 one.
 * @param {any} rules
 */
export const shopifyMinimumInr = (rules) => rules.subscriberOffer.minOrderAboveInr + 0.01;

/** The same figure in paise, which is what the offer guard measures. @param {any} rules */
export const minimumPaise = (rules) => Math.round(shopifyMinimumInr(rules) * 100);
