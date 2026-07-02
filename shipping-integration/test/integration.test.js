'use strict';

/**
 * End-to-end integration tests for the automation hub (no real network).
 * The real Express app listens on an ephemeral port; global.fetch is replaced
 * with a mock Shopify Admin API + WhatsApp Cloud API + Brevo. Requests go
 * through real HTTP exactly the way the node-workflow platform will call the
 * hub, and the last test simulates the platform's own HttpRequest -> If
 * expression contract against the flow graph the seeder creates.
 */
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_test';
process.env.SHOPIFY_API_SECRET = 'topsecret';
process.env.SHIPROCKET_EMAIL = 'a@b.com';
process.env.SHIPROCKET_PASSWORD = 'pw';
process.env.SHIPROCKET_PICKUP_LOCATION = 'Primary';
process.env.SHIPROCKET_WEBHOOK_TOKEN = 'tok123';
process.env.AUTOMATION_SHARED_SECRET = 'autosecret';
process.env.WHATSAPP_ENABLED = 'true';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAtest';
process.env.BREVO_ENABLED = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../src/index');

/* -------------------- fetch mock -------------------- */

const outbound = []; // every intercepted call: { host, body }

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const FIXTURES = {
  abandonedCheckouts: {
    nodes: [
      { // eligible: 2h idle, consented phone
        id: 'gid://shopify/AbandonedCheckout/1',
        abandonedCheckoutUrl: 'https://test.myshopify.com/12345/checkouts/abc/recover?key=k1',
        createdAt: iso(3 * HOUR), updatedAt: iso(2 * HOUR),
        totalPriceSet: { shopMoney: { amount: '2499.00', currencyCode: 'INR' } },
        customer: {
          id: 'gid://shopify/Customer/1', firstName: 'Asha',
          defaultEmailAddress: { emailAddress: 'asha@x.in', marketingState: 'SUBSCRIBED' },
          defaultPhoneNumber: { phoneNumber: '+91 98765 43210', marketingState: 'SUBSCRIBED' },
          defaultAddress: { phone: null },
        },
        lineItems: { nodes: [{ title: 'Raat Rani', quantity: 1 }] },
      },
      { // too fresh: 10 min idle
        id: 'gid://shopify/AbandonedCheckout/2',
        abandonedCheckoutUrl: 'https://test.myshopify.com/12345/checkouts/def/recover',
        createdAt: iso(HOUR), updatedAt: iso(10 * 60 * 1000),
        totalPriceSet: { shopMoney: { amount: '1899.00', currencyCode: 'INR' } },
        customer: {
          id: 'gid://shopify/Customer/2', firstName: 'Meera',
          defaultEmailAddress: null,
          defaultPhoneNumber: { phoneNumber: '+919876500000', marketingState: 'SUBSCRIBED' },
          defaultAddress: { phone: null },
        },
        lineItems: { nodes: [] },
      },
      { // no consent
        id: 'gid://shopify/AbandonedCheckout/3',
        abandonedCheckoutUrl: 'https://test.myshopify.com/12345/checkouts/ghi/recover',
        createdAt: iso(5 * HOUR), updatedAt: iso(4 * HOUR),
        totalPriceSet: { shopMoney: { amount: '999.00', currencyCode: 'INR' } },
        customer: {
          id: 'gid://shopify/Customer/3', firstName: 'Zoya',
          defaultEmailAddress: null,
          defaultPhoneNumber: { phoneNumber: '+919876511111', marketingState: 'NOT_SUBSCRIBED' },
          defaultAddress: { phone: null },
        },
        lineItems: { nodes: [] },
      },
    ],
  },
  codOrders: {
    nodes: [
      { // eligible COD, 1h old
        id: 'gid://shopify/Order/10', name: '#1051', createdAt: iso(HOUR), tags: [],
        paymentGatewayNames: ['Cash on Delivery (COD)'],
        displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
        totalPriceSet: { shopMoney: { amount: '3199.00', currencyCode: 'INR' } },
        phone: null, customer: { firstName: 'Asha', defaultPhoneNumber: { marketingState: 'SUBSCRIBED' } },
        shippingAddress: { phone: '9876543210' }, billingAddress: null,
      },
      { // prepaid: must be skipped
        id: 'gid://shopify/Order/11', name: '#1052', createdAt: iso(HOUR), tags: [],
        paymentGatewayNames: ['Razorpay Secure'],
        displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
        totalPriceSet: { shopMoney: { amount: '2199.00', currencyCode: 'INR' } },
        phone: '9876543211', customer: { firstName: 'Meera', defaultPhoneNumber: null },
        shippingAddress: null, billingAddress: null,
      },
    ],
  },
  reviewOrders: {
    nodes: [
      { // delivered 4 days ago, consented -> due
        id: 'gid://shopify/Order/20', name: '#1040',
        createdAt: iso(7 * 24 * HOUR),
        tags: ['mp-delivered', `mp-delivered-on-${new Date(Date.now() - 4 * 24 * HOUR).toISOString().slice(0, 10)}`],
        paymentGatewayNames: ['Razorpay Secure'],
        displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
        totalPriceSet: { shopMoney: { amount: '2499.00', currencyCode: 'INR' } },
        phone: '9876543212', customer: { firstName: 'Rhea', defaultPhoneNumber: { marketingState: 'SUBSCRIBED' } },
        shippingAddress: null, billingAddress: null,
      },
      { // delivered yesterday -> too soon
        id: 'gid://shopify/Order/21', name: '#1049',
        createdAt: iso(2 * 24 * HOUR),
        tags: ['mp-delivered', `mp-delivered-on-${new Date(Date.now() - 1 * 24 * HOUR).toISOString().slice(0, 10)}`],
        paymentGatewayNames: ['Razorpay Secure'],
        displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
        totalPriceSet: { shopMoney: { amount: '1499.00', currencyCode: 'INR' } },
        phone: '9876543213', customer: { firstName: 'Nina', defaultPhoneNumber: { marketingState: 'SUBSCRIBED' } },
        shippingAddress: null, billingAddress: null,
      },
    ],
  },
};

