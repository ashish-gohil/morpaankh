'use strict';

/**
 * FLOW 2 + 3 — Real-time tracking status sync + delivery/RTO webhook handling.
 * Triggered by the Shiprocket tracking webhook. Maps the courier status to a
 * Shopify fulfillment event, and on RTO tags the order + writes a note so the
 * top-priority RTO signal is visible in the Shopify admin.
 */
const config = require('../config');
const shopify = require('../shopify');
const whatsapp = require('../clients/whatsapp');
const { istDateStamp } = require('../automations/helpers');
const { mapStatus } = require('../statusMap');

/**
 * Best-effort WhatsApp shipped/delivered notifications (utility templates).
 * Deduped with order tags so courier webhook retries and repeated status
 * pings never message twice. Failures never break the tracking sync.
 */
async function notifyOnce(order, dedupTag, template, bodyParams) {
  if ((order.tags || []).includes(dedupTag)) return { skipped: 'already sent' };
  const phone =
    order.phone ||
    (order.shippingAddress && order.shippingAddress.phone) ||
    (order.billingAddress && order.billingAddress.phone);
  const outcome = await whatsapp.sendTemplate({
    to: phone,
    template,
    bodyParams,
  });
  if (outcome.sent) await shopify.addTags(order.id, [dedupTag]);
  return outcome;
}

async function handleTracking(payload) {
  const awb = payload.awb || payload.awb_code || '';
  const orderRef = String(payload.order_id || payload.channel_order_id || '').trim();
  const current = payload.current_status || payload.shipment_status || '';
  const mapped = mapStatus(current);

  const result = {
    awb,
    orderRef,
    current,
    mappedEvent: mapped.event,
    rto: mapped.rto,
  };

  if (!orderRef) {
    result.skipped = 'no order_id in payload';
    return result;
  }

  const order = await shopify.findOrderByName(orderRef);
  if (!order) {
    result.skipped = 'shopify order not found';
    return result;
  }
  result.shopifyOrder = order.name;

  const fulfillment = (order.fulfillments || [])[0];
  if (fulfillment && fulfillment.legacyResourceId) {
    try {
      await shopify.createFulfillmentEvent(
        order.legacyResourceId,
        fulfillment.legacyResourceId,
        mapped.event,
        `Shiprocket: ${current}`
      );
      result.eventCreated = true;
    } catch (e) {
      result.eventError = e.message;
    }
  } else {
    result.note = 'no fulfillment on order yet; status event skipped';
  }

  const firstName = (order.customer && order.customer.firstName) || 'there';

  if (mapped.event === 'in_transit') {
    try {
      result.shippedNotify = await notifyOnce(
        order,
        'mp-wa-shipped-sent',
        config.whatsapp.templates.shipped,
        [firstName, order.name, awb]
      );
    } catch (e) {
      result.shippedNotifyError = e.message;
    }
  }

  if (mapped.event === 'delivered') {
    // Feeds the review-request automation: mp-delivered marks the order,
    // the dated tag records when, both visible in admin.
    try {
      await shopify.addTags(order.id, [
        'mp-delivered',
        `mp-delivered-on-${istDateStamp()}`,
      ]);
      result.deliveredTagged = true;
    } catch (e) {
      result.deliveredTagError = e.message;
    }
    try {
      result.deliveredNotify = await notifyOnce(
        order,
        'mp-wa-delivered-sent',
        config.whatsapp.templates.delivered,
        [firstName, order.name]
      );
    } catch (e) {
      result.deliveredNotifyError = e.message;
    }
  }

  if (mapped.rto) {
    try {
      await shopify.addTags(order.id, ['RTO']);
      result.rtoTagged = true;
    } catch (e) {
      result.tagError = e.message;
    }
    try {
      await shopify.addOrderNote(
        order.id,
        `RTO detected via Shiprocket (AWB ${awb}, status: ${current}).`
      );
    } catch (_e) {
      /* note is best-effort */
    }
  }

  return result;
}

module.exports = { handleTracking };
