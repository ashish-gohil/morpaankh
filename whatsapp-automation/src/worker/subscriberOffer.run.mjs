/*
 * subscriberOffer.run.mjs — Flow W: one private, 24 hour welcome code for
 * someone who joined the shop and has never ordered.
 *
 * THE RULES THIS FILE EXISTS TO HOLD:
 *   ONCE PER PERSON, EVER, keyed on the number AND on the email, so a fresh
 *     customer record cannot farm a second code;
 *   nothing is sent if the code we could offer is not better than what anyone
 *     can already type in off the cart page;
 *   nobody who has an order or a live cart is touched, because Flow R owns a
 *     cart and an order needs no welcome;
 *   the lifetime locks are written only AFTER the provider accepts, and given
 *     BACK if the message then fails to deliver, because "ever" means ever and
 *     a lock on a message nobody received would burn that person permanently;
 *   WhatsApp first, email only when WhatsApp is impossible or refused.
 *
 * Every exit past the SUB row records an `outcome`, which is the only answer
 * the owner will ever get to "why did this person not get their welcome code".
 */
import { config } from '../config.mjs';
import { SUBSCRIBER_OFFER_TITLE, CART_RECOVERY_TITLE } from '../clients/shopify.mjs';
import { RULES } from '../../messages/rules.mjs';
import {
  normalizeCustomer, subscriberEligible, chooseChannel, phoneSkipReason, subscriberOfferGuard,
  subscriberCode, subscriberVars, topPicks, landingUrl, escapeHtml, minimumPaise, shopifyMinimumInr,
  onSubscriberAllowlist,
} from '../domain/subscriberOffer.mjs';
import { formatExpiresAt, shopperKeys, sameShopper, phoneKey, emailKey, idTail } from '../domain/cart.mjs';
import { heroImageUrl } from '../domain/order.mjs';
import { verifiedPhoneFromCustomAttributes, verifiedPhoneFromNoteAttributes, normalizeVerifiedPhone } from '../lib/phone.mjs';
import { formatINR, toPaise } from '../lib/money.mjs';
import { randomToken } from '../lib/ids.mjs';
import { withinWindow, nextWindowTime, addHours } from '../lib/time.mjs';
import { renderSubscriberEmail, headerSafe } from '../../messages/email.mjs';
import {
  getSubRec, ensureSubRec, patchSubRec, setSubOutcome, subRunOnce, recordSubMessage,
  getPhoneOfferLock, getEmailOfferLock, lockPhoneOffer, lockEmailOffer,
  releasePhoneOfferLock, releaseEmailOfferLock,
  parkSubForWindow, getSubParked, clearSubParked,
  setSubLinkMap, setSubCodeMap, getSubCodeMap, subAlertOncePerDay,
} from '../store/subscriberOffer.mjs';
import { getPhoneLock, getParked } from '../store/cartRecovery.mjs';
import { listCaptures } from '../store/cartCapture.mjs';
import {
  isOptedOut, isUndeliverable, canSendMarketing, markMarketing, clearMarketing, touchInbound, windowOpen,
} from '../store/phoneProfile.mjs';
import { scheduleTimer } from '../timers/schedule.mjs';
import { tpl, sess, ownerAlert, isTemplateUnusable, isWindowDeliverable } from './send.mjs';
import { soft } from '../lib/resilience.mjs';
import { log, metric, maskPhone } from '../log.mjs';

const nowOf = (deps) => deps.now || new Date();
const w = () => RULES.subscriberOffer;
/** The one host this flow ever points a customer at. Never from a request. */
const STORE = 'https://www.morpaankh.in';
/** How far back a cart of theirs still counts. */
const CART_LOOKBACK_DAYS = 7;

/**
 * The FIFO group for one person: the same `phone:<e164>` Flow R uses, so the
 * two flows cannot overtake each other on the same customer. Someone we can
 * only email has no phone to serialize on, so their group is the email hash,
 * which is never the address itself: a group id lands in SQS metadata.
 */
export const subGroup = (n) => (n?.phone ? `phone:${n.phone}` : `email:${n?.emailKey || 'none'}`);

/**
 * A skip the EMAIL client reports is its own outcome; anything else is a send
 * gate. `email-unavailable` means this deploy cannot send email at all and
 * `email-invalid` means that address never could, and neither reads as
 * "send-something".
 */
const outcomeForSkip = (skip) => (String(skip).startsWith('email-') ? String(skip) : `send-${skip}`);

/*
 * THE CLIENTS THE STATUS WEBHOOK EMAILS THROUGH.
 *
 * A WhatsApp delivery status arrives in its own invocation, and the router
 * hands onCartStatus no deps at all because Flow R's status path sends
 * nothing. Flow W's does: 131049 is reported asynchronously on the status
 * webhook (see onSubStatus) and the email fallback is the whole point of
 * handling it. So onSubStatus takes `deps` as a real parameter, and the router
 * passes it, rather than this module remembering the last clients it saw: a
 * module-level singleton would be inert today only because every caller hands
 * over the same stateless `realClients`, and would turn into a genuine bug the
 * first time two callers did not.
 */

/** The seven-day cart window, floored to a date so every candidate in one
 * sweep asks the client for the SAME window and the memo in
 * listAbandonedCheckouts actually hits. A wider window is the safe direction
 * for a gate that answers "leave this person alone". */
