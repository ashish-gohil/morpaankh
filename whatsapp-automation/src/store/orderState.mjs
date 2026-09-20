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

const pk = (id) => `ORDER#${id}`;

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

/** Log an outbound message by wamid. */
export async function recordMessage(id, wamid, data) {
  if (!wamid) return;
  await table.put({ PK: pk(id), SK: `MSG#${wamid}`, wamid, ...data, at: new Date().toISOString() });
}

/** Update a stored message's status (from WhatsApp status webhooks). */
export async function updateMessageStatus(id, wamid, status, errors) {
  const cur = (await table.get(pk(id), `MSG#${wamid}`)) || { PK: pk(id), SK: `MSG#${wamid}`, wamid };
  const history = [...(cur.history || []), { status, at: new Date().toISOString(), errors }];
  await table.put({ ...cur, status, errors, history });
}
