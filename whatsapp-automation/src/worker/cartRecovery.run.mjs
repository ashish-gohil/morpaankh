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
import { CART_RECOVERY_TITLE } from '../clients/shopify.mjs';
import { RULES } from '../../messages/rules.mjs';
import {
  normalizeCheckout, cartEligible, computeCartOffer, personalCodeName, cartCode,
  recoveryTimes, formatExpiresAt, formatTimeLeft,
} from '../domain/cart.mjs';
import { capturedToCheckout, variantGidsOf, isCapturedId } from '../domain/cartCapture.mjs';
import { getCapture } from '../store/cartCapture.mjs';
import { itemLine, heroImageUrl } from '../domain/order.mjs';
import { formatINR } from '../lib/money.mjs';
import { randomToken } from '../lib/ids.mjs';
import { withinWindow } from '../lib/time.mjs';
import {
  getRec, ensureRec, patchRec, setOutcome, cartRunOnce, recordCartMessage,
  getPhoneLock, lockPhone, releasePhoneLock, setCartLinkMap, alertOncePerDay,
  parkForWindow, getParked, clearParked,
} from '../store/cartRecovery.mjs';
import {
  isOptedOut, isUndeliverable, getProfile, canSendMarketing, markMarketing, touchInbound, windowOpen,
} from '../store/phoneProfile.mjs';
import { scheduleTimer, cancelTimer } from '../timers/schedule.mjs';
import { verifiedPhoneFromNoteAttributes, verifiedPhoneFromCustomAttributes } from '../lib/phone.mjs';
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
    // The library function, not a local copy: it already reads {key,value} and
    // it keeps the mobile-prefix check a hand-rolled version drops.
    return verifiedPhoneFromCustomAttributes(o.customAttributes) === n.verifiedPhone;
  });
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
        // The SAME constant publicCodeDiscounts() excludes on, so this code can
        // never walk back into its own floor. Not n.name, which only starts
        // with a '#' by Shopify's convention.
        title: `${CART_RECOVERY_TITLE}${n.numericId}`,
        /*
         * The WALL clock, not the flow's logical `now`. The message goes out
         * the moment this returns, so the code has to be honourable the moment
         * it lands. In production the two are the same value. They diverge only
         * under cart-recovery.mjs `send --live`, which winds the logical clock
         * FORWARD to clear the twenty minute wait: that made Shopify file the
         * discount as SCHEDULED, and a tap before the wound-forward minute was
         * refused with the code looking broken. It is the one value here that
         * belongs to when we actually spoke, not to when we decided to.
         */
        startsAt: new Date(Math.min(Date.now(), now.getTime())).toISOString(),
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
 * The checkout behind an id, whichever source minted it.
 *
 * Flow R works on two: Shopify's abandoned checkouts, and carts the storefront
 * captured when COD King's OTP attribute appeared on them. Everything past
 * this point is identical for both, because capturedToCheckout returns the
 * same node shape normalizeCheckout already reads.
 *
 * The RE-READ is the point of this function, not a detail. The sweep that
 * enqueued this is up to five minutes old, so prices, stock and the bag itself
 * are all asked again here, and for a captured cart that means Shopify's
 * prices rather than the browser's.
 */
async function readCheckout(deps, checkoutId) {
  if (!isCapturedId(checkoutId)) return deps.clients.shopify.getAbandonedCheckout(checkoutId);
  const row = await getCapture(checkoutId);
  if (!row) return null;
  const variants = await deps.clients.shopify.getVariantsByIds(variantGidsOf(row));
  /*
   * soft: the name is worth a round trip but never worth the message. If the
   * lookup fails the greeting falls back to "there" and the code to VIP,
   * which is the behaviour before this existed.
   */
  const customer = await soft('cartCaptureCustomer', () => deps.clients.shopify.getCustomerByPhone(row.phone), { checkoutId });
  return capturedToCheckout(row, variants, customer);
}

/**
 * Send one cart message by whichever channel can actually reach them.
 *
 * Inside the 24 hour service window a free-form message is NOT a template: it
 * carries no category, so the per-user MARKETING cap behind error 131049 does
 * not apply to it, and it is free. Outside the window the template is the only
 * thing there is. Both branches render the same offer and point at the same
 * /r/ link, so what the customer sees does not change with the channel.
 *
 * The undeliverable check is repeated here because it lives inside tpl(), and
 * the session branch does not go through tpl().
 */
