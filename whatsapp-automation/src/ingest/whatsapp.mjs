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
        /*
         * N2. THE OWNER'S OWN REPLIES, ECHOED BACK.
         *
         * This number is in COEXISTENCE mode: the owner answers customers from
         * the WhatsApp Business app on their phone, and those messages are not
         * inbound to us, so until now the service could not see them at all. It
         * would happily drop a template into the middle of a conversation
         * somebody was having by hand.
         *
         * An echo's `to` is the CUSTOMER, which is the opposite of an inbound
         * message's `from`, and getting that backwards would put the owner's own
         * number into takeover and silence the whole service.
         *
         * NOT counted as inbound. It opens no 24 hour window, clears no
         * opt-out, and triggers no reply: the customer did not write to us, our
         * own colleague did, and treating it as a window would let a template
         * go out on the strength of our own message.
         */
        for (const echo of v.message_echoes || []) {
          const to = echo?.to;
          if (!to) continue;
          items.push({
            message: { kind: 'wa_echo', to: `+${String(to).replace(/^\+/, '')}`, at: echo.timestamp || null },
            groupId: `phone:+${String(to).replace(/^\+/, '')}`,
            dedupId: `wa-echo-${echo.id || `${to}-${echo.timestamp || ''}`}`,
          });
        }

        // Meta tells us the moment it rejects, pauses or disables a template.
        // Only `messages` and `statuses` were read, so every one of these was
        // acked and thrown away: a template could be paused for quality and the
        // first anyone would know is customers not being messaged. order_shipped
        // has no fallback version, so for that one a pause is a silent outage.
        /*
         * N10. The four Meta fields that change what this service can do, and
         * said nothing when they changed.
         *
         * Each gets its own kind and its own group, because they are about
         * different things: a template, the phone number, or one customer's
         * preference. The PAYLOAD SHAPES ARE READ DEFENSIVELY, with every
         * field optional: this code has not seen a live one of any of them, and
         * an ack-and-ignore is better than an exception on a webhook that also
         * carries messages.
         */
        if (ch.field === 'template_category_update') {
          items.push({
            message: {
              kind: 'wa_template_category',
              name: v.message_template_name || v.message_template_id || null,
              from: v.previous_category || null,
              to: v.new_category || v.correct_category || null,
            },
            groupId: `template:${v.message_template_name || 'unknown'}`,
            dedupId: `wa-cat-${v.message_template_name}-${v.new_category || v.correct_category}-${entry.time || ''}`,
          });
        }
        if (ch.field === 'message_template_quality_update') {
          items.push({
            message: {
              kind: 'wa_template_quality',
              name: v.message_template_name || null,
              score: v.new_quality_score || null,
              previous: v.previous_quality_score || null,
            },
            groupId: `template:${v.message_template_name || 'unknown'}`,
            dedupId: `wa-q-${v.message_template_name}-${v.new_quality_score}-${entry.time || ''}`,
          });
        }
        if (ch.field === 'phone_number_quality_update') {
          items.push({
            message: {
              kind: 'wa_phone_quality',
              display: v.display_phone_number || null,
              event: v.event || null,
              limit: v.current_limit || null,
            },
            groupId: 'waba:phone',
            dedupId: `wa-pq-${v.event}-${v.current_limit}-${entry.time || ''}`,
          });
        }
        /*
         * A customer turning marketing off INSIDE WhatsApp. They never sent us
         * STOP, so nothing in this service knew, and we would keep sending
         * marketing templates Meta then refuses. Grouped by phone, like every
         * other per-person event, so it cannot overtake a send to them.
         */
        for (const pref of v.user_preferences || []) {
          if (!pref?.wa_id) continue;
          items.push({
            message: {
              kind: 'wa_user_preference',
              from: `+${String(pref.wa_id).replace(/^\+/, '')}`,
              category: pref.category || 'marketing',
              value: pref.value || null,
              at: pref.timestamp || null,
            },
            groupId: `phone:+${String(pref.wa_id).replace(/^\+/, '')}`,
            dedupId: `wa-pref-${pref.wa_id}-${pref.value}-${pref.timestamp || entry.time || ''}`,
          });
        }

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