let ledgerValue = null; // simulated shop metafield
const taggedOrders = {}; // orderGid -> [tags]

const realFetch = global.fetch;
global.fetch = async function mockFetch(url, opts = {}) {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  outbound.push({ url: u, body });

  const respond = (obj) =>
    new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

  if (u.includes('graph.facebook.com')) {
    return respond({ messages: [{ id: 'wamid.test.' + outbound.length }] });
  }
  if (u.includes('api.brevo.com')) {
    return respond({ messageId: 'brevo-test' });
  }
  if (u.includes('/graphql.json')) {
    const q = body.query || '';
    if (q.includes('abandonedCheckouts')) return respond({ data: { abandonedCheckouts: FIXTURES.abandonedCheckouts } });
    if (q.includes('AutomationLedger')) {
      return respond({ data: { shop: { id: 'gid://shopify/Shop/1', metafield: ledgerValue ? { id: 'mf1', value: ledgerValue } : null } } });
    }
    if (q.includes('metafieldsSet')) {
      ledgerValue = body.variables.metafields[0].value;
      return respond({ data: { metafieldsSet: { metafields: [{ id: 'mf1' }], userErrors: [] } } });
    }
    if (q.includes('AutomationOrders')) {
      const search = body.variables.query || '';
      const fixture = search.includes('mp-delivered') ? FIXTURES.reviewOrders : FIXTURES.codOrders;
      return respond({ data: { orders: fixture } });
    }
    if (q.includes('tagsAdd')) {
      const gid = body.variables.id;
      taggedOrders[gid] = (taggedOrders[gid] || []).concat(body.variables.tags);
      return respond({ data: { tagsAdd: { userErrors: [] } } });
    }
    return respond({ data: {} });
  }
  // anything else (e.g. hub self-calls in the flow simulation) -> real fetch
  return realFetch(url, opts);
};

/* -------------------- server -------------------- */

let server, base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(() => server.close());

