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
export const getAwaiting = async (phone) => (await getProfile(phone)).awaiting || null;

// human takeover (coexistence echoes)
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

/** Increment and return the RTO count for a phone (drives rto-count-<n> + cod-block). */
export async function markRto(phone) {
  const p = await getProfile(phone);
  const rtoCount = (p.rtoCount || 0) + 1;
  await save({ ...p, rtoCount });
  return rtoCount;
}
