/*
 * flowA.run.mjs — Flow A orchestration (COD confirm / cancel / COD->prepaid).
 *
 * Each entry point takes (orderId, deps) where deps = { clients, now? }. All
 * side effects go through the clients (real = DRY_RUN-gated; tests pass fakes)
 * and are made idempotent with runOnce. Every handler re-fetches the order and
 * re-checks eligibility before acting (webhooks + timers can be stale).
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { normalizeOrder, hasTag } from '../domain/order.mjs';
import { classify } from '../domain/classify.mjs';
import { computeAmounts } from '../domain/amounts.mjs';
import { flowAEligible } from '../domain/eligibility.mjs';
import { mapCourierStatus, isCourierEditable, isBeforePickup } from '../domain/courier-status.mjs';
import { formatINR } from '../lib/money.mjs';
import { addMinutes, addHours, deferPastQuietHours, formatIST } from '../lib/time.mjs';
import { randomToken } from '../lib/ids.mjs';
import { renderTemplate } from '../../messages/templates.mjs';
import { renderSession } from '../../messages/session.mjs';
import {
  ensureState,
  getState,
  patchState,
  patchFlowA,
  runOnce,
  getSide,
  recordMessage,
} from '../store/orderState.mjs';
import { isOptedOut, touchInbound, windowOpen, canSendMarketing, markMarketing } from '../store/phoneProfile.mjs';
import { setPaylinkMap, setPayTokenMap, setAwbMap } from '../store/maps.mjs';
import { scheduleTimer, cancelTimer } from '../timers/schedule.mjs';
import { log } from '../log.mjs';

const nowOf = (deps) => deps.now || new Date();

async function getNorm(deps, orderId) {
  const o = await deps.clients.shopify.getOrder(orderId);
  return o ? normalizeOrder(o) : null;
}

async function tpl(deps, phone, key, vars, ctx) {
  const t = renderTemplate(key, vars, ctx);
  return deps.clients.whatsapp.sendTemplate({ to: phone, name: t.name, language: t.language, components: t.components });
}
async function sess(deps, phone, key, vars, ctx = {}) {
  const r = renderSession(key, vars, ctx);
  const wa = deps.clients.whatsapp;
  if (r.type === 'text') return wa.sendText({ to: phone, body: r.body });
  if (r.type === 'buttons') return wa.sendButtons({ to: phone, body: r.body, buttons: r.buttons });
  if (r.type === 'cta_url') return wa.sendCtaUrl({ to: phone, body: r.body, buttonText: r.buttonText, url: r.url });
  return null;
}
async function ownerAlert(deps, orderName, alertText) {
  for (const phone of config.ownerAlertPhones) {
    await tpl(deps, phone, 'ops_alert', { order_number: orderName, alert_text: alertText }, {});
  }
}

const A_TIMERS = ['cod', 'reminder', 'fallback', 'highrisk'];
async function cancelAllTimers(orderId) {
  for (const step of A_TIMERS) await cancelTimer({ flow: 'A', orderId, step });
}
async function cancelLinkIfAny(deps, orderId) {
  const s = await getSide(orderId, 'paylink');
  if (s?.linkId) await deps.clients.razorpay.cancelLink(s.linkId);
}

/** Create (or reuse) the payment link + pay token. Null when no offer is valid. */
async function ensurePaymentLink(deps, n, amt, now) {
  if (!amt.feeMatches) {
    await ownerAlert(deps, n.name, 'COD fee does not match codk value, no prepaid offer made');
    return null;
  }
  return runOnce(n.numericId, 'paylink', async () => {
    const referenceId = `${n.name.replace('#', '')}-P1`.slice(0, 40);
    const expireBy = Math.floor(addHours(now, RULES.payLinkMaxHours).getTime() / 1000);
    const link = await deps.clients.razorpay.createLink({
      amountPaise: amt.newTotalPaise,
      referenceId,
      description: `Prepaid payment for ${n.name}`,
      contact: n.verifiedPhone,
      notes: { shopify_order_id: n.numericId, order_name: n.name, flow: 'A' },
      expireBy,
    });
    await setPaylinkMap(link.id, n.numericId);
    const token = randomToken();
    await setPayTokenMap(token, { orderId: n.numericId, url: link.shortUrl, expiresAt: expireBy });
    return { linkId: link.id, url: link.shortUrl, token, newTotalPaise: amt.newTotalPaise };
  });
}

