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
import { hasTag, itemLine, heroImageUrl } from '../domain/order.mjs';
import { classify } from '../domain/classify.mjs';
import { computeAmounts } from '../domain/amounts.mjs';
import { flowAEligible, excludeFromAll } from '../domain/eligibility.mjs';
import { mapCourierStatus, isCourierEditable, isBeforePickup } from '../domain/courier-status.mjs';
import { formatINR } from '../lib/money.mjs';
import { addMinutes, addHours, deferPastQuietHours, formatIST } from '../lib/time.mjs';
import { randomToken } from '../lib/ids.mjs';
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
import { getNorm, tpl, sess, ownerAlert, isTemplateUnusable } from './send.mjs';
import { log } from '../log.mjs';

const nowOf = (deps) => deps.now || new Date();

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
    return { linkId: link.id, url: link.shortUrl, token, newTotalPaise: amt.newTotalPaise, expiresAt: expireBy };
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

  // PREPAID and PARTIAL customers get a thank-you with their order details and
  // nothing else: there is nothing for them to confirm, and no COD chase.
  if (cls !== 'COD') {
    const res = await tpl(deps, n.verifiedPhone, 'order_confirmed', confirmVars(n), {
      orderId: n.numericId,
      imageUrl: heroImageUrl(n),
    });
    if (res?.skipped) {
      log.info('flowA confirm: send skipped, order left unmarked', { orderId, skip: res.skipped });
      return;
    }
    await recordMessage(orderId, res.messageId, { key: 'order_confirmed', template: res.templateName });
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-order-confirmed']);
    await patchFlowA(orderId, { step: 'order_confirmed', codConfirmAt: now.toISOString() });
    return;
  }

  // Quoting a prepaid price we cannot honour is worse than not quoting one: if
  // the COD fee does not match what COD King recorded, ensurePaymentLink will
  // refuse to create a link, and a customer who tapped Pay online after seeing a
  // number would get an apology instead. Send the price-free version instead.
  const amt = computeAmounts(n, RULES);
  const offerOk = amt.feeMatches && amt.newTotalPaise > 0;
  if (!offerOk) log.warn('flowA cod: no prepaid price quoted', { orderId, feeMatches: amt.feeMatches });

  const res = await tpl(deps, n.verifiedPhone, 'cod_confirm', confirmVars(n, amt), {
    orderId: n.numericId,
    imageUrl: heroImageUrl(n),
    preferLegacy: !offerOk,
  });
  // A skipped send (allowlist or dry run) is not a send. Leave the order
  // completely unmarked, otherwise a staged rollout tags real customer orders
  // wa-cod-sent and sets codConfirmAt, and they are then treated as already
  // confirmed and never messaged once the allowlist comes off. Nothing
  // downstream starts either, since the reminder chain is scheduled below.
  if (res?.skipped) {
    log.info('flowA cod: send skipped, order left unmarked', { orderId, skip: res.skipped });
    return;
  }
  await recordMessage(orderId, res.messageId, { key: 'cod_confirm', template: res.templateName });
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
    await sess(deps, n.verifiedPhone, 'confirmed_with_offer', offerVars(n, amt, now, link), { url: link.url });
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
  // The fallback timer is deliberately LEFT RUNNING. Asking for a payment link
  // is not paying: this tap used to cancel the only remaining nudge, so someone
  // who opened the link and got distracted was never contacted again and the
  // order quietly stayed COD. A successful payment cancels every timer anyway.
  const amt = computeAmounts(n, RULES);
  const link = await ensurePaymentLink(deps, n, amt, now);
  if (link) await sess(deps, n.verifiedPhone, 'pay_online_offer', offerVars(n, amt, now, link), { url: link.url });
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
  const amt = computeAmounts(n, RULES);
  const offerOk = amt.feeMatches && amt.newTotalPaise > 0;
  await tpl(deps, n.verifiedPhone, 'cod_reminder', confirmVars(n, amt), {
    orderId: n.numericId,
    preferLegacy: !offerOk,
  });
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
  await tpl(deps, n.verifiedPhone, 'prepaid_offer', offerVars(n, amt, now, link), {
    orderId: n.numericId,
    token: link.token,
    imageUrl: heroImageUrl(n),
  });
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

    // A read failure is NOT a reason to send someone's money back. getNorm
    // returns null both when an order genuinely does not exist and when Shopify
    // is briefly unhappy, and refunding on the second one is unrecoverable.
    // Throwing instead lets SQS retry and, if it really is gone, park it in the
    // DLQ where a human sees it. runOnce records nothing when fn throws.
    if (!n) throw new Error(`payment received for an order that could not be read: ${orderId}`);

    if (n.cancelledAt || cls !== 'COD') {
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
  // The AWB mapping and the courier prepaid edit above are the parts that must
  // not be lost. A dispatch message that cannot be sent because its template is
  // still in review is not worth failing the whole record and parking a paid
  // order's fulfillment in the DLQ over.
  try {
    await sendShipped(orderId, n, deps);
  } catch (e) {
    if (!isTemplateUnusable(e)) throw e;
    log.warn('flowA shipped: template not usable, no dispatch message sent', { orderId, waCode: e.waCode });
  }
}

