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
    const entity = body.payload?.payment_link?.entity || body.payload?.payment?.entity || {};
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
