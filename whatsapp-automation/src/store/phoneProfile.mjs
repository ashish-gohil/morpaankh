/*
 * phoneProfile.mjs — PHONE#<e164>/PROFILE: opt-out, 24h window, awaiting-state,
 * human takeover, and the per-phone caps (marketing, review asks).
 */
import { table, VersionConflict } from './table.mjs';
import { withinDays } from '../lib/time.mjs';
import { RULES } from '../../messages/rules.mjs';
import { log } from '../log.mjs';

const pk = (phone) => `PHONE#${phone}`;
const DAY = 86400 * 1000;

export async function getProfile(phone) {
  return (await table.get(pk(phone), 'PROFILE')) || { PK: pk(phone), SK: 'PROFILE', phone };
}
/**
 * Merge fields into the profile. Retries once on a version conflict.
 *
 * This used to read the whole profile and put it back wholesale, with no
 * version check, so two writers for the same phone silently lost one of the two
 * writes. That is not theoretical: the queue serializes by ORDER, not by phone,
 * so a customer with two open orders has two records in flight at once. The
 * write that loses is arbitrary, and the one that matters most is the smallest:
 * a customer sends STOP (setOptOut) while a timer for their other order stamps
 * lastMarketingAt, the stamp is written over the opt-out, and we keep marketing
 * to someone who asked us to stop. Same shape erases `undeliverable` and
 * `awaiting`. table.update is conditional on the version it read, so the loser
 * now throws and retries against the winner's row instead of overwriting it.
 */
async function patch(phone, fields) {
  const attrs = { ...fields, phone };
  try {
    return await table.update(pk(phone), 'PROFILE', attrs);
  } catch (e) {
    if (e instanceof VersionConflict) return table.update(pk(phone), 'PROFILE', attrs);
    throw e;
  }
}

// opt-out
export const isOptedOut = async (phone) => Boolean((await getProfile(phone)).optOut);
export const setOptOut = (phone, optOut) => patch(phone, { optOut, optOutAt: optOut ? new Date().toISOString() : null });

// inbound / 24h session window
/**
 * Record an inbound message, and take the number off the undeliverable list.
 *
 * An inbound message is the strongest proof there is that this number receives
 * WhatsApp: it just sent us one. Without this clear, a number that bounced once
 * with 131026 stayed blocked even after its owner installed WhatsApp and wrote
 * to us by hand, and every later order of theirs went unanswered.
 */
export async function touchInbound(phone, now = new Date()) {
  const p = await getProfile(phone);
  const fields = { lastInboundAt: now.toISOString() };
  if (p.undeliverable) {
    fields.undeliverable = false;
    fields.undeliverableAt = null;
    log.info('phone: inbound message clears the undeliverable flag', {});
  }
  return patch(phone, fields);
}
export async function windowOpen(phone, now = new Date(), safetyMinutes = 10) {
  const p = await getProfile(phone);
  if (!p.lastInboundAt) return false;
  const elapsed = now.getTime() - new Date(p.lastInboundAt).getTime();
  return elapsed < DAY - safetyMinutes * 60 * 1000;
}

// awaiting free-text (address / other reason)
/**
 * Open a question against ONE ORDER, without closing the others.
 *
 * `awaiting` was a single slot, so a customer with two orders in trouble lost
 * one of the two questions silently: the NDR address question for order X was
 * overwritten by the RTO "why" question for order Y, and their next message
 * was then read as the answer to whichever question happened to survive. On
 * the address path that means an address pushed to the courier against the
 * wrong waybill.
 *
 * Keyed by order id now. The legacy single `awaiting` field is still READ by
 * getAwaiting, so questions open at deploy time are not dropped.
 */
export async function setAwaiting(phone, awaiting) {
  const orderId = String(awaiting?.orderId || '');
  if (!orderId) return patch(phone, { awaiting });
  const cur = (await getProfile(phone)).awaitingBy || {};
  return patch(phone, { awaitingBy: { ...cur, [orderId]: { ...awaiting, orderId } }, awaiting: null });
}

/**
 * Close one order's question, or all of them when no order is named.
 */
export async function clearAwaiting(phone, orderId) {
  if (!orderId) return patch(phone, { awaiting: null, awaitingBy: {} });
  const cur = (await getProfile(phone)).awaitingBy || {};
  const next = { ...cur };
  delete next[String(orderId)];
  return patch(phone, { awaitingBy: next, awaiting: null });
}