function cartLookbackSince(createdAt) {
  const from = new Date(new Date(createdAt).getTime() - CART_LOOKBACK_DAYS * 86400 * 1000);
  return `${from.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Has this person ordered, by any route we can see?
 *
 * THREE QUESTIONS, because a new customer can become a customer three ways and
 * only one of them moves `numberOfOrders` in time to be read here:
 *   the customer record's own count (already checked in subscriberEligible);
 *   an order under their exact email, which is the guest-checkout case;
 *   an order since they signed up carrying their customer id or their COD King
 *     verified phone, which is the one that lands in the minutes between the
 *     sweep and this worker.
 */
async function hasOrdered(deps, n) {
  if (n.numberOfOrders > 0) return true;
  if (n.email) {
    const byEmail = await deps.clients.shopify.ordersByEmail(n.email);
    if (byEmail.length) return true;
  }
  /*
   * THREE WAYS TO MATCH, NOT TWO, AND THE THIRD IS WHERE THEY WERE LOST.
   *
   * This read only the order's customer id and its COD King OTP attribute. An
   * order has neither when it came through Cashfree straight from the cart, or
   * from a recovery link, or was typed into the admin: no OTP attribute at all,
   * and COD King files its own second customer record so the id does not match
   * either. Those people bought something and were sent "Rs 200 welcome" the
   * next morning.
   *
   * sameShopper reads the number off every field an order can carry it in,
   * including both address blocks, and compares on normalised keys. It is the
   * same function Flow R uses to decide whether an order came back from a cart
   * message, so the two cannot drift into disagreeing about who somebody is.
   */
  const keys = {
    phones: [phoneKey(n.phone)].filter(Boolean),
    emails: [emailKey(n.email)].filter(Boolean),
    customerId: idTail(n.gid) || null,
  };
  const since = await deps.clients.shopify.ordersCreatedSince(n.createdAt);
  return since.some((o) => sameShopper(shopperKeys(o), keys));
}

/**
 * Does this person already have a cart somewhere?
 *
 * If they do, FLOW R OWNS THEM and this flow stands down: a cart recovery
 * message is about a bag they chose, it already carries its own private code,
 * and two MORPAANKH codes against one number means the customer can be holding
 * a code the message they are reading does not mention.
 *
 * abandonedCheckouts cannot be filtered by customer, phone or id (the `id:`
 * forms return nothing for a checkout that is definitely there), so this LISTS
 * and matches in memory, exactly as Flow R's sweep does. The client memoises
 * the list for two minutes, which is what keeps a hundred candidates to one
 * read.
 */
async function hasCart(deps, n, now) {
  if (n.phone) {
    // A Flow R lease or park on the number: a sequence is already running.
    const lock = await getPhoneLock(n.phone);
    if (lock?.lockUntil && new Date(lock.lockUntil).getTime() > now.getTime()) return true;
    const parked = await getParked(n.phone);
    if (parked?.until && new Date(parked.until).getTime() > now.getTime()) return true;
    // A cart the storefront captured. COD King's OTP happens before Shopify
    // files an AbandonedCheckout, so this is the source that sees most of them.
    const captures = await listCaptures();
    if (captures.some((c) => c.phone === n.phone)) return true;
  }
  const checkouts = await deps.clients.shopify.listAbandonedCheckouts(cartLookbackSince(n.createdAt));
  return checkouts.some((c) => {
    if (c.completedAt) return false;
    if (n.gid && c.customer?.id === n.gid) return true;
    if (!n.phone) return false;
    if (verifiedPhoneFromCustomAttributes(c.customAttributes) === n.phone) return true;
    // The address phone, which is the only number on a checkout somebody
    // started without reaching COD King's popup.
    return normalizeVerifiedPhone(c.shippingAddress?.phone || c.billingAddress?.phone) === n.phone;
  });
}

/**
 * Create the Shopify code.
 *
 * `fixed` is the EMAIL path: that string is already in a message that has gone
 * out, so a collision cannot be answered by drawing another one. On the
 * WhatsApp path nothing has been sent yet, so a collision just draws again.
 * 8^4 = 4096 codes per first name and one code per person ever, so a collision
 * is a once-in-years event here, but a dropped welcome message is not an
 * acceptable answer to it.
 */
async function createCode(deps, id, n, endsAt, now, fixed = null) {
  const title = `${SUBSCRIBER_OFFER_TITLE}${n.numericId}`;
  return subRunOnce(id, 'code', async () => {
    /*
     * THE DRAWS ARE COMMITTED TO THE RECORD BEFORE ANY MONEY IS SPENT.
     *
     * subRunOnce records its result only once the side effect RETURNS, and
     * this side effect creates a real Rs 200 discount and then writes the
     * SUBCODE map. A throttle or the 60 second Lambda budget landing in that
     * gap leaves a live code in the admin that nothing remembers, and a
     * redelivery drawing FRESH strings would mint a second one, up to
     * maxReceiveCount times.
     *
     * Memoising the whole draw LIST makes the retry deterministic: it walks
     * the identical strings in the identical order, so Shopify refusing the
     * first one is information rather than an accident, and the `taken`
     * handler below can resolve it.
     */
    const draws = await subRunOnce(id, 'codedraws', async () =>
      (fixed ? [fixed] : Array.from({ length: 5 }, () => subscriberCode(n.rawFirstName, RULES))));
    let lastErr = null;
    for (const code of draws) {
      try {
        const res = await deps.clients.shopify.createDiscountCode({
          code,
          // NEVER PII: this title shows in the Shopify admin's discount list,
          // and it is the same constant publicCodeDiscounts() excludes on, so
          // a code this flow issued can never become part of its own floor.
          // It is ALSO how a retry recognises its own code below.
          title,
          /*
           * The WALL clock, not the flow's logical `now`. The message goes out
           * the moment this returns, so the code has to be honourable the
           * moment it lands. The two are the same value in production and
           * diverge only under `subscriber-offer.mjs run --date`, where a
           * logical clock wound forward made Shopify file the discount as
           * SCHEDULED and a tap before that minute was refused.
           */
          startsAt: new Date(Math.min(Date.now(), now.getTime())).toISOString(),
          endsAt: endsAt.toISOString(),
          amountInr: w().amountInr,
          // A PAISA above the figure in the copy, so "above Rs 1,500" is
          // literally true of every order it works on, and so the offer guard
          // lands in the Rs 2,000 tier rather than the Rs 1,500 one.
          minSubtotalInr: shopifyMinimumInr(RULES),
        });
        const made = { code: res.code || code, discountId: res.id };
        await setSubCodeMap(made.code, id);
        return made;
      } catch (e) {
        if (!/taken|unique|already/i.test(e.message)) throw e;
        /*
         * Shopify already holds this string, and there are exactly two ways
         * that happens: an earlier attempt of OURS created it and lost its
         * memo in the gap above, or it belongs to something else. The TITLE
         * decides, and it carries this customer's own id, so the answer is
         * never a guess.
         *
         * Ours: adopt it. Creating another would be the second Rs 200 code
         * this whole function exists to prevent.
         * Not ours: draw again. Handing a customer a discount created for
         * somebody else is the one answer worse than a dropped message.
         */
        const held = await deps.clients.shopify.discountByCode(code);
        if (held && held.title === title) {
          log.warn('subscriber: adopting the code an earlier attempt already created', { customerId: id });
          await setSubCodeMap(code, id);
          return { code, discountId: held.id };
        }
        lastErr = e;
        log.warn('subscriber: code collision, drawing another', { customerId: id });
      }
    }
    throw lastErr || new Error('subscriber: no free code after five draws');
  });
}

/** The /w/{token} link, minted once per record. */
const linkFor = (id, channel) =>
  subRunOnce(id, 'link', async () => {
    const t = randomToken();
    await setSubLinkMap(t, id, channel);
    return t;
  });

/**
 * The collection's best sellers, for the "most loved right now" line and the
 * header photo.
 *
 * soft(): the collection is DECORATION, not the offer. Losing it costs the
 * message three product names and its photo, and must never cost somebody
 * their code.
 */
async function bestSellers(deps) {
  const picks = await soft('subscriberBestSellers', () => deps.clients.shopify.collectionBestSellers(w().collectionHandle, 6), {});
  return (picks || []).filter((p) => p && p.title && p.availableForSale !== false && (p.status == null || p.status === 'ACTIVE'));
}

/**
 * Send the offer on WhatsApp, as a template or as a free-form message.
 *
 * Inside the 24 hour service window a free-form message is NOT a template: it
 * carries no category, so the per-user MARKETING cap behind 131049 does not
 * apply and it costs nothing. Both branches render the same words and point at
 * the same /w/ link, so what the customer sees does not change with the
 * channel.
 */
async function sendWhatsApp(deps, phone, vars, ctx, viaSession) {
  if (!viaSession) return tpl(deps, phone, 'subscriber_offer', vars, ctx);
  // Repeated because the check lives inside tpl(), and the session branch does
  // not go through tpl().
  if (await isUndeliverable(phone)) return { skipped: 'undeliverable', templateName: 'session:subscriber_offer' };
  const res = await sess(deps, phone, 'subscriber_offer', vars, { ...ctx, url: `${config.publicBaseUrl}/w/${ctx.token}` });
  return { ...res, templateName: 'session:subscriber_offer' };
}

/**
 * Where this message's unsubscribe points.
 *
 * Shopify's own URL whenever it has one, so that opting out here opts them out
 * there too. It is NULLABLE, though, and when it was absent every route out of
 * this list disappeared at once: the header was dropped for being empty and
 * the body link and text line sit behind the same ternary. A marketing email
 * with no opt-out is unlawful in most of the places it can land and is the
 * fastest way to get a young SES identity put under review.
 *
 * So the fallback is a mailto to the human mailbox that already answers
 * replies to this flow. It is a real opt-out: somebody reads it.
 *
 * @param {any} n a normalized customer
 */
const unsubscribeFor = (n) => {
  if (n?.unsubscribeUrl) return String(n.unsubscribeUrl);
  const box = config.emailReplyTo || config.emailFrom;
  return box ? `mailto:${box}?subject=unsubscribe` : '';
};

/** Send the offer as an email. Returns the same `{messageId}|{skipped}` shape. */
async function sendEmail(deps, n, vars, token, picks) {
  const utm = `utm_source=email&utm_medium=automation&utm_campaign=welcome_24h`;
  const unsubscribeUrl = unsubscribeFor(n);
  const { subject, text, html } = renderSubscriberEmail({
    vars,
    rawFirstName: n.rawFirstName,
    url: `${config.publicBaseUrl}/w/${token}`,
    picks,
    unsubscribeUrl,
    shopUrl: STORE,
    utm,
    escapeHtml,
  });
  return deps.clients.email.send({
    to: n.email,
    subject,
    html,
    text,
    /*
     * List-Unsubscribe is the header every inbox provider looks for. Both
     * values go through headerSafe: the URL comes from outside this service,
     * and a bare CRLF in a header appends headers of somebody else's choosing
     * to our message.
     *
     * One-Click is declared ONLY beside Shopify's HTTPS URL. RFC 8058 makes it
     * a contract to accept a POST, which a mailto cannot honour, and a
     * dangling `-Post` header with nothing to click is precisely what Gmail's
     * and Yahoo's bulk sender rules look for.
     */
    headers: {
      'List-Unsubscribe': unsubscribeUrl ? headerSafe(`<${unsubscribeUrl}>`) : '',
      'List-Unsubscribe-Post': n.unsubscribeUrl ? 'List-Unsubscribe=One-Click' : '',
    },
    // Shopify has already told us whether this address can receive at all.
    validFormat: n.emailValidFormat,
  });
}

/**
 * Message 1.
 *
 * Re-reads the customer every time: the sweep that enqueued this ran at 11:00
 * and the search index it read lags a create by seconds, so everything it
 * believed is asked again here against `customer(id:)`, which does not lag.
 */
export async function onFirst(customerId, deps) {
  const now = nowOf(deps);
  /*
   * Writes NOTHING, on purpose. With no SUB row the next run reconsiders this
   * person, which is what we want for a flow that was switched off for a
   * deploy.
   */
  if (!config.flows.W.enabled) return log.info('subscriber: flow W off, not starting', { customerId });

  const n = normalizeCustomer(await deps.clients.shopify.getCustomer(customerId));
  const eligible = subscriberEligible(n, { now, startAt: config.flows.W.startAt, rules: RULES });

  // From here on every exit is recorded, so nothing re-enqueues this person.
  const { created } = await ensureSubRec(customerId, {
    phone: n?.phone || null,
    emailKey: n?.emailKey || null,
  }, now);
  if (!created) {
    const existing = await getSubRec(customerId);
    // An SQS redelivery, or a sweep that ran twice. One offer, ever.
    if (existing?.firstSentAt || existing?.outcome) {
      return log.info('subscriber: already handled', { customerId, outcome: existing.outcome });
    }
  }
  if (!eligible.ok) {
    await setSubOutcome(customerId, eligible.reason, { skipReason: eligible.reason });
    return log.info('subscriber: not eligible', { customerId, reason: eligible.reason });
  }

  /*
   * OUTSIDE THE WINDOW WE WAIT, WE DO NOT DROP.
   *
   * This is the one place Flow W deliberately differs from Flow R. Flow R
   * drops a cold bag rather than wake someone at 09:30, because another cart
   * will come along. There is exactly ONE welcome offer per person ever, and
   * it is a whole day long, so an 09:00 run has to arm a timer for 10:00 and
   * come back. No outcome is recorded: an outcome is terminal and would lose
   * this person for good.
   */
  if (!withinWindow(now, w().sendWindow)) {
    const at = nextWindowTime(now, w().sendWindow);
    await soft('subscriberArmWindow', () =>
      scheduleTimer({ flow: 'W', orderId: String(customerId), step: 'first', at, groupId: subGroup(n), now }), { customerId });
    return log.info('subscriber: outside the send window, waiting for it', { customerId, at: at.toISOString() });
  }

  let { channel } = chooseChannel(n, { rules: RULES });
  const note = phoneSkipReason(n);
  // A note, never an outcome: "we cannot reach them on WhatsApp" is why they
  // are getting an email, not a reason to drop them. R22.
  if (note) await patchSubRec(customerId, { phoneSkipReason: note });

  if (n.phone) {
    // STOP outranks everything, including the customer record counting as
    // consent. Not even the email: stop means stop.
    if (await isOptedOut(n.phone)) return setSubOutcome(customerId, 'opted-out');
    /*
     * 131026 said this number cannot receive WhatsApp. The PERSON is not
     * refused, only the channel, so the offer goes by email if there is one.
     */
    if (await isUndeliverable(n.phone, now)) {
      channel = n.email && n.emailMarketingState !== 'UNSUBSCRIBED' ? 'email' : 'none';
      if (channel === 'none') return setSubOutcome(customerId, 'undeliverable');
    }
  }
  /*
   * An address Shopify itself says cannot receive. Skipped BEFORE anything is
   * created, because the alternative is a bounce, its retries and an alert,
   * and SES judges a sender on its bounce RATE: at one or two emails a day a
   * single dud address is a large share of the day's volume.
   */
  if (channel === 'email' && n.emailValidFormat === false) return setSubOutcome(customerId, 'email-invalid');

  if (await hasOrdered(deps, n)) return setSubOutcome(customerId, 'already-ordered');
  if (await hasCart(deps, n, now)) return setSubOutcome(customerId, 'has-cart');

  /*
   * ONCE PER PERSON, EVER, on BOTH keys. The phone lock stops a second
   * customer record on the same number; the email lock stops the obvious farm,
   * which is a new number against an address that has already been offered a
   * code.
   */
  if (n.phone && (await getPhoneOfferLock(n.phone))) return setSubOutcome(customerId, 'already-offered');
  if (n.emailKey && (await getEmailOfferLock(n.emailKey))) return setSubOutcome(customerId, 'already-offered');

  /*
   * The service-wide marketing cap, which only applies to a WhatsApp TEMPLATE.
   * An open 24 hour window means the offer goes free-form, and refusing to
   * send inside the window would be turning down the one channel Meta cannot
   * throttle in order to honour a rule about a channel we are not using.
   */
  const viaSession = channel === 'whatsapp' ? await windowOpen(n.phone, now) : false;
  if (channel === 'whatsapp' && !viaSession && !(await canSendMarketing(n.phone, now, RULES.marketingCapDays))) {
    return setSubOutcome(customerId, 'marketing-cap');
  }

  /*
   * The live public codes are read BEFORE anything is created, and a failure
   * to read them stops the message. FAIL CLOSED: without them the floor is
   * unknown, so a private Rs 200 code could be worth the same as or less than
   * something printed on the cart page, and a private offer that is not better
   * than the public one is worse than silence.
   */
  let publicCodes;
  try {
    /*
     * Filtered by title as well as trusted. publicCodeDiscounts() already
     * drops anything with a usage limit and anything titled with either
     * flow's prefix, and this is the second line of the same defence: the
     * first welcome code ever issued must not become part of the floor every
     * later one has to beat, or the offer climbs itself out of existence.
     */
    publicCodes = (await deps.clients.shopify.publicCodeDiscounts()).filter((c) => {
      const title = String(c?.title || '');
      return !title.startsWith(SUBSCRIBER_OFFER_TITLE) && !title.startsWith(CART_RECOVERY_TITLE);
    });
  } catch (e) {
    log.error('subscriber: could not read the live discount codes, refusing to offer blind', { err: e.message });
    await soft('subscriberPublicCodesAlert', async () => {
      if (await subAlertOncePerDay('public-codes', now)) {
        await ownerAlert(
          deps,
          'welcome offer',
          'the welcome offer cannot read the live discount codes, so it is sending nothing rather than offer less than the cart page already shows. Check the app has read_discounts',
        );
      }
    }, { customerId });
    return setSubOutcome(customerId, 'no-public-codes');
  }

  const guard = subscriberOfferGuard({
    amountPaise: w().amountInr * 100,
    minimumPaise: minimumPaise(RULES),
    publicCodes,
    rules: RULES,
  });
  if (!guard.ok) {
    log.info('subscriber: the public codes already give as much, sending nothing', {
      customerId, floorPaise: guard.floorPaise, capPaise: guard.capPaise,
    });
    await soft('subscriberGuardAlert', async () => {
      if (await subAlertOncePerDay('offer-guard', now)) {
        await ownerAlert(
          deps,
          'welcome offer',
          `the welcome offer is ${formatINR(w().amountInr * 100)} and the rules now refuse it (${guard.reason}): the floor is ${formatINR(guard.floorPaise)} and the ceiling ${formatINR(guard.capPaise)}. No welcome codes are going out until the public codes or RULES.subscriberOffer change`,
        );
      }
    }, { customerId });
    return setSubOutcome(customerId, guard.reason, { floor: guard.floorPaise, cap: guard.capPaise });
  }

  /*
   * Shadow mode. A non-empty allowlist means everybody else is logged and left
   * alone: no Shopify code, no lock, no message. It is the mitigation for the
   * one genuinely new risk in this flow, which is that the recipient number
   * was never OTP-verified by anyone.
   *
   * THE LOG LINE CARRIES NO NAME AND NO CODE PREVIEW. Flow R's equivalent logs
   * a codePreview that embeds the customer's own first name in clear text in
   * CloudWatch, beside a masked phone, which undoes the masking for anybody
   * reading the line.
   */
  if (config.subscriberOfferAllowlist.length && !onSubscriberAllowlist(n, config.subscriberOfferAllowlist)) {
    log.info('subscriber: would send', {
      customerId,
      phone: maskPhone(n.phone),
      channel,
      offer: formatINR(w().amountInr * 100),
      min: formatINR(w().minOrderAboveInr * 100),
    });
    metric('SubscriberShadow', 1);
    return setSubOutcome(customerId, 'shadow');
  }

  /*
   * The service-wide gate (DRY_RUN, SEND_ALLOWLIST, no EMAIL_FROM), asked here
   * rather than discovered from the send's own reply. That reply comes back
   * AFTER the Shopify code exists, so a gated run would otherwise leave one
   * orphan single-use code per candidate in the admin.
   */
  const client = channel === 'email' ? deps.clients.email : deps.clients.whatsapp;
  const gated = client?.sendSkipReason?.(channel === 'email' ? n.email : n.phone) || null;
  if (gated) {
    log.info('subscriber: send is gated, nothing created', { customerId, phone: maskPhone(n.phone), skip: gated });
    return setSubOutcome(customerId, outcomeForSkip(gated));
  }

  /*
   * The clock is computed ONCE and stored, so a redelivery can never tell the
   * customer a different closing time than the code actually has. codeEndsAt,
   * never expiresAt: expiresAt is the table's TTL and Dynamo would delete the
   * record at the moment the code closed.
   */
  const codeEndsAt = addHours(now, w().codeValidHours);
  const picks = await bestSellers(deps);
  const token = await linkFor(customerId, channel);
  const imageUrl = heroImageUrl({
    lineItems: picks.map((p) => ({
      image: p.imageUrl ? { url: p.imageUrl, width: p.imageWidth, height: p.imageHeight } : null,
    })),
  });

  /*
   * WHATSAPP CREATES THE CODE FIRST AND EMAIL SENDS FIRST. THIS IS DELIBERATE.
   *
   * The WhatsApp gate is visible before the send (sendSkipReason), so there is
   * nothing left to discover by sending and the code is created first: a send
   * that throws must not mint a second code on redelivery.
   *
   * SES can be genuinely absent at runtime. The Lambda asset excludes
   * node_modules, so @aws-sdk/client-sesv2 may simply not be in the bundle,
   * and that is invisible until the first send is attempted. A single-use
   * Shopify code created for a message that never left is an orphan discount
   * in the admin, one per candidate, so on the email path the message goes
   * first carrying a code string drawn here, and the Shopify discount is
   * created the moment the send is accepted.
   *
   * What that leaves is a code the customer has been promised and Shopify has
   * not got, for the second between the two calls. It is bounded: the string
   * is memoised, so an SQS redelivery re-sends the SAME code and retries the
   * create, and a duplicate email is a far smaller harm than a dead code.
   */
  const fixedCode = channel === 'email'
    ? await subRunOnce(customerId, 'codestr', async () => subscriberCode(n.rawFirstName, RULES))
    : null;
  const made = channel === 'email' ? null : await createCode(deps, customerId, n, codeEndsAt, now);

  await patchSubRec(customerId, {
    channel,
    code: made ? made.code : fixedCode,
    discountId: made ? made.discountId : null,
    codeEndsAt: codeEndsAt.toISOString(),
    token,
    email: n.email || null,
    unsubscribeUrl: n.unsubscribeUrl || null,
    customerGid: n.gid,
    customerCreatedAt: n.createdAt,
    offerPaise: w().amountInr * 100,
  });

  const rec = await getSubRec(customerId);
  const vars = subscriberVars({ n, rec, topPicks: topPicks(picks), now, rules: RULES });

  let res;
  try {
    res = channel === 'email'
      ? await sendEmail(deps, n, vars, token, picks)
      : await sendWhatsApp(deps, n.phone, vars, { orderId: String(customerId), token, imageUrl }, viaSession);
  } catch (e) {
    if (channel === 'email') {
      // SES refused the message. NOT a throw: an exception here would
      // redeliver a record whose code may already exist, and a rejected
      // address is not transient.
      log.error('subscriber: the email was rejected', { customerId, err: e.message });
      return setSubOutcome(customerId, 'email-send-failed');
    }
    return handleSendFailure(deps, customerId, e, now, n, vars, picks, token);
  }
  // Already on the do-not-send list, gated, invalid or suppressed: no lock,
  // because they got nothing.
  if (res?.skipped) return setSubOutcome(customerId, outcomeForSkip(res.skipped));

  if (channel === 'email') {
    // Accepted, so the code it carries has to exist. Not soft: a promise was
    // just made in writing.
    const emailed = await createCode(deps, customerId, n, codeEndsAt, now, fixedCode);
    await patchSubRec(customerId, { code: emailed.code, discountId: emailed.discountId });
  }

  /*
   * ACCEPTED. The writes that must not be lost go first and are NOT soft:
   * firstSentAt is what stops a second offer and the two locks are the
   * once-per-person-ever promise. Everything after this is bookkeeping, and a
   * failure there must not redeliver a record whose message has gone out.
   */
  await patchSubRec(customerId, { firstSentAt: now.toISOString(), wamids: [res.messageId].filter(Boolean) });
  if (n.phone) await lockPhoneOffer(n.phone, { customerId, now });
  if (n.emailKey) await lockEmailOffer(n.emailKey, { customerId, now });

  // Only a MARKETING TEMPLATE spends the cap. A session message is not one and
  // an email is not one either, so stamping here would bar this person from
  // marketing for marketingCapDays over something that never touched the cap.
  if (channel === 'whatsapp' && !viaSession) {
    await soft('subscriberMarkMarketing', () => markMarketing(n.phone, now), { customerId });
  }
  metric(channel === 'email' ? 'SubscriberEmailSent' : viaSession ? 'SubscriberSentSession' : 'SubscriberSent', 1);
  await soft('subscriberRecordMessage', () =>
    recordSubMessage(customerId, res.messageId, { key: 'subscriber_offer', template: res.templateName || 'email' }), { customerId });

  return { sent: true, channel };
}

/**
 * A WhatsApp send that threw. None of these take a lock: the customer received
 * nothing on WhatsApp.
 *
 * isWindowDeliverable covers 131049, the per-user MARKETING cap counted across
 * every business that messages that person, and 130472, Meta's marketing
 * experiment holdout. Neither moves for anything we send or stop sending, and
 * retrying the template fails the same way, so the offer is parked against the
 * phone until the customer opens a 24 hour service window by writing to us, AND
 * goes out by email now, because the offer is only a day long and a park that
 * never opens is a person who got nothing.
 *
 * 131026 means that number cannot receive WhatsApp at all, so no window helps
 * and there is nothing to park: the email is the only route left.
 */
async function handleSendFailure(deps, customerId, e, now, n, vars, picks, token) {
  const code = e?.waCode;
  if (isWindowDeliverable(code) || code === 131026) {
    if (isWindowDeliverable(code)) {
      const rec = await getSubRec(customerId);
      // The park lives exactly as long as the offer does, so onWindowOpen can
      // never deliver a message whose code has already closed.
      const until = rec?.codeEndsAt ? new Date(rec.codeEndsAt) : addHours(now, w().codeValidHours);
      await soft('subscriberPark', () => parkSubForWindow(n.phone, customerId, until, now), { customerId });
      metric('SubscriberParkedForWindow', 1);
    }
    log.warn('subscriber: Meta refused the template, falling back to email', { customerId, waCode: code });
    await emailFallback(deps, customerId, n, vars, picks, token, now);
    return setSubOutcome(customerId, isWindowDeliverable(code) ? 'waiting-window' : `meta-${code}`);
  }
  if (isTemplateUnusable(e)) {
    log.error('subscriber: template unusable', { customerId, waCode: code });
    await soft('subscriberTemplateAlert', async () => {
      if (await subAlertOncePerDay('template-unusable', now)) {
        await ownerAlert(deps, 'welcome offer', `the welcome offer template could not be used (${code}). Welcome offers are stopped until it is fixed`);
      }
    }, { customerId });
    return setSubOutcome(customerId, 'template-unusable');
  }
  throw e; // genuinely transient: let SQS redeliver
}

/**
 * The same offer, by email, after WhatsApp refused it.
 *
 * TAKES BOTH LIFETIME LOCKS, AND ONLY ONCE THE SEND IS ACCEPTED.
 *
 * Every WhatsApp-refusal path returns from onFirst before its own two
 * lockPhoneOffer/lockEmailOffer lines, and on the async 131049 path
 * onSubStatus has just RELEASED both. So if this delivery took no lock,
 * nothing would hold one for a person who has the code in their inbox, and
 * "once per person, ever" would be enforced only by `outcome`, which is keyed
 * on customerId. The farm that beats a per-record check is a NEW RECORD: a
 * fresh email and a +91 number with no WhatsApp account, through the public
 * signup popup, collects a Rs 200 code by email and comes back tomorrow for
 * another. The two locks are the only cross-record control there is.
 *
 * The locks go on AFTER the accept and never before, which is the same rule
 * onFirst follows: a lock on a message nobody received burns that person's one
 * welcome offer for ever, and `ever` has no expiry to wait out. A skipped,
 * suppressed, invalid or unavailable send therefore still leaves both free,
 * which is what lets onSubStatus hand them back for a message that reached
 * nobody.
 *
 * soft(): the WhatsApp failure is already recorded and already the outcome. A
 * failing fallback must not turn a handled refusal into a redelivery.
 */
async function emailFallback(deps, customerId, n, vars, picks, token, now = nowOf(deps)) {
  /*
   * THE KILL SWITCH. onFirst and onWindowOpen check this; onSubStatus
   * deliberately does not, because giving the two lifetime locks back for a
   * message nobody received is bookkeeping that must run even with the flow
   * switched off. SENDING is not bookkeeping, so the check belongs here.
   */
  if (!config.flows.W.enabled) return null;
  if (!n?.email || n.emailMarketingState === 'UNSUBSCRIBED') return null;
  return soft('subscriberEmailFallback', async () => {
    const res = await sendEmail(deps, n, vars, token, picks);
    if (res?.skipped) {
      log.info('subscriber: email fallback skipped', { customerId, skip: res.skipped });
      return null;
    }
    metric('SubscriberEmailFallback', 1);
    // NOT soft: this is the once-per-person-ever promise, and it is now owed.
    if (n.phone) await lockPhoneOffer(n.phone, { customerId, now });
    if (n.emailKey) await lockEmailOffer(n.emailKey, { customerId, now });
    await soft('subscriberRecordFallback', () =>
      recordSubMessage(customerId, res.messageId, { key: 'subscriber_offer', template: 'email-fallback' }), { customerId });
    return res;
  }, { customerId });
}

/**
 * This phone just wrote to us, so a 24 hour service window is now open.
 *
 * An offer parked by 131049 can go now as a free-form message, which the
 * per-user MARKETING cap does not apply to. The customer opening the window is
 * the ONLY thing that clears that cap for us, which is why this hangs off
 * their inbound message and not off a timer: a timer would collect the same
 * refusal again.
 *
 * It delivers the SAME code. One person, one code, whichever door it came
 * through.
 */
export async function onWindowOpen(phone, deps) {
  const now = nowOf(deps);
  if (!config.flows.W.enabled) return;
  const parked = await getSubParked(phone);
  if (!parked?.customerId) return;

  const customerId = parked.customerId;
  /*
   * patchSubRec, NOT setSubOutcome. The row already carries `waiting-window`
   * from the refusal that parked it, and setSubOutcome is first-writer-wins,
   * so the reason this offer was finally let go would never be recorded and
   * the owner would read "waiting" for ever.
   */
  const drop = async (reason, outcome) => {
    await clearSubParked(phone);
    if (outcome) await patchSubRec(customerId, { outcome, outcomeAt: now.toISOString() });
    log.info('subscriber: parked offer released', { customerId, reason });
  };

  // The code has closed, so there is nothing left to offer.
  if (new Date(parked.until).getTime() <= now.getTime()) return drop('offer-closed');

  const rec = await getSubRec(customerId);
  if (!rec || rec.phone !== phone) return drop('no-record');
  /*
   * firstSentAt alone does not mean they got it. On the async 131049 path Meta
   * accepted the message, stamped firstSentAt, and then never delivered it, so
   * deliveryFailed is the only honest record of what the customer received.
   * Refusing on firstSentAt alone would park an offer and then refuse to
   * deliver the very thing it was parked for.
   */
  if (rec.firstSentAt && !rec.deliveryFailed) return drop('already-sent');
  if (await isOptedOut(phone)) return drop('opted-out', 'opted-out');
  // Quiet hours. Left parked on purpose: the next inbound inside the window
  // picks it up, and the park expires with the code either way.
  if (!withinWindow(now, w().sendWindow)) return log.info('subscriber: window open but outside the send window', { customerId });

  const n = normalizeCustomer(await deps.clients.shopify.getCustomer(customerId));
  if (!n) return drop('customer-gone', 'not-found');
  if (await hasOrdered(deps, n)) return drop('ordered', 'already-ordered');

  const picks = await bestSellers(deps);
  const vars = subscriberVars({ n, rec, topPicks: topPicks(picks), now, rules: RULES });
  let res;
  try {
    res = await sendWhatsApp(deps, phone, vars, { orderId: String(customerId), token: rec.token }, true);
  } catch (e) {
    log.error('subscriber: parked send failed inside an open window', { customerId, waCode: e?.waCode });
    throw e; // leave it parked: the next inbound tries again
  }
  if (res?.skipped) return drop(`send-${res.skipped}`, outcomeForSkip(res.skipped));

  await clearSubParked(phone);
  /*
   * The outcome is CLEARED, not just stamped over. `waiting-window` was
   * written to stop anything re-enqueueing this person, and a record still
   * reading `waiting-window` for an offer that has landed is a lie the owner
   * would read in the digest.
   */
  await patchSubRec(customerId, {
    firstSentAt: now.toISOString(),
    outcome: null,
    outcomeAt: null,
    deliveryFailed: false,
    deliveryError: null,
    lastStatus: null,
    wamids: [...(rec.wamids || []), res.messageId].filter(Boolean),
  });
  if (phone) await lockPhoneOffer(phone, { customerId, now });
  if (rec.emailKey) await lockEmailOffer(rec.emailKey, { customerId, now });
  metric('SubscriberSentOnWindowOpen', 1);
  await soft('subscriberRecordWindowMsg', () =>
    recordSubMessage(customerId, res.messageId, { key: 'subscriber_offer', template: res.templateName }), { customerId });
  log.info('subscriber: delivered a parked offer through an open service window', { customerId });
  return { sent: true };
}

/**
 * A WhatsApp delivery status for a welcome offer.
 *
 * THIS IS WHERE 131049 ACTUALLY LANDS. Meta accepts the send with a 200 and
 * reports the per-user marketing cap asynchronously, seconds later, on this
 * webhook: firstSentAt is already stamped, both lifetime locks are already
 * written, and nothing ever threw. Every 131049 this store has had arrived
 * this way.
 *
 * SO THE ORDER OF WORK HERE IS THE HIGHEST-CONSEQUENCE THING IN THE FEATURE.
 * The offer is once per person EVER. A `failed` status means the customer
 * received NOTHING, so both locks and the marketing cap go back BEFORE
 * anything is parked or emailed. Leaving them would burn that customer
 * permanently over a message they never saw, and "ever" has no expiry to wait
 * out.
 */
export async function onSubStatus(customerId, st, now = new Date(), deps = null) {
  const status = st?.status;
  const rec = await getSubRec(customerId);
  if (!rec) return;
  const fields = { lastStatus: status, lastStatusAt: now.toISOString() };
  if (status === 'failed') {
    fields.deliveryFailed = true;
    fields.deliveryError = st?.errors?.[0]?.code || null;
  }
  await patchSubRec(customerId, fields);
  if (status !== 'failed') return;

  log.warn('subscriber: the offer was accepted and then failed, giving the locks back', { customerId });
  if (rec.phone) {
    await releasePhoneOfferLock(rec.phone);
    await soft('subscriberClearMarketing', () => clearMarketing(rec.phone), { customerId });
  }
  if (rec.emailKey) await releaseEmailOfferLock(rec.emailKey);
  metric('SubscriberDeliveryFailed', 1);

  const code = Number(fields.deliveryError);
  const endsAt = rec.codeEndsAt ? new Date(rec.codeEndsAt) : null;
  const live = endsAt && endsAt.getTime() > now.getTime();
  if (isWindowDeliverable(code) && rec.phone && live) {
    await soft('subscriberParkOnStatus', () => parkSubForWindow(rec.phone, customerId, endsAt, now), { customerId });
    metric('SubscriberParkedForWindow', 1);
  }
  /*
   * The offer is only a day long, so the email goes now rather than waiting on
   * a service window that may never open. It needs the customer's own details
   * and the best sellers again, which is why this path needs clients at all.
   */
  if (!live || !deps?.clients?.email) return;
  await soft('subscriberStatusFallback', async () => {
    const n = normalizeCustomer(await deps.clients.shopify.getCustomer(customerId));
    if (!n) return;
    const picks = await bestSellers(deps);
    const vars = subscriberVars({ n, rec, topPicks: topPicks(picks), now, rules: RULES });
    await emailFallback(deps, customerId, n, vars, picks, rec.token, now);
  }, { customerId });
}

/**
 * They tapped "Talk to us".
 *
 * STRICT on ownership. The router's ownsOrder() fails open for an id it has
 * never seen, and a Flow W payload carries a CUSTOMER id, so that gate always
 * passes here: this check is the only thing between a clear-text payload and
 * somebody else's private code.
 */
export async function onTap(customerId, action, phone, deps) {
  if (action !== 'help') return log.info('subscriber: unknown tap action', { action });
  const now = nowOf(deps);
  const rec = await getSubRec(customerId);
  if (!rec || rec.phone !== phone) {
    return log.warn('subscriber: tap from a phone that does not own this offer, ignoring', { customerId });
  }
  await touchInbound(phone, now);

  const closed = rec.codeEndsAt ? new Date(rec.codeEndsAt).getTime() <= now.getTime() : true;
  const n = normalizeCustomer(await deps.clients.shopify.getCustomer(customerId));
  const vars = { customer_name: n?.firstName || 'there', code: rec.code || '', expires_at: '' };
  if (!closed) vars.expires_at = formatExpiresAt(new Date(rec.codeEndsAt), now);

  await sess(deps, phone, closed ? 'subscriber_help_ack_closed' : 'subscriber_help_ack', vars);
  await patchSubRec(customerId, { helpRequestedAt: now.toISOString() });
  /*
   * The alert names neither the code nor the number. The code is the thing
   * being protected and the owner can read it off the admin by customer id,
   * and the last four digits are enough to find a WhatsApp conversation.
   */
  await soft('subscriberHelpAlert', () =>
    ownerAlert(
      deps,
      `customer ${customerId}`,
      `a customer tapped Talk to us on a welcome offer message. Phone ends ${String(phone).slice(-4)}`,
    ), { customerId });
  return { acked: true };
}

/**
 * An order arrived. Did it come from a welcome offer?
 *
 * Keyed off the CODE and not off a phone lock, which is the difference from
 * Flow R: a Flow W candidate has no checkout and may have no phone at all, so
 * the code on the order is the only link back to the record.
 *
 * Runs after Flow A's own orders/create handler and is wrapped in soft() by
 * the router, so nothing here can fail an order confirmation.
 */
export async function onOrderCreated(payload, deps) {
  const now = nowOf(deps);
  const codes = (payload?.discount_codes || []).map((d) => String(d?.code || '').toUpperCase()).filter(Boolean);
  if (!codes.length) return;

  for (const code of codes) {
    const map = await getSubCodeMap(code);
    if (!map?.customerId) continue;
    const customerId = map.customerId;
    const rec = await getSubRec(customerId);
    if (!rec?.firstSentAt) continue;
    if (rec.orderId) return { converted: true, already: true }; // a webhook retry

    const placedAt = new Date(payload.created_at || now);
    const endsAt = new Date(rec.codeEndsAt);
    const graceEnd = new Date(endsAt.getTime() + RULES.cartRecovery.attributionGraceHours * 3600 * 1000);
    // Before the offer went out it cannot have come from the offer, and well
    // after the code closed it is somebody shopping again, not converting.
    if (placedAt.getTime() < new Date(rec.firstSentAt).getTime()) continue;
    if (placedAt.getTime() > graceEnd.getTime()) continue;

    const orderId = String(payload.id);
    /*
     * The order's own total, so the digest can report what the offer earned
     * rather than only how many codes went out. Shopify sends it as a decimal
     * string; toPaise handles both that and a missing field (0), and the
     * digest leaves the figure out of the line when it is 0 rather than
     * printing a confident zero.
     */
    const revenuePaise = toPaise(payload.current_total_price || payload.total_price || 0);
    await setSubOutcome(customerId, 'converted', { orderId, codeUsed: true, revenuePaise, convertedAt: placedAt.toISOString() });
    await patchSubRec(customerId, { orderId, codeUsed: true });
    metric('SubscriberConverted', 1);
    /*
     * The gift was promised in the message, so it is owed: the tag is what
     * tells whoever packs the parcel. cartRecovery.giftTag is reused rather
     * than a second spelling of the same instruction, because the person
     * reading it in the admin is the same person.
     */
    await soft('subscriberTags', () =>
      deps.clients.shopify.tagsAdd(`gid://shopify/Order/${orderId}`, [w().convertedTag, RULES.cartRecovery.giftTag]), { orderId });
    return { converted: true, customerId };
  }
  return undefined;
}

/**
 * The verified phone on an order, for the router.
 *
 * Exported so the router can hand an orders/create payload to this flow
 * without re-deriving it, and so the one spelling of "the number on an order"
 * stays in src/lib/phone.mjs.
 */
export const orderPhone = (payload) => verifiedPhoneFromNoteAttributes(payload?.note_attributes);
