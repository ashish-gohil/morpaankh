'use strict';

/**
 * FLOW 1 — Shipment creation on order placement.
 * Triggered by the Shopify `orders/create` webhook. Maps the Shopify order to
 * a Shiprocket ad-hoc order, assigns an AWB, schedules pickup, and writes the
 * tracking number + URL back onto the Shopify order as a fulfillment.
 */
const config = require('../config');
const shiprocket = require('../shiprocket');
const shopify = require('../shopify');

function mapAddress(order) {
  const a = order.shipping_address || order.billing_address || {};
  const customer = order.customer || {};
  return {
    first_name: a.first_name || customer.first_name || 'Customer',
    last_name: a.last_name || customer.last_name || '',
    address: a.address1 || '',
    address_2: a.address2 || '',
    city: a.city || '',
    pincode: a.zip || '',
    state: a.province || '',
    country: a.country || 'India',
    email: order.email || order.contact_email || '',
    phone: String(a.phone || order.phone || '').replace(/[^0-9]/g, '').slice(-10),
  };
}

function buildPayload(order) {
  const addr = mapAddress(order);
  const isPrepaid = order.financial_status === 'paid';

  const items = (order.line_items || []).map((li) => ({
    name: li.title,
    sku: li.sku || String(li.variant_id || li.id),
    units: li.quantity,
    selling_price: Number(li.price),
    discount: '',
    tax: '',
    hsn: '',
  }));

  const subTotal = (order.line_items || []).reduce(
    (sum, li) => sum + Number(li.price) * Number(li.quantity),
    0
  );

  // Total grams -> kg, falling back to the configured default.
  const grams = (order.line_items || []).reduce(
    (sum, li) => sum + Number(li.grams || 0) * Number(li.quantity),
    0
  );
  const weight = grams > 0 ? grams / 1000 : config.defaults.weightKg;

  const payload = {
    order_id: String(order.order_number || order.name).replace(/^#/, ''),
    order_date: (order.created_at || new Date().toISOString())
      .slice(0, 16)
      .replace('T', ' '),
    pickup_location: config.shiprocket.pickupLocation,
    comment: 'Created via Mor Paankh shipping integration',
    billing_customer_name: addr.first_name,
    billing_last_name: addr.last_name,
    billing_address: addr.address,
    billing_address_2: addr.address_2,
    billing_city: addr.city,
    billing_pincode: addr.pincode,
    billing_state: addr.state,
    billing_country: addr.country,
    billing_email: addr.email,
    billing_phone: addr.phone,
    shipping_is_billing: true,
    order_items: items,
    payment_method: isPrepaid ? 'Prepaid' : 'COD',
    sub_total: subTotal,
    length: config.defaults.length,
    breadth: config.defaults.breadth,
    height: config.defaults.height,
    weight,
  };
  if (config.shiprocket.channelId) payload.channel_id = config.shiprocket.channelId;
  return payload;
}

async function handleOrderCreate(order) {
  const payload = buildPayload(order);
  const created = await shiprocket.createOrder(payload);
  const shipmentId = created.shipment_id;

  const result = {
    shopifyOrder: order.name,
    shiprocketOrderId: created.order_id,
    shipmentId,
  };

  if (config.shiprocket.autoAssignAwb && shipmentId) {
    const awbRes = await shiprocket.assignAwb(shipmentId);
    const awbData = (awbRes && awbRes.response && awbRes.response.data) || {};
    const awb = awbData.awb_code;
    const courier = awbData.courier_name;
    result.awb = awb;
    result.courier = courier;

    if (awb) {
      const trackingUrl = `${config.shiprocket.trackingUrlBase}${awb}`;
      try {
        const fulfillment = await shopify.createFulfillment({
          orderId: order.id,
          trackingNumber: awb,
          trackingUrl,
          trackingCompany: courier || 'Shiprocket',
          notifyCustomer: config.notifyCustomer,
        });
        result.shopifyFulfillmentId = fulfillment && fulfillment.id;
      } catch (e) {
        result.fulfillmentError = e.message;
      }

      try {
        await shiprocket.generatePickup(shipmentId);
        result.pickupScheduled = true;
      } catch (e) {
        result.pickupError = e.message;
      }
    }
  }

  return result;
}

module.exports = { handleOrderCreate, buildPayload, mapAddress };
