/*
 * cart.mjs — Flow R (abandoned cart recovery) domain logic. Pure, and in the
 * jsconfig include list, so it is type-checked under `strict`.
 *
 * Money is integer PAISE here, same rule as the rest of the service: the RULES
 * numbers are written in rupees because that is how the owner thinks about
 * them, and they are converted once, on the way in.
 */
import { toPaise } from '../lib/money.mjs';
import { verifiedPhoneFromCustomAttributes } from '../lib/phone.mjs';
import { liveLineItems } from './order.mjs';
import { afterStart } from './eligibility.mjs';
import { istParts, fromISTWall, addHours, addMinutes, withinWindow, nextWindowTime, formatISTDate } from '../lib/time.mjs';
import { MODERATION } from '../../messages/labels.mjs';

const attrMap = (arr) => Object.fromEntries((arr || []).map((a) => [a.key ?? a.name, a.value]));
const HOUR = 60 * 60 * 1000;

/**
 * An abandoned checkout in the same shape the flows already use for orders.
 *
 * `lineItems` goes through the SAME liveLineItems as an order, which is what
 * lets itemLine() and heroImageUrl() work on a checkout unchanged. A checkout
 * line item has no currentQuantity, no product and no discountAllocations, and
 * liveLineItems already tolerates all three (`?? li.quantity`, `|| null`, a
 * reduce over an empty array).
 *
 * @param {any} c an AbandonedCheckout node from the Admin API
 */
export function normalizeCheckout(c) {
  if (!c) return null;
  const attrs = attrMap(c.customAttributes);
  const nodes = c.lineItems?.nodes || [];
  const items = liveLineItems(nodes);
  const rawName = c.customer?.firstName || c.shippingAddress?.firstName || c.billingAddress?.firstName || '';
  return {
    gid: c.id,
    numericId: String(c.id || '').split('/').pop(),
    name: c.name || '',
    createdAt: c.createdAt,
    completedAt: c.completedAt || null,
    // Carries `key=<credential>`. Never log it, never put it in a message.
    recoveryUrl: c.abandonedCheckoutUrl || null,
    lineItems: items,
    // The bag at list price, which is what the offer is measured against.
    // NOT totalPriceSet: that is already net of whatever code they had on.
    bagPaise: items.reduce((sum, li) => sum + li.unitPaise * li.quantity, 0),
    ownDiscountPaise: toPaise(c.totalDiscountSet?.shopMoney?.amount || 0),
    quantity: items.reduce((sum, li) => sum + li.quantity, 0),
    /*
     * availableForSale is read off the RAW nodes rather than added to
     * liveLineItems, because that function is shared with normalizeOrder and
     * every Flow A/B/C message goes through it. One extra field here is not
     * worth widening a shape three live flows depend on.
     */
    soldOut: nodes.some((li) => li.variant?.availableForSale === false),
    verifiedPhone: verifiedPhoneFromCustomAttributes(c.customAttributes),
    rawFirstName: rawName,
    firstName: properFirstName(rawName),
    customerGid: c.customer?.id || null,
    codkAmountType: attrs._codkAmountType || null,
    codkAmountValue: attrs._codkAmountValue || null,
    attrs,
  };
}

/**
 * "AARAV" -> "Aarav", "Aarav" -> "Aarav", nothing -> "there".
 *
 * Only an all-caps name is re-cased. Checkout forms produce plenty of those,
 * but lower-casing the tail of a name somebody typed as "McKay" or "D'Souza"
 * would be us breaking their name to tidy it.
 */
