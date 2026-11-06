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
  patchFlowA, patchFlowB,
  runOnce,
  getSide,
} from '../store/orderState.mjs';
import {
  isOptedOut, touchInbound, windowOpen, canSendMarketing, markMarketing,
  getParkedOffer, clearParkedOffer,
} from '../store/phoneProfile.mjs';
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

/**
 * Is this order still one we may offer online payment on, and convert?
 *
 * ONE RULE, ASKED IN THREE PLACES. Before this existed, onFallback skipped only
 * OFD, DELIVERED and RTO, so it offered a discount on a parcel that was already
 * PICKED_UP or IN_TRANSIT, and onPayOnline and onConfirm created links with no
 * courier check at all. Both endings were bad. Either the payment arrives and
 * onPaymentPaid refunds it, so the customer was charged and reversed for
 * nothing, or the waybill is past editing and the order is converted in Shopify
 * while Delhivery still has it as COD, and the courier collects the money a
 * second time at the door.
 *
 * No AWB means nothing has been handed over yet, so there is nothing to refuse.
 *
 * An unreadable status is NOT payable. mapCourierStatus answers UNKNOWN both
 * for a status string Delhivery has not shown us and for a tracking call that
 * came back empty, and the cost of being wrong here is one-sided: refusing an
 * offer costs a nudge, allowing one costs a double charge.
 */
async function payable(deps, n) {
  if (!n?.delhiveryAwb) return true;
  const [t] = await deps.clients.courier.track([n.delhiveryAwb]);
  return !!t && isCourierEditable(mapCourierStatus(t));
}

