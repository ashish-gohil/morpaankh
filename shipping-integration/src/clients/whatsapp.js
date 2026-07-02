'use strict';

/**
 * Meta WhatsApp Cloud API client (direct, no BSP middleman).
 * Sends pre-approved message templates only — free-form messages are not
 * possible outside a 24h customer-service window, and every template must be
 * approved in Meta Business Manager first (see docs/whatsapp-templates.md).
 */
const config = require('../config');

/**
 * Normalize an Indian phone number to WhatsApp's E.164-without-plus format
 * ("91XXXXXXXXXX"). Returns null when the number can't be normalized, so
 * callers can skip rather than send to a mangled number.
 */
function normalizeIndianPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return digits;
  }
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1))) {
    return `91${digits.slice(1)}`;
  }
  return null;
}

/**
 * Send an approved template message.
 * @param {object} opts
 * @param {string} opts.to           Raw phone number (any common Indian format)
 * @param {string} opts.template     Approved template name
 * @param {string[]} [opts.bodyParams]     Positional {{1}}, {{2}}… body values
 * @param {string} [opts.urlButtonParam]   Value for a dynamic-URL button suffix
 * @param {boolean} [opts.dryRun]
 * @returns {{sent: boolean, skipped?: string, to?: string, messageId?: string}}
 */
async function sendTemplate({ to, template, bodyParams = [], urlButtonParam, dryRun = false }) {
  const wa = config.whatsapp;
  if (!wa.enabled) return { sent: false, skipped: 'whatsapp disabled' };
  if (!wa.phoneNumberId || !wa.accessToken) {
    return { sent: false, skipped: 'whatsapp credentials missing' };
  }

  const phone = normalizeIndianPhone(to);
  if (!phone) return { sent: false, skipped: `unusable phone: ${to || '(empty)'}` };
  if (dryRun) return { sent: false, skipped: 'dry run', to: phone };

  const components = [];
  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })),
    });
  }
  if (urlButtonParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(urlButtonParam) }],
    });
  }

  const res = await fetch(
    `https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wa.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: template,
          language: { code: wa.languageCode },
          ...(components.length ? { components } : {}),
        },
      }),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error ? json.error.message : `HTTP ${res.status}`;
    throw new Error(`WhatsApp send failed (${template} -> ${phone}): ${detail}`);
  }
  return { sent: true, to: phone, messageId: (json.messages || [])[0]?.id };
}

module.exports = { sendTemplate, normalizeIndianPhone };
