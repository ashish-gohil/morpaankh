'use strict';

/**
 * Brevo transactional email client (free tier: 300 emails/day).
 * Used only for automation emails the theme/Shopify can't send natively.
 * Sender domain (morpaankh.in) must be verified in Brevo with SPF + DKIM
 * before deliverability is usable.
 */
const config = require('../config');

/**
 * Send one transactional email.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} [opts.toName]
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {boolean} [opts.dryRun]
 * @returns {{sent: boolean, skipped?: string, messageId?: string}}
 */
async function sendEmail({ to, toName, subject, html, dryRun = false }) {
  const brevo = config.brevo;
  if (!brevo.enabled) return { sent: false, skipped: 'brevo disabled' };
  if (!brevo.apiKey) return { sent: false, skipped: 'brevo api key missing' };
  if (!to) return { sent: false, skipped: 'no email address' };
  if (dryRun) return { sent: false, skipped: 'dry run', to };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': brevo.apiKey,
    },
    body: JSON.stringify({
      sender: { email: brevo.senderEmail, name: brevo.senderName },
      to: [{ email: to, ...(toName ? { name: toName } : {}) }],
      subject,
      htmlContent: html,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.message || `HTTP ${res.status}`;
    throw new Error(`Brevo send failed (${to}): ${detail}`);
  }
  return { sent: true, to, messageId: json.messageId };
}

module.exports = { sendEmail };
