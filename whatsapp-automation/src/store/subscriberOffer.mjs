/*
 * subscriberOffer.mjs — Flow W rows.
 *
 *   SUBOFFER#<customerId>      / SUB              the offer record
 *   SUBOFFER#<customerId>      / SIDE#<action>    idempotency for code, link
 *   SUBOFFER#<customerId>      / MSG#<wamid>      the message log
 *   SUBOFFER#PHONE#<e164>      / LOCK             the LIFETIME lock, no TTL
 *   SUBOFFER#PHONE#<e164>      / WAIT             the 131049 park
 *   SUBOFFER#EMAIL#<sha256>    / LOCK             the LIFETIME lock, no TTL
 *   SUBOFFER#RUN#<IST date>    / DAY              the sweep's day marker
 *   SUBLINK#<token>            / MAP              token -> customerId
 *   SUBCODE#<CODE>             / MAP              code -> customerId
 *   SUBOFFER#ALERT#<label>     / DAY#<yyyy-mm-dd> alertOncePerDay
 *
 * THREE THINGS HERE ARE LOAD-BEARING.
 *
 * 1. THE SORT KEY IS 'SUB'. It is never 'REC' and never 'STATE'. reconcile's
 *    scanStates() hands every SK=STATE row to flowB.onDelivered as an order
 *    and reads the id out of the PK; the daily digest counts every SK=REC row
 *    as a cart Flow R messaged. A Flow W row under either would be messaged or
 *    counted as something it is not, every single day. allSubRecs() below is
 *    scanBySk('SUB'), which for the same reason cannot see a Flow R row.
 *
 * 2. THE TWO LIFETIME LOCKS HAVE NO `expiresAt`, DELIBERATELY. The offer is
 *    once per person EVER, and `expiresAt` is the table's TTL attribute, so a
 *    lock carrying one would be deleted by DynamoDB and the same person would
 *    be offered a second private code. For the same reason they are written
 *    with putNew (attribute_not_exists) and not putIfFree: putIfFree needs an
 *    ISO field that expires, and a lifetime lock has none.
 *
 * 3. The code's own end time lives in `codeEndsAt` and MUST NOT go anywhere
 *    near `expiresAt`, or Dynamo deletes the record at the moment the code
 *    closes and takes the attribution window and the outcome with it.
 */
import { table, VersionConflict } from './table.mjs';
import { RULES } from '../../messages/rules.mjs';

const recPk = (id) => `SUBOFFER#${id}`;
const phonePk = (phone) => `SUBOFFER#PHONE#${phone}`;
const emailPk = (key) => `SUBOFFER#EMAIL#${key}`;
const linkPk = (token) => `SUBLINK#${token}`;
const codePk = (code) => `SUBCODE#${String(code).toUpperCase()}`;

/** TTL for a Flow W row: the service's normal retention, never the code end. */
const ttl = (now = new Date()) => Math.floor(now.getTime() / 1000) + RULES.stateRetentionDays * 86400;

export const getSubRec = (id) => table.get(recPk(id), 'SUB');

/**
 * Create the SUB row once. Returns `{created, rec}` so the caller can tell a
 * first sight from an SQS redelivery without a second read.
 */
export async function ensureSubRec(id, init = {}, now = new Date()) {
  const created = await table.putNew({
    PK: recPk(id),
    SK: 'SUB',
    customerId: String(id),
    version: 0,
    createdAt: now.toISOString(),
    expiresAt: ttl(now),
    ...init,
  });
  return { created, rec: await getSubRec(id) };
}

/** Merge fields into the SUB row. Retries once on a version conflict. */
export async function patchSubRec(id, fields) {
  try {
    return await table.update(recPk(id), 'SUB', fields);
  } catch (e) {
    if (e instanceof VersionConflict) return table.update(recPk(id), 'SUB', fields);
    throw e;
  }
}

/**
 * Record a terminal outcome, once.
 *
 * FIRST WRITER WINS, so a later guard cannot relabel why we stopped. A
 * successful send is deliberately NOT an outcome: `outcome` holds the reasons
 * we stopped, and `converted` has to be able to land on this record weeks
 * later without losing to the guard above it.
 */
export async function setSubOutcome(id, outcome, fields = {}) {
  const cur = await getSubRec(id);
  if (cur?.outcome) return cur;
  return patchSubRec(id, { outcome, outcomeAt: new Date().toISOString(), ...fields });
}

/** Run a side effect exactly once per customer+action (code, link). */
export async function subRunOnce(id, action, fn) {
  const existing = await table.get(recPk(id), `SIDE#${action}`);
  if (existing) return existing.result;
  const result = (await fn()) ?? null;
  await table.put({
    PK: recPk(id),
    SK: `SIDE#${action}`,
    action,
    result,
    at: new Date().toISOString(),
    expiresAt: ttl(),
  });
  return result;
}

/**
 * Log an outbound Flow W message and the reverse lookup for its delivery status.
 *
 * The WAMID row carries `customerId` and NO `orderId` and NO `cartId`. The
 * order path tags the order and alerts the owner by order name, and a customer
 * id is neither an order nor a checkout: handing it one would tag
 * `gid://shopify/Order/<customerId>`, a well-formed id pointing at nothing.
 */
export async function recordSubMessage(id, wamid, data) {
  if (!wamid) return;
  await table.put({
    PK: recPk(id),
    SK: `MSG#${wamid}`,
    wamid,
    ...data,
    at: new Date().toISOString(),
    expiresAt: ttl(),
  });
  await table.put({ PK: `WAMID#${wamid}`, SK: 'MAP', customerId: String(id), key: data?.key || null });
}

// ---- the two lifetime locks ------------------------------------------------
export const getPhoneOfferLock = (phone) => table.get(phonePk(phone), 'LOCK');
export const getEmailOfferLock = (key) => table.get(emailPk(key), 'LOCK');

