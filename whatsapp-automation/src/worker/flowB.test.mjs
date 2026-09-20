import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { _resetSecrets } from '../secrets.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import * as B from './flowB.run.mjs';

const NOW = fromISTWall(2026, 9, 20, 12, 0);
const PHONE = '+919812345678';

function order(overrides = {}) {
  return {
    id: 'gid://shopify/Order/12345',
    name: '#1234',
    tags: [],
    test: false,
    createdAt: '2026-09-15T06:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    netPaymentSet: { shopMoney: { amount: '1499.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919812345678' }],
    customer: { firstName: 'Aarav' },
    shippingLines: { nodes: [] },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }],
    lineItems: { nodes: [{ id: 'li1', title: 'Bandhan', quantity: 1, product: { id: 'gid://shopify/Product/1' }, originalUnitPriceSet: { shopMoney: { amount: '1499.00' } } }] },
    ...overrides,
  };
}

function setup(o = order()) {
  const clients = makeFakeClients({});
  clients.shopify.seed(o);
  return { clients, deps: { clients, now: NOW } };
}

const submission = { flow_token: '', rating: '5', fit: 'just_right', review: 'Lovely fabric and the fit was perfect', display_name: 'Aarav', consent: true };

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  process.env.FLOW_TOKEN_KEY = 'test-flow-key';
  config.flows.B = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
  config.orderAllowlist = [];
  config.ownerAlertPhones = [];
});

const calls = (sh, op) => sh.calls.filter((c) => c.op === op);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);

describe('Flow B', () => {
  it('delivered schedules a review ask; the timer sends the flow + reminder', async () => {
    const { clients, deps } = setup();
    await B.onDelivered('12345', '2026-09-20T05:00:00Z', deps);
    expect(_peekTimers().map((t) => t.name)).toContain('B-12345-review_ask');

    await B.onReviewTimer('12345', deps);
    expect(clients.whatsapp.sent.some((s) => s.type === 'template' && s.name === 'delivered_review_v1')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-review-asked');
    expect(_peekTimers().map((t) => t.name)).toContain('B-12345-review_reminder');
  });

  it('an ACTIVE review is stored, linked, coded, and thanked', async () => {
    const { clients, deps } = setup();
    await B.onReviewSubmit('12345', submission, deps);
    const cr = calls(clients.shopify, 'createReview')[0];
    expect(cr.args.status).toBe('ACTIVE');
    expect(calls(clients.shopify, 'appendProductReview')).toHaveLength(1);
    expect(calls(clients.shopify, 'createDiscountCode')).toHaveLength(1);
    expect(clients.whatsapp.sent.some((s) => /Your code:/.test(s.body || ''))).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-reviewed');
  });

  it('a no-consent review is DRAFT (not linked) but still gets a code', async () => {
    const { clients, deps } = setup();
    await B.onReviewSubmit('12345', { ...submission, consent: false }, deps);
    expect(calls(clients.shopify, 'createReview')[0].args.status).toBe('DRAFT');
    expect(calls(clients.shopify, 'appendProductReview')).toHaveLength(0);
    expect(calls(clients.shopify, 'createDiscountCode')).toHaveLength(1);
  });

  it('is idempotent: a second submission does nothing', async () => {
    const { clients, deps } = setup();
    await B.onReviewSubmit('12345', submission, deps);
    await B.onReviewSubmit('12345', submission, deps);
    expect(calls(clients.shopify, 'createDiscountCode')).toHaveLength(1);
  });

  it('does not ask for a review on an RTO order', async () => {
    const { deps } = setup(order({ tags: ['RTO'] }));
    await B.onDelivered('12345', '2026-09-20T05:00:00Z', deps);
    expect(_peekTimers()).toHaveLength(0);
  });
});