/**
 * Every question this phone still owes an answer to.
 *
 * `until` was written by every setAwaiting caller and read by NONE, so an
 * unanswered question stayed open forever: a customer asked for their address
 * after a failed delivery, never replied, and then months later sent an
 * unrelated "hi" that was read as the address for a long-closed order (and
 * pushed to the courier as an address edit). Expiring it here means every
 * caller gets it, which is the only place that is true.
 */
export async function listAwaiting(phone, now = new Date()) {
  const p = await getProfile(phone);
  const all = Object.values(p.awaitingBy || {});
  // The pre-deploy single slot, so a question open at deploy time still works.
  if (p.awaiting) all.push(p.awaiting);
  return all.filter((a) => a && (!a.until || new Date(a.until).getTime() > now.getTime()));
}

/**
 * The ONE open question, or null when there are none or more than one.
 *
 * Null for "more than one" on purpose: with two open, no reading of a free-text
 * reply is safe, and the router asks rather than guesses.
 */
export async function getAwaiting(phone, now = new Date()) {
  const live = await listAwaiting(phone, now);
  return live.length === 1 ? live[0] : null;
}

/*
 * human takeover (coexistence echoes)
 *
 * WIRED UP (N2, 2026-11-07). This number is in COEXISTENCE mode: the owner
 * answers customers from the WhatsApp Business app on their phone, and until
 * now the service could not see those messages at all, so it would drop a
 * template into the middle of a conversation somebody was having by hand.
 *
 * The missing piece was the `smb_message_echoes` webhook field, which Meta
 * only sends once the app is subscribed to it. The ingest reads those echoes
 * now and the worker calls setHumanTakeover on each one; tpl() refuses a
 * business-initiated template to a phone in takeover.
 *
 * M6 is still required: this does nothing until the field is subscribed in the
 * Meta App Dashboard. The code is inert rather than wrong without it.
 */
export const setHumanTakeover = (phone, until) => patch(phone, { humanTakeoverUntil: until });
export async function inHumanTakeover(phone, now = new Date()) {
  const p = await getProfile(phone);
  return Boolean(p.humanTakeoverUntil && new Date(p.humanTakeoverUntil).getTime() > now.getTime());
}

/*
 * N10. A customer turning marketing off INSIDE WhatsApp.
 *
 * They never sent us STOP, so nothing in this service knew: it would keep
 * sending marketing templates, Meta would refuse each one, and the refusals
 * would read as a throttle rather than as a person who asked us to stop. Which
 * is worse than it sounds, because every refusal looks like the thing we
 * already tolerate.
 *
 * SEPARATE from optOut, deliberately. optOut is this service's own record of
 * someone replying STOP here, and it blocks everything we start; this blocks
 * MARKETING only, which is what the customer actually turned off, and it is
 * theirs to turn back on.
 */
export const setMarketingOptOut = (phone, off, now = new Date()) =>
  patch(phone, { marketingOptOut: Boolean(off), marketingOptOutAt: off ? now.toISOString() : null });

// caps
export async function canSendMarketing(phone, now, days) {
  const p = await getProfile(phone);
  // Their own choice, made in WhatsApp rather than to us. See setMarketingOptOut.
  if (p.marketingOptOut) return false;
  return !withinDays(p.lastMarketingAt, now, days);
}
export const markMarketing = (phone, now = new Date()) => patch(phone, { lastMarketingAt: now.toISOString() });
/*
 * Give the cap back when the message never arrived.
 *
 * markMarketing is called at SEND time, because that is the only moment the
 * flow still has the phone in hand. A delivery failure arrives seconds later
 * and means the customer received NOTHING, so the stamp is then recording a
 * message that does not exist, and it bars that person from marketing for
 * marketingCapDays over something they never saw.
 *
 * Measured on this store: Meta's 131049 throttle rejected two of the first
 * three cart recovery sends, and each rejection silently cost that customer
 * the next seven days.
 */
export const clearMarketing = (phone) => patch(phone, { lastMarketingAt: null });

export async function canAskReview(phone, now, days) {
  return !withinDays((await getProfile(phone)).lastReviewAskAt, now, days);
}
export const markReviewAsk = (phone, now = new Date()) => patch(phone, { lastReviewAskAt: now.toISOString() });

export const setUndeliverable = (phone) => patch(phone, { undeliverable: true, undeliverableAt: new Date().toISOString() });
/** A delivered message, or an inbound one, proves the number works after all. */
export const clearUndeliverable = (phone) => patch(phone, { undeliverable: false, undeliverableAt: null });

