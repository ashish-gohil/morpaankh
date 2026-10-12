/*
 * cartRecovery.run.mjs — Flow R: win back an abandoned checkout with one
 * private, expiring, single-use code, and one reminder before it closes.
 *
 * THE RULES THIS FILE EXISTS TO HOLD:
 *   one sequence per phone per 30 days, and never a second message 1;
 *   only ever to the COD King OTP-verified number;
 *   nothing is sent if the code we could offer is not better than what the
 *     bag can already get from a code printed on our own cart page;
 *   the phone lock is written only AFTER Meta accepts, and released if the
 *     message then fails to deliver, because a lock on a message nobody
 *     received would silence that customer for a month for nothing.
 *
 * Every exit past the REC row records an `outcome`, which is what stops the
 * five-minute sweep from re-enqueueing the same checkout forever.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import {
  normalizeCheckout, cartEligible, computeCartOffer, personalCodeName, cartCode,
  recoveryTimes, formatExpiresAt, formatTimeLeft,
} from '../domain/cart.mjs';
import { itemLine, heroImageUrl } from '../domain/order.mjs';
import { formatINR } from '../lib/money.mjs';
import { randomToken } from '../lib/ids.mjs';
import { withinWindow } from '../lib/time.mjs';
import {
  getRec, ensureRec, patchRec, setOutcome, cartRunOnce, recordCartMessage,
  getPhoneLock, lockPhone, releasePhoneLock, setCartLinkMap, alertOncePerDay,
} from '../store/cartRecovery.mjs';
import {
  isOptedOut, isUndeliverable, getProfile, canSendMarketing, markMarketing, touchInbound,
} from '../store/phoneProfile.mjs';
import { scheduleTimer, cancelTimer } from '../timers/schedule.mjs';
import { verifiedPhoneFromNoteAttributes } from '../lib/phone.mjs';
import { tpl, sess, ownerAlert, isTemplateUnusable } from './send.mjs';
import { soft } from '../lib/resilience.mjs';
import { log, metric, maskPhone } from '../log.mjs';

const nowOf = (deps) => deps.now || new Date();
const group = (phone) => `phone:${phone}`;
const r = () => RULES.cartRecovery;

/** The template vars, built as the union of both cart templates' placeholders. */
function cartVars(n, rec, now) {
  return {
    customer_name: n.firstName,
    item_line: itemLine(n) || 'your bag',
    code: rec.code,
    saving: formatINR(rec.offerPaise),
    expires_at: formatExpiresAt(new Date(rec.codeEndsAt), now),
    time_left: formatTimeLeft(new Date(rec.codeEndsAt).getTime() - now.getTime()),
  };
}

/**
 * Has this person ordered since they walked away? Asked of SHOPIFY, not of our
 * own table, because the order may have been placed on the website, by phone,
 * or by the owner by hand, and only one of those three reaches DynamoDB.
 */
async function orderedSince(deps, n) {
  const orders = await deps.clients.shopify.ordersCreatedSince(n.createdAt);
  return orders.some((o) => {
    if (n.customerGid && o.customer?.id === n.customerGid) return true;
    return verifiedPhoneFromCustomAttributesList(o.customAttributes) === n.verifiedPhone;
  });
}

