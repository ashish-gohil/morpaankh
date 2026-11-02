/*
 * ingest/shopify.mjs — Shopify webhooks -> FIFO.
 *
 * Topics: ORDERS_CREATE/UPDATED/CANCELLED, FULFILLMENTS_CREATE/UPDATE,
 * FULFILLMENT_EVENTS_CREATE, and CHECKOUTS_CREATE/UPDATE. Payloads are
 * REST-shaped.
 *
 * A CHECKOUT IS NOT AN ORDER and is deliberately routed away from the order
 * path below. It carries no order id, it is grouped by its own token so one
 * shopper's checkouts cannot serialise behind another's order, and it feeds
 * Flow R rather than any of the order flows.
 *
 * Why it is here at all: this is how the service learns a shopper passed COD
 * King's OTP, and it is the ONLY way that does not depend on COD King's user
 * interface. Shopify stamps `note_attributes` onto the checkout from the cart,
 * so `_otpVerifiedPhoneNumber` arrives here signed, server to server, whoever
 * wrote it and from whichever frame. See cartRecovery.onCheckoutSeen.
 */
import { makeIngest } from './base.mjs';
import { verifyShopify } from '../lib/signature.mjs';
import { config } from '../config.mjs';
import { log } from '../log.mjs';

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

    if (topic.startsWith('checkouts/')) {
      /*
       * `cart_token` first, so a checkout and the storefront capture of the
       * same bag land on ONE row rather than racing as two. A completed
       * checkout is dropped here: they bought, and there is nothing to win
       * back.
       */
      const token = body.cart_token || body.token;
      if (!token || body.completed_at) return [];
      return [
        {
          message: { kind: 'checkout', topic, token: String(token), payload: body },
          groupId: `checkout:${token}`,
          dedupId: h['x-shopify-webhook-id'] || `${topic}:${token}:${body.updated_at || ''}`,
        },
      ];
    }

    const orderId = orderIdFor(topic, body);
    if (!orderId) {
      // Never observed, and that is exactly why it is logged: a dropped order
      // webhook is a customer who hears nothing, and this was the one place in
      // the chain that could discard one without saying so.
      log.warn('shopify ingest: order webhook carried no order id, dropped', { topic, reason: 'no-order-id' });
      return [];
    }
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
