/*
 * Order intake end to end: EVERY WAY AN ORDER CAN BE CREATED, through the real
 * chain, asserting that a message actually leaves.
 *
 *   shopifyIngest.toItems -> routes.shopify -> the armed timer -> routes.timer
 *     -> flowA.onCodTimer -> the WhatsApp send
 *
 * Why this file exists. Flow A was reached through exactly two COD King facts:
 * the order attribute `_otpVerifiedPhoneNumber` (the recipient) and
 * `_codkAmountType` (the classifier). Both exist only when the shopper checked
 * out through COD King's popup, so every other creation path was silently
 * dropped, and no test could see it because every fixture in the suite was a
 * COD King order. Measured against the live store on 2026-11-02, 14 of the
 * last 69 orders got no confirmation; five of those were real customers:
 *
 *   #1175  storefront COD, no _codkAmountType           -> class UNKNOWN
 *   #1188  admin order, gateway "manual"                -> class UNKNOWN
 *   #1213  Cashfree straight from the cart, no OTP       -> no-verified-phone
 *   #1232  storefront COD, no OTP and no _codkAmountType -> class UNKNOWN
 *   #1233  draft order completed                        -> no-verified-phone
 *   #1239  abandoned-cart RECOVERY LINK order            -> class UNKNOWN
 *
 * Each `it` below is one of those paths. Real modules throughout; only
 * WhatsApp and Shopify are faked, and the table is the memory backend.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../src/config.mjs';
import { _resetMemory } from './store/table.mjs';
import { _resetTimers, _dueTimers } from './timers/schedule.mjs';
import { _resetSecrets } from './secrets.mjs';
import { _drainQueue } from './queue.mjs';
import { makeFakeClients } from './clients/fakes/index.mjs';
import { shopifyIngest } from './ingest/shopify.mjs';
import { realClients } from './clients/index.mjs';
import { routes } from './worker/index.mjs';
import { getState } from './store/orderState.mjs';
import { sweepUnconfirmed } from './timers/reconcile.mjs';
import * as flowB from './worker/flowB.run.mjs';

const OTP_DIGITS = '919637361371';
const OTP = '+919637361371';
const SHIP = '+919812345678';
const CUST = '+917000000001';

/** Five minutes ago, so the +3 minute timer is due and startAt is long past. */
const createdAt = () => new Date(Date.now() - 5 * 60000).toISOString();

/** The REST-shaped orders/create webhook body Shopify posts. */
const webhook = (id, over = {}) => ({
  id,
  admin_graphql_api_id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  created_at: createdAt(),
  note_attributes: [],
  discount_codes: [],
  tags: '',
  ...over,
});

/*
 * The GraphQL order the flows re-read. Defaults to the shape that works today:
 * a COD King COD order. Every test below takes something away from it.
 */
function gqlOrder(id, over = {}) {
  const {
    otp = OTP_DIGITS,
    codkType = 'cod',
    gateways = ['Cash on Delivery (COD)'],
    codLine = true,
    phones = {},
    ...rest
  } = over;
  const attrs = [];
  if (otp) attrs.push({ key: '_otpVerifiedPhoneNumber', value: otp });
  if (codkType) {
    attrs.push({ key: '_codkAmountType', value: codkType });
    attrs.push({ key: '_codkAmountValue', value: '50.0' });
  }
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    tags: ['LOW RTO Risk'],
    test: false,
    createdAt: createdAt(),
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    paymentGatewayNames: gateways,
    netPaymentSet: { shopMoney: { amount: '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: attrs,
    customer: { id: 'gid://shopify/Customer/777', firstName: 'Aarav', ...(phones.customer ? { defaultPhoneNumber: { phoneNumber: phones.customer } } : {}) },
    shippingAddress: { zip: '395007', city: 'Surat', ...(phones.shipping ? { phone: phones.shipping } : {}) },
    ...(phones.billing ? { billingAddress: { phone: phones.billing } } : {}),
    ...(phones.order ? { phone: phones.order } : {}),
    shippingLines: {
      nodes: codLine
        ? [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '50.00' } } }]
        : [{ title: 'Standard', originalPriceSet: { shopMoney: { amount: '0.00' } } }],
    },
    fulfillments: [],
    lineItems: {
      nodes: [{
        id: 'gid://shopify/LineItem/1',
        title: 'Khili Dhoop',
        quantity: 1,
        currentQuantity: 1,
        variantTitle: 'M',
        product: { id: 'gid://shopify/Product/1', handle: 'khili-dhoop' },
        variant: { id: 'gid://shopify/ProductVariant/1', selectedOptions: [{ name: 'Size', value: 'M' }] },
        image: { url: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1', width: 1200, height: 1500 },
        originalUnitPriceSet: { shopMoney: { amount: '1449.00' } },
        discountAllocations: [],
      }],
    },
    ...rest,
  };
}