/**
 * The dispatch message, for every order class.
 *
 * keep_cod_ack and order_confirmed both promise a tracking link, and until this
 * existed nothing ever sent one. Gated on a Delhivery AWB because the Track
 * button points at Delhivery's tracking page; another courier would get a link
 * that does not resolve, so it is better to stay quiet than to be wrong.
 */
async function sendShipped(orderId, n, deps) {
  if (!config.flows.A.enabled || !n.verifiedPhone) return;
  const ex = excludeFromAll(n, { orderAllowlist: config.orderAllowlist });
  if (ex.excluded) return log.info('flowA shipped: excluded', { orderId, reason: ex.reason });
  if (await isOptedOut(n.verifiedPhone)) return;

  await runOnce(orderId, 'shipped-message', async () => {
    const duePaise = Math.max(0, n.currentTotalPaise - n.receivedPaise);
    const res = await tpl(
      deps,
      n.verifiedPhone,
      'order_shipped',
      {
        customer_name: n.firstName,
        order_number: n.name,
        item_line: itemLine(n) || 'Your order',
        payment_line: duePaise > 0 ? `please keep ${formatINR(duePaise)} ready` : 'nothing to pay, this order is prepaid',
        courier: 'Delhivery',
        awb: n.delhiveryAwb,
      },
      { orderId: n.numericId, token: n.delhiveryAwb },
    );
    if (res?.skipped) {
      log.info('flowA shipped: send skipped', { orderId, skip: res.skipped });
      return null; // not recorded: a skipped send must not block the real one
    }
    await recordMessage(orderId, res.messageId, { key: 'order_shipped', template: res.templateName });
    return { sent: true };
  });
}

// ---- helpers ----------------------------------------------------------------
/**
 * Placeholders for the confirmation and reminder templates.
 *
 * Deliberately a UNION of what the current template and its legacy fallback
 * need, because which one actually goes out is decided at send time (approval
 * state, missing product image). renderTemplateDef drops the ones its version
 * does not use.
 */
function confirmVars(n, amt) {
  return {
    customer_name: n.firstName,
    order_number: n.name,
    item_line: itemLine(n) || 'Your order',
    order_total: formatINR(n.currentTotalPaise),
    cod_total: formatINR(n.currentTotalPaise),
    prepaid_total: formatINR(amt ? amt.newTotalPaise : n.currentTotalPaise),
  };
}

/**
 * Placeholders for every message that quotes the prepaid price.
 *
 * The numbers come from the LINK, not from a fresh computeAmounts. The link is
 * created once and reused, so if the order is edited afterwards a recomputed
 * total would quote a price the customer cannot actually be charged. Quoting
 * what Razorpay will really collect is the only version that cannot mislead.
 */
function offerVars(n, amt, now, link) {
  const newTotalPaise = link?.newTotalPaise ?? amt.newTotalPaise;
  if (link && link.newTotalPaise !== amt.newTotalPaise) {
    log.warn('flowA: live amount differs from the open payment link, quoting the link', {
      orderId: n.numericId,
      linkPaise: link.newTotalPaise,
      livePaise: amt.newTotalPaise,
    });
  }
  const savingPaise = Math.max(0, n.currentTotalPaise - newTotalPaise);
  const until = link?.expiresAt ? new Date(link.expiresAt * 1000) : addHours(now, RULES.payLinkMaxHours);
  return {
    customer_name: n.firstName,
    order_number: n.name,
    item_line: itemLine(n) || 'Your order',
    new_total: formatINR(newTotalPaise),
    prepaid_total: formatINR(newTotalPaise),
    order_total: formatINR(n.currentTotalPaise),
    cod_total: formatINR(n.currentTotalPaise),
    saving: formatINR(savingPaise),
    valid_until: formatIST(until),
  };
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
