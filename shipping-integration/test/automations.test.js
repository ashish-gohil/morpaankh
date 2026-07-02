'use strict';

/**
 * Pure-logic tests for the automation layer (no network). Run with `npm test`.
 * Dummy env first so config validation passes.
 */
process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'test.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || 'shpat_test';
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || 'topsecret';
process.env.SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL || 'a@b.com';
process.env.SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD || 'pw';
process.env.SHIPROCKET_PICKUP_LOCATION = process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary';
process.env.SHIPROCKET_WEBHOOK_TOKEN = process.env.SHIPROCKET_WEBHOOK_TOKEN || 'tok123';
process.env.AUTOMATION_SHARED_SECRET = process.env.AUTOMATION_SHARED_SECRET || 'autosecret';

const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeIndianPhone } = require('../src/clients/whatsapp');
const { trimLedger, minutesSince, formatAmount, orderPhone } = require('../src/automations/helpers');
const acr = require('../src/automations/abandonedCheckouts');
const cod = require('../src/automations/codConfirmation');
const review = require('../src/automations/reviewRequests');
const { verifyAutomationSecret } = require('../src/verify');

test('normalizeIndianPhone: common formats', () => {
  assert.strictEqual(normalizeIndianPhone('9876543210'), '919876543210');
  assert.strictEqual(normalizeIndianPhone('+91 98765 43210'), '919876543210');
  assert.strictEqual(normalizeIndianPhone('919876543210'), '919876543210');
  assert.strictEqual(normalizeIndianPhone('09876543210'), '919876543210');
  assert.strictEqual(normalizeIndianPhone('12345'), null);        // too short
  assert.strictEqual(normalizeIndianPhone('1234567890'), null);   // not a mobile prefix
  assert.strictEqual(normalizeIndianPhone(''), null);
  assert.strictEqual(normalizeIndianPhone(null), null);
});

test('trimLedger caps and keeps the newest entries', () => {
  const ids = Array.from({ length: 600 }, (_v, i) => `id${i}`);
  const trimmed = trimLedger(ids, 500);
  assert.strictEqual(trimmed.length, 500);
  assert.strictEqual(trimmed[0], 'id100');
  assert.strictEqual(trimmed[499], 'id599');
  assert.deepStrictEqual(trimLedger(['a'], 500), ['a']);
});

test('minutesSince', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  assert.strictEqual(minutesSince('2026-07-02T11:00:00Z', now), 60);
});

test('formatAmount: Indian formatting, no decimals', () => {
  assert.strictEqual(formatAmount({ shopMoney: { amount: '2199.00' } }), 'Rs 2,199');
  assert.strictEqual(formatAmount({ shopMoney: { amount: '124500' } }), 'Rs 1,24,500');
  assert.strictEqual(formatAmount(null), 'Rs 0');
});

test('ACR selectEligible: window, ledger, consent, phone', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const base = {
    abandonedCheckoutUrl: 'https://x/recover/abc',
    createdAt: '2026-07-02T10:00:00Z',
    updatedAt: '2026-07-02T10:30:00Z', // 90 min idle
    customer: {
      firstName: 'Asha',
      defaultPhoneNumber: { phoneNumber: '+919876543210', marketingState: 'SUBSCRIBED' },
      defaultAddress: { phone: null },
    },
    lineItems: { nodes: [{ title: 'Saanjh Kurta Set', quantity: 1 }] },
  };
  const opts = { minAgeMinutes: 60, maxAgeHours: 48, requireConsent: true };

  const checkouts = [
    { ...base, id: 'c1' },                                             // eligible
    { ...base, id: 'c2' },                                             // in ledger
    { ...base, id: 'c3', updatedAt: '2026-07-02T11:30:00Z' },          // 30 min idle: too fresh
    { ...base, id: 'c4', createdAt: '2026-06-25T10:00:00Z' },          // too old
    { ...base, id: 'c5', customer: null },                             // no customer
    {
      ...base,
      id: 'c6',
      customer: { ...base.customer, defaultPhoneNumber: { phoneNumber: '+919876543210', marketingState: 'NOT_SUBSCRIBED' } },
    },                                                                 // no consent
    {
      ...base,
      id: 'c7',
      customer: { firstName: 'B', defaultPhoneNumber: null, defaultAddress: { phone: null } },
    },                                                                 // no phone
  ];

  const { eligible, skipped } = acr.selectEligible(checkouts, ['c2'], opts, now);
  assert.deepStrictEqual(eligible.map((c) => c.id), ['c1']);
  const reasons = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
  assert.strictEqual(reasons.c2, 'already contacted');
  assert.strictEqual(reasons.c3, 'too fresh');
  assert.strictEqual(reasons.c4, 'too old');
  assert.strictEqual(reasons.c5, 'no customer');
  assert.strictEqual(reasons.c6, 'no marketing consent');
  assert.strictEqual(reasons.c7, 'no phone');
});

