/*
 * clients/whatsapp.mjs — Meta WhatsApp Cloud API (direct, no BSP).
 *
 * Send primitives only (template + the session types). Message assembly
 * (component shapes, copy) lives in messages/ (Phase 4). Every send is gated by
 * DRY_RUN and SEND_ALLOWLIST so nothing reaches a real customer until both the
 * flag is flipped and (during testing) the number is allowlisted.
 *
 * Interface (the fake in fakes/whatsapp.mjs implements the same shape):
 *   sendTemplate({ to, name, language, components }) -> { messageId, skipped? }
 *   sendText({ to, body })
 *   sendButtons({ to, body, buttons:[{id,title}] })
 *   sendCtaUrl({ to, body, buttonText, url })
 *   sendList({ to, body, buttonText, rows:[{id,title,description?}] })
 *   sendFlow({ to, body, flowId, flowToken, flowCta, flowActionData })
 */
import { config } from '../config.mjs';
import { getSecrets } from '../secrets.mjs';
import { log, maskPhone, metric } from '../log.mjs';
import { withRetry } from '../lib/resilience.mjs';

/** @returns {string|null} a skip reason, or null when sending is allowed */
function guard(to) {
  if (config.dryRun) return 'dry_run';
  if (config.sendAllowlist.length && !config.sendAllowlist.includes(to)) return 'not_allowlisted';
  return null;
}

async function post(to, payload) {
  const skip = guard(to);
  if (skip) {
    log.info('wa send skipped', { phone: to, skip, type: payload.type });
    return { messageId: `${skip}:dry`, skipped: skip };
  }
  const s = await getSecrets();
  const url = `https://graph.facebook.com/${config.graphVersion}/${s.waPhoneNumberId}/messages`;
  // NOT idempotent: a retry after an unknown outcome could send the customer a
  // second copy. Only a refusal Meta never processed (429/503, DNS, refused
  // connection) is retried.
  return withRetry('whatsapp.send', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.waAccessToken}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), ...payload }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`wa send failed (${payload.type}): ${json.error?.message || res.status}`);
      err.waCode = json.error?.code; // 131047, 131049, 131026, ... handled by the worker
      err.status = res.status;
      throw err;
    }
    metric('MessageSent', 1, { type: payload.type });
    return { messageId: json.messages?.[0]?.id, raw: json };
  });
}

export const whatsapp = {
  sendTemplate: ({ to, name, language = 'en', components }) =>
    post(to, { type: 'template', template: { name, language: { code: language }, ...(components ? { components } : {}) } }),

  sendText: ({ to, body }) => post(to, { type: 'text', text: { body, preview_url: false } }),

  sendButtons: ({ to, body, buttons }) =>
    post(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    }),

  /*
   * An interactive list. Meta's caps, from the Cloud API docs: at most 10 rows
   * for ALL sections COMBINED (not 10 per section - the widely repeated "10
   * sections x 10 rows = 100" is wrong), row title 24 chars, row description
   * 72, row id 200, list button text 20, body 4096. One section is all we need,
   * and the caller is responsible for staying inside the row cap; the registry
   * test enforces it for anything that lives in messages/.
   */
  sendList: ({ to, body, buttonText, rows }) =>
    post(to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonText,
          sections: [
            {
              rows: rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            },
          ],
        },
      },
    }),

  sendCtaUrl: ({ to, body, buttonText, url }) =>
    post(to, {
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: body },
        action: { name: 'cta_url', parameters: { display_text: buttonText, url } },
      },
    }),

  sendFlow: ({ to, body, flowId, flowToken, flowCta, flowActionData }) =>
    post(to, {
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: body },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: flowId,
            flow_token: flowToken,
            flow_cta: flowCta,
            flow_action: 'navigate',
            flow_action_payload: flowActionData ? { screen: 'RATE', data: flowActionData } : undefined,
          },
        },
      },
    }),
};

export { maskPhone };
