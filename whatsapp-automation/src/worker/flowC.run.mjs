/*
 * flowC.run.mjs — Flow C: NDR rescue + RTO reason capture.
 * NDR: one action prompt per failed attempt; re-attempt / same-pincode address
 * edit / cancel. RTO: tag, stop other flows, capture the reason, apply cod-block
 * when warranted. All sends DRY_RUN + allowlist gated; writes idempotent.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { RTO_REASONS, COD_BLOCK_REASONS } from '../../messages/labels.mjs';
import { classifyAddressReply } from '../domain/ndr.mjs';
import { addHours, addDays, nextWindowTime, withinWindow, istDayKey } from '../lib/time.mjs';
import { getState, patchFlowC, runOnce } from '../store/orderState.mjs';
import { isOptedOut, touchInbound, setAwaiting, clearAwaiting, markRto } from '../store/phoneProfile.mjs';
import { alertOncePerDay } from '../store/cartRecovery.mjs';
import { formatINR } from '../lib/money.mjs';
import { scheduleTimer } from '../timers/schedule.mjs';
import { getNorm, tpl, sendBest, sess, ownerAlert, isTemplateUnusable } from './send.mjs';
import * as flowA from './flowA.run.mjs';
import { log } from '../log.mjs';
import { soft } from '../lib/resilience.mjs';

const nowOf = (deps) => deps.now || new Date();

/*
 * Flow C had NO kill switch at all: `FLOW_C_ENABLED=false` was read by nothing
 * here and by nothing in the worker's router, so the flow ran in full while it
 * was supposed to be off. On 2026-09-29 that tagged three orders `RTO` in
 * Shopify and force-stopped Flow A on them. The RTO tag also feeds the Meta
 * exclusion audience, so an off flow was quietly shaping ad spend.
 *
 * Guarded at the two STARTERS and the RTO timer only. A customer who is already
 * mid-conversation still gets their button tap honoured, because going silent
 * on someone we just asked a question is worse than finishing the exchange.
 */
function flowCOff(where, orderId) {
  if (config.flows.C.enabled) return false;
  log.info('flowC: disabled, not starting', { where, orderId });
  return true;
}

/**
 * We cannot do what they asked, so a person will. Never a confirmation.
 *
 * Both NDR actions need a Delhivery waybill, and both used to send their
 * "Done" message whether or not there was one: ndr_reattempt_ok and
 * ndr_address_saved went out on orders where nothing had been booked and
 * nobody had been told. The customer then waits for a delivery that was never
 * rescheduled.
 */
async function ndrHandoff(deps, n, orderId, what) {
  await soft('ndrHandoffMsg', () => sess(deps, n.verifiedPhone, 'ndr_handoff', {}), { orderId });
  await ownerAlert(deps, n.name, `customer asked for ${what} after a failed delivery and there is no Delhivery waybill on this order. Nothing was booked, call them`);
  log.warn('flowC ndr: no waybill, handed to a person', { orderId, what });
}

// ---- NDR --------------------------------------------------------------------
/**
 * A delivery attempt failed.
 *
 * ONE PROMPT PER FAILED ATTEMPT, NOT ONE PER ORDER.
 *
 * The guard here was `if (st.flowC.ndrAskedAt) return`, which is per ORDER.
 * Delhivery attempts up to three times, so attempts 2 and 3 got nothing at all
 * and the parcel went to RTO while the customer was never asked again. Keyed on
 * the IST day of the attempt now, which also makes it idempotent across the two
 * sources that report the same failure: the Delhivery poller and Shopify's
 * fulfillment_events both arrive for one attempt and must produce one prompt.
 *
 * `attemptAt` is the ATTEMPT's own time, passed in by the caller, and not
 * `now`. When the prompt is deferred past the send window overnight, `now` is
 * the following morning, so attempt_date told the customer their delivery was
 * attempted on a day it was not. It rides along in the deferred timer so the
 * date survives the wait.
 */