export function properFirstName(raw) {
  const first = String(raw || '').trim().split(/\s+/)[0] || '';
  if (!first) return 'there';
  if (/[a-z]/.test(first)) return first;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * A COD King PARTIAL ADVANCE checkout, where the line prices are only the
 * advance and the real total lives in `_codkOriginalTotal`.
 *
 * `_partialPaymentProduct` is NOT this signal: live checkout #66761819390324
 * is fully prepaid, has full line prices, and still carries that attribute.
 * Only amountType `percentage` with a value below 100 means an advance.
 *
 * An unreadable value counts as partial, because the whole reason to skip
 * these is that we cannot price a bag we cannot read.
 * @param {any} n
 */
export function isPartialAdvance(n) {
  if (n?.codkAmountType !== 'percentage') return false;
  const v = Number(n.codkAmountValue);
  return !Number.isFinite(v) || v < 100;
}

/**
 * Can this checkout be messaged at all? Order facts only; the phone-level
 * gates (opt-out, undeliverable, cooldown) are checked at send time.
 *
 * @param {any} n a normalized checkout
 * @param {{now: Date, startAt?: string, rules: any}} opts
 * @returns {{ok: boolean, reason?: string}}
 */
export function cartEligible(n, { now, startAt, rules }) {
  if (!n) return { ok: false, reason: 'not-found' };
  const r = rules.cartRecovery;
  if (n.completedAt) return { ok: false, reason: 'completed' };
  if (!n.verifiedPhone) return { ok: false, reason: 'no-verified-phone' };
  if (!afterStart({ createdAt: n.createdAt }, startAt || '')) return { ok: false, reason: 'before-start' };
  const ageMin = (now.getTime() - new Date(n.createdAt).getTime()) / 60000;
  if (!Number.isFinite(ageMin)) return { ok: false, reason: 'no-created-at' };
  // Age from createdAt ONLY. `updatedAt` on an abandoned checkout is not
  // customer activity: one created 3 Aug read updatedAt 12 Oct.
  if (ageMin > r.maxCheckoutAgeHours * 60) return { ok: false, reason: 'too-old' };
  if (ageMin < r.firstAfterMin) return { ok: false, reason: 'too-fresh' };
  if (r.skipPartialAdvance && isPartialAdvance(n)) return { ok: false, reason: 'partial-advance' };
  if (!n.lineItems.length) return { ok: false, reason: 'no-items' };
  if (n.soldOut) return { ok: false, reason: 'sold-out' };
  if (n.bagPaise <= 0) return { ok: false, reason: 'no-value' };
  return { ok: true };
}

export const roundUpTo = (x, step) => Math.ceil(x / step) * step;
export const roundDownTo = (x, step) => Math.floor(x / step) * step;

/**
 * The best saving any live public code would give THIS bag, in paise.
 *
 * @param {{type: string, percentage?: number, amountPaise?: number,
 *          minQuantity?: number, minSubtotalPaise?: number}[]} codes
 * @param {number} bagPaise
 * @param {number} quantity
 */
export function bestPublicSavingPaise(codes, bagPaise, quantity) {
  let best = 0;
  for (const c of codes || []) {
    if (c.minQuantity && quantity < c.minQuantity) continue;
    if (c.minSubtotalPaise && bagPaise < c.minSubtotalPaise) continue;
    const saving =
      c.type === 'percentage' ? Math.round(bagPaise * (c.percentage || 0)) : Math.round(c.amountPaise || 0);
    if (saving > best) best = saving;
  }
  return best;
}

/**
 * What to offer this bag, in paise.
 *
 * The shape of this is the whole point of Flow R. A flat percentage was
 * measured against the last ten reachable carts and was equal to or worse than
 * what eight of them could already get by typing a code off the cart page, and
 * a "private code" that saves less than the public one is worse than silence.
 * So: find what the bag ALREADY gets (its own applied discount, or the best
 * live public code it qualifies for), beat that by beatPublicByInr, and refuse
 * outright if the cap makes beating it impossible.
 *
 * @param {{bagPaise: number, ownDiscountPaise?: number, quantity: number,
 *          publicCodes?: any[], rules: any}} args
 */
/**
 * The rupee ceiling for this bag, from rules.cartRecovery.offerTiers.
 *
 * Stated in rupees, not as a percentage, because a percentage cannot express
 * "never more than Rs 160 on a small bag": 20% of Rs 1,249 is Rs 249, which
 * waves through the Rs 200 code that started this.
 *
 * @param {number} bagPaise @param {any} r rules.cartRecovery
 */
export function tierMaxPaise(bagPaise, r) {
  const bagInr = bagPaise / 100;
  for (const t of r.offerTiers || []) {
    if (t.upToInr === null || t.upToInr === undefined || bagInr <= t.upToInr) return t.maxInr * 100;
  }
  return 0;
}

export function computeCartOffer({ bagPaise, ownDiscountPaise = 0, quantity, publicCodes = [], rules }) {
  const r = rules.cartRecovery;
  const step = r.roundToInr * 100;
  const publicBestPaise = bestPublicSavingPaise(publicCodes, bagPaise, quantity);
  const floorPaise = Math.max(ownDiscountPaise || 0, publicBestPaise);
  // Integer multiply then divide, so the percentage never rides a float.
  const wantPaise = roundUpTo(
    Math.max((bagPaise * r.percentOff) / 100, floorPaise + r.beatPublicByInr * 100),
    step,
  );
  const percentCapPaise = roundDownTo((bagPaise * r.maxPercentOfBag) / 100, step);
  const capPaise = Math.min(percentCapPaise, tierMaxPaise(bagPaise, r));
  /*
   * A bag at or below minOfferBagInr is not discounted at all, so this exits
   * before the arithmetic rather than letting a tier of 0 fall through and be
   * reported as "the public code was better", which it was not.
   */
  const tooSmall = bagPaise <= r.minOfferBagInr * 100;
  const offerPaise = tooSmall ? 0 : Math.min(wantPaise, capPaise);
  return {
    bagPaise,
    floorPaise,
    publicBestPaise,
    wantPaise,
    capPaise,
    offerPaise,
    // Equal is not good enough: an identical saving with a private code on it
    // is a worse customer experience than the code already on the cart page.
    ok: !tooSmall && offerPaise > floorPaise,
    reason: tooSmall ? 'bag-below-minimum' : offerPaise > floorPaise ? null : 'public-offer-better',
    /*
     * Never below minSubtotalFloorInr: the code must not be usable on a basket
     * smaller than the one we refuse to discount in the first place.
     */
    minSubtotalInr: Math.max(
      Math.floor((bagPaise * r.minSubtotalFactor) / 100),
      r.minSubtotalFloorInr || 0,
    ),
  };
}

/**
 * The NAME part of MORPAANKH<NAME><digits>.
 *
 * Falls back to codeFallbackName for anything we cannot render as A-Z: a
 * Devanagari name strips to nothing, a one-letter name reads as a typo, and a
 * name that happens to contain a word off the moderation list would print it
 * in bold in the customer's own message.
 * @param {string} raw @param {any} rules
 */
export function personalCodeName(raw, rules) {
  const r = rules.cartRecovery;
  const first = String(raw || '').trim().split(/\s+/)[0] || '';
  const letters = first
    .normalize('NFKD')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  if (letters.length < 2) return r.codeFallbackName;
  if (MODERATION.words.some((w) => letters.includes(String(w).toUpperCase()))) return r.codeFallbackName;
  return letters.slice(0, r.codeNameMaxLen);
}

/**
 * Digits for the code, drawn from 2-9 only: a 0 reads as an O and a 1 as an I
 * when somebody types a code off a phone screen.
 * @param {number} count @param {() => number} [rng]
 */
export function codeDigits(count, rng = Math.random) {
  let out = '';
  for (let i = 0; i < count; i += 1) out += String(2 + Math.floor(rng() * 8));
  return out;
}

/** MORPAANKH + NAME + digits. @param {string} name @param {number} digits @param {any} rules @param {() => number} [rng] */
export function cartCode(name, digits, rules, rng = Math.random) {
  return `${rules.cartRecovery.codePrefix}${name}${codeDigits(digits, rng)}`;
}

/**
 * When the code closes and when the reminder goes, computed ONCE when the code
 * is created and stored, so a retry can never move the clock.
 *
 * A reminder that lands outside the send window moves to the next window start
 * and the code end moves with it, which means the code only ever lives LONGER,
 * never shorter: the customer is never told a closing time that then comes
 * sooner than promised.
 *
 * @param {Date} firstSentAt @param {any} rules
 * @returns {{codeEndsAt: Date, reminderAt: Date}}
 */
export function recoveryTimes(firstSentAt, rules) {
  const r = rules.cartRecovery;
  let codeEndsAt = addHours(firstSentAt, r.codeValidHours);
  let reminderAt = addMinutes(codeEndsAt, -r.finalBeforeEndMin);
  if (!withinWindow(reminderAt, r.sendWindow)) {
    reminderAt = nextWindowTime(reminderAt, r.sendWindow);
    codeEndsAt = addMinutes(reminderAt, r.finalBeforeEndMin);
  }
  return { codeEndsAt, reminderAt };
}

const istDayStart = (d) => {
  const p = istParts(d);
  return fromISTWall(p.y, p.mon, p.day, 0, 0).getTime();
};

/** "9:20 PM" in IST. @param {Date} date */
function istClock(date) {
  const p = istParts(date);
  const ampm = p.h >= 12 ? 'PM' : 'AM';
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${String(p.m).padStart(2, '0')} ${ampm}`;
}

/**
 * "today at 9:20 PM" / "tomorrow at 9:20 PM" / "14 Oct at 9:20 PM".
 *
 * A closing time is only useful if the customer can tell how long they have
 * without doing calendar arithmetic, which is why the near days are named.
 * @param {Date} date @param {Date} [now]
 */
export function formatExpiresAt(date, now = new Date()) {
  const days = Math.round((istDayStart(date) - istDayStart(now)) / (24 * HOUR));
  const time = istClock(date);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${formatISTDate(date)} at ${time}`;
}

/**
 * "2 hours" / "1 hour 40 minutes" / "50 minutes", rounded to 5 minutes.
 * Rounded because "1 hour 57 minutes" is a machine talking.
 * @param {number} ms
 */
export function formatTimeLeft(ms) {
  const mins = Math.max(0, Math.round(ms / 60000 / 5) * 5);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} minute${m === 1 ? '' : 's'}`;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m ? `${hours} ${m} minutes` : hours;
}