async function sendCart(deps, phone, key, vars, ctx, viaSession) {
  if (!viaSession) return tpl(deps, phone, key, vars, ctx);
  if (await isUndeliverable(phone)) return { skipped: 'undeliverable', templateName: `session:${key}` };
  const res = await sess(deps, phone, key, vars, { ...ctx, url: `${config.publicBaseUrl}/r/${ctx.token}` });
  return { ...res, templateName: `session:${key}` };
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

  const raw = await readCheckout(deps, checkoutId);
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
  /*
   * Is the 24 hour service window open? If it is, message 1 goes free-form,
   * and the cap below does not apply to it: the cap exists to ration MARKETING
   * TEMPLATES, and refusing to send inside the window would be turning down
   * the one channel Meta cannot throttle in order to honour a rule about a
   * channel we are not using.
   */
  const viaSession = await windowOpen(phone, now);
  if (!viaSession && !(await canSendMarketing(phone, now, RULES.marketingCapDays))) {
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
   * The service-wide gate (DRY_RUN, SEND_ALLOWLIST), asked here rather than
   * discovered from the send's own reply. The reply comes back AFTER the
   * Shopify code exists, so a run with SEND_ALLOWLIST set for testing would
   * leave one orphan single-use code per eligible checkout.
   */
  const gated = deps.clients.whatsapp.sendSkipReason?.(phone) || null;
  if (gated) {
    log.info('cart: send is gated, nothing created', { checkoutId, phone: maskPhone(phone), skip: gated });
    return setOutcome(checkoutId, `send-${gated}`);
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
    res = await sendCart(deps, phone, 'cart_recovery', cartVars(n, rec, now), {
      orderId: String(checkoutId),
      token,
      imageUrl: heroImageUrl(n),
    }, viaSession);
  } catch (e) {
    return handleSendFailure(deps, checkoutId, 'first', e, now, phone);
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
  /*
   * soft: a throw here would redeliver a record whose message has already gone
   * out, and firstSentAt would then short-circuit it, so the stamp would be
   * lost AND the handler would report a failure. Losing it alone is the
   * smaller harm, and it is logged.
   */
  // Only a MARKETING TEMPLATE spends the cap. A session message is not one, so
  // stamping it here would bar this customer for marketingCapDays over a
  // message that never touched the cap in the first place.
  if (!viaSession) await soft('cartMarkMarketing', () => markMarketing(phone, now), { checkoutId });
  metric(viaSession ? 'CartFirstSentSession' : 'CartFirstSent', 1);

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
 * 131049 was previously recorded as terminal, on the belief that it was a
 * quality throttle against our number and that retrying would make the rating
 * worse. That reading was wrong. Meta documents 131049 as the per-user
 * MARKETING TEMPLATE cap, counted across every business that messages that
 * person: it is not our volume, not our rating, and nothing we send or stop
 * sending moves it. What is not capped is a free-form reply inside a 24 hour
 * service window, so the checkout is parked against the phone and delivered
 * by onWindowOpen the moment that person writes to us. It is still never
 * retried as a template, which is Meta's own guidance.
 *
 * 131026 stays terminal here: that number cannot receive WhatsApp at all, so
 * no channel helps. isUndeliverable expires it so they get another chance on
 * a later order.
 */
async function handleSendFailure(deps, checkoutId, step, e, now, phone) {
  const code = e?.waCode;
  if (code === 131049) {
    /*
     * The park lives exactly as long as the offer does. Using the code's own
     * end date rather than a fresh rule is what stops onWindowOpen ever
     * delivering a message whose code has already closed.
     */
    const rec = await getRec(checkoutId);
    const until = rec?.codeEndsAt ? new Date(rec.codeEndsAt) : new Date(now.getTime() + 24 * 3600 * 1000);
    if (phone) await soft('cartPark', () => parkForWindow(phone, checkoutId, until, now), { checkoutId });
    log.warn('cart: Meta per-user marketing cap, parked for a service window', { checkoutId, step, waCode: code, until: until.toISOString() });
    metric('CartParkedForWindow', 1);
    return setOutcome(checkoutId, 'waiting-window');
  }
  if (code === 131026) {
    log.warn('cart: this number cannot receive WhatsApp, not retrying', { checkoutId, step, waCode: code });
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

  const raw = await readCheckout(deps, checkoutId);
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
    res = await sendCart(deps, phone, 'cart_final', cartVars(n, rec, now), {
      orderId: String(checkoutId),
      token: rec.token,
      imageUrl: heroImageUrl(n),
    }, await windowOpen(phone, now));
  } catch (e) {
    return handleSendFailure(deps, checkoutId, 'final', e, now, phone);
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
 * This phone just wrote to us, so a 24 hour service window is now open.
 *
 * A checkout parked by 131049 can be delivered now as a free-form message,
 * which the per-user MARKETING cap does not apply to. The customer opening
 * the window is the ONLY thing that clears that cap for us, which is why this
 * hangs off their inbound message and not off a timer: a timer would just
 * collect the same refusal again.
 *
 * Everything about the bag is re-read, because this runs minutes to hours
 * after the refusal and they may well have bought in between.
 */
export async function onWindowOpen(phone, deps) {
  const now = nowOf(deps);
  if (!config.flows.R.enabled) return;
  const parked = await getParked(phone);
  if (!parked?.checkoutId) return;

  const checkoutId = parked.checkoutId;
  const drop = async (reason, outcome) => {
    await clearParked(phone);
    if (outcome) await patchRec(checkoutId, { outcome, outcomeAt: now.toISOString() });
    log.info('cart: parked checkout released', { checkoutId, reason });
  };

  // The code has closed, so there is nothing left to offer.
  if (new Date(parked.until).getTime() <= now.getTime()) return drop('offer-closed');

  const rec = await getRec(checkoutId);
  if (!rec || rec.phone !== phone) return drop('no-record');
  if (rec.firstSentAt) return drop('already-sent');
  if (await isOptedOut(phone)) return drop('opted-out', 'opted-out');
  // Quiet hours. Left parked on purpose: the next inbound inside the window
  // picks it up, and the park expires with the code either way.
  if (!withinWindow(now, r().sendWindow)) return log.info('cart: window open but outside the send window', { checkoutId });

  const n = normalizeCheckout(await readCheckout(deps, checkoutId));
  if (!n) return drop('checkout-gone', 'checkout-gone');
  if (n.completedAt || (await orderedSince(deps, n))) return drop('ordered', 'already-ordered');

  let res;
  try {
    res = await sendCart(deps, phone, 'cart_recovery', cartVars(n, rec, now), {
      orderId: String(checkoutId),
      token: rec.token,
      imageUrl: heroImageUrl(n),
    }, true);
  } catch (e) {
    log.error('cart: parked send failed inside an open window', { checkoutId, err: e.message, waCode: e?.waCode });
    throw e; // leave it parked: the next inbound tries again
  }
  if (res?.skipped) return drop(`send-${res.skipped}`, `send-${res.skipped}`);

  await clearParked(phone);
  /*
   * The outcome is cleared as well as stamped over: `waiting-window` was
   * written by handleSendFailure to stop the five-minute sweep, and onFinal
   * refuses to send a reminder for any checkout that carries an outcome.
   * Leaving it would deliver message 1 and then silently drop the reminder.
   */
  await patchRec(checkoutId, {
    firstSentAt: now.toISOString(),
    outcome: null,
    outcomeAt: null,
    wamids: [...(rec.wamids || []), res.messageId].filter(Boolean),
  });
  await lockPhone(phone, { checkoutId, until: new Date(now.getTime() + r().cooldownDays * 86400 * 1000), now });
  metric('CartSentOnWindowOpen', 1);

  await soft('cartRecordWindowMsg', () => recordCartMessage(checkoutId, res.messageId, { key: 'cart_recovery', template: res.templateName }), { checkoutId });
  /*
   * Only if the reminder slot is still ahead of us. The park can be hours old
   * by the time they write in, and EventBridge accepts an at() in the past and
   * then never invokes it, so arming a stale one would look scheduled and
   * silently do nothing.
   */
  if (new Date(rec.reminderAt).getTime() > now.getTime()) {
    await soft('cartArmFinalAfterWindow', () =>
      scheduleTimer({
        flow: 'R',
        orderId: String(checkoutId),
        step: 'final',
        at: new Date(rec.reminderAt),
        groupId: group(phone),
      }), { checkoutId });
  }
  log.info('cart: delivered a parked checkout through an open service window', { checkoutId });
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
  const raw = await readCheckout(deps, checkoutId);
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
