/*
 * flowA.run.mjs — Flow A orchestration (COD confirm / cancel / COD->prepaid).
 *
 * Each entry point takes (orderId, deps) where deps = { clients, now? }. All
 * side effects go through the clients (real = DRY_RUN-gated; tests pass fakes)
 * and are made idempotent with runOnce. Every handler re-fetches the order and
 * re-checks eligibility before acting (webhooks + timers can be stale).
 */
import { config } from '../config.mjs';
import * as variantChange from './variantChange.run.mjs';
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
import { onUntrackedFulfillment } from './flowB.run.mjs';
import { OFFER_GIFT_LINE, OFFER_NO_GIFT_LINE } from '../../messages/session.mjs';
import { log } from '../log.mjs';
import { soft, withRetry } from '../lib/resilience.mjs';

const nowOf = (deps) => deps.now || new Date();

const A_TIMERS = ['cod', 'reminder', 'fallback', 'highrisk'];
async function cancelAllTimers(orderId) {
  for (const step of A_TIMERS) await cancelTimer({ flow: 'A', orderId, step });
}
/**
 * Close the open payment link, if there is one. NEVER throws.
 *
 * Razorpay refuses to cancel a link that has already been paid or has expired,
 * and both are perfectly normal here: this runs on cancellation, on RTO and
 * right after a successful conversion, by which point the link usually IS paid.
 *
 * It used to throw. A real customer cancelling order #1150 after paying failed
 * the whole orders/cancelled record five times and parked it in the DLQ, so
 * Flow A was never stopped for that order. Tidying up a link is never worth
 * failing the work it belongs to.
 */
