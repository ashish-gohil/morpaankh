/*
 * flowC.run.mjs — Flow C: NDR rescue + RTO reason capture.
 * NDR: one action prompt per failed attempt; re-attempt / same-pincode address
 * edit / cancel. RTO: tag, stop other flows, capture the reason, apply cod-block
 * when warranted. All sends DRY_RUN + allowlist gated; writes idempotent.
 */
import { RULES } from '../../messages/rules.mjs';
import { RTO_REASONS, COD_BLOCK_REASONS } from '../../messages/labels.mjs';
import { classifyAddressReply } from '../domain/ndr.mjs';
import { addHours, addDays, nextWindowTime, withinWindow } from '../lib/time.mjs';
import { getState, patchFlowC, runOnce } from '../store/orderState.mjs';
import { touchInbound, setAwaiting, clearAwaiting, markRto } from '../store/phoneProfile.mjs';
import { scheduleTimer } from '../timers/schedule.mjs';
import { getNorm, tpl, sess, ownerAlert } from './send.mjs';
import * as flowA from './flowA.run.mjs';
import { log } from '../log.mjs';
import { soft } from '../lib/resilience.mjs';

const nowOf = (deps) => deps.now || new Date();

// ---- NDR --------------------------------------------------------------------
export async function onNdr(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n || n.cancelledAt || !n.verifiedPhone) return;
  // Send only inside the NDR window; otherwise defer to the next window start.
  if (!withinWindow(now, RULES.ndrSendWindow)) {
    return scheduleTimer({ flow: 'C', orderId, step: 'ndr', at: nextWindowTime(now, RULES.ndrSendWindow) });
  }
  const st = await getState(orderId);
  if (st?.flowC?.ndrAskedAt) return; // a retry after the send succeeded
  const res = await tpl(deps, n.verifiedPhone, 'ndr_action', { customer_name: n.firstName, order_number: n.name, attempt_date: fmtDate(now) }, { orderId: n.numericId });
  if (res?.skipped) return;
  await patchFlowC(orderId, { ndrAskedAt: now.toISOString() });
}

export async function onNdrReattempt(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));
  try {
    if (n.delhiveryAwb) await deps.clients.courier.ndrAction(n.delhiveryAwb, 'RE-ATTEMPT');
    await sess(deps, n.verifiedPhone, 'ndr_reattempt_ok', {});
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-ndr-reattempt']);
  } catch (e) {
    await ownerAlert(deps, n.name, 'NDR re-attempt request failed');
    log.error('flowC re-attempt failed', { orderId, err: e.message });
  }
}

export async function onNdrAddressStart(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  await sess(deps, n.verifiedPhone, 'ndr_address_ask', {});
  await setAwaiting(n.verifiedPhone, { type: 'address', orderId, until: addHours(now, 24).toISOString() });
}

export async function onNdrCancel(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));
  await sess(deps, n.verifiedPhone, 'ndr_cancel_ack', {});
  await ownerAlert(deps, n.name, 'customer asked to cancel after a failed delivery, team to decide');
}

/** The customer's free-text address reply (awaiting.type === 'address'). */
export async function onAddressText(orderId, text, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));
  const res = classifyAddressReply(text, n.zip);
  if (res.status === 'same') {
    try {
      if (n.delhiveryAwb) await deps.clients.courier.ndrAction(n.delhiveryAwb, 'EDIT_DETAILS', { address: text, pin: res.pincode });
      await sess(deps, n.verifiedPhone, 'ndr_address_saved', {});
      await deps.clients.shopify.tagsAdd(n.gid, ['wa-ndr-address']);
    } catch (e) {
      await ownerAlert(deps, n.name, 'NDR address edit failed');
    }
    await clearAwaiting(n.verifiedPhone);
  } else if (res.status === 'different') {
    await sess(deps, n.verifiedPhone, 'ndr_pincode_changed', {});
    await ownerAlert(deps, n.name, 'NDR new address is a different pincode, needs a manual call');
    await clearAwaiting(n.verifiedPhone);
  } else {
    const st = await getState(orderId);
    if (st?.flowC?.addressRetried) {
      await ownerAlert(deps, n.name, 'NDR address reply had no pincode twice, needs a manual call');
      await clearAwaiting(n.verifiedPhone);
    } else {
      await sess(deps, n.verifiedPhone, 'ndr_address_retry', {});
      await patchFlowC(orderId, { addressRetried: true });
      // keep awaiting for one more reply
    }
  }
}

