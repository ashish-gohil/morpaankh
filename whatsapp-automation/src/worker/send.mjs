/*
 * send.mjs — shared send helpers for the flow orchestrators: render + dispatch
 * a template or session message, owner alerts, and the order re-fetch.
 */
import { config } from '../config.mjs';
import { normalizeOrder } from '../domain/order.mjs';
import { renderTemplate } from '../../messages/templates.mjs';
import { renderSession } from '../../messages/session.mjs';

export async function getNorm(deps, orderId) {
  const o = await deps.clients.shopify.getOrder(orderId);
  return o ? normalizeOrder(o) : null;
}

export async function tpl(deps, phone, key, vars, ctx) {
  const t = renderTemplate(key, vars, ctx);
  return deps.clients.whatsapp.sendTemplate({ to: phone, name: t.name, language: t.language, components: t.components });
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