/** Swap the real client bundle for fakes for the duration of one journey. */
async function withFakes(clients, fn) {
  const saved = { shopify: realClients.shopify, whatsapp: realClients.whatsapp, razorpay: realClients.razorpay };
  Object.assign(realClients, { shopify: clients.shopify, whatsapp: clients.whatsapp, razorpay: clients.razorpay });
  try {
    return await fn();
  } finally {
    Object.assign(realClients, saved);
  }
}

/** One order's whole journey: the webhook, then every timer it armed. */
async function place(id, over = {}, { skipWebhook = false } = {}) {
  const clients = makeFakeClients();
  clients.shopify.seed(gqlOrder(id, over));
  await withFakes(clients, async () => {
    if (!skipWebhook) {
      const [item] = shopifyIngest.toItems(
        { 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': `wh-${id}` },
        webhook(id, over.webhook),
      );
      expect(item.message.kind).toBe('shopify');
      await routes.shopify(item.message);
    } else {
      // The dropped webhook. The reconcile sweep is the only thing that can
      // notice, and it enqueues the same timer message the worker would.
      await sweepUnconfirmed(new Date());
      for (const q of _drainQueue()) await routes.timer(q.message);
      return;
    }
    // Fire whatever was armed, 10 minutes on: the first confirmation is at +3.
    for (const t of _dueTimers(new Date(Date.now() + 10 * 60000))) await routes.timer(t.message);
  });
  return clients;
}

const templates = (c) => c.whatsapp.sent.filter((s) => s.type === 'template').map((s) => s.name);
const customerSends = (c) => c.whatsapp.sent.filter((s) => s.type === 'template' && !s.name.startsWith('ops_alert'));
const tags = (c) => c.shopify.calls.filter((x) => x.op === 'tagsAdd').flatMap((x) => x.tags);

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  _drainQueue();
  config.ownerAlertPhones = ['+919999999999'];
  config.flows.A = { enabled: true, startAt: '2026-01-01T00:00:00Z' };
  config.flows.B = { enabled: true, startAt: '2026-01-01T00:00:00Z' };
  config.sendAllowlist = [];
  config.orderAllowlist = [];
});

describe('every creation path reaches the customer', () => {
  it('COD through COD King: the path that already worked', async () => {
    const c = await place(9001);
    expect(customerSends(c)).toHaveLength(1);
    expect(customerSends(c)[0].to).toBe(OTP);
    expect(templates(c)[0]).toMatch(/^cod_confirm/);
    expect((await getState('9001')).class).toBe('COD');
    expect((await getState('9001')).phoneSource).toBe('otp');
  });

  it('prepaid through Shopify checkout, OTP present', async () => {
    const c = await place(9002, {
      codkType: 'percentage',
      gateways: ['1Cashfree Payments(UPI,Cards,Net Banking,Wallets)'],
      codLine: false,
      displayFinancialStatus: 'PAID',
      netPaymentSet: { shopMoney: { amount: '1499.00' } },
    });
    expect(templates(c)[0]).toMatch(/^order_confirmed/);
    expect((await getState('9002')).class).toBe('PREPAID');
  });

  it('#1213 Cashfree straight from the cart: no OTP, phone from the order', async () => {
    const c = await place(9003, {
      otp: null,
      codkType: null,
      gateways: ['1Cashfree Payments(UPI,Cards,Net Banking,Wallets)'],
      codLine: false,
      displayFinancialStatus: 'PAID',
      netPaymentSet: { shopMoney: { amount: '1499.00' } },
      phones: { order: '+91 98123 45678', shipping: SHIP },
    });
    expect(customerSends(c)).toHaveLength(1);
    expect(customerSends(c)[0].to).toBe(SHIP);
    expect(templates(c)[0]).toMatch(/^order_confirmed/);
    expect((await getState('9003')).phoneSource).toBe('order');
  });

  it('#1239 the abandoned-cart RECOVERY LINK order: no OTP, no COD King attribute', async () => {
    const c = await place(9004, {
      otp: null,
      codkType: null,
      phones: { shipping: SHIP, billing: SHIP },
    });
    // Classified COD off the shipping line alone, and confirmed.
    expect((await getState('9004')).class).toBe('COD');
    expect((await getState('9004')).phoneSource).toBe('shipping');
    expect(customerSends(c)).toHaveLength(1);
    expect(customerSends(c)[0].to).toBe(SHIP);
    expect(templates(c)[0]).toMatch(/^cod_confirm/);
    expect(tags(c)).toContain('wa-cod-sent');
  });

  it('#1233 a draft order completed: COD, no OTP', async () => {
    const c = await place(9005, {
      otp: null,
      codkType: null,
      displayFinancialStatus: 'PAID',
      netPaymentSet: { shopMoney: { amount: '1499.00' } },
      phones: { customer: CUST },
    });
    expect(customerSends(c)).toHaveLength(1);
    expect(customerSends(c)[0].to).toBe(CUST);
    expect((await getState('9005')).phoneSource).toBe('customer');
  });

  it('#1188 a manual admin order: gateway "manual"', async () => {
    const c = await place(9006, { codkType: null, gateways: ['manual'] });
    expect((await getState('9006')).class).toBe('COD');
    expect(customerSends(c)).toHaveLength(1);
    expect(customerSends(c)[0].to).toBe(OTP);
  });

  it('an API order with no gateway at all still gets the plain confirmation', async () => {
    const c = await place(9007, {
      otp: null,
      codkType: null,
      gateways: [],
      codLine: false,
      displayFinancialStatus: null,
      phones: { shipping: SHIP },
    });
    expect((await getState('9007')).class).toBe('UNKNOWN');
    // The plain confirmation, which promises nothing about payment, plus the
    // owner alert naming the order we could not read.
    expect(templates(c)).toContain('order_confirmed_v1');
    expect(templates(c).some((t) => t.startsWith('ops_alert'))).toBe(true);
    expect(customerSends(c)[0].to).toBe(SHIP);
  });

  it('an order with no usable number anywhere is recorded, not dropped in silence', async () => {
    const c = await place(9008, { otp: null, codkType: null, gateways: [], codLine: false, phones: {} });
    expect(customerSends(c)).toHaveLength(0);
    expect(tags(c)).toContain('wa-no-verified-phone');
    expect((await getState('9008')).flowA.codSkip).toBe('no-phone-anywhere');
  });

  it('a phone that is not an Indian mobile is refused rather than messaged', async () => {
    const c = await place(9009, { otp: null, codkType: null, phones: { shipping: '+1 415 555 0101', billing: '12345' } });
    expect(customerSends(c)).toHaveLength(0);
    expect((await getState('9009')).flowA.codSkip).toBe('no-phone-anywhere');
  });
});