// ---- RTO --------------------------------------------------------------------
export async function onRto(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await runOnce(orderId, 'rto-init', async () => {
    await deps.clients.shopify.tagsAdd(n.gid, ['RTO']);
    return { tagged: true };
  });
  await flowA.onStop(orderId, deps); // stop Flow A, cancel links + timers
  await scheduleTimer({ flow: 'C', orderId, step: 'rto_reason', at: nextWindowTime(now, RULES.reviewSendWindow) });
  await patchFlowC(orderId, { rto: true });
}

export async function onRtoTimer(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n || !n.verifiedPhone) return;
  const st = await getState(orderId);
  if (st?.flowC?.rtoReasonAskedAt) return;
  const res = await tpl(deps, n.verifiedPhone, 'rto_reason', { customer_name: n.firstName, order_number: n.name }, { orderId: n.numericId });
  if (res?.skipped) return;
  await patchFlowC(orderId, { rtoReasonAskedAt: nowOf(deps).toISOString() });
}

export async function onRtoReason(orderId, reasonId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  const reason = RTO_REASONS.find((r) => r.id === reasonId) || { id: reasonId, slug: reasonId };

  // The customer just tapped a button and is waiting. None of this bookkeeping
  // is worth leaving them without an answer, so all of it is soft and any
  // failure is reported instead of thrown.
  await soft('metafieldsSet:rto_reason', () =>
    deps.clients.shopify.metafieldsSet([
      { ownerId: n.gid, namespace: 'automation', key: 'rto_reason', type: 'json', value: JSON.stringify({ reasonId: reason.id, at: now.toISOString() }) },
    ]),
    { orderId },
  );
  await soft('tagsAdd:rto-reason', () => deps.clients.shopify.tagsAdd(n.gid, [`rto-reason-${reason.slug}`]), { orderId });

  const count = await soft('markRto', () => markRto(n.verifiedPhone), { orderId });
  if (n.customerGid && count != null) {
    const tags = [`rto-count-${count}`];
    if (count >= RULES.rtoCodBlockCount || COD_BLOCK_REASONS.includes(reason.id)) tags.push('cod-block');
    await soft('tagsAdd:cod-block', () => deps.clients.shopify.tagsAdd(n.customerGid, tags), { orderId });
  }

  if (reason.id === 'other') {
    await sess(deps, n.verifiedPhone, 'rto_other_ask', {});
    await setAwaiting(n.verifiedPhone, { type: 'rto_other', orderId, until: addHours(now, 24).toISOString() });
  } else {
    await sess(deps, n.verifiedPhone, 'rto_thanks', {});
  }
  await patchFlowC(orderId, { rtoReason: reason.id });
}

export async function onRtoOtherText(orderId, text, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));
  await soft('metafieldsSet:rto_reason_other', () =>
    deps.clients.shopify.metafieldsSet([
      { ownerId: n.gid, namespace: 'automation', key: 'rto_reason', type: 'json', value: JSON.stringify({ reasonId: 'other', text, at: nowOf(deps).toISOString() }) },
    ]),
    { orderId },
  );
  await sess(deps, n.verifiedPhone, 'rto_thanks', {});
  await clearAwaiting(n.verifiedPhone);
}

function fmtDate(d) {
  // local import avoided to keep this pure-ish; reuse time formatter
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(d);
}