// ---- triggers ---------------------------------------------------------------
export async function onOrderCreate(orderId, deps) {
  const now = nowOf(deps);
  await ensureState(orderId, {});
  // First confirmation is a direct response to the order and may go any time,
  // so the +3min timer is NOT quiet-hour deferred.
  await scheduleTimer({ flow: 'A', orderId, step: 'cod', at: addMinutes(now, RULES.codFirstMessageDelayMin) });
}

export async function onCodTimer(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  const st = (await getState(orderId)) || {};
  const cls = st.class || classify(n);
  await patchState(orderId, { class: cls, riskTag: n.riskTag, verifiedPhone: n.verifiedPhone, firstName: n.firstName, name: n.name });

  if (st.flowA?.codConfirmAt) return; // already sent (stale timer)

  if (cls === 'UNKNOWN') {
    await runOnce(orderId, 'alert-unknown', () => ownerAlert(deps, n.name, 'order class UNKNOWN, no Flow A'));
    return;
  }
  const elig = flowAEligible(n, cls, { startAt: config.flows.A.startAt, orderAllowlist: config.orderAllowlist });
  if (!elig.ok) {
    log.info('flowA cod: not eligible', { orderId, reason: elig.reason });
    return;
  }
  if (!n.verifiedPhone) {
    await runOnce(orderId, 'tag-no-phone', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-no-verified-phone']));
    return;
  }
  if (await isOptedOut(n.verifiedPhone)) return;
  if (!config.flows.A.enabled) {
    log.info('flowA cod: flow disabled, not sending', { orderId });
    return;
  }

  const res = await tpl(
    deps,
    n.verifiedPhone,
    'cod_confirm',
    { customer_name: n.firstName, order_number: n.name, order_total: formatINR(n.currentTotalPaise) },
    { orderId: n.numericId },
  );
  // A skipped send (allowlist or dry run) is not a send. Leave the order
  // completely unmarked, otherwise a staged rollout tags real customer orders
  // wa-cod-sent and sets codConfirmAt, and they are then treated as already
  // confirmed and never messaged once the allowlist comes off. Nothing
  // downstream starts either, since the reminder chain is scheduled below.
  if (res?.skipped) {
    log.info('flowA cod: send skipped, order left unmarked', { orderId, skip: res.skipped });
    return;
  }
  await recordMessage(orderId, res.messageId, { key: 'cod_confirm', template: 'cod_confirm_v1' });
  await deps.clients.shopify.tagsAdd(n.gid, ['wa-cod-sent']);
  await patchFlowA(orderId, { step: 'confirm_sent', codConfirmAt: now.toISOString() });

  await scheduleTimer({ flow: 'A', orderId, step: 'reminder', at: deferPastQuietHours(addMinutes(now, RULES.codReminderAfterMin), RULES.quietHours) });
  await scheduleTimer({ flow: 'A', orderId, step: 'fallback', at: deferPastQuietHours(addMinutes(now, RULES.codMarketingFallbackAfterMin), RULES.quietHours) });
  await scheduleTimer({ flow: 'A', orderId, step: 'highrisk', at: deferPastQuietHours(addHours(now, RULES.highRiskCheckAfterHours), RULES.quietHours) });
}

// ---- taps -------------------------------------------------------------------
export async function onConfirm(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  await cancelTimer({ flow: 'A', orderId, step: 'reminder' });
  await cancelTimer({ flow: 'A', orderId, step: 'fallback' });
  await deps.clients.shopify.tagsAdd(n.gid, ['wa-confirmed']);
  await patchFlowA(orderId, { step: 'confirmed' });
  const amt = computeAmounts(n, RULES);
  const link = await ensurePaymentLink(deps, n, amt, now);
  if (link) {
    await sess(deps, n.verifiedPhone, 'confirmed_with_offer', offerVars(n, amt, now), { url: link.url });
  } else {
    await sess(deps, n.verifiedPhone, 'keep_cod_ack', { customer_name: n.firstName, order_number: n.name });
  }
}

export async function onPayOnline(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  await cancelTimer({ flow: 'A', orderId, step: 'reminder' });
  await cancelTimer({ flow: 'A', orderId, step: 'fallback' });
  const amt = computeAmounts(n, RULES);
  const link = await ensurePaymentLink(deps, n, amt, now);
  if (link) await sess(deps, n.verifiedPhone, 'pay_online_offer', offerVars(n, amt, now, false), { url: link.url });
  else await sess(deps, n.verifiedPhone, 'keep_cod_ack', { customer_name: n.firstName, order_number: n.name });
}

export async function onKeepCod(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  await cancelTimer({ flow: 'A', orderId, step: 'reminder' });
  await cancelTimer({ flow: 'A', orderId, step: 'fallback' });
  await deps.clients.shopify.tagsAdd(n.gid, ['wa-confirmed']);
  await patchFlowA(orderId, { step: 'kept_cod' });
  await sess(deps, n.verifiedPhone, 'keep_cod_ack', { customer_name: n.firstName, order_number: n.name });
}

export async function onCancel(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));
  await sess(deps, n.verifiedPhone, 'cancel_check', { order_number: n.name }, { orderId: n.numericId });
}