/** Create (or reuse) the payment link + pay token. Null when no offer is valid. */
async function ensurePaymentLink(deps, n, amt, now) {
  if (!amt.feeMatches) {
    /*
     * ONCE PER ORDER, not once per tap. This fires from onConfirm, onPayOnline
     * and the 12h fallback, so a customer prodding the buttons on a genuinely
     * mismatched order sent the owner the same line three or four times.
     */
    await soft('alertFeeMismatch', () =>
      runOnce(n.numericId, 'alert-fee-mismatch', async () => {
        await ownerAlert(deps, n.name, 'COD fee does not match codk value, no prepaid offer made');
        return { alerted: true };
      }),
      { orderId: n.numericId },
    );
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
  await scheduleTimer({ flow: 'A', orderId, step: 'cod', at: addMinutes(now, RULES.codFirstMessageDelayMin), now });
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

/**
 * Has it already been dispatched? Records the answer and says so.
 *
 * Shared by the reminder and the high-risk hold, which both ask the same
 * question of the same order and both used to send regardless. Recorded rather
 * than returned silently, for the same reason codSkip exists: "we did not send"
 * and "we looked and decided not to" are different facts, and only one of them
 * means something is wrong.
 */
async function dispatchSkip(orderId, n, step) {
  if (!n?.fulfillments?.length && !n?.delhiveryAwb) return false;
  await patchFlowA(orderId, { reminderSkip: `${step}:already-dispatched` });
  log.info('flowA: already dispatched, pre-dispatch nudge not sent', { orderId, step });
  return true;
}

export async function onCodTimer(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  const st = (await getState(orderId)) || {};
  const cls = st.class || classify(n);
  // phoneSource records WHICH field the recipient came from, so an owner asking
  // "who did we message about this order" has an answer that is not a guess.
  await patchState(orderId, { class: cls, riskTag: n.riskTag, verifiedPhone: n.verifiedPhone, phoneSource: n.phoneSource || null, firstName: n.firstName, name: n.name });

  if (st.flowA?.codConfirmAt) return; // already sent (stale timer)

  /*
   * IT HAS ALREADY SHIPPED, SO THERE IS NOTHING TO CONFIRM.
   *
   * cod_confirm says the order is "ready to be packed" and offers a button to
   * send it for packing. On a parcel Delhivery already has, every word of that
   * is false, and order_shipped has covered it. This is reachable two ways: a
   * timer that fired late, and the reconcile sweep re-arming an old order.
   *
   * codSkip rather than a bare return, so the sweep records that we looked at
   * it and decided, and stops re-arming it three times and alerting.
   */
  if (n.fulfillments?.length) {
    await codSkip(orderId, 'already-fulfilled');
    log.info('flowA cod: already dispatched, nothing to confirm', { orderId });
    return;
  }

  /*
   * UNKNOWN NO LONGER MEANS SILENCE.
   *
   * It used to stop the flow dead, and that was the single biggest hole in it:
   * any order we could not read the payment of got no confirmation, no tag and
   * nothing but an owner alert. Four real orders in the last 30 days ended
   * there (#1175, #1188, #1232, #1239) and two of them shipped without the
   * customer ever hearing from us.
   *
   * Not being able to read the payment is a reason not to PROMISE anything
   * about payment, which is all it ever was: order_confirmed names the items
   * and the total and says the parcel is with the packing team, and every word
   * of that is true whatever the gateway says. So the flow carries on into the
   * non-COD branch below and the owner still gets told, once, that this one
   * could not be read.
   */
  if (cls === 'UNKNOWN') {
    await runOnce(orderId, 'alert-unknown', () =>
      ownerAlert(deps, n.name, 'payment type could not be read, sent the plain order confirmation and no COD chase'));
  }
  const elig = flowAEligible(n, cls, { startAt: config.flows.A.startAt, orderAllowlist: config.orderAllowlist });
  if (!elig.ok) {
    await codSkip(orderId, `ineligible:${elig.reason}`);
    log.info('flowA cod: not eligible', { orderId, reason: elig.reason });
    return;
  }
  if (!n.verifiedPhone) {
    // Reached only when the order has no OTP number AND no usable phone in any
    // field; getNorm has already logged which fields it tried.
    await codSkip(orderId, 'no-phone-anywhere');
    log.warn('flowA cod: no recipient on this order, nothing sent', { orderId, reason: 'no-phone-anywhere' });
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
  await soft('tagsAdd:wa-cod-sent', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-cod-sent']), { orderId });

  await armTimer(orderId, 'reminder', deferPastQuietHours(addMinutes(now, RULES.codReminderAfterMin), RULES.quietHours), now);
  // Not armed when the offer is off, so we do not create a schedule per order
  // for a message that will return immediately. onFallback re-checks the flag
  // anyway, which is what makes the timers already out there harmless.
  if (RULES.prepaidOfferEnabled) {
    await armTimer(orderId, 'fallback', deferPastQuietHours(addMinutes(now, RULES.codMarketingFallbackAfterMin), RULES.quietHours), now);
  }
  await armTimer(orderId, 'highrisk', deferPastQuietHours(addHours(now, RULES.highRiskCheckAfterHours), RULES.quietHours), now);
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
async function armTimer(orderId, step, at, now) {
  return soft(`scheduleTimer:${step}`, () =>
    withRetry(`scheduleTimer:${step}`, () => scheduleTimer({ flow: 'A', orderId, step, at, now }), { idempotent: true }),
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
  await armTimer(orderId, 'cod', addHours(now, CONFIRM_DEFER_HOURS), now);
}

/**
 * What state is this order in, as far as a button tap is concerned?
 *
 * WHATSAPP BUTTONS DO NOT EXPIRE. The confirmation we sent three minutes after
 * the order sits in the customer's chat for as long as the chat does, and they
 * tap it whenever they scroll back. Before this existed, every tap acted as if
 * the order were still the one we had messaged about:
 *
 *   - "Keep cash on delivery" after paying online replied "stays on cash on
 *     delivery" and overwrote flowA.step `converted`, erasing the record of a
 *     real payment.
 *   - "Confirm" on a cancelled order added wa-confirmed, created a Razorpay
 *     link and offered to take money for an order that no longer exists.
 *
 * Four answers, cancelled first because a cancelled order can also be paid and
 * shipped and the customer only needs to hear the one that ends the matter.
 *
 * `paid` reads three things because each can be true on its own: our own
 * conversion stamp, the tag Shopify carries, and the money actually received,
 * which covers a payment taken outside this flow.
 */
function tapState(n, st) {
  if (n?.cancelledAt || st?.flowA?.step === 'stopped') return 'cancelled';
  if (
    st?.flowA?.convertedAt ||
    hasTag(n?.tags, 'PREPAID-CONVERTED') ||
    (n?.receivedPaise || 0) >= (n?.currentTotalPaise || 0)
  ) {
    return 'paid';
  }
  if (n?.fulfillments?.length || n?.delhiveryAwb) return 'shipped';
  return 'open';
}

/**
 * The tap gate: tapState, corrected by the waybill, with one courier read.
 *
 * tapState calls anything with a fulfillment `shipped`, and that is too blunt
 * on its own. A MANIFESTED parcel is already fulfilled in Shopify and is still
 * perfectly editable at Delhivery, so refusing those would close the prepaid
 * switch a day early and turn a working offer into "it has already left us".
 * The waybill is the authority on whether it has actually gone.
 *
 * `payable` is returned alongside rather than asked again, because asking twice
 * is a second tracking call on every tap.
 *
 * @returns {Promise<{state:'cancelled'|'paid'|'shipped'|'open', payable:boolean}>}
 */
async function tapGate(deps, n, st) {
  const state = tapState(n, st);
  if (state === 'cancelled' || state === 'paid') return { state, payable: false };
  const ok = await payable(deps, n);
  return { state: ok ? 'open' : 'shipped', payable: ok };
}

/*
 * The reply for a tap that arrived too late, and nothing else.
 *
 * No tag, no link, no flowA.step write. That last one is the point: `converted`
 * and `stopped` are terminal records of something irreversible, and the whole
 * defect was a stale button overwriting them.
 */
const closedReply = (deps, n, key) =>
  sess(deps, n.verifiedPhone, key, {
    customer_name: n.firstName,
    order_number: n.name,
    awb: n.delhiveryAwb || '',
  });

// ---- taps -------------------------------------------------------------------
export async function onConfirm(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  const { state } = await tapGate(deps, n, await getState(orderId));
  if (state !== 'open') {
    // Nothing is tagged, linked or written. A stale button must not be able to
    // confirm an order that is cancelled, or re-open one that is paid.
    const key = { cancelled: 'order_closed', paid: 'already_paid', shipped: 'already_shipped' }[state];
    return closedReply(deps, n, key);
  }
  await cancelTimer({ flow: 'A', orderId, step: 'reminder' });
  await cancelTimer({ flow: 'A', orderId, step: 'fallback' });
  await deps.clients.shopify.tagsAdd(n.gid, ['wa-confirmed']);
  await patchFlowA(orderId, { step: 'confirmed' });
  // `open` already means the waybill is still ours to change, so the offer
  // needs no second courier read here.
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
  const { state } = await tapGate(deps, n, await getState(orderId));
  if (state === 'cancelled' || state === 'paid') {
    return closedReply(deps, n, state === 'cancelled' ? 'order_closed' : 'already_paid');
  }
  await cancelTimer({ flow: 'A', orderId, step: 'reminder' });
  // The fallback timer is deliberately LEFT RUNNING. Asking for a payment link
  // is not paying: this tap used to cancel the only remaining nudge, so someone
  // who opened the link and got distracted was never contacted again and the
  // order quietly stayed COD. A successful payment cancels every timer anyway.
  /*
   * They ASKED to pay online, so a silent "it stays cash on delivery" is the
   * one answer that does not work here: it reads as the tap having failed.
   * pay_at_door says what happened and what to have ready.
   */
  if (state === 'shipped') {
    return sess(deps, n.verifiedPhone, 'pay_at_door', {
      customer_name: n.firstName,
      order_number: n.name,
      cod_total: formatINR(n.currentTotalPaise),
    });
  }
  const amt = computeAmounts(n, RULES);
  const link = await ensurePaymentLink(deps, n, amt, now);
  if (link) return sess(deps, n.verifiedPhone, 'pay_online_offer', offerVars(n, amt, now, link), { url: link.url });
  /*
   * They asked to pay online and we cannot make a link. keep_cod_ack used to go
   * here, and "Done, your order stays on cash on delivery" is the wrong answer
   * to a request: it reads as though the tap chose the opposite of what they
   * tapped. Say the option is unavailable and leave the door open.
   */
  return sess(deps, n.verifiedPhone, 'pay_online_unavailable', {
    customer_name: n.firstName,
    order_number: n.name,
  });
}

export async function onKeepCod(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  /*
   * THE WORST OF THE THREE. This used to reply "stays on cash on delivery" to
   * a customer who had already paid online, and overwrite flowA.step
   * `converted` on the way, erasing the record of a real payment.
   */
  const { state } = await tapGate(deps, n, await getState(orderId));
  if (state !== 'open') {
    const key = { cancelled: 'order_closed', paid: 'already_paid', shipped: 'already_shipped' }[state];
    return closedReply(deps, n, key);
  }
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
  const st = (await getState(orderId)) || {};
  // Only `cancelled` is refused. A paid or shipped customer may still ASK to
  // cancel, and the paths below already handle both: the refund review handoff
  // and cancel_too_late. Refusing those would take away the one route they
  // have to a human.
  if (tapState(n, st) === 'cancelled') return closedReply(deps, n, 'order_closed');
  // Offer the change first when the order can still take one. Cancelling used
  // to be the only self-service option, so a customer who wanted a different
  // size had to cancel and reorder: that is how #1187 became #1188, 36 minutes
  // apart. When the order is past changing (AWB printed, money taken, already
  // changed once, flag off) this is byte for byte the old behaviour.
  if (await variantChange.changeOffered(n, st, n.verifiedPhone)) {
    return sess(deps, n.verifiedPhone, 'change_or_cancel', { order_number: n.name }, { orderId: n.numericId });
  }
  await sess(deps, n.verifiedPhone, 'cancel_check', { order_number: n.name }, { orderId: n.numericId });
}

export async function onCancelNo(orderId, deps) {
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, nowOf(deps));
  // "No, keep it" on an order that is already cancelled cannot keep anything,
  // and replying "we have kept it" would be untrue.
  if (tapState(n, await getState(orderId)) === 'cancelled') return closedReply(deps, n, 'order_closed');
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
  /*
   * cod_reminder says "we are still holding your order" and asks for one tap
   * to send it for packing. Six hours is long enough for the order to have
   * been packed and handed over, and this had no dispatch check at all, so a
   * customer whose parcel was already in transit was asked to release it.
   */
  if (await dispatchSkip(orderId, n, 'reminder')) return;
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
  // Checked here and not only at arm time: every order placed before this flag
  // went off already has a fallback timer sitting in EventBridge, and this is
  // the only thing standing between those and a MARKETING send.
  if (!RULES.prepaidOfferEnabled) return;
  const st = await getState(orderId);
  if (!st || st.flowA?.step !== 'confirm_sent') return; // tapped already
  if (st.flowA?.fallbackSentAt) return; // a retry after the send succeeded
  const n = await getNorm(deps, orderId);
  if (!n || n.cancelledAt || !n.verifiedPhone) return;
  if (await isOptedOut(n.verifiedPhone)) return;
  /*
   * This used to skip only OUT_FOR_DELIVERY, DELIVERED and RTO, so a parcel
   * that was merely PICKED_UP or IN_TRANSIT still got a discount offer it
   * could not honour. One predicate now, shared with the two taps.
   */
  if (!(await payable(deps, n))) return;
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
  // "HIGH RTO risk and unconfirmed after 24h" is a hold instruction, and a
  // parcel already with the courier cannot be held. The tag would ask the
  // owner to stop something that has gone.
  if (await dispatchSkip(orderId, n, 'highrisk')) return;
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
  /*
   * THE WAYBILL ARRIVED LATE, SO THE GUESS IS OFF.
   *
   * A fulfillment created before its tracking number has no waybill to track,
   * so Flow B arms an ASSUMED review ask at +5 days. The AWB then turns up on a
   * later fulfillments/update, and until now nothing cancelled that timer: a
   * parcel still in transit on day 6 was told "your order reached you on
   * <today>". Delhivery is tracking it now, so Delhivery's own DELIVERED is the
   * only thing that should ask.
   *
   * Soft, for the reason the whole rest of this handler is: a review ask is
   * never worth failing a fulfillment record over.
   */
  if (st?.flowB?.assumedDelivery && !st?.flowB?.reviewAsked) {
    await soft('flowB:cancelAssumedAsk', async () => {
      await cancelTimer({ flow: 'B', orderId, step: 'review_ask' });
      await patchFlowB(orderId, { scheduled: false, assumedDelivery: false });
    }, { orderId });
  }
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
/*
 * "Order total: Rs 1,099" is true for a PARTIAL order and still reads as a
 * receipt. #1162 and #1197 each paid a Rs 62.45 deposit at COD King's checkout
 * and owe Rs 1,036.55 at the door, and neither was told so until order_shipped
 * went out days later at label time. This spells the split out inside the
 * EXISTING {{order_total}} variable, so the approved template and its copy are
 * untouched and nothing has to go back to Meta for review.
 *
 * COD and fully prepaid orders have nothing to split, so they read exactly as
 * before.
 */
function orderTotalLine(n) {
  const total = formatINR(n.currentTotalPaise);
  const due = Math.max(0, n.currentTotalPaise - (n.receivedPaise || 0));
  if (!n.receivedPaise || due <= 0) return total;
  return `${total} (${formatINR(n.receivedPaise)} paid online, ${formatINR(due)} at delivery)`;
}

function confirmVars(n, amt) {
  return {
    customer_name: n.firstName,
    order_number: n.name,
    item_line: itemLine(n) || 'Your order',
    order_total: orderTotalLine(n),
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

/**
 * This phone just wrote to us, so a 24 hour service window is now open.
 *
 * The third of three such hooks, next to Flow R's and Flow W's, and for the
 * same reason: a prepaid_offer Meta refused with 131049 or 130472 can go now as
 * a free-form message, which carries no category and so no per-user marketing
 * cap. The customer opening the window is the only thing that clears that cap
 * for us, which is why this hangs off their inbound message rather than off a
 * timer. A timer would collect the same refusal again.
 *
 * Everything is re-asked, because this runs minutes to hours after the refusal:
 * the order may have been paid, cancelled or dispatched since, and the link may
 * have expired. Each of those clears the park rather than leaving it to rot.
 */
export async function onWindowOpen(phone, deps) {
  const now = nowOf(deps);
  const parked = await getParkedOffer(phone);
  if (!parked?.orderId) return;
  const orderId = parked.orderId;

  const drop = async (reason) => {
    await clearParkedOffer(phone);
    log.info('flowA: parked offer released', { orderId, reason });
    return { dropped: reason };
  };

  if (!RULES.prepaidOfferEnabled) return drop('offer-off');
  if (parked.until && new Date(parked.until).getTime() <= now.getTime()) return drop('link-expired');
  if (await isOptedOut(phone)) return drop('opted-out');

  const n = await getNorm(deps, orderId);
  if (!n || n.verifiedPhone !== phone) return drop('not-this-phone');

  const st = await getState(orderId);
  const { state } = await tapGate(deps, n, st);
  // Paid, cancelled or past pickup: the offer has nothing left to offer.
  if (state !== 'open') return drop(`state:${state}`);

  const amt = computeAmounts(n, RULES);
  const link = await ensurePaymentLink(deps, n, amt, now);
  if (!link) return drop('no-link');

  await sess(deps, phone, 'pay_online_offer', offerVars(n, amt, now, link), { url: link.url });
  await patchFlowA(orderId, { offerDeliveredInWindowAt: now.toISOString() });
  await clearParkedOffer(phone);
  log.info('flowA: parked offer delivered inside the window', { orderId });
  return { sent: true };
}
