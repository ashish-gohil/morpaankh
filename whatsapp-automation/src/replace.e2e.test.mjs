/*
 * replace.e2e.test.mjs — one /replace journey end to end, with the REAL
 * Delhivery adapter in the chain and only `fetch` stubbed.
 *
 * replace.test.mjs drives the state machine through the fake courier, which is
 * the right tool for the branches but proves nothing about the request we
 * actually put on the wire. This one wires the real adapter in, so the payload
 * construction, the form encoding and the response classifier are all part of
 * the test: a Delhivery reply that says "success" at HTTP 200 while the package
 * failed has to come out of here as a refusal, not as a booked parcel.
 *
 * Real modules throughout (domain, store, messages, adapter), memory table,
 * only WhatsApp, Shopify and the network faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../src/config.mjs';
import { RULES } from '../src/../messages/rules.mjs';
import { _resetMemory, table } from '../src/store/table.mjs';
import { _resetSecrets } from '../src/secrets.mjs';
import { makeFakeClients } from '../src/clients/fakes/index.mjs';
import { ensureState, patchState, patchFlowB } from '../src/store/orderState.mjs';
import { getAwbMap } from '../src/store/maps.mjs';
import { touchInbound } from '../src/store/phoneProfile.mjs';
import { decodePayload } from '../src/lib/ids.mjs';
import { delhivery } from '../src/clients/logistics/delhivery.mjs';
import * as store from '../src/store/replace.mjs';
import * as RP from '../src/worker/replace.run.mjs';

const ADMIN = '+919999999999';
const CUSTOMER = '+919812345678';
const ORDER = '12345';
const PRODUCT = 'gid://shopify/Product/9';
const VAR = (n) => `gid://shopify/ProductVariant/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;
const NOW = new Date('2026-10-22T09:00:00Z');

const size = (s) => [{ name: 'Size', value: s }];
const variant = (id, s) => ({
  id: VAR(id),
  title: s,
  sku: `NOOR-${s}`,
  price: '1249.00',
  availableForSale: true,
  inventoryQuantity: 5,
  selectedOptions: size(s),
});

const product = {
  id: PRODUCT,
  handle: 'noor',
  title: 'Noor',
  options: [{ name: 'Size', values: ['M', 'XL'] }],
  variants: { nodes: [variant(100, 'M'), variant(101, 'XL')] },
};

const order = {
  id: `gid://shopify/Order/${ORDER}`,
  name: '#1234',
  tags: [],
  test: false,
  createdAt: '2026-10-10T06:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  paymentGatewayNames: ['Cash on Delivery (COD)'],
  netPaymentSet: { shopMoney: { amount: '1299.00' } },
  currentTotalPriceSet: { shopMoney: { amount: '1299.00' } },
  totalPriceSet: { shopMoney: { amount: '1299.00' } },
  customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919812345678' }],
  customer: { firstName: 'Aarav' },
  shippingLines: { nodes: [] },
  fulfillments: [
    { status: 'SUCCESS', createdAt: '2026-10-12T06:00:00Z', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] },
  ],
  lineItems: {
    nodes: [
      {
        id: LI(1),
        title: 'Noor',
        quantity: 1,
        currentQuantity: 1,
        variantTitle: 'M',
        product: { id: PRODUCT, handle: 'noor' },
        variant: { id: VAR(100), selectedOptions: size('M') },
        originalUnitPriceSet: { shopMoney: { amount: '1249.00' } },
        discountAllocations: [],
      },
    ],
  },
};

const shippingSeed = {
  [ORDER]: {
    orderName: '#1234',
    address: {
      name: 'Aarav Sharma',
      address1: '14 Jhalana Road & Co',
      address2: 'Malviya Nagar',
      city: 'Jaipur',
      state: 'Rajasthan',
      pin: '302017',
      country: 'India',
      phone: '+919812345678',
    },
    lines: [{ id: LI(1), sku: 'NOOR-M', quantity: 1, currentQuantity: 1, variantId: VAR(100) }],
  },
};

/** Every call the stubbed network saw, so a payload can be read back. */
let wire = [];
const bodyOf = (init) => {
  const raw = String(init?.body || '');
  const m = /(?:^|&)data=([^&]*)/.exec(raw);
  return m ? JSON.parse(decodeURIComponent(m[1])) : null;
};
const createdShipments = () =>
  wire.filter((c) => c.url.includes('/api/cmu/create.json')).map((c) => bodyOf(c.init).shipments[0]);

const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
const serviceable = { delivery_codes: [{ postal_code: { pickup: 'Y', pre_paid: 'Y', is_oda: 'N', remarks: '' } }] };

/**
 * `plan` maps a path fragment to a handler, so a test says only how Delhivery
 * answers and nothing about the order of calls.
 */
