/*
 * send.mjs — shared send helpers for the flow orchestrators: render + dispatch
 * a template or session message, owner alerts, and the order re-fetch.
 */
import { config } from '../config.mjs';
import { normalizeOrder } from '../domain/order.mjs';
import { TEMPLATES, LEGACY, renderTemplateDef } from '../../messages/templates.mjs';
import { renderSession } from '../../messages/session.mjs';
import { log, metric } from '../log.mjs';

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
  const fallback = LEGACY[key] || null;

  // A template with an image header cannot be sent without an image, so a
  // product with no photo takes the image-free version rather than no message.
  const noImage = primary.header?.format === 'IMAGE' && !ctx.imageUrl;
  if (noImage || ctx.preferLegacy) {
    if (!fallback) {
      if (noImage) throw new Error(`template ${key} needs ctx.imageUrl and has no fallback`);
    } else {
      log.info('template: using the previous version', { key, name: fallback.name, noImage: Boolean(noImage) });
      return dispatch(deps, phone, fallback, vars, ctx);
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
  return null;
}

export async function ownerAlert(deps, orderName, alertText) {
  for (const phone of config.ownerAlertPhones) {
    await tpl(deps, phone, 'ops_alert', { order_number: orderName, alert_text: alertText }, {});
  }
}