async function cancelLinkIfAny(deps, orderId) {
  const s = await getSide(orderId, 'paylink');
  if (!s?.linkId) return null;
  return soft('cancelPaymentLink', () => deps.clients.razorpay.cancelLink(s.linkId), { orderId, linkId: s.linkId });
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

/*
 * Record that the confirmation was deliberately NOT sent, and why.
 *
 * codConfirmAt means "this customer was told". Its absence used to mean two very
 * different things: the message was lost in the chain, or we looked at the order
 * and decided there was nothing to send. The reconcile sweep could only read the
 * first meaning, so it re-armed orders that could never confirm, three times
 * each, and then raised a stuck alert about a condition the owner had already
 * been told about by name. One field separates the two.
 */
async function codSkip(orderId, reason) {
  await patchFlowA(orderId, { codSkip: reason });
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
    await codSkip(orderId, 'class-unknown');
    await runOnce(orderId, 'alert-unknown', () => ownerAlert(deps, n.name, 'order class UNKNOWN, no Flow A'));
    return;
  }
  const elig = flowAEligible(n, cls, { startAt: config.flows.A.startAt, orderAllowlist: config.orderAllowlist });
  if (!elig.ok) {
    await codSkip(orderId, `ineligible:${elig.reason}`);
    log.info('flowA cod: not eligible', { orderId, reason: elig.reason });
    return;
  }
  if (!n.verifiedPhone) {
    await codSkip(orderId, 'no-verified-phone');
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
    let res;
    try {
      res = await tpl(deps, n.verifiedPhone, 'order_confirmed', confirmVars(n), {
        orderId: n.numericId,
        imageUrl: heroImageUrl(n),
      });
    } catch (e) {
      // Both versions of this one can be in review at the same time, unlike the
      // COD templates which always have an approved fallback. Throwing would
      // send a real customer's order to the DLQ; dropping it would leave them
      // with silence forever. Come back later instead, so the confirmation goes
      // out by itself once Meta approves, with no redeploy and no redrive.
      if (!isTemplateUnusable(e)) throw e;
      return deferConfirm(orderId, st, now, e);
    }
    if (res?.skipped) {
      log.info('flowA confirm: send skipped, order left unmarked', { orderId, skip: res.skipped });
      return;
    }
    // The message is now on the customer's phone. Record that FIRST, because
    // codConfirmAt is the only thing stopping a retry from sending a second
    // copy, and then let nothing after it throw.
    await patchFlowA(orderId, { step: 'order_confirmed', codConfirmAt: now.toISOString() });
    await soft('recordMessage', () => recordMessage(orderId, res.messageId, { key: 'order_confirmed', template: res.templateName }), { orderId });
    await soft('tagsAdd:wa-order-confirmed', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-order-confirmed']), { orderId });
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
  // Same rule: mark the send before anything else can fail. Everything below is
  // bookkeeping the customer never sees, and a throw here used to redeliver the
  // whole record and message them a second time.
  await patchFlowA(orderId, { step: 'confirm_sent', codConfirmAt: now.toISOString() });
  await soft('recordMessage', () => recordMessage(orderId, res.messageId, { key: 'cod_confirm', template: res.templateName }), { orderId });
  await soft('tagsAdd:wa-cod-sent', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-cod-sent']), { orderId });

  await armTimer(orderId, 'reminder', deferPastQuietHours(addMinutes(now, RULES.codReminderAfterMin), RULES.quietHours));
  await armTimer(orderId, 'fallback', deferPastQuietHours(addMinutes(now, RULES.codMarketingFallbackAfterMin), RULES.quietHours));
  await armTimer(orderId, 'highrisk', deferPastQuietHours(addHours(now, RULES.highRiskCheckAfterHours), RULES.quietHours));
}

/**
 * Arm one Flow A timer.
 *
 * Retried, because losing it silently drops the rest of the chase, and creating
 * a schedule is idempotent (deterministic name, delete-then-create). Soft after
 * that, because the confirmation has already gone out and failing the record
 * would only send it again. A total failure is logged at error level, so it
 * reaches the owner's inbox rather than disappearing.
 */
async function armTimer(orderId, step, at) {
  return soft(`scheduleTimer:${step}`, () =>
    withRetry(`scheduleTimer:${step}`, () => scheduleTimer({ flow: 'A', orderId, step, at }), { idempotent: true }),
    { orderId, step },
  );
}


/**
 * Postpone the confirmation until its template exists.
 *
 * Bounded so an order cannot be retried forever: after a day of trying, the
 * owner is told rather than the order quietly rotting. Rescheduling the same
 * timer name replaces it, so this can never pile up duplicates.
 */
const CONFIRM_DEFER_HOURS = 2;
const CONFIRM_DEFER_MAX = 12; // 24h of trying

async function deferConfirm(orderId, st, now, err) {
  const tries = (st.flowA?.confirmDeferred || 0) + 1;
  if (tries > CONFIRM_DEFER_MAX) {
    log.error('flowA confirm: template still not approved after a day, giving up', { orderId, err: err.message });
    return;
  }
  await patchFlowA(orderId, { confirmDeferred: tries });
  log.info('flowA confirm: template not approved yet, trying again later', { orderId, tries, waCode: err.waCode });
  await armTimer(orderId, 'cod', addHours(now, CONFIRM_DEFER_HOURS));
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
  // Offer the change first when the order can still take one. Cancelling used
  // to be the only self-service option, so a customer who wanted a different
  // size had to cancel and reorder: that is how #1187 became #1188, 36 minutes
  // apart. When the order is past changing (AWB printed, money taken, already
  // changed once, flag off) this is byte for byte the old behaviour.
  const st = (await getState(orderId)) || {};
  if (await variantChange.changeOffered(n, st, n.verifiedPhone)) {
    return sess(deps, n.verifiedPhone, 'change_or_cancel', { order_number: n.name }, { orderId: n.numericId });
  }
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

  // Already cancelled, by the owner in Shopify, by COD King, or by a tap whose
  // runOnce record has since aged out. orderCancel returns a userError for an
  // order that is already cancelled and the client throws on userErrors, so
  // this used to fail the record five times into the DLQ AND leave the customer
  // with no answer at all, on an order that is in exactly the state they asked
  // for. Confirm it and stop.
  if (n.cancelledAt) {
    log.info('flowA cancel: order is already cancelled, acknowledging', { orderId });
    await soft('cancelAllTimers', () => cancelAllTimers(orderId), { orderId });
    await cancelLinkIfAny(deps, orderId);
    await sess(deps, n.verifiedPhone, 'cancel_done', { order_number: n.name });
    return;
  }

  // Money has already been taken: a prepaid link the customer paid, or a COD
  // King part payment. orderCancel omits the refund argument on purpose, with
  // the reasoning "COD has nothing captured, so no refund is issued" - true
  // only while nothing HAS been captured. Past that point the old path took the
  // order away, kept the money, issued no refund and told nobody, and because
  // cancelLinkIfAny is soft a stale Pay online message stays tappable, so this
  // was reachable by an ordinary customer. Refunds are a person's decision, so
  // hand off instead of cancelling.
  //
  // Timers are deliberately left armed. The order is still live pending that
  // person's decision, and disarming it here would silently break the flow if
  // they decide to keep it. Their cancel in Shopify fires orders/cancelled,
  // which routes to onStop and tidies up properly.
  if (n.receivedPaise > 0) {
    await soft('tagsAdd:wa-cancel-refund-review', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-cancel-refund-review']), { orderId });
    await ownerAlert(
      deps,
      n.name,
      `URGENT: customer asked to cancel an order with Rs ${(n.receivedPaise / 100).toFixed(2)} already received. ` +
        'Nothing was cancelled. Cancel and refund by hand',
    );
    await sess(deps, n.verifiedPhone, 'cancel_refund_review', { order_number: n.name });
    return;
  }

  if (!n.delhiveryAwb || n.fulfillments.length === 0) {
    await runOnce(orderId, 'cancel', async () => {
      await deps.clients.shopify.orderCancel(n.gid, { reason: 'CUSTOMER', staffNote: 'WhatsApp customer cancel' });
      return { cancelled: true };
    });
    await soft('tagsAdd:wa-cancelled', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-cancelled']), { orderId });
    await soft('cancelAllTimers', () => cancelAllTimers(orderId), { orderId });
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
    await soft('tagsAdd:wa-cancelled', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-cancelled']), { orderId });
    await soft('cancelAllTimers', () => cancelAllTimers(orderId), { orderId });
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
  const now = nowOf(deps);
  const st = await getState(orderId);
  if (!st || st.flowA?.step !== 'confirm_sent') return; // tapped already
  if (st.flowA?.reminderSentAt) return; // a retry after the send succeeded
  const n = await getNorm(deps, orderId);
  if (!n || n.cancelledAt || !n.verifiedPhone) return;
  if (await isOptedOut(n.verifiedPhone)) return;
  const amt = computeAmounts(n, RULES);
  const offerOk = amt.feeMatches && amt.newTotalPaise > 0;
  const res = await tpl(deps, n.verifiedPhone, 'cod_reminder', confirmVars(n, amt), {
    orderId: n.numericId,
    preferLegacy: !offerOk,
  });
  if (res?.skipped) return;
  await patchFlowA(orderId, { reminderSentAt: now.toISOString() });
}

export async function onFallback(orderId, deps) {
  const now = nowOf(deps);
  const st = await getState(orderId);
  if (!st || st.flowA?.step !== 'confirm_sent') return; // tapped already
  if (st.flowA?.fallbackSentAt) return; // a retry after the send succeeded
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
  const res = await tpl(deps, n.verifiedPhone, 'prepaid_offer', offerVars(n, amt, now, link), {
    orderId: n.numericId,
    token: link.token,
    imageUrl: heroImageUrl(n),
  });
  if (res?.skipped) return;
  // fallbackSentAt is what stops a retry re-sending a MARKETING message, so it
  // is written before the marketing cap is stamped, not after.
  await patchFlowA(orderId, { fallbackSentAt: now.toISOString() });
  await soft('markMarketing', () => markMarketing(n.verifiedPhone, now), { orderId });
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
/**
 * A customer paid the prepaid link.
 *
 * This is the only handler that moves money, so every irreversible step is its
 * own runOnce and every step that is not irreversible is soft. The rule is:
 * a failure anywhere must be safe to redeliver, and redelivery must never
 * repeat a refund, a conversion or a message the customer already has.
 *
 * The outer runOnce only records on full success, so a partial failure
 * re-enters here and resumes from whichever inner step has not been recorded.
 */
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
    // ONLY the real pay_... id. entity.id on a payment_link.paid webhook is a
    // plink_..., which the refund endpoint rejects with "not a valid id", so
    // this fallback meant a refund that had to happen silently did not. The
    // ingest now carries payment_id explicitly; when it is genuinely absent a
    // refund needs a human, not a guess at the id.
    const paymentId = entity?.payment_id || null;
    const paidPaise = entity?.amount_paid != null ? Math.round(entity.amount_paid) : null;

    // A read failure is NOT a reason to send someone's money back. getNorm
    // returns null both when an order genuinely does not exist and when Shopify
    // is briefly unhappy, and refunding on the second one is unrecoverable.
    // Throwing instead lets SQS retry and, if it really is gone, park it in the
    // DLQ where a human sees it. runOnce records nothing when fn throws.
    if (!n) throw new Error(`payment received for an order that could not be read: ${orderId}`);

    // Already converted: a repeat delivery of the same event. Still make sure
    // the customer was actually told, because the previous attempt may have
    // converted the order and then failed on the message. notifyPaid is
    // runOnce-guarded, so this cannot send a second copy.
    if (stNow?.flowA?.convertedAt || hasTag(n.tags, 'PREPAID-CONVERTED')) {
      log.info('flowA payment: already converted, confirming the customer was told', { orderId });
      await notifyPaid(deps, n, orderId, paidPaise ?? n.currentTotalPaise, now);
      return { duplicate: true };
    }

    if (n.cancelledAt || cls !== 'COD') {
      const r = await refundOnce(deps, orderId, paymentId, paidPaise ?? 0);
      // refundOnce returns null when there is no usable payment id. Sending the
      // refund message anyway told the customer their money was on its way back
      // when nothing had been refunded, which is the one lie this service must
      // never tell. No refund, no message: the owner gets it instead.
      if (!r) {
        await ownerAlert(deps, n.name, 'URGENT: payment received on an order that is no longer eligible, but it could NOT be refunded automatically. Refund this by hand in Razorpay');
        return { refundFailed: true };
      }
      await notifyRefund(deps, n, orderId, paidPaise, now);
      await ownerAlert(deps, n.name, 'payment received but order no longer eligible, refunded');
      return { refunded: true };
    }

    const amt = computeAmounts(n, RULES);
    if (n.delhiveryAwb) {
      const [t] = await deps.clients.courier.track([n.delhiveryAwb]);
      const courierState = mapCourierStatus(t);
      // An unreadable courier state is NOT a reason to send someone's money
      // back. mapCourierStatus returns UNKNOWN both for a genuinely odd status
      // and for a tracking call that came back empty or with a string Delhivery
      // has not shown us before, and the else-branch below refunds. That is the
      // same mistake the getNorm-null path was fixed for: throw instead, so SQS
      // retries while the poller refreshes the status, and a real dead end parks
      // in the DLQ where a human sees it rather than silently reversing a
      // payment the customer meant to make.
      if (!t || courierState === 'UNKNOWN') {
        throw new Error(`payment received but the courier status for ${n.delhiveryAwb} could not be read, refusing to decide`);
      }
      if (isCourierEditable(courierState)) {
        // Delhivery's edit-to-prepaid field names are still unverified against
        // a live waybill, so this call can fail for reasons that have nothing
        // to do with the customer. Letting it throw parked a real payment in
        // the DLQ with the order unconverted, the customer untold, and the
        // waybill still marked COD, which is the worst of every world: the
        // courier would collect the money a second time on delivery.
        //
        // soft() returns null on failure and runOnce records nothing when its
        // function throws, so a later attempt can still succeed.
        const edited = await soft('courierEditToPrepaid', () =>
          runOnce(orderId, 'courier-prepaid-edit', async () => {
            await deps.clients.courier.editToPrepaid(n.delhiveryAwb);
            return { edited: true };
          }),
          { orderId, awb: n.delhiveryAwb },
        );
        if (!edited) {
          // Convert the order anyway. The money is real and the customer has to
          // be served; what is left is a courier record a human must correct,
          // which is why this is tagged and alerted rather than swallowed.
          await patchFlowA(orderId, { pendingCourierPrepaid: true });
          await soft('tagsAdd:courier-still-cod', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-courier-still-cod']), { orderId });
          await ownerAlert(
            deps,
            n.name,
            'URGENT: paid online but the courier record is still cash on delivery. Fix the waybill before dispatch or the courier will collect the money a second time',
          );
        }
      } else {
        const r = await refundOnce(deps, orderId, paymentId, paidPaise ?? amt.newTotalPaise);
        if (!r) {
          await ownerAlert(deps, n.name, 'URGENT: paid online but the courier is past editing AND the refund could not be issued automatically. Refund this by hand in Razorpay before dispatch');
          return { refundFailed: true };
        }
        await notifyRefund(deps, n, orderId, paidPaise, now);
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
    // The order edit is not repeatable: a second run would discount the order
    // twice. runOnce makes a redelivery return the first result untouched.
    const conv = await runOnce(orderId, 'convert-prepaid', () =>
      deps.clients.shopify.convertToPrepaid({ order: n, amounts: amt, paymentId, linkId }),
    );
    // convertedAt is the guard that stops a redelivery re-entering this branch,
    // so it is written immediately after the conversion and before the
    // bookkeeping that follows it.
    await patchFlowA(orderId, { convertedAt: now.toISOString(), step: 'converted' });

    // Everything from here is internal record keeping. The money has moved and
    // the order is correct; none of it is worth redelivering the record for.
    await soft('tagsAdd:prepaid-converted', () =>
      withRetry('tagsAdd:prepaid-converted', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-prepaid-converted', 'PREPAID-CONVERTED']), { idempotent: true }),
      { orderId },
    );
    await soft('metafieldsSet:prepaid_conversion', () =>
      deps.clients.shopify.metafieldsSet([
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
            method: conv?.method,
            convertedAt: now.toISOString(),
          }),
        },
      ]),
      { orderId },
    );
    await cancelLinkIfAny(deps, orderId);
    await soft('cancelAllTimers', () => cancelAllTimers(orderId), { orderId });

    // Deliberately NOT soft. Telling the customer their money arrived is the
    // point of this handler, so a failure here should redeliver the record. On
    // redelivery the duplicate branch above calls this same guarded step.
    await notifyPaid(deps, n, orderId, paidPaise ?? amt.newTotalPaise, now);
    return { converted: true };
  });
}

/**
 * Refund exactly once, ever.
 *
 * Razorpay's refund endpoint is not idempotent, so this is the single most
 * dangerous call in the service. Wrapping it in runOnce means no redelivery,
 * retry or duplicate webhook can issue a second refund, whatever fails after it.
 */
async function refundOnce(deps, orderId, paymentId, amountPaise) {
  if (!paymentId) {
    log.error('flowA payment: refund needed but no payment id in the webhook', { orderId });
    return null;
  }
  return runOnce(orderId, 'refund', () => deps.clients.razorpay.refund(paymentId, amountPaise));
}

/** Tell the customer their payment landed. Guarded so a retry cannot repeat it. */
async function notifyPaid(deps, n, orderId, paidPaise, now) {
  if (!n.verifiedPhone) return null;
  return runOnce(orderId, 'paid-notify', async () => {
    const vars = { customer_name: n.firstName, amount_paid: formatINR(paidPaise), order_number: n.name };
    const res = (await windowOpen(n.verifiedPhone, now, RULES.windowSafetyMinutes))
      ? await sess(deps, n.verifiedPhone, 'payment_received', vars)
      : await tpl(deps, n.verifiedPhone, 'prepaid_confirmed', vars, { orderId: n.numericId });
    // A skipped send is not a send, so it must not be recorded as one.
    if (res?.skipped) throw new Error(`paid notify skipped: ${res.skipped}`);
    return { sent: true };
  });
}

/** Tell the customer about a refund. Guarded so a retry cannot repeat it. */
async function notifyRefund(deps, n, orderId, paidPaise, now) {
  if (!n?.verifiedPhone) return null;
  return runOnce(orderId, 'refund-notify', async () => {
    await sendRefundMessage(deps, n, orderId, paidPaise, now);
    return { sent: true };
  });
}

/** Stop Flow A for this order: no more chasing, no open link. Never throws. */
export async function onStop(orderId, deps) {
  await patchFlowA(orderId, { step: 'stopped' });
  await soft('cancelAllTimers', () => cancelAllTimers(orderId), { orderId });
  await cancelLinkIfAny(deps, orderId);
}

/**
 * fulfillments/create brought the AWB. Map it, and if a prepaid payment arrived
 * before the AWB existed (pendingCourierPrepaid), do the courier edit now; a
 * failure here is URGENT (the courier would otherwise collect cash).
 */
export async function onFulfillmentCreate(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  if (!n.delhiveryAwb) {
    // Shipped by someone other than Delhivery: no waybill to track, so no
    // delivery event will ever arrive and Flow B would never hear about this
    // order. Fall back to the assumed-delivery date. Soft, because a review
    // ask is never worth failing a fulfillment record.
    if (n.fulfillments.length) {
      await soft('flowB:untrackedFulfillment', () => onUntrackedFulfillment(orderId, n.fulfilledAt, deps), { orderId });
    }
    return;
  }
  await setAwbMap(n.delhiveryAwb, n.numericId);
  const st = await getState(orderId);
  if (st?.flowA?.pendingCourierPrepaid) {
    // Same reasoning as the payment path: failing the record here would park
    // the fulfillment in the DLQ and lose the dispatch message too, while the
    // waybill stayed COD either way. Flag it for a human instead, and leave
    // pendingCourierPrepaid set so a later fulfillment update tries again.
    const edited = await soft('courierEditToPrepaid', () =>
      runOnce(orderId, 'pending-courier-edit', async () => {
        await deps.clients.courier.editToPrepaid(n.delhiveryAwb);
        return { edited: true };
      }),
      { orderId, awb: n.delhiveryAwb },
    );
    if (edited) {
      await patchFlowA(orderId, { pendingCourierPrepaid: false });
    } else {
      await soft('tagsAdd:courier-still-cod', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-courier-still-cod']), { orderId });
      await ownerAlert(
        deps,
        n.name,
        'URGENT: paid online but the courier record is still cash on delivery after the waybill was assigned. Fix it before dispatch or the courier will collect the money a second time',
      );
    }
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
    // order_shipped has no LEGACY fallback, so an unusable template means the
    // customer is told NOTHING about their dispatch. That was a WARN in a log
    // nobody reads, and three real orders went out silently on 24 Sept before
    // anyone noticed. Tell the owner, once per order so a second fulfillment
    // update does not repeat it.
    await soft('shippedTemplateAlert', () =>
      runOnce(orderId, 'shipped-template-alert', async () => {
        await ownerAlert(
          deps,
          n.name,
          'dispatch message NOT sent: the order_shipped template is not approved on WhatsApp. Message this customer the tracking link by hand and get the template approved',
        );
        return { alerted: true };
      }),
      { orderId, waCode: e.waCode },
    );
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
    gift_line: amt?.gift ? OFFER_GIFT_LINE : OFFER_NO_GIFT_LINE,
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
    gift_line: amt?.gift ? OFFER_GIFT_LINE : OFFER_NO_GIFT_LINE,
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