function stubNetwork(plan) {
  wire = [];
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    wire.push({ url: u, init });
    for (const [frag, reply] of Object.entries(plan)) {
      if (u.includes(frag)) return reply(u, init);
    }
    return ok({});
  });
}

async function world() {
  const clients = makeFakeClients({ shopify: { products: { [PRODUCT]: product }, shipping: shippingSeed } });
  clients.shopify.seed(order);
  // The real adapter, not the fake: this is the point of the file.
  clients.logistics = delhivery;
  await ensureState(ORDER, {});
  await patchState(ORDER, { class: 'COD', verifiedPhone: CUSTOMER, name: '#1234', awb: 'AWB1' });
  await patchFlowB(ORDER, { deliveredAt: '2026-10-20T06:00:00Z' });
  await touchInbound(ADMIN, NOW);
  return { clients, deps: { clients, now: NOW } };
}

const sent = (c) => c.whatsapp.sent;
const said = (c, phone) => sent(c).filter((s) => s.to === phone).map((s) => s.body || '').join('\n');
const lastTo = (c, phone) => sent(c).filter((s) => s.to === phone).slice(-1)[0];
const shopifyWrites = (c) =>
  c.shopify.calls
    .map((x) => x.op)
    .filter((o) => !['getOrder', 'getOrderByName', 'getProductVariants', 'getShippingDetails'].includes(o));

/*
 * `pays:us` by default here too. The parser defaults a size change to
 * pays:customer and N4 then holds the booking until the freight is paid; these
 * tests are about the adapter and the booking, so they skip that gate. The
 * collection has its own tests in worker/replace.test.mjs.
 */
const run = (deps, text = '/replace 1234 noor m xl pays:us') => RP.onOwnerRequest(text, deps, ADMIN);
const confirm = async (deps) => {
  const r = await store.latestRequest(ORDER);
  const action = Object.fromEntries(
    (lastTo(deps.clients, ADMIN).buttons || []).map((b) => [b.title, decodePayload(b.id).action]),
  );
  return RP.route(ORDER, action.Confirm || `rpok:${r.seq}:${r.nonce}`, deps, ADMIN);
};

beforeEach(() => {
  _resetMemory();
  _resetSecrets();
  process.env.DELHIVERY_TOKEN = 'test-token';
  config.replaceMode = 'live';
  config.dryRun = false;
  config.replaceAdminPhones = [ADMIN];
  config.ownerAlertPhones = ['+919000000000'];
  config.replaceTestOrders = [];
  config.replaceRequireConfirm = true;
  config.replaceNotifyCustomer = true;
  config.replaceSendLabel = true;
  config.delhiveryPickupLocation = 'Morpaankh Studio';
  config.sellerGstin = '08ABCDE1234F1Z5';
  config.replaceReturnTo = {};
  // RULES.replace.hsn ships empty on purpose; a guessed tax code is worse than
  // a refusal. The owner's real value is stood in for here.
  RULES.replace.hsn = '6204';
});

afterEach(() => {
  config.dryRun = true;
  config.replaceMode = 'shadow';
  vi.restoreAllMocks();
});