/**
 * Take the once-per-person-ever lock on a number.
 *
 * Written ONLY after the provider accepts the message: a lock on a message
 * nobody received would burn that person's one welcome offer for ever. Returns
 * false when somebody already holds it, and does not overwrite.
 */
export const lockPhoneOffer = (phone, { customerId, now = new Date() }) =>
  table.putNew({ PK: phonePk(phone), SK: 'LOCK', phone, customerId: String(customerId), lockedAt: now.toISOString() });

/**
 * The same lock on an email address, keyed by its sha256.
 *
 * This is the one that stops the obvious farm: a fresh customer record with a
 * new phone number and the same address would otherwise earn a second Rs 200
 * code. The row holds the hash and never the address.
 */
export const lockEmailOffer = (key, { customerId, now = new Date() }) =>
  table.putNew({ PK: emailPk(key), SK: 'LOCK', customerId: String(customerId), lockedAt: now.toISOString() });

export const releasePhoneOfferLock = (phone) => table.del(phonePk(phone), 'LOCK');
export const releaseEmailOfferLock = (key) => table.del(emailPk(key), 'LOCK');

/**
 * Is there a live, unused Flow W code against this number?
 *
 * ONE LIVE PRIVATE CODE PER PHONE. Flow R asks this before it mints its own,
 * because both flows make a MORPAANKH code against the same person and the
 * theme's offers script keeps whichever one the link applied: two live codes
 * means the customer can be holding a code the message they are reading does
 * not mention.
 */
export async function liveSubscriberOffer(phone, now = new Date()) {
  const lock = await getPhoneOfferLock(phone);
  if (!lock?.customerId) return null;
  const rec = await getSubRec(lock.customerId);
  if (!rec?.code || rec.codeUsed) return null;
  if (!rec.codeEndsAt || new Date(rec.codeEndsAt).getTime() <= now.getTime()) return null;
  return rec;
}

// ---- the 131049 park -------------------------------------------------------
/*
 * An offer Meta refused with 131049, parked against its phone.
 *
 * 131049 is the per-user MARKETING cap, counted across every business that
 * messages that person, so there is nothing on our side to tune and no point
 * retrying the template: it fails again. What DOES clear it is the customer
 * opening a 24 hour service window by writing to us, because a free-form reply
 * is not a template and is not capped. The park lives exactly as long as the
 * code does, so onWindowOpen can never deliver a dead offer.
 */
export async function parkSubForWindow(phone, customerId, until, now = new Date()) {
  await table.put({
    PK: phonePk(phone),
    SK: 'WAIT',
    customerId: String(customerId),
    until: until.toISOString(),
    at: now.toISOString(),
    expiresAt: ttl(now),
  });
}
export const getSubParked = (phone) => table.get(phonePk(phone), 'WAIT');
export const clearSubParked = (phone) => table.del(phonePk(phone), 'WAIT');

// ---- the link and code maps ------------------------------------------------
export const setSubLinkMap = (token, customerId, channel) =>
  table.put({ PK: linkPk(token), SK: 'MAP', customerId: String(customerId), channel: channel || null, expiresAt: ttl() });
export const getSubLinkMap = (token) => table.get(linkPk(token), 'MAP');

/**
 * code -> customer, for attribution.
 *
 * Needed because a Flow W candidate has no order and no phone lock to key an
 * incoming order off: the code on the order is the only link back. Stored
 * upper-cased, because Shopify echoes a code in whatever case the shopper
 * typed it.
 */
export const setSubCodeMap = (code, customerId) =>
  table.put({ PK: codePk(code), SK: 'MAP', customerId: String(customerId), expiresAt: ttl() });
export const getSubCodeMap = (code) => table.get(codePk(code), 'MAP');

// ---- the sweep's day marker ------------------------------------------------
/*
 * Written ONLY after a complete sweep. A run that died half way leaves no
 * marker, so the next run reads the same IST day again, which is SAFE and has
 * to stay safe: the dedupId is identical so SQS drops the duplicate, and
 * anyone the worker already reached has a SUB row that stops them being
 * enqueued a second time. A marker written over a half-read day is the one
 * failure this flow cannot recover from, because the offer is once per person
 * ever and the sweep never looks at that day again.
 */
export const getSweepDay = (date) => table.get(`SUBOFFER#RUN#${date}`, 'DAY');
export const setSweepDay = (date, data = {}, now = new Date()) =>
  table.put({ PK: `SUBOFFER#RUN#${date}`, SK: 'DAY', date, ...data, at: now.toISOString(), expiresAt: ttl(now) });

/** Every SUB row, for the digest and for `subscriber-offer.mjs preview`. */
export const allSubRecs = () => table.scanBySk('SUB');

/**
 * True the FIRST time today this label is raised, false afterwards.
 *
 * For owner alerts whose cause is account-wide rather than per-customer: an
 * unapproved template or a missing API scope fails for every candidate at
 * once, and the owner needs one line a day about it, not one per signup. The
 * PK prefix is Flow W's own, so a label Flow R also uses cannot swallow this
 * flow's alert for the day.
 */
export async function subAlertOncePerDay(label, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return table.putNew({
    PK: `SUBOFFER#ALERT#${label}`,
    SK: `DAY#${day}`,
    at: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + 7 * 86400,
  });
}

/** Count a real tap on the /w/ link. First tap keeps its own timestamp. */
export async function countSubClick(id, now = new Date()) {
  const rec = await getSubRec(id);
  const fields = { clicks: (rec?.clicks || 0) + 1, lastClickAt: now.toISOString() };
  if (!rec?.firstClickAt) fields.firstClickAt = now.toISOString();
  return patchSubRec(id, fields);
}
