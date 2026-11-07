/*
 * orderState.mjs — ORDER#<id> items: STATE (one per order), MSG#<wamid>
 * (message log), SIDE#<action> (idempotency for external side effects).
 *
 * STATE is the durable per-order record: stored class (never reclassified),
 * verified phone, first name, amounts, AWB, courier status, per-flow sub-state.
 * All writes go through table.update (optimistic version); we retry once on a
 * conflict, which is enough at our per-order-serialized cadence.
 */
import { table, VersionConflict } from './table.mjs';
import { RULES } from '../../messages/rules.mjs';
import { setWamidMap } from './maps.mjs';

const pk = (id) => `ORDER#${id}`;
/*
 * DynamoDB's eviction time, in epoch seconds. Never derived from a business
 * deadline: a code's life, a lock's lease and a link's expiry are promises to
 * somebody, and letting one of those set `expiresAt` is how a row disappears
 * while it still matters.
 */
const ttl = (days, now = new Date()) => Math.floor(now.getTime() / 1000) + days * 86400;

export function getState(id) {
  return table.get(pk(id), 'STATE');
}

/** Create the STATE row once (first sight); returns the row (new or existing). */
export async function ensureState(id, init = {}) {
  const created = await table.putNew({
    PK: pk(id),
    SK: 'STATE',
    orderId: String(id),
    version: 0,
    flowA: {},
    /*
     * 400 days. Nothing expired before this, so every order added a STATE row
     * that stayed forever.
     *
     * Longer than the MSG# rows below on purpose: those are a log, this is the
     * order's memory. The P&L restates closed months, Flow R's repeat-customer
     * checks read back, and a replacement record already keeps 400 days, so a
     * state row expiring at 180 would leave all three reading a month whose
     * orders had gone.
     */
    expiresAt: ttl(RULES.stateTtlDays),
    ...init,
  });
  if (created) return getState(id);
  return getState(id);
}

/** Merge fields into STATE. Retries once on a version conflict. */
export async function patchState(id, fields) {
  try {
    return await table.update(pk(id), 'STATE', fields);
  } catch (e) {
    if (e instanceof VersionConflict) return table.update(pk(id), 'STATE', fields);
    throw e;
  }
}

/** Merge into the nested flowA sub-state. */
export async function patchFlowA(id, fields) {
  const s = (await getState(id)) || {};
  return patchState(id, { flowA: { ...(s.flowA || {}), ...fields } });
}

/** Merge into the nested flowB sub-state. */
export async function patchFlowB(id, fields) {
  const s = (await getState(id)) || {};
  return patchState(id, { flowB: { ...(s.flowB || {}), ...fields } });
}

/** Merge into the nested flowC sub-state. */
export async function patchFlowC(id, fields) {
  const s = (await getState(id)) || {};
  return patchState(id, { flowC: { ...(s.flowC || {}), ...fields } });
}

/** True once a side effect has been recorded (idempotency). */
export async function sideDone(id, action) {
  return Boolean(await table.get(pk(id), `SIDE#${action}`));
}

/** The stored result of a recorded side effect, or null. */
export async function getSide(id, action) {
  const r = await table.get(pk(id), `SIDE#${action}`);
  return r ? r.result : null;
}

/**
 * Run an external side effect exactly once per order+action. If already done,
 * returns the stored result; otherwise runs fn, records it, and returns it.
 */
export async function runOnce(id, action, fn) {
  const existing = await table.get(pk(id), `SIDE#${action}`);
  if (existing) return existing.result;
  const result = (await fn()) ?? null;
  await table.put({
    PK: pk(id),
    SK: `SIDE#${action}`,
    action,
    result,
    at: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + RULES.stateRetentionDays * 86400,
  });
  return result;
}

/**
 * Log an outbound message by wamid, and the reverse lookup that lets a delivery
 * status webhook find its way back to the order. Every send records here, so
 * this is the one place that has to know about both.
 */
export async function recordMessage(id, wamid, data) {
  if (!wamid) return;
  // A log, so stateRetentionDays rather than the state row's 400: nothing asks
  // what a six-month-old message's delivery status was.
  await table.put({
    PK: pk(id),
    SK: `MSG#${wamid}`,
    wamid,
    ...data,
    at: new Date().toISOString(),
    expiresAt: ttl(RULES.stateRetentionDays),
  });
  await setWamidMap(wamid, { orderId: String(id), key: data?.key || null });
}

// sent -> delivered -> read is the normal order, and `failed` is terminal.
// Webhooks are not ordered, so a status can arrive after a later one.
const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Update a stored message's status (from WhatsApp status webhooks).
 *
 * `status` only ever moves forward. Every status used to be written blindly,
 * which was harmless while only failures were recorded, but now that the whole
 * lifecycle lands here a late-arriving `sent` would overwrite `failed` and take
 * its errors with it, turning the one record that proves a customer was never
 * reached back into a clean send. The full sequence is still kept in `history`.
 */
export async function updateMessageStatus(id, wamid, status, errors) {
  const cur = (await table.get(pk(id), `MSG#${wamid}`)) || { PK: pk(id), SK: `MSG#${wamid}`, wamid };
  const history = [...(cur.history || []), { status, at: new Date().toISOString(), errors }];
  const keepCurrent = (STATUS_RANK[cur.status] || 0) > (STATUS_RANK[status] || 0);
  await table.put({
    ...cur,
    status: keepCurrent ? cur.status : status,
    errors: errors || cur.errors,
    history,
  });
}
