/*
 * send.mjs — shared send helpers for the flow orchestrators: render + dispatch
 * a template or session message, owner alerts, and the order re-fetch.
 */
import { config } from '../config.mjs';
import { normalizeOrder } from '../domain/order.mjs';
import { resolveOrderPhone } from '../lib/phone.mjs';
import { TEMPLATES, LEGACY, NO_PRICE, renderTemplateDef } from '../../messages/templates.mjs';
import { renderSession, SESSION } from '../../messages/session.mjs';
import { log, metric, maskPhone } from '../log.mjs';
import { isUndeliverable, windowOpen } from '../store/phoneProfile.mjs';
import { RULES } from '../../messages/rules.mjs';
import { recordMessage } from '../store/orderState.mjs';
import { table } from '../store/table.mjs';
import { istDayKey } from '../lib/time.mjs';
import { soft } from '../lib/resilience.mjs';

/**
 * Meta errors that mean "this particular template could not be used", as
 * opposed to a problem with the recipient or the account. Every one of these is
 * survivable by sending the previous version instead, so they drive the
 * fallback rather than failing the message.
 *
 *  131052/131053 media could not be downloaded or uploaded (the header image)
 *  132000        parameter count mismatch
 *  132001        template does not exist in this language (new copy, still in review)
 *  132005        hydrated text too long
 *  132007        format character policy violated
 *  132012        parameter format mismatch
 *  132015/132016 template paused or disabled by Meta for quality
 */
const TEMPLATE_UNUSABLE = new Set([131052, 131053, 132000, 132001, 132005, 132007, 132012, 132015, 132016]);

/** True when a send failed because of the template itself, not the recipient. */
export const isTemplateUnusable = (err) => TEMPLATE_UNUSABLE.has(err?.waCode);

/*
 * Meta errors that mean "this RECIPIENT cannot be reached by a marketing
 * template right now", while a free-form message inside an open 24 hour
 * service window still arrives.
 *
 *  131049  the per-user marketing cap, counted across every business that
 *          messages that person. Nothing we send or stop sending moves it.
 *  130472  the number is in Meta's marketing-message experiment. Meta holds
 *          out a small share of numbers to measure incrementality: marketing
 *          templates to them are refused, the send is not billed, retrying
 *          returns the same error, and there is no opt-out and no published
 *          end date.
 *
 * Both are the same fact for us, so both get the same handling: park the offer
 * against the phone and deliver it the moment the customer writes in. 130472
 * was in neither code set until 2026-10-26, when it refused both of that day's
 * Flow W candidates and the generic branch parked nothing. The customer who had
 * no email on file therefore received nothing at all, and nothing would have
 * come back for them: the daily sweep only ever looks at yesterday.
 *
 * This set is NOT the same question as isTemplateUnusable. That one is a fault
 * in our template, fixed by sending a different one; these are facts about the
 * person, fixed only by a different channel or an open window.
 */
const WINDOW_DELIVERABLE = new Set([131049, 130472]);

/**
 * True when Meta refused a marketing template for THIS recipient, but a
 * free-form message inside an open service window would still reach them.
 *
 * Takes the numeric code rather than the error, because half the callers read
 * it off a status webhook where there is no error object at all.
 */
export const isWindowDeliverable = (code) => WINDOW_DELIVERABLE.has(Number(code));

/**
 * The same order intake as getNorm, entered by ORDER NAME.
 *
 * The owner's tools look an order up by the number they typed, so they called
 * getOrderByName and normalizeOrder directly and never reached the 2 Nov
 * recipient resolver below. Orders without COD King's OTP attribute therefore
 * answered "no OTP verified WhatsApp number" to /size-change, and /replace
 * booked both parcels and told nobody, on orders where Flows A, B and C were
 * messaging the customer perfectly well.
 *
 * The extra read only happens for an order with no OTP number, which is the
 * same lazy arrangement getNorm itself documents.
 */
export async function getNormByName(deps, orderName) {
  const o = await deps.clients.shopify.getOrderByName(orderName);
  if (!o) return null;
  const n = normalizeOrder(o);
  if (n.verifiedPhone) {
    n.phoneSource = 'otp';
    return n;
  }
  return (await getNorm(deps, n.numericId)) || n;
}