// customAttributes on an order node use {key,value}, same as a checkout.
function verifiedPhoneFromCustomAttributesList(attrs) {
  const hit = (attrs || []).find((a) => a && a.key === '_otpVerifiedPhoneNumber');
  if (!hit) return null;
  const digits = String(hit.value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return null;
}

/**
 * Create the Shopify code, retrying on a collision.
 *
 * Two digits for six tries, then three. Two digits drawn from 2-9 gives 64
 * combinations per name, which is plenty for one shop but not infinite, and a
 * third digit is a better answer than failing the message.
 */
async function createUniqueCode(deps, n, offer, endsAt, now) {
  const name = personalCodeName(n.rawFirstName, RULES);
  const digitPlan = [2, 2, 2, 2, 2, 2, 3, 3, 3];
  let lastErr = null;
  for (const digits of digitPlan) {
    const code = cartCode(name, digits, RULES);
    try {
      const res = await deps.clients.shopify.createDiscountCode({
        code,
        // Never a phone number in a title: it shows in the Shopify admin list.
        title: `Cart recovery ${n.name}`,
        startsAt: now.toISOString(),
        endsAt: endsAt.toISOString(),
        amountInr: offer.offerPaise / 100,
        minSubtotalInr: offer.minSubtotalInr,
      });
      return { code: res.code || code, discountId: res.id };
    } catch (e) {
      if (!/taken|unique|already/i.test(e.message)) throw e;
      lastErr = e;
      log.warn('cart: code collision, trying another', { digits });
    }
  }
  throw lastErr || new Error('cart: no free code after nine tries');
}

/**
 * Message 1. Re-reads Shopify every time: the sweep that enqueued this is up
 * to five minutes old and the customer may have completed the order since.
 */
export async function onFirst(checkoutId, deps) {
  const now = nowOf(deps);
  /*
   * These two write NOTHING, on purpose. No REC row means the next sweep in
   * five minutes tries again, which is what we want for a flow that was off
   * for a deploy or a clock that is twenty minutes outside the window.
   */
  if (!config.flows.R.enabled) return log.info('cart: flow R off, not starting', { checkoutId });
  if (!withinWindow(now, r().sendWindow)) return log.info('cart: outside the send window', { checkoutId });

  const raw = await deps.clients.shopify.getAbandonedCheckout(checkoutId);
  const n = normalizeCheckout(raw);
  const eligible = cartEligible(n, { now, startAt: config.flows.R.startAt, rules: RULES });

  // From here on every exit is recorded, so the sweep stops re-enqueueing it.
  const { created } = await ensureRec(checkoutId, { phone: n?.verifiedPhone || null, name: n?.name || null }, now);
  if (!created) {
    const existing = await getRec(checkoutId);
    // An SQS redelivery or a second sweep enqueue. One message 1, ever.
    if (existing?.firstSentAt || existing?.outcome) {
      return log.info('cart: already handled', { checkoutId, outcome: existing.outcome });
    }
  }
  if (!eligible.ok) {
    await setOutcome(checkoutId, eligible.reason, { skipReason: eligible.reason });
    return log.info('cart: not eligible', { checkoutId, reason: eligible.reason });
  }

  const phone = n.verifiedPhone;
  if (await isOptedOut(phone)) return setOutcome(checkoutId, 'opted-out');
  if (await isUndeliverable(phone)) return setOutcome(checkoutId, 'undeliverable');

  /*
   * Flow R's OWN cooldown first, because it is the stricter rule and the more
   * honest label. Checked before the marketing cap below so that a customer
   * who abandons twice in a month is recorded as `cooldown` and not as
   * `marketing-cap`: both refuse the send, but only one of them answers the
   * question "why did this person not get a second message".
   */
  const lock = await getPhoneLock(phone);
  if (lock?.lockUntil && new Date(lock.lockUntil).getTime() > now.getTime()) {
    return setOutcome(checkoutId, 'cooldown');
  }

  /*
   * Then the service-wide marketing cap, which Flow R has to honour too.
   * Before this flow, prepaid_offer was the only MARKETING template a customer
   * could get, and it is capped at one per marketingCapDays. Ignoring it here
   * would let someone get a prepaid offer on Monday and a cart recovery on
   * Tuesday, which is precisely the "they keep messaging me" problem the cap
   * exists for. Message 1 ONLY: the reminder belongs to a sequence this
   * message opened, and re-checking the cap there would block it 22 hours
   * later against the stamp we are about to make.
   */
  if (!(await canSendMarketing(phone, now, RULES.marketingCapDays))) {
    return setOutcome(checkoutId, 'marketing-cap');
  }

  if (await orderedSince(deps, n)) return setOutcome(checkoutId, 'already-ordered');

  /*
   * The public codes are read BEFORE anything is created, and a failure to
   * read them stops the message.
   *
   * Offering blind is the one failure mode this flow must not have: without
   * the live codes the floor is only whatever discount is already applied, so
   * a Rs 1,249 bag would be offered Rs 130 while WELCOME150 sits on the cart
   * page offering Rs 150. A private code worth less than the public one is
   * worse than sending nothing at all.
   */
  let publicCodes;
  try {
    publicCodes = await deps.clients.shopify.publicCodeDiscounts();
  } catch (e) {
    log.error('cart: could not read the live discount codes, refusing to offer blind', { err: e.message });
    await soft('cartPublicCodesAlert', async () => {
      if (await alertOncePerDay('public-codes', now)) {
        await ownerAlert(
          deps,
          'cart recovery',
          'cart recovery cannot read the live discount codes, so it is sending nothing rather than offer less than the cart page already shows. Check the app has read_discounts',
        );
      }
    }, { checkoutId });
    return setOutcome(checkoutId, 'no-public-codes');
  }

  const offer = computeCartOffer({
    bagPaise: n.bagPaise,
    ownDiscountPaise: n.ownDiscountPaise,
    quantity: n.quantity,
    publicCodes,
    rules: RULES,
  });
  if (!offer.ok) {
    log.info('cart: the bag already gets as much or more, sending nothing', {
      checkoutId, bagPaise: n.bagPaise, floorPaise: offer.floorPaise, offerPaise: offer.offerPaise,
    });
    return setOutcome(checkoutId, 'public-offer-better', { bag: n.bagPaise, floor: offer.floorPaise });
  }

  /*
   * Shadow mode. Non-empty allowlist means everybody else is logged and left
   * alone: no Shopify code, no phone lock, no message. The log line carries
   * what WOULD have been sent so the owner can read a week of real decisions
   * before anyone is messaged.
   */
  if (config.cartRecoveryAllowlist.length && !config.cartRecoveryAllowlist.includes(phone)) {
    const preview = cartCode(personalCodeName(n.rawFirstName, RULES), 2, RULES);
    log.info('cart: would send', {
      checkoutId,
      phone: maskPhone(phone),
      item: itemLine(n),
      bag: formatINR(n.bagPaise),
      floor: formatINR(offer.floorPaise),
      offer: formatINR(offer.offerPaise),
      codePreview: preview,
    });
    metric('CartShadow', 1);
    return setOutcome(checkoutId, 'shadow');
  }

  /*
   * The clock is computed ONCE and stored. Both messages, the Shopify code's
   * own end date and the reminder timer all read it back, so a redelivery or a
   * retry can never tell the customer a different closing time than the code
   * actually has.
   */
  const times = recoveryTimes(now, RULES);
  const made = await cartRunOnce(checkoutId, 'code', () => createUniqueCode(deps, n, offer, times.codeEndsAt, now));
  const token = await cartRunOnce(checkoutId, 'link', async () => {
    const t = randomToken();
    await setCartLinkMap(t, checkoutId);
    return t;
  });

  await patchRec(checkoutId, {
    bag: n.bagPaise,
    floor: offer.floorPaise,
    offerPaise: offer.offerPaise,
    code: made.code,
    discountId: made.discountId,
    codeEndsAt: times.codeEndsAt.toISOString(),
    reminderAt: times.reminderAt.toISOString(),
    token,
    recoveryUrl: n.recoveryUrl,
    /*
     * Stored so the /r/ redirect can build a /cart/ permalink without a
     * Shopify round trip. That route is the last-resort link target and this
     * is a route a customer is waiting on, so it must not go and ask.
     */
    cartItems: n.lineItems
      .map((li) => ({ v: String(li.variantGid || '').split('/').pop(), q: li.quantity }))
      .filter((x) => x.v && x.v !== 'null'),
    customerGid: n.customerGid,
    checkoutCreatedAt: n.createdAt,
  });

  const rec = await getRec(checkoutId);
  let res;
  try {
    res = await tpl(deps, phone, 'cart_recovery', cartVars(n, rec, now), {
      orderId: String(checkoutId),
      token,
      imageUrl: heroImageUrl(n),
    });
  } catch (e) {
    return handleSendFailure(deps, checkoutId, 'first', e, now);
  }
  // Already on the do-not-send list: no lock, because they got nothing.
  if (res?.skipped) return setOutcome(checkoutId, `send-${res.skipped}`);

  /*
   * ACCEPTED. The two writes that must not be lost go first and are NOT soft:
   * firstSentAt is what stops a second message 1, and the phone lock is the
   * 30-day promise. Everything after this is bookkeeping, and a failure there
   * must not redeliver a record whose message has already gone out.
   */
  await patchRec(checkoutId, { firstSentAt: now.toISOString(), wamids: [res.messageId].filter(Boolean) });
  await lockPhone(phone, { checkoutId, until: new Date(now.getTime() + r().cooldownDays * 86400 * 1000), now });
  await markMarketing(phone, now);
  metric('CartFirstSent', 1);

  await soft('cartRecordMessage', () => recordCartMessage(checkoutId, res.messageId, { key: 'cart_recovery', template: res.templateName }), { checkoutId });
  await soft('cartArmFinal', () =>
    scheduleTimer({
      flow: 'R',
      orderId: String(checkoutId),
      step: 'final',
      at: new Date(rec.reminderAt),
      groupId: group(phone),
    }), { checkoutId });
  return { sent: true, code: made.code };
}

/**
 * A send that threw. None of these take the phone lock, because the customer
 * did not receive anything.
 *
 * 131049 (Meta throttled us for quality) and 131026 (this number cannot
 * receive WhatsApp) are recorded and never retried: both will fail again, and
 * retrying a MARKETING template against a quality throttle makes the rating
 * that caused it worse.
 */
async function handleSendFailure(deps, checkoutId, step, e, now) {
  const code = e?.waCode;
  if (code === 131049 || code === 131026) {
    log.warn('cart: Meta refused this recipient, not retrying', { checkoutId, step, waCode: code });
    return setOutcome(checkoutId, `meta-${code}`);
  }
  if (isTemplateUnusable(e)) {
    log.error('cart: template unusable', { checkoutId, step, waCode: code });
    await soft('cartTemplateAlert', async () => {
      if (await alertOncePerDay('template-unusable', now)) {
        await ownerAlert(deps, 'cart recovery', `the cart recovery template could not be used (${code}). Cart messages are stopped until it is fixed`);
      }
    }, { checkoutId });
    return setOutcome(checkoutId, 'template-unusable');
  }
  throw e; // genuinely transient: let SQS redeliver
}

/**
 * The reminder, two hours before the code closes.
 *
 * Eleven reasons not to send, and the one that fired is recorded, because
 * "why did this customer not get the reminder" is otherwise unanswerable.
 */
export async function onFinal(checkoutId, deps) {
  const now = nowOf(deps);
  const rec = await getRec(checkoutId);
  const stop = async (reason) => {
    log.info('cart: no reminder', { checkoutId, reason });
    await patchRec(checkoutId, { finalSkipped: reason, finalSkippedAt: now.toISOString() });
    return { skipped: reason };
  };

  if (!config.flows.R.enabled) return stop('flow-r-off');
  if (!rec) return stop('no-record');
  if (!rec.firstSentAt) return stop('no-first-message');
  if (rec.finalSentAt) return stop('already-sent');
  if (rec.outcome) return stop(`outcome-${rec.outcome}`);
  if (rec.deliveryFailed) return stop('first-message-failed');
  if (rec.helpRequestedAt) return stop('asked-for-a-person');

  const phone = rec.phone;
  if (!phone) return stop('no-phone');
  if (await isOptedOut(phone)) return stop('opted-out');

  /*
   * They have written to us since message 1. Somebody is talking to them, or
   * about to be, and a scheduled nudge landing in the middle of that is the
   * most obviously robotic thing this service could do.
   */
  const profile = await getProfile(phone);
  if (profile.lastInboundAt && new Date(profile.lastInboundAt).getTime() > new Date(rec.firstSentAt).getTime()) {
    return stop('they-replied');
  }

  if (rec.discountId) {
    const usage = await deps.clients.shopify.discountUsageCount(rec.discountId);
    if (usage.count > 0) return stop('code-used');
  }

  const raw = await deps.clients.shopify.getAbandonedCheckout(checkoutId);
  const n = normalizeCheckout(raw);
  if (!n) return stop('checkout-gone');
  if (n.completedAt) return stop('completed');
  if (await orderedSince(deps, n)) return stop('ordered');

  if (!withinWindow(now, r().sendWindow)) return stop('outside-window');
  const leftMs = new Date(rec.codeEndsAt).getTime() - now.getTime();
  // Under half an hour there is no time left to act on it, so the reminder
  // would only be telling them they have missed something.
  if (leftMs < r().finalMinRemainingMin * 60000) return stop('too-close-to-the-end');

  let res;
  try {
    res = await tpl(deps, phone, 'cart_final', cartVars(n, rec, now), {
      orderId: String(checkoutId),
      token: rec.token,
      imageUrl: heroImageUrl(n),
    });
  } catch (e) {
    return handleSendFailure(deps, checkoutId, 'final', e, now);
  }
  if (res?.skipped) return stop(`send-${res.skipped}`);

  await patchRec(checkoutId, {
    finalSentAt: now.toISOString(),
    wamids: [...(rec.wamids || []), res.messageId].filter(Boolean),
  });
  metric('CartFinalSent', 1);
  await soft('cartRecordFinal', () => recordCartMessage(checkoutId, res.messageId, { key: 'cart_final', template: res.templateName }), { checkoutId });
  return { sent: true };
}

/**
 * They tapped "Talk to us".
 *
 * STRICT on ownership. The router's ownsOrder() fails open for an id it has
 * never seen, and a Flow R payload carries a CHECKOUT id, so that gate always
 * passes here. The tapping phone has to be the phone we messaged.
 */
export async function onTap(checkoutId, action, phone, deps) {
  if (action !== 'help') return log.info('cart: unknown tap action', { action });
  const now = nowOf(deps);
  const rec = await getRec(checkoutId);
  if (!rec || rec.phone !== phone) {
    return log.warn('cart: tap from a phone that does not own this checkout, ignoring', { checkoutId });
  }
  await touchInbound(phone, now);

  const closed = rec.codeEndsAt ? new Date(rec.codeEndsAt).getTime() <= now.getTime() : true;
  const vars = { customer_name: rec.name ? rec.name : 'there', code: rec.code || '', expires_at: '' };
  if (!closed) {
    vars.expires_at = formatExpiresAt(new Date(rec.codeEndsAt), now);
  }
  // The name on the REC row is the checkout's, not the customer's, so the
  // greeting is re-read from Shopify rather than guessed at.
  const raw = await deps.clients.shopify.getAbandonedCheckout(checkoutId);
  const n = normalizeCheckout(raw);
  vars.customer_name = n?.firstName || 'there';

  await sess(deps, phone, closed ? 'cart_help_ack_closed' : 'cart_help_ack', vars);
  await patchRec(checkoutId, { helpRequestedAt: now.toISOString() });
  // No reminder after this. A person is taking over.
  await soft('cartCancelFinal', () => cancelTimer({ flow: 'R', orderId: String(checkoutId), step: 'final' }), { checkoutId });
  await soft('cartHelpAlert', () =>
    ownerAlert(
      deps,
      rec.name || String(checkoutId),
      `a customer tapped Talk to us on a cart recovery message. Bag: ${n ? itemLine(n) : 'unknown'}. Their code: ${rec.code || 'none'}. Phone ends ${String(phone).slice(-4)}`,
    ), { checkoutId });
  return { acked: true };
}

/**
 * A WhatsApp delivery status for a cart message.
 *
 * Kept here rather than in the router because of what it must NOT do. The
 * order path tags the order wa-undeliverable and alerts the owner by order
 * name; a checkout has neither, and handing it the checkout id would tag
 * `gid://shopify/Order/<checkoutId>`, a well-formed id pointing at nothing.
 *
 * A `failed` status means Meta accepted the message and then could not deliver
 * it, so the customer received NOTHING. The phone lock goes back: holding a
 * 30-day cooldown against a message nobody ever saw would silence that
 * customer for a month for free.
 */
export async function onCartStatus(cartId, st) {
  const status = st?.status;
  const rec = await getRec(cartId);
  if (!rec) return;
  const fields = { lastStatus: status, lastStatusAt: new Date().toISOString() };
  if (status === 'failed') {
    fields.deliveryFailed = true;
    fields.deliveryError = st?.errors?.[0]?.code || null;
  }
  await patchRec(cartId, fields);
  if (status === 'failed' && rec.phone) {
    log.warn('cart: message 1 was accepted and then failed, releasing the phone lock', { cartId });
    await releasePhoneLock(rec.phone);
    metric('CartDeliveryFailed', 1);
  }
}

/**
 * An order arrived. Did it come from a cart message?
 *
 * Runs AFTER Flow A's own orders/create handler and is wrapped in soft() by the
 * router, so nothing here can fail an order confirmation. Idempotent: it keys
 * off the phone lock, and re-running it rewrites the same fields.
 */
export async function onOrderCreated(payload, deps) {
  const now = nowOf(deps);
  const phone = verifiedPhoneFromNoteAttributes(payload?.note_attributes);
  if (!phone) return;
  const lock = await getPhoneLock(phone);
  if (!lock?.checkoutId) return;
  const checkoutId = lock.checkoutId;
  const rec = await getRec(checkoutId);
  if (!rec?.firstSentAt) return;
  if (rec.orderId) return; // already attributed

  const placedAt = new Date(payload.created_at || now);
  const endsAt = new Date(rec.codeEndsAt);
  const graceEnd = new Date(endsAt.getTime() + r().attributionGraceHours * 3600 * 1000);
  if (placedAt.getTime() < new Date(rec.firstSentAt).getTime() || placedAt.getTime() > graceEnd.getTime()) return;

  const codes = (payload.discount_codes || []).map((d) => String(d?.code || '').toUpperCase());
  const codeUsed = Boolean(rec.code && codes.includes(String(rec.code).toUpperCase()));
  const orderId = String(payload.id);
  const beforeEnd = placedAt.getTime() <= endsAt.getTime();

  await setOutcome(checkoutId, 'recovered', { orderId, codeUsed, recoveredAt: placedAt.toISOString() });
  await patchRec(checkoutId, { orderId, codeUsed });
  metric('CartRecovered', 1, { code: codeUsed ? 'used' : 'unused' });
  await soft('cartCancelFinalOnOrder', () => cancelTimer({ flow: 'R', orderId: String(checkoutId), step: 'final' }), { checkoutId });

  const tags = [r().recoveredTag];
  // The gift was promised in the message, so it is owed whenever they came back
  // inside the code's own life, with or without the code applied.
  if (beforeEnd) tags.push(r().giftTag);
  await soft('cartTags', () => deps.clients.shopify.tagsAdd(`gid://shopify/Order/${orderId}`, tags), { orderId });

  /*
   * They came back from our message and did not use the code, so they paid more
   * than we offered. That is a promise we made and they did not get, and only a
   * human can put it right.
   */
  if (beforeEnd && !codeUsed) {
    await soft('cartMissedCodeAlert', () =>
      ownerAlert(
        deps,
        payload.name || orderId,
        `this order came back from a cart recovery message but the code ${rec.code} was NOT applied, so they paid about ${formatINR(rec.offerPaise)} more than we offered them. Consider refunding the difference`,
      ), { orderId });
  }
  return { recovered: true, codeUsed };
}
