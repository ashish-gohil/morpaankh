import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { setOptOut } from '../store/phoneProfile.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import * as A from './flowA.run.mjs';

const NOW = fromISTWall(2026, 9, 20, 12, 0); // daytime IST, not quiet
const PHONE = '+919812345678';

function codOrder(overrides = {}) {
  const { fulfillments, attrs, ...rest } = overrides;
  return {
    id: 'gid://shopify/Order/12345',
    name: '#1234',
    tags: ['✅ COD-Verified', 'LOW RTO Risk'],
    test: false,
    createdAt: '2026-09-20T06:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    netPaymentSet: { shopMoney: { amount: '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: attrs || [
      { key: '_otpVerifiedPhoneNumber', value: '919812345678' },
      { key: '_codkAmountType', value: 'cod' },
      { key: '_codkAmountValue', value: '50.0' },
    ],
    customer: { firstName: 'Aarav' },
    shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '50.00' } } }] },
    fulfillments: fulfillments || [],
    lineItems: { nodes: [{ id: 'li1', title: 'Bandhan', quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '1449.00' } } }] },
    ...rest,
  };
}

function setup(order = codOrder(), courier = {}) {
  const clients = makeFakeClients({ shopify: {}, courier });
  clients.shopify.seed(order);
  return { clients, deps: { clients, now: NOW } };
}

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  config.flows.A = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
  config.orderAllowlist = [];
  config.ownerAlertPhones = [];
});

const types = (wa) => wa.sent.map((s) => s.type);
const names = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);

describe('Flow A happy path', () => {
  it('create -> cod timer -> confirm sent -> convert on payment', async () => {
    const { clients, deps } = setup();

    await A.onOrderCreate('12345', deps);
    expect(_peekTimers().map((t) => t.name)).toContain('A-12345-cod');

    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp)).toContain('cod_confirm_v1');
    expect(tagsAdded(clients.shopify)).toContain('wa-cod-sent');
    const timerNames = _peekTimers().map((t) => t.name);
    expect(timerNames).toEqual(expect.arrayContaining(['A-12345-reminder', 'A-12345-fallback', 'A-12345-highrisk']));

    await A.onConfirm('12345', deps);
    expect(tagsAdded(clients.shopify)).toContain('wa-confirmed');
    expect(_peekTimers().map((t) => t.name)).not.toContain('A-12345-reminder');
    expect(clients.razorpay.links).toHaveLength(1);
    expect(types(clients.whatsapp)).toContain('cta_url'); // confirmed_with_offer

    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-prepaid-converted');
    expect(clients.shopify.calls.some((c) => c.op === 'metafieldsSet')).toBe(true);
    // window is open (they just confirmed) -> session payment_received
    expect(clients.whatsapp.sent.some((s) => s.type === 'text' && /received your payment/.test(s.body))).toBe(true);
  });

  it('creates the payment link only once across duplicate taps', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onConfirm('12345', deps);
    await A.onConfirm('12345', deps);
    expect(clients.razorpay.links).toHaveLength(1);
  });
});

describe('Flow A cancel', () => {
  it('unfulfilled order: orderCancel + wa-cancelled + cancel_done', async () => {
    const { clients, deps } = setup();
    await A.onCancel('12345', deps);
    expect(types(clients.whatsapp)).toContain('buttons'); // cancel_check
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'orderCancel')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-cancelled');
    expect(clients.whatsapp.sent.some((s) => /has been cancelled/.test(s.body || ''))).toBe(true);
  });

  it('dispatched order: no cancel, tag wa-cancel-requested + too-late message', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'Out for Delivery', statusType: 'UD' } } });
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'orderCancel')).toBe(false);
    expect(tagsAdded(clients.shopify)).toContain('wa-cancel-requested');
    expect(clients.whatsapp.sent.some((s) => /already been dispatched/.test(s.body || ''))).toBe(true);
  });
});

describe('Flow A payment edge cases', () => {
  it('courier not editable -> full refund + prepaid_refund, no conversion', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'Out for Delivery', statusType: 'UD' } } });
    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.razorpay.refunds).toHaveLength(1);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(false);
    // window closed -> refund goes as the prepaid_refund template
    expect(clients.whatsapp.sent.some((s) => s.name === 'prepaid_refund_v1' || /refund/.test(s.body || ''))).toBe(true);
  });

  it('editable courier (manifested/in transit) -> edits to prepaid then converts', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } });
    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.courier.calls.some((c) => c.op === 'editToPrepaid')).toBe(true);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
  });
});

describe('Flow A exclusions + guards', () => {
  it('PARTIAL order never enters Flow A (no cod_confirm)', async () => {
    const { clients, deps } = setup(codOrder({ displayFinancialStatus: 'PARTIALLY_PAID' }));
    await A.onCodTimer('12345', deps);
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('no verified phone -> tag wa-no-verified-phone, no message', async () => {
    const { clients, deps } = setup(codOrder({ attrs: [{ key: '_codkAmountType', value: 'cod' }, { key: '_codkAmountValue', value: '50.0' }] }));
    await A.onCodTimer('12345', deps);
    expect(tagsAdded(clients.shopify)).toContain('wa-no-verified-phone');
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('opted-out phone gets no cod_confirm', async () => {
    const { clients, deps } = setup();
    await setOptOut(PHONE, true);
    await A.onCodTimer('12345', deps);
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('marketing fallback respects the 7-day cap', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps); // step = confirm_sent
    await A.onFallback('12345', deps);
    await A.onFallback('12345', deps);
    const offers = clients.whatsapp.sent.filter((s) => s.type === 'template' && s.name === 'prepaid_offer_v1');
    expect(offers).toHaveLength(1);
  });
});

describe('Flow A staged rollout (SEND_ALLOWLIST)', () => {
  it('a skipped send leaves the order unmarked, and it still sends once the allowlist comes off', async () => {
    const { clients, deps } = setup();
    const realSend = clients.whatsapp.sendTemplate.bind(clients.whatsapp);
    // what the real client returns for a recipient outside SEND_ALLOWLIST
    clients.whatsapp.sendTemplate = async () => ({ messageId: 'not_allowlisted:dry', skipped: 'not_allowlisted' });

    await A.onCodTimer('12345', deps);

    // nothing may be written to a real customer's order for a message we never sent
    expect(tagsAdded(clients.shopify)).not.toContain('wa-cod-sent');
    expect(_peekTimers().map((t) => t.name)).not.toContain('A-12345-reminder');

    // allowlist removed: the order must NOT be stuck as already-confirmed
    clients.whatsapp.sendTemplate = realSend;
    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp)).toContain('cod_confirm_v1');
    expect(tagsAdded(clients.shopify)).toContain('wa-cod-sent');
  });
});