/*
 * THE ONE ORDER INTAKE. Every order flow reads its order through here, so this
 * is where the recipient is resolved and nowhere else.
 *
 * An order that came through COD King's popup carries the OTP verified number
 * and nothing below runs. An order from a recovery link, a Cashfree checkout
 * straight from the cart, a draft order, the admin or the API carries no OTP
 * attribute at all, and every flow reads ONE field for the recipient, so those
 * customers were dropped by Flows A, B and C alike: no confirmation, no
 * dispatch message, no review ask, no NDR follow-up. See exception 2 in
 * lib/phone.mjs for the owner's decision and its limits.
 *
 * The extra read is lazy, both senses: it only happens for an order with no
 * verified number, and it asks for the phone fields alone.
 */
export async function getNorm(deps, orderId) {
  const o = await deps.clients.shopify.getOrder(orderId);
  if (!o) return null;
  const n = normalizeOrder(o);
  if (n.verifiedPhone) {
    n.phoneSource = 'otp';
    return n;
  }
  n.phoneSource = null;
  // A client without the method (an older fake) must not break the flows.
  if (typeof deps.clients.shopify.getOrderPhones !== 'function') return n;

  const p = await soft('getOrderPhones', () => deps.clients.shopify.getOrderPhones(orderId), { orderId });
  if (!p) return n;
  const r = resolveOrderPhone({ otp: null, order: p.order, shipping: p.shipping, billing: p.billing, customer: p.customer });
  if (!r.phone) {
    log.warn('order intake: no recipient on this order', {
      orderId,
      reason: p.scopeProblem ? 'phone-scope-denied' : 'no-usable-phone',
      tried: r.tried.join(',') || 'none',
    });
    metric('OrderNoRecipient', 1, { reason: p.scopeProblem ? 'scope' : 'invalid' });
    return n;
  }
  n.verifiedPhone = r.phone;
  n.phoneSource = r.source;
  log.info('order intake: recipient resolved without an OTP number', {
    orderId,
    source: r.source,
    phone: maskPhone(r.phone),
  });
  metric('OrderPhoneFallback', 1, { source: r.source });
  return n;
}

/*
 * Send one rendered template and log it against the order.
 *
 * The logging is HERE, and not at the call sites, because it is what makes a
 * delivery failure recoverable and a call site cannot be trusted to remember.
 * Meta accepts a template with a 200 and reports the failure seconds later on a
 * status webhook carrying the wamid and nothing else, so onWaStatus can only
 * find the order through the reverse map recordMessage writes. No map means no
 * order: no wa-undeliverable tag for the owner to filter on and no owner alert.
 *
 * Three of the thirteen template send sites called recordMessage. The other ten
 * sent real customer messages that no status webhook could trace back, and
 * order #1230 paid for it on 2026-10-27: the prepaid fallback carrying a 1,999
 * rupee payment link was refused with 131049 thirteen seconds after Meta
 * accepted it, onWaStatus resolved no order and returned, and the order shipped
 * COD unconfirmed with nobody aware the offer had never arrived.
 *
 * ctx.orderId is the marker, which twelve of the thirteen sites already passed
 * for other reasons. A send without one is Flow W's or Flow R's: those write
 * their own map against a customerId or a cartId, and an ORDER# row for them
 * would point this handler at an order that does not exist.
 */
async function dispatch(deps, phone, def, vars, ctx, key) {
  const t = renderTemplateDef(def, vars, ctx);
  const res = await deps.clients.whatsapp.sendTemplate({
    to: phone,
    name: t.name,
    language: t.language,
    components: t.components,
  });
  // The template recorded is the one Meta accepted, not the one first asked
  // for: a fallback send means the customer holds a different version, and the
  // row an owner reads has to name the message that actually arrived.
  // soft, because the customer already has it. A throw here would redeliver the
  // SQS record and send a second copy over a bookkeeping failure.
  if (ctx.orderId && res?.messageId) {
    await soft(
      'recordMessage',
      () => recordMessage(ctx.orderId, res.messageId, { key, template: t.name }),
      { orderId: ctx.orderId },
    );
  }
  return { ...res, templateName: t.name };
}

/**
 * Send a template by registry key, falling back to its LEGACY version when the
 * current one cannot be used.
 *
 * This is what makes new copy safe to deploy. A renamed template is rejected by
 * Meta until a human reviewer approves it, which takes hours, so deploying new
 * copy without this would silently break every order confirmation in between.
 * Callers pass the union of both versions' placeholders; renderTemplateDef
 * ignores the ones its version does not use.
 *
 * @returns {Promise<{messageId?:string, skipped?:string, templateName:string}>}
 */
