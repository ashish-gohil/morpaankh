/*
 * flowB.run.mjs — Flow B: delivered -> review request (WhatsApp Flow) -> code.
 * Reviews are stored as product_review metaobjects (ACTIVE when consented + clean,
 * else DRAFT); the thank-you code is given for ANY genuine review, whatever the
 * rating. All sends DRY_RUN + allowlist gated; all writes idempotent.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { hasRtoTag } from '../domain/order.mjs';
import { afterStart } from '../domain/eligibility.mjs';
import { validateReview, moderationStatus } from '../domain/review.mjs';
import { reviewFormSuffix } from '../../messages/templates.mjs';
import { formatINR } from '../lib/money.mjs';
import { addDays, nextDailySlot, formatISTDate, endOfDayIST } from '../lib/time.mjs';
import { signToken } from '../lib/ids.mjs';
import { generateCode } from '../lib/discount-code.mjs';
import { getSecrets } from '../secrets.mjs';
import { getState, patchFlowB, runOnce } from '../store/orderState.mjs';
import { isOptedOut, touchInbound, canAskReview, markReviewAsk } from '../store/phoneProfile.mjs';
import { scheduleTimer, cancelTimer } from '../timers/schedule.mjs';
import { getNorm, tpl, sess, ownerAlert } from './send.mjs';
import { log } from '../log.mjs';
import { soft } from '../lib/resilience.mjs';

const nowOf = (deps) => deps.now || new Date();

/** Order-level reasons to never ask for a review. */
function reviewSkipReason(n) {
  // The kill switch was checked in onDelivered only, so timers armed while the
  // flow was on kept firing after it was turned off: switching Flow B off did
  // not actually stop it. Flow A checks `enabled` at every send for exactly
  // this reason, and every review send routes through here.
  if (!config.flows.B.enabled) return 'flow-disabled';
  if (!n) return 'no-order';
  if (n.cancelledAt) return 'cancelled';
  if (hasRtoTag(n.tags)) return 'rto';
  if (String(n.financialStatus || '').toUpperCase().includes('REFUNDED')) return 'refunded';
  if (!afterStart(n, config.flows.B.startAt)) return 'before-startAt';
  return null;
}

/**
 * When a review ask goes out: the fixed daily slot, `days` whole IST days on.
 *
 * Every Flow B send routes through here so the ask and the reminder land at the
 * same hour. Before this each one was its own offset nudged into a window, so a
 * customer could be asked at 12:20 and reminded at 16:29.
 */
const reviewSlot = (from, days, now) => nextDailySlot(from, RULES.reviewAskAtIST, { minDays: days, now });

async function flowToken(orderId, now) {
  const s = await getSecrets();
  const exp = Math.floor(addDays(now, 14).getTime() / 1000);
  return signToken({ orderId, exp }, s.flowTokenKey || 'dev-flow-key');
}

/*
 * EVERY key the Flow's screen declares must be present in flow_action_data.
 *
 * WhatsApp binds the screen's data as a whole: one missing key and the binding
 * fails for the ENTIRE screen, so every ${data.x} renders as its own literal
 * source text. The customer sees "a code for ${data.percent_text} off your next
 * order of ${data.min_order_text} or more".
 *
 * `products` used to be added only when the order had more than one line, so
 * every SINGLE-line order got a broken form - which is almost all of them, 14
 * of the last 15. It is now always present, empty when there is nothing to
 * choose between. That is safe: the Dropdown it feeds is hidden behind
 * `visible: ${data.show_product}`, so an empty list is never rendered.
 *
 * messages/flows/review.flow.json is the contract, and flowB.test.mjs reads
 * that file and fails if this function stops supplying any key it declares.
 */
function flowData(n, withProducts) {
  const data = {
    first_name: n.firstName,
    // The Flow screen's key is still named percent_text, and it stays that way
    // on purpose: renaming it would need the published Flow republished, and
    // publishing is ONE WAY (a published Flow can be deprecated, never returned
    // to draft). The key is a slot; what the customer reads is the value.
    percent_text: formatINR(RULES.reviewCodeAmountInr * 100),
    min_order_text: formatINR(RULES.reviewCodeMinSubtotalInr * 100),
    show_product: false,
    products: [],
  };
  if (withProducts && n.lineItems.length > 1) {
    data.show_product = true;
    data.products = n.lineItems.filter((li) => li.productGid).map((li) => ({ id: li.productGid, title: li.title }));
  }
  return data;
}

/** Exported for the test that keeps this in step with review.flow.json. */
export const _flowData = flowData;

