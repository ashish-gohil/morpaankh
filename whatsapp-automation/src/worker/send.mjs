/*
 * send.mjs — shared send helpers for the flow orchestrators: render + dispatch
 * a template or session message, owner alerts, and the order re-fetch.
 */
import { config } from '../config.mjs';
import { normalizeOrder } from '../domain/order.mjs';
import { TEMPLATES, LEGACY, NO_PRICE, renderTemplateDef } from '../../messages/templates.mjs';
import { renderSession } from '../../messages/session.mjs';
import { log, metric, maskPhone } from '../log.mjs';
import { isUndeliverable } from '../store/phoneProfile.mjs';
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

export async function getNorm(deps, orderId) {
  const o = await deps.clients.shopify.getOrder(orderId);
  return o ? normalizeOrder(o) : null;
}

async function dispatch(deps, phone, def, vars, ctx) {
  const t = renderTemplateDef(def, vars, ctx);
  const res = await deps.clients.whatsapp.sendTemplate({
    to: phone,
    name: t.name,
    language: t.language,
    components: t.components,
  });
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
      return dispatch(deps, phone, priceless, vars, ctx);
    }
  }

  try {
    return await dispatch(deps, phone, primary, vars, ctx);
  } catch (e) {
    if (!fallback || !TEMPLATE_UNUSABLE.has(e.waCode)) throw e;
    log.warn('template unusable, sending previous version', {
      key,
      name: primary.name,
      waCode: e.waCode,
      fallback: fallback.name,
    });
    metric('TemplateFallback', 1, { key });
    return dispatch(deps, phone, fallback, vars, ctx);
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

/**
 * Tell the owner something needs attention. NEVER throws.
 *
 * This is usually called right after an irreversible step (a refund, a cancel),
 * so letting it throw would redeliver the record and repeat that step. An
 * unreachable owner must never cost a customer money.
 */
export async function ownerAlert(deps, orderName, alertText) {
  for (const phone of config.ownerAlertPhones) {
    await soft('ownerAlert', () => tpl(deps, phone, 'ops_alert', { order_number: orderName, alert_text: alertText }, {}), {
      orderName,
      alertText,
    });
  }
}