const call = (task, headers = { 'x-automation-secret': 'autosecret' }, payload = {}) =>
  realFetch(`${base}/automations/${task}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

/* -------------------- tests -------------------- */

test('auth: missing/wrong secret rejected, unknown task 404', async () => {
  assert.strictEqual((await call('abandoned-checkouts', {})).status, 401);
  assert.strictEqual((await call('abandoned-checkouts', { 'x-automation-secret': 'nope' })).status, 401);
  assert.strictEqual((await call('does-not-exist')).status, 404);
});

test('abandoned checkouts: sends WhatsApp to the one eligible checkout, writes ledger', async () => {
  const res = await call('abandoned-checkouts');
  assert.strictEqual(res.status, 200);
  const s = await res.json();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.scanned, 3);
  assert.strictEqual(s.eligible, 1);
  assert.strictEqual(s.sent, 1);
  assert.strictEqual(s.skippedReasons['too fresh'], 1);
  assert.strictEqual(s.skippedReasons['no marketing consent'], 1);

  const wa = outbound.filter((o) => o.url.includes('graph.facebook.com'));
  assert.strictEqual(wa.length, 1);
  assert.strictEqual(wa[0].body.to, '919876543210');
  assert.strictEqual(wa[0].body.template.name, 'abandoned_checkout_reminder');
  const btn = wa[0].body.template.components.find((c) => c.type === 'button');
  assert.ok(btn.parameters[0].text.includes('checkouts/abc/recover'));
  assert.ok(JSON.parse(ledgerValue).includes('gid://shopify/AbandonedCheckout/1'));
});

test('abandoned checkouts: second run is a no-op (ledger dedup)', async () => {
  const s = await (await call('abandoned-checkouts')).json();
  assert.strictEqual(s.eligible, 0);
  assert.strictEqual(s.skippedReasons['already contacted'], 1);
});

test('COD confirmation: messages the COD order only, tags it', async () => {
  const s = await (await call('cod-confirmation')).json();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.eligible, 1);
  assert.strictEqual(s.sent, 1);
  const wa = outbound.filter((o) => o.url.includes('graph.facebook.com'));
  const last = wa[wa.length - 1];
  assert.strictEqual(last.body.template.name, 'cod_order_confirmation');
  assert.deepStrictEqual(
    last.body.template.components[0].parameters.map((p) => p.text),
    ['Asha', '#1051', 'Rs 3,199']
  );
  assert.ok(taggedOrders['gid://shopify/Order/10'].includes('mp-cod-confirm-sent'));
});

test('review requests: only the 4-day-old delivered order is due', async () => {
  const s = await (await call('review-requests')).json();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.scanned, 2);
  assert.strictEqual(s.eligible, 1);
  assert.strictEqual(s.sent, 1);
  assert.ok(taggedOrders['gid://shopify/Order/20'].includes('mp-review-request-sent'));
});

test('dry run: reports but sends nothing, tags nothing, no ledger writes', async () => {
  const waBefore = outbound.filter((o) => o.url.includes('graph.facebook.com')).length;
  ledgerValue = null; // reset so checkout 1 is eligible again
  const s = await (await call('abandoned-checkouts', undefined, { dryRun: true })).json();
  assert.strictEqual(s.dryRun, true);
  assert.strictEqual(s.eligible, 1);
  assert.strictEqual(s.sent, 0); // skipped: dry run
  const waAfter = outbound.filter((o) => o.url.includes('graph.facebook.com')).length;
  assert.strictEqual(waAfter, waBefore);
  assert.strictEqual(ledgerValue, null);
});

test('flow contract: the seeded graph passes the platform If gate on this response', async () => {
  // Mirrors node-workflow's expressionResolver (whole-string token -> raw
  // typed value) and IfNode.evaluate('equals' uses loose ==), per source.
  const res = await call('cod-confirmation');
  const httpNodeOutput = {
    statusCode: res.status,
    body: await res.json(),
    ok: res.status >= 200 && res.status < 300,
  };
  const ctx = { 'Run Task': { output: httpNodeOutput } };
  const resolve = (tpl) => {
    if (!/^\{\{[^}]+\}\}$/.test(tpl.trim())) return tpl;
    let v = ctx;
    for (const k of tpl.trim().slice(2, -2).split('.')) { v = v && v[k]; if (v === undefined) return ''; }
    return v;
  };
  const condition = { left: resolve('{{Run Task.output.body.ok}}'), operator: 'equals', right: true };
  // eslint-disable-next-line eqeqeq
  assert.strictEqual(condition.left == condition.right, true);
  assert.strictEqual(typeof resolve('{{Run Task.output.body.sent}}'), 'number');
});