export async function tpl(deps, phone, key, vars, ctx = {}) {
  const primary = TEMPLATES[key];
  if (!primary) throw new Error(`unknown template: ${key}`);

  // Meta tells us once, with error 131026, that a number cannot receive
  // WhatsApp. setUndeliverable recorded that and NOTHING ever read it, so the
  // same dead number kept getting every confirmation, reminder and marketing
  // nudge for every future order. Each one is billed and each one drags the
  // number's quality rating down, which is what 131049 throttling is made of.
  // Owner alert numbers are exempt: losing those silently is how the dead
  // worker went unnoticed for ten hours.
  if (!config.ownerAlertPhones.includes(phone) && (await isUndeliverable(phone))) {
    log.info('template: recipient is undeliverable, not sending', { key, phone: maskPhone(phone) });
    metric('SendSkippedUndeliverable', 1, { key });
    return { skipped: 'undeliverable', templateName: primary.name };
  }

  const fallback = LEGACY[key] || null;

  /*
   * THE FALLBACK SLOT HAS TWO DIFFERENT JOBS, and they want opposite answers.
   *
   *   no price to quote (ctx.preferLegacy), or no product photo (noImage)
   *     -> NO_PRICE, the version that quotes one total and no prepaid price.
   *   the current version is unusable, e.g. new copy still in Meta review
   *     -> LEGACY, the previous APPROVED version, which keeps the prices.
   *
   * A single slot used to serve both, which was fine only while they happened
   * to be the same template. The moment cod_confirm_v3 entered review, sharing
   * one slot would have meant either dropping the prepaid price from every
   * confirmation for hours, or quoting a price we could not honour.
   *
   * noImage takes NO_PRICE because that is the only cod_confirm version without
   * an IMAGE header: falling back to LEGACY (v2) would still have one and still
   * fail. This reproduces today's behaviour exactly.
   */
  const noImage = primary.header?.format === 'IMAGE' && !ctx.imageUrl;
  if (noImage || ctx.preferLegacy) {
    const priceless = NO_PRICE[key] || fallback;
    if (!priceless) {
      if (noImage) throw new Error(`template ${key} needs ctx.imageUrl and has no fallback`);
    } else {
      log.info('template: using the price-free version', { key, name: priceless.name, noImage: Boolean(noImage) });
      return dispatch(deps, phone, priceless, vars, ctx, key);
    }
  }

  try {
    return await dispatch(deps, phone, primary, vars, ctx, key);
  } catch (e) {
    if (!fallback || !TEMPLATE_UNUSABLE.has(e.waCode)) throw e;
    log.warn('template unusable, sending previous version', {
      key,
      name: primary.name,
      waCode: e.waCode,
      fallback: fallback.name,
    });
    metric('TemplateFallback', 1, { key });
    return dispatch(deps, phone, fallback, vars, ctx, key);
  }
}

export async function sess(deps, phone, key, vars, ctx = {}) {
  const r = renderSession(key, vars, ctx);
  const wa = deps.clients.whatsapp;
  if (r.type === 'text') return wa.sendText({ to: phone, body: r.body });
  if (r.type === 'buttons') return wa.sendButtons({ to: phone, body: r.body, buttons: r.buttons });
  if (r.type === 'cta_url') return wa.sendCtaUrl({ to: phone, body: r.body, buttonText: r.buttonText, url: r.url });
  // Without this line a 'list' would render and then be dropped by the
  // `return null` below, which is exactly what happens to 'html' today.
  if (r.type === 'list') return wa.sendList({ to: phone, body: r.body, buttonText: r.buttonText, rows: r.rows });
  return null;
}

/*
 * Since 1 Oct 2026 Meta bills a UTILITY template even inside the customer's
 * 24 hour window, and gives each number 1,000 free SERVICE (free-form)
 * messages a month before charging the utility rate for those too. So a
 * free-form message in an open window is free, and the template beside it is
 * not, for identical words.
 *
 * The counter is per IST month on one row, incremented atomically because the
 * queue serialises by order and not by month. 900 is a warning and not a stop:
 * past 1,000 a session message costs the same as the utility template it
 * replaced, so there is nothing to gain by going back to templates, and
 * stopping would cost the customer the message.
 */
