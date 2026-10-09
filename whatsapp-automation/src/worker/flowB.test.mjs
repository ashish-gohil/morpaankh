import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { _resetSecrets } from '../secrets.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import * as B from './flowB.run.mjs';
import { _flowData } from './flowB.run.mjs';

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
  config.reviewVia = 'flow';
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

  it('link mode sends the form button, prefilled, and arms no reminder', async () => {
    config.reviewVia = 'link';
    const { clients, deps } = setup();
    await B.onDelivered('12345', '2026-09-20T05:00:00Z', deps);
    await B.onReviewTimer('12345', deps);

    const sent = clients.whatsapp.sent.find((s) => s.type === 'template');
    expect(sent.name).toBe('delivered_review_link_v1');

    // The order number has to ride along in the URL or the response lands in
    // the sheet with nothing tying it to a buyer.
    const urlBtn = sent.components.find((c) => c.sub_type === 'url');
    const suffix = urlBtn.parameters[0].text;
    expect(suffix).toContain('usp=pp_url');
    expect(suffix).toContain('entry.1498099268=Aarav');

    // Asked, tagged, and NOT reminded: a form cannot tell us it was filled in,
    // so a reminder would nag the people who already answered.
    expect(tagsAdded(clients.shopify)).toContain('wa-review-asked');
    expect(_peekTimers().map((t) => t.name)).not.toContain('B-12345-review_reminder');
  });

  it('an ACTIVE review is stored, linked, coded, and thanked', async () => {
    const { clients, deps } = setup();
    await B.onReviewSubmit('12345', submission, deps);
    const cr = calls(clients.shopify, 'createReview')[0];
    expect(cr.args.status).toBe('ACTIVE');
    expect(calls(clients.shopify, 'appendProductReview')).toHaveLength(1);
    expect(calls(clients.shopify, 'createDiscountCode')).toHaveLength(1);
    expect(clients.whatsapp.sent.some((s) => /off your next order/.test(s.body || ''))).toBe(true);
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

/*
 * Loopholes found by walking every decision point in Flow B before it is
 * switched on for the first time. All of these were reachable in production.
 */
describe('Flow B kill switch actually stops it', () => {
  it('does not send a review ask from a timer armed before the flow was turned off', async () => {
    const { clients, deps } = setup();
    await B.onDelivered('12345', '2026-09-20T05:00:00Z', deps);
    config.flows.B = { enabled: false, startAt: '2020-01-01T00:00:00Z' };
    await B.onReviewTimer('12345', deps);
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('does not send the reminder either', async () => {
    const { clients, deps } = setup();
    await B.onDelivered('12345', '2026-09-20T05:00:00Z', deps);
    await B.onReviewTimer('12345', deps);
    const afterAsk = clients.whatsapp.sent.length;
    config.flows.B = { enabled: false, startAt: '2020-01-01T00:00:00Z' };
    await B.onReviewReminder('12345', deps);
    expect(clients.whatsapp.sent).toHaveLength(afterAsk);
  });
});

describe('Flow B never sends a second thank-you code', () => {
  it('records the review before the bookkeeping that can fail', async () => {
    const { clients, deps } = setup();
    await B.onReviewTimer('12345', deps);
    clients.shopify.tagsAdd = async () => {
      throw new Error('shopify is down');
    };
    await B.onReviewSubmit('12345', submission, deps);
    await B.onReviewSubmit('12345', submission, deps); // redelivery
    const codes = clients.whatsapp.sent.filter((s) => /THANKS-/.test(s.body || ''));
    expect(codes).toHaveLength(1);
  });

  it('survives a failure publishing the review to the product page', async () => {
    const { clients, deps } = setup();
    await B.onReviewTimer('12345', deps);
    clients.shopify.appendProductReview = async () => {
      throw new Error('metafield write failed');
    };
    await expect(B.onReviewSubmit('12345', submission, deps)).resolves.toBeUndefined();
    expect(clients.whatsapp.sent.filter((s) => /THANKS-/.test(s.body || ''))).toHaveLength(1);
  });
});

describe('Flow B answers a submission it cannot read', () => {
  const bad = { ...submission, review: 'nope' }; // under the 10 char minimum

  it('does not leave the customer in silence', async () => {
    const { clients, deps } = setup();
    config.ownerAlertPhones = [];
    await B.onReviewTimer('12345', deps);
    const before = clients.whatsapp.sent.length;
    await B.onReviewSubmit('12345', bad, deps);
    expect(clients.whatsapp.sent.length).toBeGreaterThan(before);
  });

  it('tells the owner to follow up by hand', async () => {
    const { clients, deps } = setup();
    config.ownerAlertPhones = ['+919999999999'];
    await B.onReviewTimer('12345', deps);
    await B.onReviewSubmit('12345', bad, deps);
    expect(clients.whatsapp.sent.some((s) => /could not be read/i.test(JSON.stringify(s)))).toBe(true);
  });

  it('does not record it as reviewed, so a real one can still come', async () => {
    const { clients, deps } = setup();
    await B.onReviewTimer('12345', deps);
    await B.onReviewSubmit('12345', bad, deps);
    await B.onReviewSubmit('12345', submission, deps);
    expect(clients.whatsapp.sent.filter((s) => /THANKS-/.test(s.body || ''))).toHaveLength(1);
  });
});

describe('Flow B thank-you code survives a collision', () => {
  it('generates another code when Shopify says that one is taken', async () => {
    const { clients, deps } = setup();
    await B.onReviewTimer('12345', deps);
    let n = 0;
    const real = clients.shopify.createDiscountCode;
    clients.shopify.createDiscountCode = async (a) => {
      n += 1;
      if (n === 1) throw new Error('Discount code already exists');
      return real(a);
    };
    await B.onReviewSubmit('12345', submission, deps);
    expect(n).toBe(2);
    expect(clients.whatsapp.sent.filter((s) => /THANKS-/.test(s.body || ''))).toHaveLength(1);
  });
});

/*
 * `untrackedDeliveryAssumeDays` sat in RULES read by nothing. The only two
 * things that start Flow B are a Shopify delivery event and the Delhivery
 * poller, so an order shipped by any other courier had no delivery signal at
 * all and was never asked for a review.
 */
describe('Flow B still reaches an order shipped without a Delhivery waybill', () => {
  const untracked = () =>
    setup(
      order({
        fulfillments: [{ status: 'SUCCESS', createdAt: '2026-09-18T06:00:00Z', trackingInfo: [{ number: 'BD9', company: 'Bluedart' }] }],
      }),
    );

  it('schedules the ask from the dispatch date when no delivery event can come', async () => {
    const { deps } = untracked();
    await B.onUntrackedFulfillment('12345', '2026-09-18T06:00:00Z', deps);
    expect(_peekTimers().map((t) => t.name)).toContain('B-12345-review_ask');
  });

  it('lets a real delivery override the assumed date', async () => {
    // Both dates have to be genuinely ahead of the wall clock: scheduleTimer
    // floors anything already past to now+1min, which would otherwise collapse
    // the two and hide the ordering this test is about.
    const dispatch = new Date(Date.now() + 2 * 86400000).toISOString();
    const delivered = new Date(Date.now() + 3 * 86400000).toISOString();
    const { deps } = untracked();
    await B.onUntrackedFulfillment('12345', dispatch, deps);
    const assumed = _peekTimers().find((t) => t.name === 'B-12345-review_ask').at;
    await B.onDelivered('12345', delivered, deps);
    const real = _peekTimers().find((t) => t.name === 'B-12345-review_ask').at;
    expect(new Date(real).getTime()).toBeLessThan(new Date(assumed).getTime());
  });

  it('does not re-arm once the ask has already gone out', async () => {
    const { deps } = untracked();
    await B.onReviewTimer('12345', deps);
    _resetTimers();
    await B.onUntrackedFulfillment('12345', '2026-09-18T06:00:00Z', deps);
    expect(_peekTimers()).toHaveLength(0);
  });

  it('stays quiet while the flow is off', async () => {
    const { deps } = untracked();
    config.flows.B = { enabled: false, startAt: '2020-01-01T00:00:00Z' };
    await B.onUntrackedFulfillment('12345', '2026-09-18T06:00:00Z', deps);
    expect(_peekTimers()).toHaveLength(0);
  });
});

/*
 * The Flow screen and the payload that fills it are two files that must agree,
 * and nothing checked that they did. WhatsApp binds a screen's data as a whole:
 * ONE missing key and the binding fails for the whole screen, so every
 * ${data.x} renders as its own literal source text. That is what a real
 * customer saw: "a code for ${data.percent_text} off your next order of
 * ${data.min_order_text} or more".
 *
 * This reads the Flow JSON itself, so adding a key there fails the test until
 * flowData supplies it.
 */
describe('the review Flow payload matches what the Flow screen declares', () => {
  const flowJson = JSON.parse(
    readFileSync(new URL('../../messages/flows/review.flow.json', import.meta.url), 'utf8'),
  );
  const declared = Object.keys(flowJson.screens[0].data);
  const order = (lines) => ({
    firstName: 'Aarav',
    lineItems: lines.map((t, i) => ({ productGid: `gid://shopify/Product/${i}`, title: t })),
  });

  it('declares something worth checking', () => {
    expect(declared).toContain('products');
    expect(declared.length).toBeGreaterThan(3);
  });

  it('supplies EVERY declared key for a single-line order', () => {
    // The common case: 14 of the last 15 real orders had exactly one line.
    const data = _flowData(order(['Khili Dhoop']), true);
    expect(Object.keys(data).sort()).toEqual([...declared].sort());
    expect(data.products).toEqual([]);
    expect(data.show_product).toBe(false);
  });

  it('supplies EVERY declared key for a multi-line order, and offers the choice', () => {
    const data = _flowData(order(['Khili Dhoop', 'Bandhan']), true);
    expect(Object.keys(data).sort()).toEqual([...declared].sort());
    expect(data.show_product).toBe(true);
    expect(data.products.map((p) => p.title)).toEqual(['Khili Dhoop', 'Bandhan']);
  });

  it('supplies every declared key even when products are not wanted', () => {
    const data = _flowData(order(['Khili Dhoop', 'Bandhan']), false);
    expect(Object.keys(data).sort()).toEqual([...declared].sort());
  });
});

/*
 * The thank-you code's terms. Owner's rules 2026-10-09: a FLAT Rs 150, usable
 * ONCE, expiring after 30 days. Each of those is a separate Shopify field and
 * getting any one wrong is a money bug that nothing else would catch:
 * `percentage` and `discountAmount` are different FIELDS on the same input, so
 * setting the wrong one silently changes what the customer gets.
 */
describe('the review thank-you code', () => {
  const args = async () => {
    const { clients, deps } = setup();
    await B.onReviewSubmit('12345', submission, deps);
    return clients.shopify.calls.find((c) => c.op === 'createDiscountCode').args;
  };

  it('is a flat rupee amount, never a percentage', async () => {
    const a = await args();
    expect(a.amountInr).toBe(150);
    expect(a.percentage).toBeUndefined();
  });

  it('expires 30 days out, not 60', async () => {
    const a = await args();
    const days = (new Date(a.endsAt) - new Date(a.startsAt)) / 86400000;
    expect(Math.round(days)).toBe(30);
  });

  it('carries the minimum spend it promises', async () => {
    expect((await args()).minSubtotalInr).toBe(1500);
  });

  it('tells the customer the amount, the one-use rule and the expiry', async () => {
    const { clients, deps } = setup();
    await B.onReviewSubmit('12345', submission, deps);
    const body = clients.whatsapp.sent.map((s) => s.body || '').join('\n');
    expect(body).toMatch(/₹150 off your next order/);
    expect(body).toMatch(/works once/);
    expect(body).toMatch(/valid until/);
    expect(body).not.toMatch(/%/); // the percentage wording is gone
  });

  it('offers the same amount inside the Flow form the customer reads first', async () => {
    // The form says what the reward is BEFORE they write, so it has to agree
    // with the code they get afterwards.
    const data = _flowData({ firstName: 'Aarav', lineItems: [{ productGid: 'gid://p/1', title: 'X' }] }, true);
    expect(data.percent_text).toBe('₹150');
  });
});
