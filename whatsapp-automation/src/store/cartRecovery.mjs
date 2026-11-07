/*
 * cartRecovery.mjs — Flow R rows.
 *
 *   CART#<checkoutId> / REC            the recovery record
 *   CART#<checkoutId> / SIDE#<action>  idempotency for code, link, first, final
 *   CART#<checkoutId> / MSG#<wamid>    the message log for this checkout
 *   CARTREC#PHONE#<e164> / LOCK        the 30-day one-sequence-per-phone lease
 *   CARTLINK#<token> / MAP             the /r/ link -> checkoutId
 *
 * TWO THINGS HERE ARE LOAD-BEARING.
 *
 * 1. The sort key is REC, never STATE. reconcile's scanStates() treats every
 *    SK=STATE row in the table as an order and reads its id out of the PK, so
 *    a cart row with that sort key would be handed to flowB.onDelivered as
 *    order "CART#123..." by the nightly review sweep.
 *
 * 2. `expiresAt` is the table's TTL attribute. The code's own end time lives in
 *    `codeEndsAt` and MUST NOT go anywhere near expiresAt, or DynamoDB deletes
 *    the whole record at the moment the code closes, taking the attribution
 *    window, the reminder guard and the outcome with it.
 */
import { table, VersionConflict } from './table.mjs';
import { log } from '../log.mjs';
import { RULES } from '../../messages/rules.mjs';

const recPk = (id) => `CART#${id}`;
const lockPk = (phone) => `CARTREC#PHONE#${phone}`;
const linkPk = (token) => `CARTLINK#${token}`;
// One identity key, in the `p:`/`e:`/`c:` spelling identityKeys() produces.
const orderedPk = (key) => `CARTREC#ORDERED#${key}`;

/** TTL for a cart row: the service's normal retention, never the code end. */
const ttl = (now = new Date()) => Math.floor(now.getTime() / 1000) + RULES.stateRetentionDays * 86400;

export const getRec = (id) => table.get(recPk(id), 'REC');

/**
 * Create the REC row once. Returns `{created, rec}` so the caller can tell a
 * first sight from a redelivery without a second read.
 */
export async function ensureRec(id, init = {}, now = new Date()) {
  const created = await table.putNew({
    PK: recPk(id),
    SK: 'REC',
    checkoutId: String(id),
    version: 0,
    createdAt: now.toISOString(),
    // GSI2's sparse keys: see the note on allRecs below.
    kind: 'cartrec',
    kindAt: now.toISOString(),
    expiresAt: ttl(now),
    ...init,
  });
  return { created, rec: await getRec(id) };
}

/** Merge fields into the REC row. Retries once on a version conflict. */
export async function patchRec(id, fields) {
  try {
    return await table.update(recPk(id), 'REC', fields);
  } catch (e) {
    if (e instanceof VersionConflict) return table.update(recPk(id), 'REC', fields);
    throw e;
  }
}

/**
 * Record a terminal outcome, once.
 *
 * `outcome` is what stops the five-minute sweep re-enqueueing this checkout
 * forever, so it holds FINAL states only: a skip reason, `shadow`, `recovered`.
 * A successful send is not an outcome, because the sequence is still running.
 * First writer wins, so a later guard cannot relabel why we stopped.
 */
export async function setOutcome(id, outcome, fields = {}) {
  const cur = await getRec(id);
  if (cur?.outcome) return cur;
  return patchRec(id, { outcome, outcomeAt: new Date().toISOString(), ...fields });
}

/*
 * A checkout Meta refused (131049), parked against its phone.
 *
 * 131049 is the per-user MARKETING cap and it is counted across every business
 * that messages that person, so there is nothing on our side to tune and no
 * point retrying the template on a timer: it fails again. What DOES clear it
 * is the customer opening a 24 hour service window by writing to us, because a
 * free-form reply is not a template and is not capped. So the checkout waits
 * here, keyed by phone, and onWindowOpen delivers it the moment they do.
 *
 * SK is 'WAIT', deliberately not 'REC' (scanned for the digest) or 'STATE'
 * (read as an order by the nightly sweep).
 */
export async function parkForWindow(phone, checkoutId, until, now = new Date()) {
  await table.put({
    PK: lockPk(phone),
    SK: 'WAIT',
    checkoutId: String(checkoutId),
    until: until.toISOString(),
    at: now.toISOString(),
    expiresAt: ttl(now),
  });
}
export const getParked = (phone) => table.get(lockPk(phone), 'WAIT');
export const clearParked = (phone) => table.del(lockPk(phone), 'WAIT');