const SERVICE_FREE_PER_MONTH = 1000;
const SERVICE_WARN_AT = 900;

async function countServiceSend(deps, phone, now) {
  const month = istDayKey(now).slice(0, 7);
  const n = await table.addCount(`WACOUNT#${month}`, 'SERVICE', 'count', 1, {
    month,
    expiresAt: Math.floor(now.getTime() / 1000) + 400 * 86400,
  });
  if (n === SERVICE_WARN_AT) {
    await soft('serviceAllowanceAlert', () =>
      ownerAlert(deps, 'WhatsApp', `${n} of the ${SERVICE_FREE_PER_MONTH} free service messages used this month. Past that they cost the utility rate`), {});
  }
  return n;
}

/**
 * The cheapest message that will actually arrive.
 *
 * Window open and a `<key>_session` twin exists: free-form, free. Otherwise the
 * template. On 131047 (the window shut between our check and the send) it falls
 * back to the template once, which is the whole reason the check being slightly
 * stale is safe.
 *
 * A key with no twin falls through to the template silently, so making a key
 * free in-window is one entry in messages/session.mjs and nothing else.
 *
 * cod_confirm deliberately does NOT route through here: it goes out three
 * minutes after the order, when the customer has almost never written to us, so
 * the window is shut and the check would be a wasted read on every order.
 */
export async function sendBest(deps, phone, key, vars, ctx = {}) {
  const now = ctx.now || new Date();
  const twin = `${key}_session`;
  if (SESSION[twin] && (await windowOpen(phone, now, RULES.windowSafetyMinutes))) {
    try {
      if (await isUndeliverable(phone)) {
        metric('SendSkippedUndeliverable', 1, { key });
        return { skipped: 'undeliverable', templateName: `session:${key}` };
      }
      const r = await sess(deps, phone, twin, vars, ctx);
      await soft('countServiceSend', () => countServiceSend(deps, phone, now), {});
      metric('SessionInsteadOfTemplate', 1, { key });
      return { ...r, templateName: `session:${key}` };
    } catch (e) {
      // 131047: re-engagement required, i.e. the window closed under us. Any
      // other failure is the session channel's own and the template is still
      // worth trying, because the alternative is the customer hearing nothing.
      log.warn('session send failed, falling back to the template', { key, waCode: e.waCode, err: e.message });
    }
  }
  return tpl(deps, phone, key, vars, ctx);
}

/**
 * Tell the owner something needs attention. NEVER throws.
 *
 * This is usually called right after an irreversible step (a refund, a cancel),
 * so letting it throw would redeliver the record and repeat that step. An
 * unreachable owner must never cost a customer money.
 */
export async function ownerAlert(deps, orderName, alertText) {
  for (const phone of config.ownerAlertPhones) {
    await soft('ownerAlert', () => ownerSend(deps, phone, 'ops_alert', { order_number: orderName, alert_text: alertText }), {
      orderName,
      alertText,
    });
  }
}

/**
 * One owner message, by whichever channel actually arrives.
 *
 * Free inside their 24 hour window, billed outside it. ops_alert and ops_error
 * are UTILITY and, since 1 Oct 2026, are billed even when the window IS open,
 * so the session twin is a straight saving and says exactly the same words.
 *
 * AN ALERT ALWAYS GOES. If the window is shut the template is sent, billed,
 * because an alert that waits for a window is not an alert. The digest is the
 * one that may fall back to email instead (see timers/digest.mjs).
 *
 * The twin carries a "Got it" button, and that is the mechanism rather than a
 * courtesy: a tap reopens the window, so tomorrow's messages are free too.
 *
 * `digestChannel: 'template'` restores the old behaviour for both.
 */
export async function ownerSend(deps, phone, key, vars) {
  if (RULES.digestChannel !== 'template' && (await windowOpen(phone, new Date(), RULES.windowSafetyMinutes))) {
    /*
     * ctx.orderId is what encodePayload puts in the button id, and an owner
     * message is not about one order. A literal keeps 'undefined' out of the
     * payload and gives the router's O branch something readable to log.
     */
    const r = await sess(deps, phone, `${key}_session`, vars, { orderId: 'owner' });
    if (r) {
      metric('OwnerSessionSend', 1, { key });
      return r;
    }
    // No twin for this key: fall through to the template rather than go silent.
  }
  return tpl(deps, phone, key, vars, {});
}