describe('POSITIVE: the whole way through, over the real adapter', () => {
  it('previews, books both legs prepaid, messages the customer, writes nothing to Shopify', async () => {
    let created = 0;
    stubNetwork({
      '/c/api/pin-codes': () => ok(serviceable),
      '/invoice/charges': () => ok([{ total_amount: 61 }]),
      '/api/cmu/create.json': () =>
        ok({ success: true, packages: [{ status: 'Success', waybill: `1490000000${++created}`, refnum: 'r' }] }),
      '/api/p/packing_slip': () => ok({ packages: [{ pdf_download_link: 'https://example.test/label.pdf' }] }),
    });
    const { clients, deps } = await world();
    // The customer wrote in, so their window is open and the twin is free.
    await touchInbound(CUSTOMER, NOW);

    await run(deps);
    const preview = said(clients, ADMIN);
    expect(preview).toMatch(/#1234/);
    expect(preview).toMatch(/xxxxxx5678/); // masked to the last four, never full
    expect(preview).not.toMatch(/\+919812345678/);
    expect(preview).toMatch(/Noor/);

    await confirm(deps);

    const req = await store.latestRequest(ORDER);
    expect(req.state).toBe('DONE');
    expect(req.returnAwb).toBeTruthy();
    expect(req.forwardAwb).toBeTruthy();
    expect(req.returnAwb).not.toBe(req.forwardAwb);

    // Two shipments, and the REAL payloads say what they must.
    const [reverse, forward] = createdShipments();
    expect(createdShipments()).toHaveLength(2);
    expect(reverse.payment_mode).toBe('Pickup');
    expect(forward.payment_mode).toBe('Prepaid');
    expect(forward.cod_amount).toBe(0);
    expect(JSON.stringify(reverse) + JSON.stringify(forward)).not.toMatch(/&/); // sanitised
    expect(forward.add).toMatch(/and Co/); // "&" became "and", not dropped

    /*
     * The reference is built from the ORDER NAME (#1234 -> 1234), not the
     * numeric id, because it is what a human searches for in Delhivery One when
     * the runbook says "check that reference before rebooking by hand". It is
     * also what a later findByRef adopts a duplicate by, so the format is load
     * bearing in both directions.
     */
    expect(reverse.order).toBe('1234-REPLACE-1R');
    expect(forward.order).toBe('1234-REPLACE-1F');
    /*
     * The order number LEADS, so one search for 1234 in Delhivery One finds the
     * original delivery and both replacement legs together.
     */
    expect(reverse.order.startsWith('1234')).toBe(true);
    expect(forward.order.startsWith('1234')).toBe(true);
    /*
     * The two legs must never share a reference. bookLeg answers a duplicate
     * reference by calling findByRef and adopting whatever it returns, so one
     * shared string could staple the return waybill onto the forward leg.
     */
    expect(reverse.order).not.toBe(forward.order);
    // Letters, digits and hyphens only: the alphabet cmu/create.json has
    // actually accepted. No underscore, no '#', no space.
    for (const ref of [reverse.order, forward.order]) expect(ref).toMatch(/^[A-Za-z0-9-]+$/);

    // Never a pickup request, for either leg.
    expect(wire.some((c) => /pickup/i.test(c.url) && !c.url.includes('pin-codes'))).toBe(false);

    // The customer heard once, on their own open window, and nothing else.
    const toCustomer = sent(clients).filter((s) => s.to === CUSTOMER);
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0].type).not.toBe('template'); // the free twin, no template charge
    expect(said(clients, CUSTOMER)).toMatch(/we are sending a replacement/i);

    // Shopify was read and never written.
    expect(shopifyWrites(clients)).toEqual([]);

    // Neither waybill may reach the poller: the AWB map must not know them.
    expect(await getAwbMap(req.returnAwb)).toBeFalsy();
    expect(await getAwbMap(req.forwardAwb)).toBeFalsy();
    const repl = await table.get(`REPLAWB#${req.forwardAwb}`, 'MAP');
    expect(repl.orderId).toBe(ORDER);
    expect(repl.activeShipment).toBeUndefined(); // the attribute that would arm GSI1
  });
});

describe('NEGATIVE: Delhivery says 200 and means no', () => {
  it('treats a failed package inside a 200 as a refusal, books nothing, messages no customer', async () => {
    stubNetwork({
      '/c/api/pin-codes': () => ok(serviceable),
      '/invoice/charges': () => ok([{ total_amount: 61 }]),
      // HTTP 200, success:false, the shape that would read as a booking to
      // anything that only checked the status code.
      '/api/cmu/create.json': () =>
        ok({ success: false, rmk: 'Low wallet balance', packages: [{ status: 'Fail', remarks: ['Low wallet balance'] }] }),
    });
    const { clients, deps } = await world();
    await touchInbound(CUSTOMER, NOW);

    await run(deps);
    await confirm(deps);

    const req = await store.latestRequest(ORDER);
    expect(req.state).toBe('FAILED');
    expect(req.returnAwb).toBeFalsy();
    // The provider's words reach the owner verbatim, with the command that fixes it.
    expect(said(clients, ADMIN)).toMatch(/Low wallet balance/);
    expect(said(clients, ADMIN)).toMatch(/\/replace retry 1234/);
    // The customer is told nothing: no leg exists.
    expect(sent(clients).filter((s) => s.to === CUSTOMER)).toHaveLength(0);
    expect(shopifyWrites(clients)).toEqual([]);
  });

  it('adopts the existing shipment when the reference comes back duplicate, never a second parcel', async () => {
    let creates = 0;
    stubNetwork({
      '/c/api/pin-codes': () => ok(serviceable),
      '/invoice/charges': () => ok([{ total_amount: 61 }]),
      '/api/cmu/create.json': () => {
        creates += 1;
        return ok({ success: false, rmk: 'Duplicate order id', packages: [{ status: 'Fail', remarks: ['Duplicate order id'] }] });
      },
      // The parcel Delhivery already holds against our reference.
      '/api/v1/packages/json/': () =>
        ok({ ShipmentData: [{ Shipment: { AWB: '1490999999', Status: { Status: 'Manifested', StatusCode: 'X-UCI' } } }] }),
    });
    const { clients, deps } = await world();
    await touchInbound(CUSTOMER, NOW);

    await run(deps);
    await confirm(deps);

    const req = await store.latestRequest(ORDER);
    // Adopted, not re-booked: the reverse leg exists and only one create per leg went out.
    expect(req.returnAwb).toBe('1490999999');
    expect(creates).toBeLessThanOrEqual(2); // one per leg, never a retry of either
    expect(shopifyWrites(clients)).toEqual([]);
  });
});
