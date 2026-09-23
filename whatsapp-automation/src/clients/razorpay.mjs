/*
 * clients/razorpay.mjs — PaymentLinks interface (Cashfree can be added later
 * behind the same shape). All writes gated by DRY_RUN.
 *
 * Interface:
 *   createLink({ amountPaise, referenceId, description, contact, notes, expireBy }) -> { id, shortUrl }
 *   cancelLink(id) -> { ok }
 *   refund(paymentId, amountPaise) -> { id }
 */
import { config } from '../config.mjs';
import { getSecrets } from '../secrets.mjs';
import { log } from '../log.mjs';
import { withRetry } from '../lib/resilience.mjs';

const BASE = 'https://api.razorpay.com/v1';

async function authHeader() {
  const s = await getSecrets();
  return `Basic ${Buffer.from(`${s.razorpayKeyId}:${s.razorpayKeySecret}`).toString('base64')}`;
}

// Never idempotent. A retry after an unknown outcome could issue a second
// refund or create a second payment link, so only refusals Razorpay never
// processed are retried.
async function call(method, path, body) {
  const auth = await authHeader();
  return withRetry(`razorpay.${path.split('/')[1] || path}`, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`razorpay ${method} ${path} failed: ${json.error?.description || res.status}`);
      e.status = res.status;
      throw e;
    }
    return json;
  });
}

export const razorpay = {
  async createLink({ amountPaise, referenceId, description, contact, notes, expireBy }) {
    if (config.dryRun) {
      log.info('razorpay createLink skipped (dry_run)', { referenceId, amountPaise });
      return { id: `dry_${referenceId}`, shortUrl: 'https://dry.run/pay' };
    }
    const j = await call('POST', '/payment_links', {
      amount: amountPaise,
      currency: 'INR',
      accept_partial: false,
      reference_id: referenceId,
      description,
      customer: { contact },
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: expireBy,
      notes,
    });
    return { id: j.id, shortUrl: j.short_url };
  },

  async cancelLink(id) {
    if (config.dryRun) return { ok: true, skipped: 'dry_run' };
    await call('POST', `/payment_links/${id}/cancel`);
    return { ok: true };
  },

  async refund(paymentId, amountPaise) {
    if (config.dryRun) return { id: `dry_refund_${paymentId}`, skipped: 'dry_run' };
    const j = await call('POST', `/payments/${paymentId}/refund`, { amount: amountPaise });
    return { id: j.id };
  },
};