// ---- trigger: delivered -----------------------------------------------------
export async function onDelivered(orderId, deliveredAt, deps) {
  if (!config.flows.B.enabled) return;
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  const skip = reviewSkipReason(n);
  if (skip) return log.info('flowB: skip review ask', { orderId, skip });
  if (!n.verifiedPhone) return;
  const st = await getState(orderId);
  if (st?.flowB?.reviewAsked || st?.flowB?.reviewed) return;
  // A real delivery OVERRIDES an assumed one. The assumed date is a guess five
  // days after dispatch; a confirmed delivery is usually earlier and always
  // truer, and rescheduling the same timer name just replaces it.
  if (st?.flowB?.scheduled && !st?.flowB?.assumedDelivery) return;

  const at = reviewSlot(new Date(deliveredAt || now), RULES.reviewAskAfterDeliveryDays, now);
  await scheduleTimer({ flow: 'B', orderId, step: 'review_ask', at });
  await patchFlowB(orderId, {
    scheduled: true,
    assumedDelivery: false,
    deliveredAt: new Date(deliveredAt || now).toISOString(),
  });
}

/**
 * Fulfilled with no Delhivery waybill, so no delivery event is ever coming.
 *
 * `untrackedDeliveryAssumeDays` was defined in RULES and read by NOTHING, and
 * the only two things that start Flow B are a Shopify delivery event and the
 * Delhivery poller. An order shipped by any other courier therefore had no
 * delivery signal at all and was never asked for a review: the rule existed,
 * the hole it was written for did not get covered.
 *
 * Assumed, so it yields to the real thing the moment one arrives.
 */
export async function onUntrackedFulfillment(orderId, fulfilledAt, deps) {
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  const skip = reviewSkipReason(n);
  if (skip) return log.info('flowB: skip untracked review schedule', { orderId, skip });
  if (!n.verifiedPhone) return;
  const st = await getState(orderId);
  if (st?.flowB?.reviewAsked || st?.flowB?.reviewed || st?.flowB?.scheduled) return;

  const at = reviewSlot(addDays(new Date(fulfilledAt || now), RULES.untrackedDeliveryAssumeDays), RULES.reviewAskAfterDeliveryDays, now);
  await scheduleTimer({ flow: 'B', orderId, step: 'review_ask', at });
  await patchFlowB(orderId, { scheduled: true, assumedDelivery: true });
}

