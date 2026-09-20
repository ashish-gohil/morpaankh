/*
 * ingest/shopify.mjs — Shopify webhooks -> FIFO, grouped per order.
 * Topics: ORDERS_CREATE/UPDATED/CANCELLED, FULFILLMENTS_CREATE/UPDATE,
 * FULFILLMENT_EVENTS_CREATE. Payloads are REST-shaped.
 */
import { makeIngest } from './base.mjs';
import { verifyShopify } from '../lib/signature.mjs';
import { config } from '../config.mjs';

function orderIdFor(topic, body) {
  if (topic.startsWith('orders/')) return body.id;
  if (topic.startsWith('fulfillments/') || topic.startsWith('fulfillment_events/')) return body.order_id;
  return body.order_id || body.id || null;
}

export const shopifyIngest = {
  name: 'shopify',
  verify: (raw, h, s) => verifyShopify(raw, h['x-shopify-hmac-sha256'], s.shopifyWebhookSecret),
  checkRequest: (h) => !config.shopDomain || h['x-shopify-shop-domain'] === config.shopDomain,
  toItems(h, body) {
    const topic = String(h['x-shopify-topic'] || '');
    const orderId = orderIdFor(topic, body);
    if (!orderId) return [];
    const dedupId = h['x-shopify-webhook-id'] || `${topic}:${orderId}:${body.updated_at || ''}`;
    return [
      {
        message: { kind: 'shopify', topic, orderId: String(orderId), payload: body },
        groupId: `order:${orderId}`,
        dedupId,
      },
    ];
  },
};

export const handler = makeIngest(shopifyIngest);