export async function onNdr(orderId, deps, { attemptAt } = {}) {
  if (flowCOff('onNdr', orderId)) return;
  const now = nowOf(deps);
  const at = attemptAt ? new Date(attemptAt) : now;
  const day = istDayKey(at);
  const n = await getNorm(deps, orderId);
  if (!n || n.cancelledAt || !n.verifiedPhone) {
    log.info('flowC ndr: not sent', { orderId, reason: !n ? 'order-unreadable' : n.cancelledAt ? 'cancelled' : 'no-phone-anywhere' });
    return;
  }
  // Flow C had NO opt-out check anywhere, while A and B both honour it, so a
  // customer who had sent STOP still received NDR and RTO templates. Opt-out is
  // a hard guardrail, not a per-flow preference.
  if (await isOptedOut(n.verifiedPhone)) return;

  const st0 = await getState(orderId);
  const asked = st0?.flowC?.ndrAsked || {};
  if (asked[day]) return; // this attempt has already been prompted
  /*
   * Past the cap, the customer is not the person to ask any more. Three failed
   * attempts is Delhivery's own limit and a fourth means something a prompt
   * cannot fix, so the owner gets one line and nobody gets a fourth template.
   */
  if (Object.keys(asked).length >= RULES.ndrMaxPrompts) {
    await soft('ndrCapAlert', () =>
      runOnce(orderId, 'ndr-cap', async () => {
        await ownerAlert(deps, n.name, 'repeated failed delivery, call the customer');
        return { alerted: true };
      }),
      { orderId },
    );
    return log.warn('flowC ndr: past the prompt cap, owner told instead', { orderId, prompts: Object.keys(asked).length });
  }

  // Send only inside the NDR window; otherwise defer to the next window start,
  // carrying the attempt time so attempt_date is still the attempt's own day.
  if (!withinWindow(now, RULES.ndrSendWindow)) {
    return scheduleTimer({
      flow: 'C', orderId, step: 'ndr', at: nextWindowTime(now, RULES.ndrSendWindow), now,
      extra: { attemptAt: at.toISOString() },
    });
  }
  const res = await sendBest(deps, n.verifiedPhone, 'ndr_action', { customer_name: n.firstName, order_number: n.name, attempt_date: fmtDate(at) }, { orderId: n.numericId, now });
  if (res?.skipped) return;
  await patchFlowC(orderId, { ndrAsked: { ...asked, [day]: now.toISOString() }, ndrAskedAt: now.toISOString() });
  // One tag, on the first prompt: it is what the daily digest counts, and
  // counting replies instead meant the digest reported zero NDR for days when
  // three parcels had failed.
  await soft('tagsAdd:wa-ndr', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-ndr']), { orderId });
}

export async function onNdrReattempt(orderId, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);
  /*
   * NO WAYBILL MEANS NOTHING WAS BOOKED, SO NOTHING IS CONFIRMED.
   *
   * The AWB check used to be inline, `if (n.delhiveryAwb) await ndrAction(...)`,
   * and ndr_reattempt_ok went out either way. So an order with no Delhivery
   * waybill told the customer their delivery had been rescheduled when nothing
   * had been asked of anybody, and the owner was not told either. A promise we
   * have not made is the one thing this service must never send.
   */
  if (!n.delhiveryAwb) return ndrHandoff(deps, n, orderId, 'a new delivery attempt');

  try {
    /*
     * ONCE PER DAY, not once per tap. Now that an order can be prompted on
     * three separate days, a customer who taps "Deliver tomorrow" twice would
     * otherwise book two re-attempts with Delhivery for the same day. Keyed by
     * day rather than by order, because tomorrow's prompt deserves its own
     * booking.
     */
    await runOnce(orderId, `ndr-reattempt:${istDayKey(now)}`, async () => {
      await deps.clients.courier.ndrAction(n.delhiveryAwb, 'RE-ATTEMPT');
      return { booked: true };
    });
    await sess(deps, n.verifiedPhone, 'ndr_reattempt_ok', {});
    await deps.clients.shopify.tagsAdd(n.gid, ['wa-ndr-reattempt']);
  } catch (e) {
    await soft('ndrReattemptHandoff', () => sess(deps, n.verifiedPhone, 'ndr_handoff', {}), { orderId });
    await ownerAlert(deps, n.name, 'NDR re-attempt request failed, customer told a person will call');
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
    // Same rule as the re-attempt: with no waybill there is nothing to edit, so
    // "we have saved your address" would be describing work nobody did.
    if (!n.delhiveryAwb) {
      await clearAwaiting(n.verifiedPhone);
      return ndrHandoff(deps, n, orderId, 'an address correction');
    }
    try {
      /*
       * `add` is the field Delhivery documents, and the pincode is not a field
       * at all. This sent { address, pin } until 2026-10-26, which is the same
       * unknown-key mistake that got a re-attempt refused whole. Nothing is
       * lost: classifyAddressReply only returns 'same' when the pincode has not
       * changed, so there is no new pincode to send.
       */
      // Once per day, for the same reason as the re-attempt above.
      await runOnce(orderId, `ndr-address:${istDayKey(nowOf(deps))}`, async () => {
        await deps.clients.courier.ndrAction(n.delhiveryAwb, 'EDIT_DETAILS', { add: text });
        return { edited: true };
      });
      await sess(deps, n.verifiedPhone, 'ndr_address_saved', {});
      await deps.clients.shopify.tagsAdd(n.gid, ['wa-ndr-address']);
    } catch (e) {
      await soft('ndrAddressHandoff', () => sess(deps, n.verifiedPhone, 'ndr_handoff', {}), { orderId });
      await ownerAlert(deps, n.name, 'NDR address edit failed, customer told a person will call');
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

/**
 * N1. The parcel is with the rider today.
 *
 * This is the last moment an NDR is preventable. Flow C's own prompt arrives
 * AFTER a failed attempt, by which time somebody has driven to the address and
 * the parcel is heading for a second attempt or for RTO. "Keep this much
 * ready" and "tell us if you will be out" the morning of covers the two
 * reasons a COD delivery fails here.
 *
 * ONCE PER WAYBILL PER IST DAY. Delhivery can scan out-for-delivery twice in a
 * day, and a second attempt on a later day is a genuinely new nudge, so the
 * key is the day rather than the order.
 *
 * COD WITH SOMETHING LEFT TO PAY, only. A prepaid parcel needs nothing ready,
 * and an order already paid online would be asked to hand over money it has
 * paid.
 *
 * Past 19:00 it is SKIPPED rather than deferred: tomorrow morning it will not
 * be true, and a message about a delivery that has already failed is the NDR
 * prompt's job.
 */
export async function onOutForDelivery(orderId, deps, { awb } = {}) {
  if (flowCOff('onOutForDelivery', orderId)) return;
  const now = nowOf(deps);
  if (!withinWindow(now, RULES.ofdSendWindow)) {
    return log.info('flowC ofd: outside the send window, skipping rather than deferring', { orderId });
  }
  const n = await getNorm(deps, orderId);
  if (!n || n.cancelledAt || !n.verifiedPhone) return;
  if (await isOptedOut(n.verifiedPhone)) return;

  const duePaise = Math.max(0, n.currentTotalPaise - (n.receivedPaise || 0));
  if (duePaise <= 0) {
    return log.info('flowC ofd: nothing left to pay, no nudge needed', { orderId });
  }

  const day = istDayKey(now);
  const st = await getState(orderId);
  const sent = st?.flowC?.ofdSent || {};
  const key = `${awb || n.delhiveryAwb || 'noawb'}:${day}`;
  if (sent[key]) return;

  try {
    const res = await sendBest(deps, n.verifiedPhone, 'out_for_delivery', {
      customer_name: n.firstName,
      order_number: n.name,
      cod_total: formatINR(duePaise),
    }, { orderId: n.numericId, token: n.delhiveryAwb, now });
    if (res?.skipped) return;
  } catch (e) {
    /*
     * The template is new, so Meta may still be reviewing it. Skipping is
     * right: this nudge is a bonus and failing a courier event over it would
     * cost the delivery and the RTO handling that follow. One line to the
     * owner, once a day, because an unapproved template is something only they
     * can fix.
     */
    if (!isTemplateUnusable(e)) throw e;
    await soft('ofdTemplateAlert', async () => {
      if (await alertOncePerDay('ofd-template', now)) {
        await ownerAlert(deps, n.name, 'the out_for_delivery template is not approved on WhatsApp yet, so the same-day delivery nudge is not going out. Submit it and get it approved');
      }
    }, { orderId });
    return log.warn('flowC ofd: template not usable, nothing sent', { orderId, waCode: e.waCode });
  }

  await patchFlowC(orderId, { ofdSent: { ...sent, [key]: now.toISOString() } });
}

// ---- RTO --------------------------------------------------------------------
export async function onRto(orderId, deps) {
  if (flowCOff('onRto', orderId)) return;
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await runOnce(orderId, 'rto-init', async () => {
    await deps.clients.shopify.tagsAdd(n.gid, ['RTO']);
    return { tagged: true };
  });

  /*
   * COUNT THE RTO WHEN IT HAPPENS, NOT WHEN THEY ANSWER A QUESTION ABOUT IT.
   *
   * markRto used to live in onRtoReason, the BUTTON TAP, which got the count
   * wrong in both directions. A customer who ignored the reason question was
   * never counted, so a repeat silent RTO never reached the cod-block, which is
   * the one customer the block exists for. And a double tap counted twice, so a
   * single RTO produced rto-count-2 and a cod-block on a first offence.
   *
   * runOnce per order, so a redelivered RTO event cannot count the same return
   * again, and keyed on the ORDER rather than the phone because the same phone
   * genuinely can return two different parcels.
   */
  await soft('rtoCount', () =>
    runOnce(orderId, 'rto-count', async () => {
      const count = await markRto(n.verifiedPhone);
      if (n.customerGid && count != null) {
        const tags = [`rto-count-${count}`];
        if (count >= RULES.rtoCodBlockCount) tags.push('cod-block');
        await deps.clients.shopify.tagsAdd(n.customerGid, tags);
      }
      return { count };
    }),
    { orderId },
  );

  await flowA.onStop(orderId, deps); // stop Flow A, cancel links + timers
  await scheduleTimer({ flow: 'C', orderId, step: 'rto_reason', at: nextWindowTime(now, RULES.reviewSendWindow), now });
  await patchFlowC(orderId, { rto: true, rtoAt: now.toISOString() });
}

export async function onRtoTimer(orderId, deps) {
  if (flowCOff('onRtoTimer', orderId)) return;
  const n = await getNorm(deps, orderId);
  if (!n || !n.verifiedPhone) return;
  if (await isOptedOut(n.verifiedPhone)) return;
  const st = await getState(orderId);
  if (st?.flowC?.rtoReasonAskedAt) return;
  /*
   * The session twin is a LIST, because six reasons will not fit in three
   * reply buttons, so its rows have to be passed in. They are built from
   * RTO_REASONS, the same list the template's buttons are generated from, so
   * the two channels can never offer different reasons.
   */
  const res = await sendBest(deps, n.verifiedPhone, 'rto_reason', { customer_name: n.firstName, order_number: n.name }, {
    orderId: n.numericId,
    rows: RTO_REASONS.map((r) => ({ action: `rto_${r.id}`, title: r.label })),
    now: nowOf(deps),
  });
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

  /*
   * The count is NOT here any more; onRto owns it. This tap only adds what the
   * answer itself tells us, which is whether the reason is one we block COD
   * for. Everything is runOnce so a second tap re-sends the thanks and changes
   * nothing else.
   */
  await soft('rtoReasonBlock', () =>
    runOnce(orderId, 'rto-reason', async () => {
      if (n.customerGid && COD_BLOCK_REASONS.includes(reason.id)) {
        await deps.clients.shopify.tagsAdd(n.customerGid, ['cod-block']);
      }
      return { reason: reason.id };
    }),
    { orderId },
  );

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