/**
 * Meta has told us (131026) this number cannot receive WhatsApp, recently.
 *
 * 131026 is NOT a permanent verdict. Meta returns it when the number has no
 * WhatsApp account, when its owner has not accepted the current terms, and when
 * their app is too old to render the message. All three get fixed by the
 * customer without telling us. Treating the first bounce as final meant one bad
 * moment silenced that customer across every future order, for good, including
 * their dispatch and delivery updates. Expire it instead, so the number gets
 * one more chance later, and the flag still does its job in the window that
 * matters: no repeat billing and no quality-rating damage today.
 */
export async function isUndeliverable(phone, now = new Date()) {
  const p = await getProfile(phone);
  if (!p.undeliverable) return false;
  if (!p.undeliverableAt) return true; // flagged before we recorded a time: stay safe
  return withinDays(p.undeliverableAt, now, RULES.undeliverableRetryDays);
}

/** Increment and return the RTO count for a phone (drives rto-count-<n> + cod-block). */
export async function markRto(phone) {
  // Read-increment-write, so it needs the version it read as the condition:
  // patch() alone would retry with a count computed from the losing row and
  // two RTOs landing together would count as one, which is the difference
  // between a cod-block and none.
  for (let i = 0; i < 3; i += 1) {
    const p = await getProfile(phone);
    try {
      const next = await table.update(pk(phone), 'PROFILE', { phone, rtoCount: (p.rtoCount || 0) + 1 }, p.version || 0);
      return next.rtoCount;
    } catch (e) {
      if (!(e instanceof VersionConflict) || i === 2) throw e;
    }
  }
  throw new Error('markRto: unreachable');
}

/*
 * PHONE#<e164> / OFFERWAIT — a prepaid offer Meta refused, waiting for a window.
 *
 * Flows R and W both park a refused MARKETING send against the phone and
 * deliver it free-form when the customer next writes in. Flow A was the one
 * that did not: a prepaid_offer refused with 131049 or 130472 was simply gone,
 * and the order was tagged wa-undeliverable and reported to the owner as a
 * customer who had not been told, which was false. They had been told. The
 * cod_confirm reached them; it was the optional discount that bounced.
 *
 * Its own sort key rather than a field on PROFILE, because patch() merges and
 * two orders for one phone can be in flight at once; and keyed by phone rather
 * than by order because the thing we are waiting for is the PHONE's window.
 *
 * `until` is the payment link's own expiry, so the park dies with the offer it
 * is holding. expiresAt is a separate 7 day floor purely so the row cannot
 * outlive its usefulness in the table: never derived from the business
 * deadline, which is what `until` is for.
 */
const OFFERWAIT = 'OFFERWAIT';

export async function parkOffer(phone, orderId, until, now = new Date()) {
  await table.put({
    PK: pk(phone),
    SK: OFFERWAIT,
    phone,
    orderId: String(orderId),
    until: until ? new Date(until).toISOString() : null,
    parkedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + 7 * 86400,
  });
}

export const getParkedOffer = (phone) => table.get(pk(phone), OFFERWAIT);
export const clearParkedOffer = (phone) => table.del(pk(phone), OFFERWAIT);

/*
 * N9. WACOUNT#<yyyy-mm> — what WhatsApp cost this month, and what Meta refused.
 *
 * Nothing said what this service spends. The owner could read it in WhatsApp
 * Manager, which is a different screen from everything else they look at and
 * does not appear in the daily digest or the P&L, so the single largest
 * variable cost in the automation was invisible next to freight and COGS.
 *
 * ONE ROW A MONTH, many counters on it, incremented atomically: the queue
 * serialises by order and not by month, so a read-modify-write would lose
 * increments and a cost meter that under-reports is worse than none.
 *
 * Sort keys:
 *   <category>#billable   delivered and charged (marketing, utility, service)
 *   <category>#free       delivered inside an allowance
 *   SERVICE               O8's free-form sends, for the 1,000 a month allowance
 *   REFUSED#<code>        131049, 130472, 131026: not billed, but the share of
 *                         sends Meta turns away is the number that explains why
 *                         a flow "is not working"
 */
const countPk = (month) => `WACOUNT#${month}`;

export async function countWaMessage(month, sk, now = new Date()) {
  return table.addCount(countPk(month), sk, 'count', 1, {
    month,
    expiresAt: Math.floor(now.getTime() / 1000) + 400 * 86400,
  });
}

/** Every counter for a month, as { [sk]: count }. */
export async function waCounts(month) {
  const rows = await table.query(countPk(month));
  return Object.fromEntries(rows.map((r) => [String(r.SK), Number(r.count) || 0]));
}