describe('the later flows run on the same orders', () => {
  it('dispatch and the review ask both reach an order that never had an OTP number', async () => {
    const id = 9101;
    const clients = makeFakeClients();
    clients.shopify.seed(gqlOrder(id, {
      otp: null,
      codkType: null,
      phones: { shipping: SHIP },
      fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: new Date().toISOString(), trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }],
    }));
    await withFakes(clients, async () => {
      const [item] = shopifyIngest.toItems(
        { 'x-shopify-topic': 'fulfillments/create', 'x-shopify-webhook-id': `wh-f-${id}` },
        { id: 1, order_id: id, created_at: createdAt() },
      );
      await routes.shopify(item.message);
      await flowB.onDelivered(String(id), new Date().toISOString(), { clients, now: new Date() });
    });
    expect(templates(clients)).toContain('order_shipped_v2');
    expect((await getState(String(id))).flowB.scheduled).toBe(true);
  });
});

describe('what must still never be messaged', () => {
  it('a cancelled order', async () => {
    const c = await place(9201, { cancelledAt: new Date().toISOString() });
    expect(customerSends(c)).toHaveLength(0);
    expect((await getState('9201')).flowA.codSkip).toBe('ineligible:cancelled');
  });

  it('a COD-Cancelled order', async () => {
    const c = await place(9202, { tags: ['❌ COD-Cancelled'] });
    expect(customerSends(c)).toHaveLength(0);
    expect((await getState('9202')).flowA.codSkip).toBe('ineligible:cod-cancelled-tag');
  });

  it('a Shopify test order', async () => {
    const c = await place(9203, { test: true });
    expect(customerSends(c)).toHaveLength(0);
    expect((await getState('9203')).flowA.codSkip).toBe('ineligible:test-order');
  });
});

describe('idempotency and the safety net', () => {
  it('the same webhook twice, and the timer twice, sends exactly one message', async () => {
    const clients = makeFakeClients();
    clients.shopify.seed(gqlOrder(9301, { otp: null, codkType: null, phones: { shipping: SHIP } }));
    await withFakes(clients, async () => {
      const items = ['a', 'b'].map((k) => shopifyIngest.toItems(
        { 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': `wh-9301-${k}` },
        webhook(9301),
      )[0]);
      for (const i of items) await routes.shopify(i.message);
      const due = _dueTimers(new Date(Date.now() + 10 * 60000));
      for (const t of due) await routes.timer(t.message);
      // The replay: the same timer message delivered a second time.
      for (const t of due) await routes.timer(t.message);
    });
    expect(customerSends(clients)).toHaveLength(1);
  });

  it('a DROPPED webhook is caught by the reconcile sweep and the customer is still told', async () => {
    const c = await place(9302, {
      otp: null,
      codkType: null,
      phones: { shipping: SHIP },
      // An hour old: the sweep leaves anything inside its 20 minute grace
      // window alone, so it does not race the +3 minute timer.
      createdAt: new Date(Date.now() - 60 * 60000).toISOString(),
    }, { skipWebhook: true });
    expect(customerSends(c)).toHaveLength(1);
    expect(customerSends(c)[0].to).toBe(SHIP);
    expect((await getState('9302')).flowA.codConfirmAt).toBeTruthy();
  });
});
