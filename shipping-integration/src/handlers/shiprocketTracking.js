'use strict';

/**
 * FLOW 2 + 3 — Real-time tracking status sync + delivery/RTO webhook handling.
 * Triggered by the Shiprocket tracking webhook. Maps the courier status to a
 * Shopify fulfillment event, and on RTO tags the order + writes a note so the
 * top-priority RTO signal is visible in the Shopify admin.
 */
const shopify = require('../shopify');
const { mapStatus } = require('../statusMap');

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
