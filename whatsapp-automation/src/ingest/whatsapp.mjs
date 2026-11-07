/*
 * ingest/whatsapp.mjs — WhatsApp Cloud API webhooks.
 *
 * GET: hub.challenge verification. POST: inbound messages + delivery statuses.
 * Dedupe per message id (inbound) and per id+status (statuses). Inbound that
 * carries a button/flow payload maps to an order; otherwise it groups by phone.
 * Deep parsing of taps happens in the worker; here we only route + dedupe.
 */
import { makeIngest, resp } from './base.mjs';
import { verifyWhatsApp, safeEqual } from '../lib/signature.mjs';
import { decodePayload } from '../lib/ids.mjs';
import { waStatusActionable } from '../domain/actionable.mjs';
import { metric } from '../log.mjs';

function challenge(event, secrets) {
  const q = event.queryStringParameters || {};
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const chal = q['hub.challenge'];
  if (mode === 'subscribe' && safeEqual(token, secrets.waVerifyToken)) return resp(200, String(chal ?? ''));
  return resp(403, 'forbidden');
}

/** Inbound message -> order group (button/flow payload) or phone group. */
function routeInbound(m) {
  if (m.type === 'button' && m.button?.payload) {
    const p = decodePayload(m.button.payload);
    if (p) return { groupId: `order:${p.orderId}` };
  }
  if (m.type === 'interactive' && m.interactive?.button_reply?.id) {
    const p = decodePayload(m.interactive.button_reply.id);
    if (p) return { groupId: `order:${p.orderId}` };
  }
  // A list reply groups by order exactly as a button does. Without this the
  // variant-change taps would land on the phone group, so a pick and the
  // confirm that follows it could be processed out of order or in parallel,
  // and FIFO per-order serialization is what holds the order edit together.
  if (m.type === 'interactive' && m.interactive?.list_reply?.id) {
    const p = decodePayload(m.interactive.list_reply.id);
    if (p) return { groupId: `order:${p.orderId}` };
  }
  return { groupId: `phone:+${m.from}` }; // from is e164 without '+'
}

export const whatsappIngest = {
  name: 'whatsapp',
  verifyGet: challenge,
  verify: (raw, h, s) => verifyWhatsApp(raw, h['x-hub-signature-256'], s.waAppSecret),
  toItems(_h, body) {
    const items = [];
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        for (const m of v.messages || []) {
          const { groupId } = routeInbound(m);
          items.push({
            message: { kind: 'wa_inbound', from: `+${m.from}`, msg: m },
            groupId,
            dedupId: `wa-msg-${m.id}`,
          });
        }
        for (const st of v.statuses || []) {
          /*
           * `sent` and `read` are read by NOTHING: no code anywhere branches on
           * either, and they were roughly half of this function's 4,343 runs in
           * 30 days. Each one cost a dedupe write, an SQS message, a worker run
           * and a WAMID read to reach a `return`.
           */
          if (!waStatusActionable(st?.status)) {
            metric('IngestSkipped', 1, { provider: 'whatsapp' });
            continue;
          }
          items.push({
            message: { kind: 'wa_status', status: st },
            groupId: `phone:+${st.recipient_id}`,
            dedupId: `wa-status-${st.id}-${st.status}`,
          });
        }
        // Meta tells us the moment it rejects, pauses or disables a template.
        // Only `messages` and `statuses` were read, so every one of these was
        // acked and thrown away: a template could be paused for quality and the
        // first anyone would know is customers not being messaged. order_shipped
        // has no fallback version, so for that one a pause is a silent outage.
        if (ch.field === 'message_template_status_update') {
          items.push({
            message: {
              kind: 'wa_template_status',
              name: v.message_template_name,
              language: v.message_template_language,
              event: v.event,
              reason: v.reason || v.other_info?.title || null,
            },
            groupId: `template:${v.message_template_name || 'unknown'}`,
            dedupId: `wa-tpl-${v.message_template_name}-${v.event}-${entry.time || ''}`,
          });
        }
      }
    }
    return items;
  },
};

export const handler = makeIngest(whatsappIngest);