export async function onCancelNo(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));
  await sess(deps, n.verifiedPhone, 'cancel_kept', { order_number: n.name });
}

export async function onCancelYes(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));

  if (!n.delhiveryAwb || n.fulfillments.length === 0) {
    await runOnce(orderId, 'cancel', async () => {
      await deps.clients.shopify.orderCancel(n.gid, { reason: 'CUSTOMER', staffNote: 'WhatsApp customer cancel' });
      return { cancelled: true };
    });
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-cancelled']);
    await cancelAllTimers(orderId);
    await cancelLinkIfAny(deps, orderId);
    await sess(deps, n.verifiedPhone, 'cancel_done', { order_number: n.name });
    return;
  }

  const [t] = await deps.clients.courier.track([n.delhiveryAwb]);
  const state = mapCourierStatus(t);
  if (isBeforePickup(state)) {
    await runOnce(orderId, 'cancel', async () => {
      await deps.clients.courier.cancel(n.delhiveryAwb);
      await deps.clients.shopify.orderCancel(n.gid, { reason: 'CUSTOMER', staffNote: 'WhatsApp customer cancel' });
      return { cancelled: true };
    });
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-cancelled']);
    await cancelAllTimers(orderId);
    await cancelLinkIfAny(deps, orderId);
    await sess(deps, n.verifiedPhone, 'cancel_done', { order_number: n.name });
  } else {
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-cancel-requested']);
    await ownerAlert(deps, n.name, 'cancel requested after dispatch, needs a manual call');
    await sess(deps, n.verifiedPhone, 'cancel_too_late', { order_number: n.name });
  }
}

// ---- timers -----------------------------------------------------------------
export async function onReminder(orderId, deps) {
  const st = await getState(orderId);
  if (!st || st.flowA?.step !== 'confirm_sent') return; // tapped already
  const n = await getNorm(deps, orderId);
  if (!n || n.cancelledAt || !n.verifiedPhone) return;
  if (await isOptedOut(n.verifiedPhone)) return;
  await tpl(deps, n.verifiedPhone, 'cod_reminder', { customer_name: n.firstName, order_number: n.name, order_total: formatINR(n.currentTotalPaise) }, { orderId: n.numericId });
  await patchFlowA(orderId, { reminderSentAt: new Date().toISOString() });
}

