'use strict';

/**
 * Pure-logic smoke tests (no network). Run with `npm test`.
 * Dummy env is set first so config validation passes.
 */
process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'test.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || 'shpat_test';
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || 'topsecret';
process.env.SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL || 'a@b.com';
process.env.SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD || 'pw';
process.env.SHIPROCKET_PICKUP_LOCATION = process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary';
process.env.SHIPROCKET_WEBHOOK_TOKEN = process.env.SHIPROCKET_WEBHOOK_TOKEN || 'tok123';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { mapStatus } = require('../src/statusMap');
const { verifyShopifyHmac, verifyShiprocketToken } = require('../src/verify');
const { buildPayload } = require('../src/handlers/shopifyOrderCreate');

test('mapStatus: RTO always flagged', () => {
  assert.deepStrictEqual(mapStatus('RTO Initiated'), { event: 'failure', rto: true });
  assert.deepStrictEqual(mapStatus('RTO Delivered'), { event: 'failure', rto: true });
});

test('mapStatus: "undelivered" is NOT "delivered" (substring trap)', () => {
  assert.deepStrictEqual(mapStatus('Undelivered'), { event: 'failure', rto: false });
  assert.deepStrictEqual(mapStatus('Non Delivered'), { event: 'failure', rto: false });
  assert.deepStrictEqual(mapStatus('Delivered'), { event: 'delivered', rto: false });
});

test('mapStatus: transit / OFD / default', () => {
  assert.deepStrictEqual(mapStatus('Out For Delivery'), { event: 'out_for_delivery', rto: false });
  assert.deepStrictEqual(mapStatus('In Transit'), { event: 'in_transit', rto: false });
  assert.deepStrictEqual(mapStatus('Picked Up'), { event: 'in_transit', rto: false });
  assert.deepStrictEqual(mapStatus('Something unknown'), { event: 'confirmed', rto: false });
});

test('verify: Shopify HMAC + Shiprocket token', () => {
  const body = JSON.stringify({ id: 1, name: '#1001' });
  const good = crypto.createHmac('sha256', 'topsecret').update(body, 'utf8').digest('base64');
  assert.strictEqual(verifyShopifyHmac(body, good), true);
  assert.strictEqual(verifyShopifyHmac(body, 'wrong'), false);
  assert.strictEqual(verifyShiprocketToken('tok123'), true);
  assert.strictEqual(verifyShiprocketToken('nope'), false);
});

test('buildPayload: Shopify order -> Shiprocket', () => {
  const order = {
    id: 555, name: '#1042', order_number: 1042, created_at: '2026-06-04T10:30:00Z',
    financial_status: 'pending', email: 'c@x.com', phone: '+91 98765 43210',
    shipping_address: { first_name: 'Asha', last_name: 'R', address1: '12 MG Rd', city: 'Surat', zip: '395006', province: 'Gujarat', country: 'India', phone: '9876543210' },
    line_items: [{ title: 'Saanjh Kurta Set', sku: 'SAANJH-M', quantity: 2, price: '2199.00', grams: 600 }],
  };
  const p = buildPayload(order);
  assert.strictEqual(p.order_id, '1042');
  assert.strictEqual(p.payment_method, 'COD');          // pending => COD
  assert.strictEqual(p.sub_total, 4398);                // 2199 * 2
  assert.strictEqual(p.weight, 1.2);                    // 1200g => 1.2kg
  assert.strictEqual(p.billing_pincode, '395006');
  assert.strictEqual(p.billing_phone, '9876543210');    // last 10 digits
  assert.strictEqual(buildPayload({ ...order, financial_status: 'paid' }).payment_method, 'Prepaid');
});
