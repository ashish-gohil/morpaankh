/*
 * phoneProfile.mjs — PHONE#<e164>/PROFILE: opt-out, 24h window, awaiting-state,
 * human takeover, and the per-phone caps (marketing, review asks).
 */
import { table } from './table.mjs';
import { withinDays } from '../lib/time.mjs';

const pk = (phone) => `PHONE#${phone}`;
const DAY = 86400 * 1000;

export async function getProfile(phone) {
  return (await table.get(pk(phone), 'PROFILE')) || { PK: pk(phone), SK: 'PROFILE', phone };
}
async function save(profile) {
  await table.put({ ...profile, PK: pk(profile.phone), SK: 'PROFILE', updatedAt: new Date().toISOString() });
}
async function patch(phone, fields) {
  const p = await getProfile(phone);
  const next = { ...p, ...fields };
  await save(next);
  return next;
}

// opt-out
export const isOptedOut = async (phone) => Boolean((await getProfile(phone)).optOut);
export const setOptOut = (phone, optOut) => patch(phone, { optOut, optOutAt: optOut ? new Date().toISOString() : null });

// inbound / 24h session window
export const touchInbound = (phone, now = new Date()) => patch(phone, { lastInboundAt: now.toISOString() });
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

export async function canAskReview(phone, now, days) {
  return !withinDays((await getProfile(phone)).lastReviewAskAt, now, days);
}
export const markReviewAsk = (phone, now = new Date()) => patch(phone, { lastReviewAskAt: now.toISOString() });

export const setUndeliverable = (phone) => patch(phone, { undeliverable: true, undeliverableAt: new Date().toISOString() });
/** Meta has told us (131026) this number cannot receive WhatsApp. */
export const isUndeliverable = async (phone) => Boolean((await getProfile(phone)).undeliverable);

/** Increment and return the RTO count for a phone (drives rto-count-<n> + cod-block). */
export async function markRto(phone) {
  const p = await getProfile(phone);
  const rtoCount = (p.rtoCount || 0) + 1;
  await save({ ...p, rtoCount });
  return rtoCount;
}
