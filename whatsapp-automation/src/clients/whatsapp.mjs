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
 *   uploadMedia({ bytes, filename, mime }) -> { mediaId, skipped? }
 *   sendDocument({ to, mediaId, link, filename, caption }) -> { messageId, skipped? }
 */
import { config } from '../config.mjs';
import { getSecrets } from '../secrets.mjs';
import { log, maskPhone, metric } from '../log.mjs';
import { withRetry } from '../lib/resilience.mjs';

/**
 * The send gate, asked as a question. A caller that spends something before it
 * sends (Flow R creates a single-use Shopify code first) needs to know the
 * send is going to be dropped BEFORE it spends, or every dropped send leaves
 * an orphan behind it.
 * @returns {string|null} a skip reason, or null when sending is allowed
 */
export function sendSkipReason(to) {
  return guard(to);
}

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
    const messageId = json.messages?.[0]?.id;
    /*
     * Meta has always returned messages[0].id on a 2xx, and this has never been
     * seen. It is logged rather than thrown deliberately: a throw would
     * redeliver the SQS record and risk a second copy of a message Meta may
     * genuinely have accepted, which is the worse failure.
     *
     * It is logged at all because without a wamid there is no reverse map, so
     * a later delivery failure could not be traced back to the order, which is
     * exactly the silent failure dispatch() in worker/send.mjs now exists to
     * close. If this ever fires, that is the hole reopening by another door.
     */
    if (!messageId) log.warn('wa send: 2xx with no message id', { type: payload.type });
    return { messageId, raw: json };
  });
}

export const whatsapp = {
  sendSkipReason,

  /*
   * Every template on the WABA, as { name: status }.
   *
   * A READ, so it deliberately skips guard(): dryRun and the send allowlist are
   * about not messaging people, and asking Meta which templates exist messages
   * nobody. Gating it on dryRun would have made the one check that catches an
   * unapproved template go quiet in exactly the configuration used to rehearse.
   *
   * This exists because nothing in the service knew a template's real status.
   * replacement_raised_v1 was written, tested, deployed and reported as done
   * while it had never been submitted to Meta at all, and a template that is
   * missing, PENDING or REJECTED is a customer who is silently never told.
   */
  listTemplates: async () => {
    const s = await getSecrets();
    /** @type {Record<string,string>} */
    const out = {};
    let url = `https://graph.facebook.com/${config.graphVersion}/${s.waWabaId}/message_templates?fields=name,status&limit=200`;
    // Paged, because a WABA past 200 templates would otherwise report the tail
    // of the registry as missing and cry wolf every morning.
    while (url) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${s.waAccessToken}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`listTemplates ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
      for (const t of json.data || []) out[t.name] = t.status;
      url = json.paging?.next || null;
    }
    return out;
  },

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

  /*
   * Put a file on Meta's servers and get back the id a document message points
   * at. Needed because the P&L report is an .xlsx the owner has to open, and a
   * WhatsApp document message carries either a media id or a public link. We
   * have no public host for it (the S3 bucket is private, by design), so the
   * id is the only route.
   *
   * This is a write, so it honours DRY_RUN like every other write. It has no
   * recipient, though, so it cannot honour the send allowlist: guard() asks
   * about a phone and there is not one yet. That is safe because an upload
   * messages nobody; the allowlist still gates sendDocument below, which is
   * the call that actually reaches a person.
   *
   * Retried as idempotent: a retry after an unknown outcome leaves a second
   * unreferenced media object on Meta (they expire in 30 days) and sends
   * nothing, which is the cheap failure. The expensive one would be giving up
   * and reporting the month as undeliverable.
   */
  uploadMedia: async ({ bytes, filename, mime }) => {
    if (config.dryRun) {
      log.info('wa media upload skipped', { skip: 'dry_run', filename, bytes: bytes?.length ?? 0 });
      return { mediaId: 'dry_run:media', skipped: 'dry_run' };
    }
    const s = await getSecrets();
    const url = `https://graph.facebook.com/${config.graphVersion}/${s.waPhoneNumberId}/media`;
    return withRetry(
      'whatsapp.uploadMedia',
      async () => {
        // FormData and Blob are globals on Node 18+, so this needs no
        // dependency and no hand-rolled multipart boundary. Do NOT set
        // Content-Type by hand: fetch has to add the boundary itself.
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', mime);
        form.append('file', new Blob([bytes], { type: mime }), filename);
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${s.waAccessToken}` },
          body: form,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.id) {
          const err = new Error(`wa media upload failed: ${json.error?.message || res.status}`);
          err.waCode = json.error?.code;
          err.status = res.status;
          throw err;
        }
        metric('MediaUploaded', 1);
        return { mediaId: String(json.id) };
      },
      { idempotent: true },
    );
  },

  /*
   * A document message. `mediaId` is what uploadMedia returned; `link` is the
   * alternative Meta accepts, kept for a future public host.
   *
   * Free-form, so it only reaches the owner inside an open 24 hour window. A
   * scheduled run at 09:00 has no window open, which is why the scheduled path
   * emails the file and only a template with a document header can carry it
   * unprompted. The caller decides; this is a primitive.
   */
  sendDocument: ({ to, mediaId, link, filename, caption }) =>
    post(to, {
      type: 'document',
      document: {
        ...(mediaId ? { id: mediaId } : { link }),
        ...(filename ? { filename } : {}),
        ...(caption ? { caption } : {}),
      },
    }),
};

export { maskPhone };
