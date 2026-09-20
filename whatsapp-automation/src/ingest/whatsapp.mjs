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
          items.push({
            message: { kind: 'wa_status', status: st },
            groupId: `phone:+${st.recipient_id}`,
            dedupId: `wa-status-${st.id}-${st.status}`,
          });
        }
      }
    }
    return items;
  },
};

export const handler = makeIngest(whatsappIngest);