export async function onFallback(orderId, deps) {
  const now = nowOf(deps);
  const st = await getState(orderId);
  if (!st || st.flowA?.step !== 'confirm_sent') return; // tapped already
  const n = await getNorm(deps, orderId);
  if (!n || n.cancelledAt || !n.verifiedPhone) return;
  if (await isOptedOut(n.verifiedPhone)) return;
  if (n.delhiveryAwb) {
    const [t] = await deps.clients.courier.track([n.delhiveryAwb]);
    if (['OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_INITIATED', 'RTO_DELIVERED'].includes(mapCourierStatus(t))) return;
  }
  if (!(await canSendMarketing(n.verifiedPhone, now, RULES.marketingCapDays))) return;
  const amt = computeAmounts(n, RULES);
  const link = await ensurePaymentLink(deps, n, amt, now);
  if (!link) return;
  await tpl(deps, n.verifiedPhone, 'prepaid_offer', offerVars(n, amt, now), { orderId: n.numericId, token: link.token });
  await markMarketing(n.verifiedPhone, now);
  await patchFlowA(orderId, { fallbackSentAt: new Date().toISOString() });
}

export async function onHighRisk(orderId, deps) {
  const st = await getState(orderId);
  if (!st || st.flowA?.step !== 'confirm_sent') return; // a tap happened
  const n = await getNorm(deps, orderId);
  if (n?.riskTag !== 'HIGH') return;
  await runOnce(orderId, 'highrisk-hold', async () => {
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-hold-unconfirmed']);
    await ownerAlert(deps, n.name, 'HIGH RTO risk and unconfirmed after 24h');
    return { held: true };
  });
}

// ---- payment ----------------------------------------------------------------
export async function onPaymentPaid(orderId, entity, deps) {
  const now = nowOf(deps);
  await runOnce(orderId, 'payment-processed', async () => {
    const n = await getNorm(deps, orderId);
    const stNow = await getState(orderId);
    // Use the STORED class. classify() is explicitly a once-at-first-sight
    // decision: a converted (or delivered) COD order reads back as PAID, so
    // re-classifying here would call a successfully converted order
    // "no longer eligible" and refund a customer who did nothing wrong. That
    // is exactly what a duplicate or retried Razorpay webhook would do.
    const cls = stNow?.class || (n ? classify(n) : 'UNKNOWN');
    const paymentId = entity?.payment_id || entity?.id || null;
    const paidPaise = entity?.amount_paid != null ? Math.round(entity.amount_paid) : null;

    // Already converted: this is a repeat delivery of the same event. Ack it.
    if (stNow?.flowA?.convertedAt || hasTag(n?.tags, 'PREPAID-CONVERTED')) {
      log.info('flowA payment: already converted, ignoring duplicate', { orderId });
      return { duplicate: true };
    }

    if (!n || n.cancelledAt || cls !== 'COD') {
      if (paymentId) await deps.clients.razorpay.refund(paymentId, paidPaise ?? 0);
      await sendRefundMessage(deps, n, orderId, paidPaise, now);
      await ownerAlert(deps, n?.name || `#${orderId}`, 'payment received but order no longer eligible, refunded');
      return { refunded: true };
    }

    const amt = computeAmounts(n, RULES);
    if (n.delhiveryAwb) {
      const [t] = await deps.clients.courier.track([n.delhiveryAwb]);
      if (isCourierEditable(mapCourierStatus(t))) {
        await deps.clients.courier.editToPrepaid(n.delhiveryAwb);
      } else {
        if (paymentId) await deps.clients.razorpay.refund(paymentId, paidPaise ?? amt.newTotalPaise);
        await sendRefundMessage(deps, n, orderId, paidPaise, now);
        await ownerAlert(deps, n.name, 'payment received but courier not editable, refunded');
        return { refunded: true };
      }
    } else {
      // No AWB yet: remember to edit the shipment to prepaid once it exists.
      // Deliberately NOT tagged PREPAID-CONVERTED here. That tag used to be
      // applied before convertToPrepaid ran, so any failure in the conversion
      // (the CONVERSION_VERIFIED gate, a Shopify error) left a still-unpaid COD
      // order marked as prepaid, which risks shipping it without collecting
      // cash. The tag is applied below, only after the conversion succeeds.
      await patchFlowA(orderId, { pendingCourierPrepaid: true });
    }

    const linkId = (await getSide(orderId, 'paylink'))?.linkId;
    const conv = await deps.clients.shopify.convertToPrepaid({ order: n, amounts: amt, paymentId, linkId });
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-prepaid-converted', 'PREPAID-CONVERTED']);
    await patchFlowA(orderId, { convertedAt: now.toISOString() });
    await deps.clients.shopify.metafieldsSet([
      {
        ownerId: n.gid,
        namespace: 'automation',
        key: 'prepaid_conversion',
        type: 'json',
        value: JSON.stringify({
          paymentId,
          linkId,
          amountPaise: paidPaise ?? amt.newTotalPaise,
          discountPaise: amt.discountPaise,
          codFeeRemovedPaise: amt.codFeePaise,
          method: conv.method,
          convertedAt: now.toISOString(),
        }),
      },
    ]);
    await cancelLinkIfAny(deps, orderId);
    await cancelAllTimers(orderId);

    const paidStr = formatINR(paidPaise ?? amt.newTotalPaise);
    if (await windowOpen(n.verifiedPhone, now, RULES.windowSafetyMinutes)) {
      await sess(deps, n.verifiedPhone, 'payment_received', { customer_name: n.firstName, amount_paid: paidStr, order_number: n.name });
    } else {
      await tpl(deps, n.verifiedPhone, 'prepaid_confirmed', { customer_name: n.firstName, amount_paid: paidStr, order_number: n.name }, { orderId: n.numericId });
    }
    await patchFlowA(orderId, { step: 'converted' });
    return { converted: true };
  });
}