test('ACR selectEligible: consent gate can be relaxed', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const checkout = {
    id: 'c1',
    abandonedCheckoutUrl: 'https://x/recover/abc',
    createdAt: '2026-07-02T10:00:00Z',
    updatedAt: '2026-07-02T10:30:00Z',
    customer: {
      firstName: 'Asha',
      defaultPhoneNumber: { phoneNumber: '+919876543210', marketingState: 'NOT_SUBSCRIBED' },
      defaultAddress: { phone: null },
    },
    lineItems: { nodes: [] },
  };
  const { eligible } = acr.selectEligible(
    [checkout],
    [],
    { minAgeMinutes: 60, maxAgeHours: 48, requireConsent: false },
    now
  );
  assert.strictEqual(eligible.length, 1);
});

test('COD: gateway detection + eligibility', () => {
  assert.strictEqual(cod.isCodOrder({ paymentGatewayNames: ['Cash on Delivery (COD)'] }), true);
  assert.strictEqual(cod.isCodOrder({ paymentGatewayNames: ['cod_king'] }), true);
  assert.strictEqual(cod.isCodOrder({ paymentGatewayNames: ['Razorpay Secure'] }), false);
  assert.strictEqual(cod.isCodOrder({ paymentGatewayNames: [] }), false);

  const now = new Date('2026-07-02T12:00:00Z');
  const base = {
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    tags: [],
    displayFulfillmentStatus: 'UNFULFILLED',
    createdAt: '2026-07-02T11:00:00Z', // 60 min old
    phone: '+919876543210',
  };
  const orders = [
    { ...base, name: '#1' },                                          // eligible
    { ...base, name: '#2', tags: [cod.SENT_TAG] },                    // already sent
    { ...base, name: '#3', createdAt: '2026-07-02T11:55:00Z' },       // too fresh (20 min gate)
    { ...base, name: '#4', displayFulfillmentStatus: 'FULFILLED' },   // fulfilled
    { ...base, name: '#5', paymentGatewayNames: ['Razorpay Secure'] },// prepaid
    { ...base, name: '#6', phone: null },                             // no phone anywhere
  ];
  const eligible = cod.selectEligible(orders, 20, now);
  assert.deepStrictEqual(eligible.map((o) => o.name), ['#1']);
});

test('review: delivered-on tag parsing + due window', () => {
  assert.strictEqual(
    review.deliveredOnFromTags(['RTO', 'mp-delivered', 'mp-delivered-on-2026-06-28']),
    '2026-06-28'
  );
  assert.strictEqual(review.deliveredOnFromTags(['mp-delivered']), null);
  assert.strictEqual(review.deliveredOnFromTags(['mp-delivered-on-junk']), null);
  assert.strictEqual(review.deliveredOnFromTags([]), null);

  const now = new Date('2026-07-02T12:00:00Z');
  assert.strictEqual(review.isDueForReview('2026-06-28', 3, 30, now), true);  // 4 days
  assert.strictEqual(review.isDueForReview('2026-07-01', 3, 30, now), false); // 1 day: too soon
  assert.strictEqual(review.isDueForReview('2026-05-01', 3, 30, now), false); // too old
  assert.strictEqual(review.isDueForReview(null, 3, 30, now), false);
});

test('verifyAutomationSecret: constant-time compare + empty guards', () => {
  assert.strictEqual(verifyAutomationSecret('autosecret'), true);
  assert.strictEqual(verifyAutomationSecret('wrong'), false);
  assert.strictEqual(verifyAutomationSecret(''), false);
  assert.strictEqual(verifyAutomationSecret(undefined), false);
});

test('orderPhone: fallback chain', () => {
  assert.strictEqual(orderPhone({ phone: 'a' }), 'a');
  assert.strictEqual(orderPhone({ phone: null, shippingAddress: { phone: 'b' } }), 'b');
  assert.strictEqual(
    orderPhone({ phone: null, shippingAddress: null, billingAddress: { phone: 'c' } }),
    'c'
  );
  assert.strictEqual(orderPhone({}), null);
});