/** Run a side effect exactly once per checkout+action (code, link, first, final). */
export async function cartRunOnce(id, action, fn) {
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
 * Log an outbound cart message and the reverse lookup for its delivery status.
 *
 * The WAMID row carries `cartId` and NO `orderId`, deliberately. onWaStatus
 * tags the order and alerts the owner on a failure, and a checkout has no
 * order: handing it one would make it tag `gid://shopify/Order/<checkoutId>`,
 * which is a real id pointing at nothing.
 */
export async function recordCartMessage(id, wamid, data) {
  if (!wamid) return;
  await table.put({
    PK: recPk(id),
    SK: `MSG#${wamid}`,
    wamid,
    ...data,
    at: new Date().toISOString(),
    expiresAt: ttl(),
  });
  await table.put({ PK: `WAMID#${wamid}`, SK: 'MAP', cartId: String(id), key: data?.key || null });
}

/*
 * THIS PERSON HAS ORDERED, recorded by us at the moment the webhook arrives.
 *
 * It exists because `orders(query: "created_at:>=...")` is a SEARCH, and
 * Shopify's order search index lags a create by seconds: the five minute sweep
 * can land inside that gap, ask "has this person ordered", be told no, and
 * send. The webhook carries no such lag, so the answer is kept here as well and
 * read first. Written per IDENTITY KEY rather than per checkout, because at
 * webhook time the checkout this belongs to may have no record yet, and
 * because an order can name the person by an email or a customer id and carry
 * no phone at all.
 */
export async function markOrdered(key, { orderId, at, now = new Date() }) {
  if (!key) return;
  await table.put({
    PK: orderedPk(key),
    SK: 'ORDERED',
    key,
    orderId: String(orderId ?? ''),
    at: (at || now).toISOString(),
    /*
     * SEVEN DAYS, not the table's 180. orderedSince only ever looks back over
     * the longest a sequence can live (36 hours), so a row older than that is
     * read and ignored. This key is derived from a customer's phone number and
     * there is no reason to hold it for five months to answer a question about
     * yesterday.
     */
    expiresAt: Math.floor(now.getTime() / 1000) + 7 * 86400,
  });
}
export const getOrdered = (key) => (key ? table.get(orderedPk(key), 'ORDERED') : Promise.resolve(null));

export const getPhoneLock = (phone) => table.get(lockPk(phone), 'LOCK');

/**
 * Take the one-sequence-per-phone lease, or report that somebody else holds it.
 *
 * Written ONLY after Meta accepts message 1: locking before the send would
 * burn the customer's next thirty days on a message that never left.
 */
export async function lockPhone(phone, { checkoutId, until, now = new Date() }) {
  return table.putIfFree(
    {
      PK: lockPk(phone),
      SK: 'LOCK',
      phone,
      checkoutId: String(checkoutId),
      lockUntil: until.toISOString(),
      lockedAt: now.toISOString(),
      expiresAt: ttl(now),
    },
    'lockUntil',
    now.toISOString(),
  );
}

/** Give the lease back. Used when message 1 was accepted and then failed to deliver. */
export const releasePhoneLock = (phone) => table.del(lockPk(phone), 'LOCK');

export const setCartLinkMap = (token, checkoutId) =>
  table.put({ PK: linkPk(token), SK: 'MAP', checkoutId: String(checkoutId), expiresAt: ttl() });
export const getCartLinkMap = (token) => table.get(linkPk(token), 'MAP');

/**
 * The CART REC rows, for the digest and for attributing an order to a cart.
 *
 * A QUERY on GSI2 rather than a table Scan. `onOrderCreated` called this on
 * EVERY orders/create, and the digest calls it once a day, and a Scan is billed
 * for every row it evaluates rather than for the handful it returns.
 *
 * STILL FILTERED BY PK. The old scanBySk matched on the sort key with no PK
 * condition at all, so it was "every row in the table whose SK is REC" and the
 * digest's "carts messaged" count was one new flow away from counting somebody
 * else's records. The `kind` key makes that structurally impossible now, and
 * the PK filter stays anyway: two guarantees cost one comparison.
 *
 * The scan fallback covers one window only, between the deploy that adds the
 * index and the backfill. Delete it once backfill-kind.mjs has run --live.
 *
 * @param {string} [sinceISO] ignore records older than this
 */
export async function allRecs(sinceISO) {
  const mine = (rows) => rows.filter((rec) => String(rec.PK || '').startsWith('CART#'));
  const rows = mine(await table.queryKind('cartrec', { sinceISO }));
  if (rows.length) return rows;
  const scanned = mine(await table.scanBySk('REC')).filter(
    (rec) => !sinceISO || String(rec.createdAt || '') >= sinceISO,
  );
  if (scanned.length) {
    log.warn('cartRecovery: GSI2 is empty but rows exist, run scripts/backfill-kind.mjs --live', { found: scanned.length });
  }
  return scanned;
}

/**
 * True the FIRST time today this label is raised, false afterwards.
 *
 * For owner alerts whose cause is account-wide rather than per-customer: an
 * unusable template or a missing API scope fails for every checkout at once,
 * and the owner needs one line a day about it, not one per abandoned cart.
 */
export async function alertOncePerDay(label, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return table.putNew({
    PK: `CARTREC#ALERT#${label}`,
    SK: `DAY#${day}`,
    at: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + 7 * 86400,
  });
}
