/*
 * flowB.run.mjs — Flow B: delivered -> review request (WhatsApp Flow) -> code.
 * Reviews are stored as product_review metaobjects (ACTIVE when consented + clean,
 * else DRAFT); the thank-you code is given for ANY genuine review, whatever the
 * rating. All sends DRY_RUN + allowlist gated; all writes idempotent.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { hasTag } from '../domain/order.mjs';
import { afterStart } from '../domain/eligibility.mjs';
import { validateReview, moderationStatus } from '../domain/review.mjs';
import { formatINR } from '../lib/money.mjs';
import { addHours, addDays, nextWindowTime, formatISTDate, endOfDayIST } from '../lib/time.mjs';
import { signToken } from '../lib/ids.mjs';
import { generateCode } from '../lib/discount-code.mjs';
import { getSecrets } from '../secrets.mjs';
import { getState, patchFlowB, runOnce } from '../store/orderState.mjs';
import { isOptedOut, touchInbound, canAskReview, markReviewAsk } from '../store/phoneProfile.mjs';
import { scheduleTimer, cancelTimer } from '../timers/schedule.mjs';
import { getNorm, tpl, sess, ownerAlert } from './send.mjs';
import { log } from '../log.mjs';

const nowOf = (deps) => deps.now || new Date();

/** Order-level reasons to never ask for a review. */
function reviewSkipReason(n) {
  if (!n) return 'no-order';
  if (n.cancelledAt) return 'cancelled';
  if (hasTag(n.tags, 'RTO')) return 'rto';
  if (String(n.financialStatus || '').toUpperCase().includes('REFUNDED')) return 'refunded';
  if (!afterStart(n, config.flows.B.startAt)) return 'before-startAt';
  return null;
}

async function flowToken(orderId, now) {
  const s = await getSecrets();
  const exp = Math.floor(addDays(now, 14).getTime() / 1000);
  return signToken({ orderId, exp }, s.flowTokenKey || 'dev-flow-key');
}

function flowData(n, withProducts) {
  const data = {
    first_name: n.firstName,
    percent_text: `${RULES.reviewCodePercent}%`,
    min_order_text: formatINR(RULES.reviewCodeMinSubtotalInr * 100),
    show_product: false,
  };
  if (withProducts && n.lineItems.length > 1) {
    data.show_product = true;
    data.products = n.lineItems.filter((li) => li.productGid).map((li) => ({ id: li.productGid, title: li.title }));
  }
  return data;
}

// ---- trigger: delivered -----------------------------------------------------
export async function onDelivered(orderId, deliveredAt, deps) {
  if (!config.flows.B.enabled) return;
  const now = nowOf(deps);
  const n = await getNorm(deps, orderId);
  const skip = reviewSkipReason(n);
  if (skip) return log.info('flowB: skip review ask', { orderId, skip });
  if (!n.verifiedPhone) return;
  const st = await getState(orderId);
  if (st?.flowB?.reviewAsked || st?.flowB?.reviewed || st?.flowB?.scheduled) return;

  const at = nextWindowTime(addHours(new Date(deliveredAt || now), RULES.reviewAskAfterDeliveryHours), RULES.reviewSendWindow);
  await scheduleTimer({ flow: 'B', orderId, step: 'review_ask', at });
  await patchFlowB(orderId, { scheduled: true, deliveredAt: new Date(deliveredAt || now).toISOString() });
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

  const token = await flowToken(n.numericId, now);
  await tpl(
    deps,
    n.verifiedPhone,
    'delivered_review',
    { customer_name: n.firstName, order_number: n.name, delivered_date: formatISTDate(new Date(st?.flowB?.deliveredAt || now)) },
    { orderId: n.numericId, flowToken: token, flowActionData: flowData(n, true) },
  );
  await deps.clients.shopify.tagsAdd(n.gid, ['wa-review-asked']);
  await markReviewAsk(n.verifiedPhone, now);
  await patchFlowB(orderId, { reviewAsked: true, askedAt: now.toISOString() });
  await scheduleTimer({ flow: 'B', orderId, step: 'review_reminder', at: nextWindowTime(addHours(now, RULES.reviewReminderAfterHours), RULES.reviewSendWindow) });
}

export async function onReviewReminder(orderId, deps) {
  const now = nowOf(deps);
  const st = await getState(orderId);
  if (!st?.flowB?.reviewAsked || st?.flowB?.reviewed) return;
  const n = await getNorm(deps, orderId);
  if (reviewSkipReason(n) || !n.verifiedPhone || (await isOptedOut(n.verifiedPhone))) return;
  const token = await flowToken(n.numericId, now);
  await tpl(deps, n.verifiedPhone, 'review_reminder', { customer_name: n.firstName, order_number: n.name }, { orderId: n.numericId, flowToken: token, flowActionData: flowData(n, false) });
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
    log.warn('flowB: invalid review submission', { orderId, errors: v.errors });
    return; // a human follows up; we do not spam a re-ask
  }
  const status = moderationStatus(v.value.review, v.value.consent);
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
  if (status === 'ACTIVE' && productGid) await deps.clients.shopify.appendProductReview(productGid, review.id);

  let code = null;
  try {
    const res = await runOnce(orderId, 'review-code', () =>
      deps.clients.shopify.createDiscountCode({
        code: generateCode(),
        title: `Review thanks ${n.name}`,
        startsAt: now.toISOString(),
        endsAt: endOfDayIST(addDays(now, RULES.reviewCodeValidDays)).toISOString(),
        percentage: RULES.reviewCodePercent / 100,
        minSubtotalInr: RULES.reviewCodeMinSubtotalInr,
      }),
    );
    code = res?.code || null;
  } catch (e) {
    log.error('flowB: discount code creation failed', { orderId, err: e.message });
  }

  if (code) {
    await sess(deps, n.verifiedPhone, 'review_code', {
      customer_name: n.firstName,
      code,
      percent: String(RULES.reviewCodePercent),
      min_order: formatINR(RULES.reviewCodeMinSubtotalInr * 100),
      valid_until: formatISTDate(addDays(now, RULES.reviewCodeValidDays)),
    });
  } else {
    await sess(deps, n.verifiedPhone, 'review_code_pending', { customer_name: n.firstName });
    await ownerAlert(deps, n.name, 'review code creation failed, sent pending message');
  }

  await deps.clients.shopify.tagsAdd(n.gid, ['wa-reviewed']);
  await patchFlowB(orderId, { reviewed: true, reviewedAt: now.toISOString(), status });
  await cancelTimer({ flow: 'B', orderId, step: 'review_reminder' });
}