// ---- timer: send the review ask --------------------------------------------
export async function onReviewTimer(orderId, deps) {
  const now = nowOf(deps);
  const st = await getState(orderId);
  if (st?.flowB?.reviewed || st?.flowB?.reviewAsked) return;
  const n = await getNorm(deps, orderId);
  if (reviewSkipReason(n)) return;
  if (!n.verifiedPhone || (await isOptedOut(n.verifiedPhone))) return;
  if (!(await canAskReview(n.verifiedPhone, now, RULES.reviewAskCapDays))) return;

  // Two ways to ask, same message. 'flow' opens the native WhatsApp Flow, which
  // reports the answers straight back to onReviewSubmit. 'link' opens the Google
  // Form, which cannot report anything back: it is the stand-in while Meta
  // refuses to publish the Flow (publishing one requires business verification).
  const viaLink = config.reviewVia === 'link';
  const vars = {
    customer_name: n.firstName,
    order_number: n.name,
    delivered_date: formatISTDate(new Date(st?.flowB?.deliveredAt || now)),
  };
  const res = viaLink
    ? await tpl(deps, n.verifiedPhone, 'delivered_review_link', vars, {
        orderId: n.numericId,
        // The URL button suffix. Prefilling the order number is what makes a
        // sheet row traceable to an order; without it every response is
        // anonymous and no code can be matched to a buyer.
        token: reviewFormSuffix({ name: n.firstName, orderNumber: n.name }),
      })
    : await tpl(deps, n.verifiedPhone, 'delivered_review', vars, {
        orderId: n.numericId,
        flowToken: await flowToken(n.numericId, now),
        flowActionData: flowData(n, true),
      });
  if (res?.skipped) return;
  // reviewAsked is the only guard against asking the same customer twice, so it
  // is written before any step that could throw.
  await patchFlowB(orderId, { reviewAsked: true, askedAt: now.toISOString() });
  await soft('tagsAdd:wa-review-asked', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-review-asked']), { orderId });
  await soft('markReviewAsk', () => markReviewAsk(n.verifiedPhone, now), { orderId });
  // A reminder is only safe when we can tell whether they already answered.
  // In link mode nothing comes back, so `reviewed` is never set and every
  // single customer would be reminded, including the ones who filled it in.
  if (viaLink) return;
  await soft('scheduleTimer:review_reminder', () =>
    scheduleTimer({ flow: 'B', orderId, step: 'review_reminder', at: reviewSlot(now, RULES.reviewReminderAfterDays, now) }),
    { orderId },
  );
}

export async function onReviewReminder(orderId, deps) {
  const now = nowOf(deps);
  const st = await getState(orderId);
  if (!st?.flowB?.reviewAsked || st?.flowB?.reviewed) return;
  if (st?.flowB?.reminderSentAt) return; // a retry after the send succeeded
  const n = await getNorm(deps, orderId);
  if (reviewSkipReason(n) || !n.verifiedPhone || (await isOptedOut(n.verifiedPhone))) return;
  const token = await flowToken(n.numericId, now);
  const res = await tpl(deps, n.verifiedPhone, 'review_reminder', { customer_name: n.firstName, order_number: n.name }, { orderId: n.numericId, flowToken: token, flowActionData: flowData(n, false) });
  if (res?.skipped) return;
  await patchFlowB(orderId, { reminderSentAt: now.toISOString() });
}

// ---- inbound: review submitted (nfm_reply) ---------------------------------
export async function onReviewSubmit(orderId, submission, deps) {
  const now = nowOf(deps);
  const st = await getState(orderId);
  if (st?.flowB?.reviewed) return; // idempotent: one review per order
  const n = await getNorm(deps, orderId);
  if (!n) return;
  await touchInbound(n.verifiedPhone, now);

  const v = validateReview(submission, { firstName: n.firstName });
  if (!v.ok) {
    // They filled the form, tapped submit and were promised a code. Returning
    // silently left them staring at nothing with no one aware of it. Still no
    // automatic re-ask (that would nag), but say something and raise it.
    log.warn('flowB: invalid review submission', { orderId, errors: v.errors });
    await soft('sess:review_invalid', () => sess(deps, n.verifiedPhone, 'review_code_pending', { customer_name: n.firstName }), { orderId });
    await ownerAlert(deps, n.name, `a review came in that could not be read (${v.errors.join(', ')}). The customer was told their code is coming, so please follow up by hand`);
    return;
  }
  const status = moderationStatus(v.value.review, v.value.consent, v.value.displayName);
  const productGid = n.lineItems.length > 1 ? v.value.product : n.lineItems[0]?.productGid || null;

  const review = await runOnce(orderId, 'review-metaobject', () =>
    deps.clients.shopify.createReview({
      productGid,
      orderName: n.name,
      rating: v.value.rating,
      fit: v.value.fit,
      body: v.value.review,
      authorName: v.value.displayName,
      consent: v.value.consent,
      status,
      submittedAt: now.toISOString(),
    }),
  );
  // Soft: publishing to the product page is ours to retry, and a failure here
  // used to redeliver the whole record and send the customer a SECOND copy of
  // their code. appendProductReview already skips an id it has.
  if (status === 'ACTIVE' && productGid) {
    await soft('appendProductReview', () => deps.clients.shopify.appendProductReview(productGid, review.id), { orderId });
  }

  let code = null;
  try {
    const res = await runOnce(orderId, 'review-code', () => createCodeWithRetry(deps, n, now));
    code = res?.code || null;
  } catch (e) {
    log.error('flowB: discount code creation failed', { orderId, err: e.message });
  }

  if (code) {
    await sess(deps, n.verifiedPhone, 'review_code', {
      customer_name: n.firstName,
      code,
      amount: formatINR(RULES.reviewCodeAmountInr * 100),
      min_order: formatINR(RULES.reviewCodeMinSubtotalInr * 100),
      valid_until: formatISTDate(addDays(now, RULES.reviewCodeValidDays)),
    });
  } else {
    await sess(deps, n.verifiedPhone, 'review_code_pending', { customer_name: n.firstName });
    await ownerAlert(deps, n.name, 'review code creation failed, the customer was promised one and is waiting. Create a code by hand and send it');
  }

  // The customer now has their code. Record that BEFORE anything else can
  // throw: `reviewed` is the only guard against sending a second one, and it
  // used to be written after the tag and the timer cancel, so a Shopify blip
  // redelivered the record and the thank you went out twice. Same ordering
  // rule Flow A and Flow C already follow.
  await patchFlowB(orderId, { reviewed: true, reviewedAt: now.toISOString(), status });
  await soft('tagsAdd:wa-reviewed', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-reviewed']), { orderId });
  await soft('cancelTimer:review_reminder', () => cancelTimer({ flow: 'B', orderId, step: 'review_reminder' }), { orderId });
}

/**
 * Create the thank-you code, retrying on the one error that is worth retrying.
 *
 * generateCode's own comment promised "caller retries on collision" and no
 * caller did, so a duplicate code meant the customer was told their code was
 * coming and it never came. Six characters from a 31-letter alphabet makes a
 * collision rare, not impossible, and the whole cost of being wrong is one
 * extra call.
 */
async function createCodeWithRetry(deps, n, now, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await deps.clients.shopify.createDiscountCode({
        code: generateCode(),
        title: `Review thanks ${n.name}`,
        startsAt: now.toISOString(),
        endsAt: endOfDayIST(addDays(now, RULES.reviewCodeValidDays)).toISOString(),
        amountInr: RULES.reviewCodeAmountInr,
        minSubtotalInr: RULES.reviewCodeMinSubtotalInr,
      });
    } catch (e) {
      last = e;
      if (!/exists|taken|duplicate/i.test(e.message || '')) throw e;
      log.warn('flowB: code already taken, generating another', { orderId: n.numericId, attempt: i + 1 });
    }
  }
  throw last;
}