export async function onStop(orderId, deps) {
  await patchFlowA(orderId, { step: 'stopped' });
  await cancelAllTimers(orderId);
  await cancelLinkIfAny(deps, orderId);
}

/**
 * fulfillments/create brought the AWB. Map it, and if a prepaid payment arrived
 * before the AWB existed (pendingCourierPrepaid), do the courier edit now; a
 * failure here is URGENT (the courier would otherwise collect cash).
 */
export async function onFulfillmentCreate(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n || !n.delhiveryAwb) return;
  await setAwbMap(n.delhiveryAwb, n.numericId);
  const st = await getState(orderId);
  if (st?.flowA?.pendingCourierPrepaid) {
    await runOnce(orderId, 'pending-courier-edit', async () => {
      try {
        await deps.clients.courier.editToPrepaid(n.delhiveryAwb);
        return { edited: true };
      } catch (e) {
        await ownerAlert(deps, n.name, 'URGENT: order paid online but courier edit to prepaid failed after AWB assigned');
        throw e;
      }
    });
    await patchFlowA(orderId, { pendingCourierPrepaid: false });
  }
}

// ---- helpers ----------------------------------------------------------------
function offerVars(n, amt, now, includeOrderNumber = true) {
  const v = {
    customer_name: n.firstName,
    new_total: formatINR(amt.newTotalPaise),
    order_total: formatINR(n.currentTotalPaise),
    saving: formatINR(amt.savingPaise),
    valid_until: formatIST(addHours(now, RULES.payLinkMaxHours)),
  };
  if (includeOrderNumber) v.order_number = n.name;
  return v;
}

async function sendRefundMessage(deps, n, orderId, paidPaise, now) {
  if (!n) return;
  const vars = {
    customer_name: n.firstName,
    order_number: n.name,
    amount_paid: formatINR(paidPaise ?? 0),
    refund_eta: RULES.refundEtaText,
    cod_amount: formatINR(n.currentTotalPaise),
  };
  if (await windowOpen(n.verifiedPhone, now, RULES.windowSafetyMinutes)) {
    await sess(deps, n.verifiedPhone, 'prepaid_refund', vars);
  } else {
    await tpl(deps, n.verifiedPhone, 'prepaid_refund', vars, { orderId: n.numericId });
  }
}
