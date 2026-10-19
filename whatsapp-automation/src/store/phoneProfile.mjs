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
export const setAwaiting = (phone, awaiting) => patch(phone, { awaiting });
export const clearAwaiting = (phone) => patch(phone, { awaiting: null });
/**
 * The open question this phone still owes an answer to, or null.
 *
 * `until` was written by every setAwaiting caller and read by NONE, so an
 * unanswered question stayed open forever: a customer asked for their address
 * after a failed delivery, never replied, and then months later sent an
 * unrelated "hi" that was read as the address for a long-closed order (and
 * pushed to the courier as an address edit). Expiring it here means every
 * caller gets it, which is the only place that is true.
 */
export async function getAwaiting(phone, now = new Date()) {
  const a = (await getProfile(phone)).awaiting;
  if (!a) return null;
  if (a.until && new Date(a.until).getTime() <= now.getTime()) return null;
  return a;
}

// human takeover (coexistence echoes)
//
// NOT BUILT. Nothing calls setHumanTakeover and nothing calls inHumanTakeover,
// and RULES.humanTakeoverHours is referenced nowhere else in the service, so
// treat these three as a design that was never wired up rather than as working
// behaviour. It matters because this number is in COEXISTENCE mode: the owner
// answers from the WhatsApp app on their phone, and the bot will happily send a
// template into the middle of that conversation.
//
// Finishing it needs a piece we do not have yet: the Meta app must be
// subscribed to the `message_echoes` webhook field so we see messages the owner
// sent by hand. Once those arrive, call setHumanTakeover(phone, +12h) on each
// echo and add inHumanTakeover to the guard in send.mjs tpl(), next to the
// opt-out and undeliverable checks.
export const setHumanTakeover = (phone, until) => patch(phone, { humanTakeoverUntil: until });
export async function inHumanTakeover(phone, now = new Date()) {
  const p = await getProfile(phone);
  return Boolean(p.humanTakeoverUntil && new Date(p.humanTakeoverUntil).getTime() > now.getTime());
}

// caps
export async function canSendMarketing(phone, now, days) {
  return !withinDays((await getProfile(phone)).lastMarketingAt, now, days);
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
