/*
 * ingest/razorpay.mjs — Razorpay payment-link webhooks.
 * Events: payment_link.paid / .expired / .cancelled. The order id rides in the
 * link's notes (set at creation). Dedupe by x-razorpay-event-id.
 */
import { makeIngest } from './base.mjs';
import { verifyRazorpay } from '../lib/signature.mjs';

export const razorpayIngest = {
  name: 'razorpay',
  verify: (raw, h, s) => verifyRazorpay(raw, h['x-razorpay-signature'], s.razorpayWebhookSecret),
  toItems(h, body) {
    const event = body.event;
    const link = body.payload?.payment_link?.entity;
    const payment = body.payload?.payment?.entity;
    const base = link || payment || {};
    // The payment_link entity's id is a plink_..., which is NOT accepted by the
    // refund endpoint (it 400s with "not a valid id"), so every refund silently
    // failed. Carry the real pay_... id and the captured amount explicitly.
    const entity = {
      ...base,
      payment_id: payment?.id || base.payment_id || null,
      amount_paid: base.amount_paid != null ? base.amount_paid : payment?.amount,
    };
    const orderId = entity.notes?.shopify_order_id;
    const dedupId = h['x-razorpay-event-id'] || `${event}:${entity.id || ''}`;
    return [
      {
        message: { kind: 'razorpay', event, entity },
        groupId: orderId ? `order:${orderId}` : `paylink:${entity.id || 'unknown'}`,
        dedupId,
      },
    ];
  },
};

export const handler = makeIngest(razorpayIngest);
