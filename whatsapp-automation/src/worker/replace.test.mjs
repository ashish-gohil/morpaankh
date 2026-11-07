/*
 * replace.test.mjs — the /replace state machine, driven through the fakes.
 *
 * The four properties asserted hardest, because each one of them is a parcel or
 * a customer:
 *
 *   1. SHOPIFY IS NEVER WRITTEN. Every assertion that counts writes expects an
 *      empty list: /replace reads orders and products and nothing else.
 *   2. ONE REPLACEMENT IS ONE PARCEL PER LEG. A timeout, a duplicate reference
 *      and a retry all have to end with exactly one createReverse call.
 *   3. THE REPLACEMENT WAYBILLS STAY OUT OF THE ORDER MAP, so the poller cannot
 *      fire Flow B or Flow C on the original order.
 *   4. THE CUSTOMER IS NEVER MESSAGED SILENTLY OR WRONGLY: once both legs
 *      exist, never before, and never without telling the admin what happened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { _resetMemory, table } from '../store/table.mjs';
import { getWamidMap } from '../store/maps.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { ensureState, patchState, patchFlowB, getSide, getState } from '../store/orderState.mjs';
import { _peekTimers } from '../timers/schedule.mjs';
import * as B from './flowB.run.mjs';
import { getAwbMap } from '../store/maps.mjs';
import { table } from '../store/table.mjs';
import { touchInbound, setOptOut } from '../store/phoneProfile.mjs';
import { decodePayload } from '../lib/ids.mjs';
import * as store from '../store/replace.mjs';
import * as RP from './replace.run.mjs';

const ADMIN = '+919999999999';
const CUSTOMER = '+919812345678';
const STRANGER = '+919800000000';
const ORDER = '12345';
const PRODUCT = 'gid://shopify/Product/9';
const VAR = (n) => `gid://shopify/ProductVariant/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;
const NOW = new Date('2026-10-22T09:00:00Z');

const size = (s) => [{ name: 'Size', value: s }];

const variant = (id, s, over = {}) => ({
  id: VAR(id),
  title: s,
  sku: `NOOR-${s}`,
  price: '1249.00',
  availableForSale: true,
  inventoryQuantity: 5,
  selectedOptions: size(s),
  ...over,
});

const product = {
  id: PRODUCT,
  handle: 'noor',
  title: 'Noor',
  options: [{ name: 'Size', values: ['M', 'XL'] }],
  variants: { nodes: [variant(100, 'M'), variant(101, 'XL')] },
};

const order = (over = {}) => ({
  id: `gid://shopify/Order/${ORDER}`,
  name: '#1234',
  tags: ['LOW RTO Risk'],
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
  fulfillments: [{ status: 'SUCCESS', createdAt: '2026-10-12T06:00:00Z', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }],
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
  ...over,
});

const ADDRESS = {
  name: 'Aarav Sharma',
  address1: '14 Jhalana Road',
  address2: 'Malviya Nagar',
  city: 'Jaipur',
  state: 'Rajasthan',
  pin: '302017',
  country: 'India',
  phone: '+919812345678',
};

const shippingSeed = {
  [ORDER]: {
    orderName: '#1234',
    address: ADDRESS,
    lines: [{ id: LI(1), sku: 'NOOR-M', quantity: 1, currentQuantity: 1, variantId: VAR(100) }],
  },
};

/**
 * `fail` is handed to the fake as a LIVE object so a test can switch a provider
 * failure off between two runs. That is the only way to drive "it failed, the
 * owner fixed the wallet, then /replace retry finished it" in one test.
 */
async function setup({ logistics = {}, over = {}, delivered = '2026-10-20T06:00:00Z', openWindows = true } = {}) {
  const fail = logistics.fail || {};
  const clients = makeFakeClients({
    shopify: { products: { [PRODUCT]: product }, shipping: shippingSeed },
    logistics: { ...logistics, fail },
  });
  clients.shopify.seed(order(over));
  await ensureState(ORDER, {});
  await patchState(ORDER, { class: 'COD', verifiedPhone: CUSTOMER, name: '#1234', awb: 'AWB1' });
  if (delivered) await patchFlowB(ORDER, { deliveredAt: delivered });
  // An admin who just typed a command has an open window by definition, so
  // their replies are free-form. The customer's window is opened separately by
  // the tests that care which door the message goes through.
  if (openWindows) await touchInbound(ADMIN, NOW);
  return { clients, fail, deps: { clients, now: NOW } };
}

const sent = (c) => c.whatsapp.sent;
const to = (c, phone) => sent(c).filter((s) => s.to === phone);
const said = (c, phone) => to(c, phone).map((s) => s.body || '').join('\n');
const lastTo = (c, phone) => to(c, phone)[to(c, phone).length - 1];
const bookings = (c) => c.logistics.calls.filter((x) => x.op !== 'cancel').map((x) => x.op);
/** Shopify ops that are not reads. /replace must never produce one. */
const writes = (c) =>
  c.shopify.calls
    .map((x) => x.op)
    .filter((o) => !['getOrder', 'getOrderByName', 'getProductVariants', 'getShippingDetails'].includes(o));
const req = () => store.latestRequest(ORDER);

/** The Confirm / Cancel actions off the preview's buttons. */
const previewActions = (c) =>
  Object.fromEntries((lastTo(c, ADMIN).buttons || []).map((b) => [b.title, decodePayload(b.id).action]));

/*
 * `pays:us` by DEFAULT in these tests, deliberately.
 *
 * The parser defaults a size change to pays:customer, and N4 then holds the
 * booking until the freight is paid. Every test below is about the BOOKING
 * mechanics, so they say pays:us to get past that gate; the collection itself
 * has its own describe block at the end of this file.
 */
const run = (deps, text = '/replace 1234 noor m xl pays:us') => RP.onOwnerRequest(text, deps, ADMIN);
const tap = (deps, action, phone = ADMIN) => RP.route(ORDER, action, deps, phone);

beforeEach(() => {
  _resetMemory();
  config.replaceMode = 'live';
  config.replaceAdminPhones = [ADMIN];
  config.ownerAlertPhones = ['+919000000000'];
  config.replaceTestOrders = [];
  config.replaceRequireConfirm = true;
  config.replaceAllowSkipConfirm = false;
  config.replaceNotifyCustomer = true;
  config.replaceSendLabel = true;
  config.delhiveryPickupLocation = 'Morpaankh Studio';
  config.sellerGstin = '08ABCDE1234F1Z5';
  config.replaceReturnTo = { name: 'Morpaankh', address1: '2 Civil Lines', city: 'Jaipur', state: 'Rajasthan', pin: '302006', phone: '+919000000000' };
  // RULES.replace.hsn ships EMPTY on purpose (a guessed HSN is a wrong tax
  // declaration), and an empty one is a hard stop. Every test here is about the
  // state machine, so the owner's value is stood in for.
  RULES.replace.hsn = '6204';
});

describe('the preview', () => {
  it('names the order, the masked phone, the address, the swap, the money and the deadline', async () => {
    const { clients, deps } = await setup();
    // The bare command, so the parser's own default for a size change applies:
    // the customer pays. That is what the preview has to show the owner.
    await run(deps, '/replace 1234 noor m xl');

    const body = said(clients, ADMIN);
    expect(body).toMatch(/Replacement for #1234/);
    expect(body).toMatch(/Aarav Sharma/);
    // Masked to the last 4. The full number never appears anywhere.
    expect(body).toMatch(/\+91xxxxxx5678/);
    expect(body).not.toMatch(/\+919812345678/);
    expect(body).toMatch(/14 Jhalana Road, Malviya Nagar, Jaipur, Rajasthan, 302017/);
    expect(body).toMatch(/1 x Noor, size M goes back, Noor, size XL goes out/);
    expect(body).toMatch(/Paid as: COD/);
    // This test drives the command itself, so it keeps the parser's own
    // default for a size change: the customer pays.
    expect(body).toMatch(/Freight paid by: customer/);
    expect(body).toMatch(/reverse pickup yes, prepaid delivery yes/);
    expect(body).toMatch(/pickup Rs 70, delivery Rs 70/);
    expect(body).toMatch(/Confirm by .* IST/);
    // The COD warning is printed, never acted on.
    expect(body).toMatch(/Note: The original order was COD/);

    expect(previewActions(clients)).toEqual({ Confirm: 'rpok:1:' + (await req()).nonce, Cancel: 'rpno:1:' + (await req()).nonce });
    expect(bookings(clients)).toEqual([]);
    expect(writes(clients)).toEqual([]);
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  it('says quote unavailable rather than inventing a number', async () => {
    const { clients, deps } = await setup({ logistics: { quoteInr: null } });
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/pickup quote unavailable, delivery quote unavailable/);
  });

  /*
   * A failed pin check is "we did not ask", and validate emits no stop for it on
   * purpose. The preview used to print it as "reverse pickup NO", which is a
   * sentence the courier never said: an actual NO is a hard stop, so no preview
   * is ever sent for one.
   */
  it('says the pin check went unanswered rather than printing it as a refusal', async () => {
    const { clients, deps } = await setup();
    clients.logistics.serviceability = async () => {
      throw new Error('pin codes endpoint down');
    };
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/did not answer the pin check/);
    expect(said(clients, ADMIN)).not.toMatch(/reverse pickup NO/);
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  it('refuses a pin the courier will not pick up from, and books nothing', async () => {
    const { clients, deps } = await setup({ logistics: { pins: { '302017': { reversePickup: false, prepaidDelivery: true } } } });
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/does not do reverse pickup at 302017/);
    expect(bookings(clients)).toEqual([]);
    expect(await req()).toBe(null);
  });

  it('still previews with no HSN set, saying the label goes out without one', async () => {
    RULES.replace.hsn = '';
    const { clients, deps } = await setup();
    await run(deps);
    // A warning, not a refusal: the owner's Delhivery account already holds
    // their GST details, so blocking here made them re-enter what the courier
    // had. The preview still arrives with its Confirm button.
    expect(said(clients, ADMIN)).toMatch(/without one/i);
    expect(lastTo(clients, ADMIN).buttons?.length).toBeGreaterThan(0);
  });

  /*
   * The regression that cost a real replacement. onDelivered writes
   * flowB.deliveredAt only when it also schedules the review ask, and it
   * returns before doing either when the order has no OTP verified phone. The
   * courier status still says DELIVERED. Reading the delivery off Flow B's
   * bookkeeping refused 19 of the 41 delivered orders in the live table with
   * "the courier has not confirmed this order as delivered", which was not
   * true of any of them.
   */
  it('takes the delivery from the courier status when Flow B never recorded one', async () => {
    const { clients, deps } = await setup({ delivered: null });
    await patchState(ORDER, { courierStatus: 'DELIVERED', courierStatusAt: '2026-10-20T06:00:00Z' });
    await run(deps);

    expect(said(clients, ADMIN)).not.toMatch(/has not confirmed this order as delivered/);
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  it('counts a courier delivery that predates courierStatusAt, without measuring its age', async () => {
    // The older live rows: DELIVERED and no timestamp at all. The fact is
    // enough to let the command run; the routine window simply goes unmeasured.
    const { clients, deps } = await setup({ delivered: null });
    await patchState(ORDER, { courierStatus: 'DELIVERED' });
    await run(deps);

    const body = said(clients, ADMIN);
    expect(body).not.toMatch(/has not confirmed this order as delivered/);
    expect(body).not.toMatch(/routine window/);
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  /*
   * The other half of that fix: courierStatusAt is the last status change
   * whatever it was, so an order still moving must not have its transit
   * timestamp read as a delivery.
   */
  it('still says the delivery is unconfirmed while the parcel is in transit', async () => {
    const { clients, deps } = await setup({ delivered: null });
    await patchState(ORDER, { courierStatus: 'IN_TRANSIT', courierStatusAt: '2026-10-20T06:00:00Z' });
    await run(deps);

    expect(said(clients, ADMIN)).toMatch(/has not confirmed this order as delivered/);
    expect(await req()).toBe(null);
  });

  /*
   * The diagnosability gap that made the 22 Oct incident expensive. A refused
   * command used to log nothing, so CloudWatch could not say which order was
   * asked about or why it was turned down.
   */
  it('logs every refusal with its order and its codes, and never the address', async () => {
    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
    try {
      const { deps } = await setup({ delivered: null });
      await run(deps);
      const refusal = lines.filter((l) => l.includes('replace: refused'));
      expect(refusal.join('')).toMatch(/soft:delivery-unconfirmed/);
      expect(refusal.join('')).toMatch(/"order":"1234"/);
      // The reply names the street; the log must not.
      expect(refusal.join('')).not.toMatch(/Jhalana/);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs an unknown order number as a code rather than silently', async () => {
    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
    try {
      const { deps } = await setup();
      await run(deps, '/replace 9999 noor m xl');
      expect(lines.filter((l) => l.includes('replace: refused')).join('')).toMatch(/order-not-found/);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses while the warehouse name is unset, because only a human knows which one', async () => {
    config.delhiveryPickupLocation = '';
    const { clients, deps } = await setup();
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/DELHIVERY_PICKUP_LOCATION/);
    expect(bookings(clients)).toEqual([]);
  });

  /*
   * REPLACE_TEST_ORDERS is the rail the go-live notes promise: "NON-EMPTY means
   * live mode acts ONLY on these order numbers". It was only ever consulted for
   * Shopify TEST orders, so an owner who set it to one order of their own and
   * then flipped REPLACE_MODE=live could still book two real parcels against any
   * order in the store, with a courier payload nothing had verified.
   */
  it('while REPLACE_TEST_ORDERS is set, live mode refuses every order that is not on it', async () => {
    config.replaceTestOrders = ['9999'];
    const { clients, deps } = await setup();
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/not in REPLACE_TEST_ORDERS/);
    expect(bookings(clients)).toEqual([]);
    expect(await req()).toBe(null);
  });

  it('and books the order that IS on it', async () => {
    config.replaceTestOrders = ['1234'];
    const { clients, deps } = await setup();
    await run(deps);
    expect(said(clients, ADMIN)).not.toMatch(/REPLACE_TEST_ORDERS/);
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  it('and shadow stays runnable on any order, because it books nothing', async () => {
    config.replaceMode = 'shadow';
    config.replaceTestOrders = ['9999'];
    const { clients, deps } = await setup();
    await run(deps);
    expect(said(clients, ADMIN)).not.toMatch(/REPLACE_TEST_ORDERS/);
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  it('reports a Shopify permissions failure as a permissions failure', async () => {
    const clients = makeFakeClients({ shopify: { products: { [PRODUCT]: product }, shippingScopeProblem: true }, logistics: {} });
    clients.shopify.seed(order());
    await ensureState(ORDER, {});
    await touchInbound(ADMIN, NOW);
    await run({ clients, now: NOW });
    expect(said(clients, ADMIN)).toMatch(/PERMISSIONS problem and not a typo/);
    expect(bookings(clients)).toEqual([]);
  });
});

describe('Confirm books the return first and then the forward', () => {
  it('books both legs, messages the customer, reports both waybills, and writes nothing to Shopify', async () => {
    const { clients, deps } = await setup();
    await touchInbound(CUSTOMER, NOW); // their window is open
    await run(deps);
    const nonce = (await req()).nonce;

    await tap(deps, `rpok:1:${nonce}`);

    // Return leg FIRST. It is the leg that is right whatever happens next.
    expect(bookings(clients)).toEqual(['createReverse', 'createForward']);
    const r = await req();
    expect(r.state).toBe('DONE');
    expect(r.returnAwb).toBe('FAKEAWB1');
    expect(r.forwardAwb).toBe('FAKEAWB2');
    expect(r.notified).toMatchObject({ sent: 'session' });

    const reply = said(clients, ADMIN);
    expect(reply).toMatch(/Pickup waybill FAKEAWB1/);
    expect(reply).toMatch(/Delivery waybill FAKEAWB2/);
    expect(reply).toMatch(/Label: https:\/\/fake\.delhivery\/label\.pdf/);
    expect(reply).toMatch(/The customer was messaged \(session\)/);
    expect(writes(clients)).toEqual([]);
  });

  it('sends the forward leg prepaid and on surface, and never requests a pickup', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    for (const call of clients.logistics.calls) {
      expect(call.mode).toBe('surface');
      // There is no COD field in the spec at all, and inventing one is how a
      // replacement starts asking the customer for money at the door.
      expect(Object.keys(call.spec)).not.toContain('cod');
    }
    // The adapter is asked to create, never to request a pickup.
    expect(clients.logistics.calls.map((c) => c.op)).toEqual(['createReverse', 'createForward']);
  });

  it('keeps the replacement waybills out of the order AWB map and out of the poller', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);

    // Its own row, which the poller cannot see...
    expect(await store.getReplAwb('FAKEAWB1')).toMatchObject({ orderId: ORDER, seq: 1, leg: 'return' });
    expect(await store.getReplAwb('FAKEAWB2')).toMatchObject({ leg: 'forward' });
    // ...because it carries no activeShipment, which is the attribute that puts
    // a row into GSI1 and makes the poller track it. With it, the reverse leg
    // reaching RTO would fire Flow C on the original order and the forward leg
    // reaching DELIVERED would ask for a second review.
    expect((await table.get('REPLAWB#FAKEAWB1', 'MAP')).activeShipment).toBeUndefined();
    expect(await table.scanGsi1()).toEqual([]);
    expect(await getAwbMap('FAKEAWB1')).toBe(null);
  });

  it('is idempotent: a second Confirm tap answers rather than booking again', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    const nonce = (await req()).nonce;
    await tap(deps, `rpok:1:${nonce}`);
    await tap(deps, `rpok:1:${nonce}`);
    expect(bookings(clients)).toEqual(['createReverse', 'createForward']);
    expect(said(clients, ADMIN)).toMatch(/is already DONE/);
  });
});

describe('one replacement is one parcel per leg', () => {
  /*
   * The exact shape of the accident: the request reached Delhivery, Delhivery
   * booked the pickup, and the connection died before we read the answer. A
   * blind retry here is a second courier at the customer's door.
   */
  it('adopts the shipment the provider already has when the create times out', async () => {
    const { clients, deps } = await setup({
      logistics: {
        byRef: { '1234-REPLACE-1R': { awb: 'DL100', status: 'Manifested' } },
        fail: { createReverse: { code: 'ETIMEDOUT', permanent: false, remark: 'read timeout' } },
      },
    });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);

    // Called ONCE, not retried, and the existing waybill was adopted.
    expect(clients.logistics.calls.filter((c) => c.op === 'createReverse')).toHaveLength(1);
    const r = await req();
    expect(r.returnAwb).toBe('DL100');
    expect(r.returnAdopted).toBe(true);
    expect(r.state).toBe('DONE');
  });

  it('adopts it when the provider calls the reference a duplicate', async () => {
    const { clients, deps } = await setup({
      logistics: {
        byRef: { '1234-REPLACE-1R': { awb: 'DL200', status: 'Manifested' } },
        fail: { createReverse: { duplicate: true, remark: 'ref already used' } },
      },
    });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    expect(clients.logistics.calls.filter((c) => c.op === 'createReverse')).toHaveLength(1);
    expect((await req()).returnAwb).toBe('DL200');
  });

  it('uses deterministic references, so a resume can find what it booked', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    expect(clients.logistics.calls.map((c) => c.ref)).toEqual(['1234-REPLACE-1R', '1234-REPLACE-1F']);
  });
});

describe('the forward leg fails after the return is booked', () => {
  it('keeps the return, sets FAILED, and tells the admin which commands fix it', async () => {
    const { clients, deps } = await setup({
      logistics: { fail: { createForward: { permanent: true, remark: 'Insufficient wallet balance' } } },
    });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);

    const r = await req();
    expect(r.state).toBe('FAILED');
    expect(r.failedStep).toBe('forward');
    expect(r.returnAwb).toBe('FAKEAWB1'); // the return STAYS. It is right either way.
    expect(r.permanent).toBe(true);

    const reply = said(clients, ADMIN);
    expect(reply).toMatch(/RETURN PICKUP IS ALREADY BOOKED \(waybill FAKEAWB1\)/);
    expect(reply).toMatch(/Insufficient wallet balance/); // the provider's words, verbatim
    expect(reply).toMatch(/\/replace retry 1234/);
    expect(reply).toMatch(/\/replace cancel 1234/);
    // The customer hears nothing until both parcels exist.
    expect(to(clients, CUSTOMER)).toEqual([]);
  });

  it('and /replace retry finishes it without booking the return twice', async () => {
    const { clients, fail, deps } = await setup({
      logistics: { fail: { createForward: { permanent: true, remark: 'Insufficient wallet balance' } } },
    });
    await touchInbound(CUSTOMER, NOW);
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    expect((await req()).state).toBe('FAILED');

    delete fail.createForward; // the owner recharged the wallet
    await RP.onOwnerRequest('/replace retry 1234', deps, ADMIN);

    const r = await req();
    expect(r.state).toBe('DONE');
    expect(r.returnAwb).toBe('FAKEAWB1'); // the SAME pickup, read back out of runOnce
    expect(r.forwardAwb).toBe('FAKEAWB2');
    expect(clients.logistics.calls.filter((c) => c.op === 'createReverse')).toHaveLength(1);
    expect(await getSide(ORDER, 'replace:1:R')).toMatchObject({ awb: 'FAKEAWB1' });
    expect(to(clients, CUSTOMER)).toHaveLength(1);
  });

  it('a transient failure on the return leg books nothing and keeps the order clean', async () => {
    const { clients, deps } = await setup({
      logistics: { fail: { createReverse: { code: 'ECONNREFUSED', permanent: false, remark: 'connection refused' } } },
    });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    const r = await req();
    expect(r.state).toBe('FAILED');
    expect(r.failedStep).toBe('return');
    expect(r.returnAwb).toBeUndefined();
    // runOnce records NOTHING when its function throws, which is what makes
    // the retry a fresh attempt rather than a replay of the failure.
    expect(await getSide(ORDER, 'replace:1:R')).toBe(null);
    expect(said(clients, ADMIN)).toMatch(/nothing was booked/);
  });
});

describe('only one execution per order at a time', () => {
  it('two commands racing for the same order leave one preview and one refusal', async () => {
    const { clients, deps } = await setup();
    await Promise.all([run(deps), run(deps)]);

    const rows = await table.query(`REPL#${ORDER}`);
    expect(rows.filter((r) => String(r.SK).startsWith('REQ#'))).toHaveLength(1);
    expect(said(clients, ADMIN)).toMatch(/already has a replacement running/);
    expect(bookings(clients)).toEqual([]);
  });

  /*
   * The owner who never taps Confirm is the common case, and the preview they
   * abandoned used to block that garment for good: it is not mid execution and
   * not terminal, so validate read it as an open replacement forever. Tapping it
   * is refused as stale, so the only way out was /replace cancel on a dead row.
   */
  it('a preview nobody tapped stops blocking once it has gone stale', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    const later = new Date(NOW.getTime() + (RULES.replace.confirmMinutes + 1) * 60 * 1000);
    await touchInbound(ADMIN, later);
    await run({ ...deps, now: later });
    expect(said(clients, ADMIN)).not.toMatch(/already an open replacement/);
    expect((await req()).seq).toBe(2);
  });

  it('a second command once the first is mid execution is refused by validate', async () => {
    const { clients, deps } = await setup({
      logistics: { fail: { createForward: { permanent: true, remark: 'wallet' } } },
    });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/already running \(FAILED\)/);
  });
});

describe('a Confirm tap is only honoured when it is current, correct and ours', () => {
  it('expires a preview older than the confirm window and books nothing', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    const nonce = (await req()).nonce;
    const later = { ...deps, now: new Date(NOW.getTime() + (RULES.replace.confirmMinutes + 1) * 60 * 1000) };
    await tap(later, `rpok:1:${nonce}`);
    expect((await req()).state).toBe('EXPIRED');
    expect(bookings(clients)).toEqual([]);
    expect(said(clients, ADMIN)).toMatch(/more than 15 minutes old/);
  });

  it('refuses a superseded preview, because a newer command replaced it', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    const first = await req();
    await run(deps, '/replace 1234 noor m xl again');
    expect((await req()).seq).toBe(2);

    await tap(deps, `rpok:1:${first.nonce}`);
    expect(said(clients, ADMIN)).toMatch(/newer \/replace .* has replaced that one/);
    expect(bookings(clients)).toEqual([]);
    expect((await store.getRequest(ORDER, 1)).state).toBe('AWAITING_CONFIRMATION');
  });

  it('refuses a tap carrying the wrong nonce', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await tap(deps, 'rpok:1:000000');
    expect(said(clients, ADMIN)).toMatch(/belongs to an older preview/);
    expect(bookings(clients)).toEqual([]);
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  it('ignores a Confirm tap from a phone that is not an admin, and answers it nothing', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    const before = sent(clients).length;
    await tap(deps, `rpok:1:${(await req()).nonce}`, STRANGER);
    expect(bookings(clients)).toEqual([]);
    expect(sent(clients)).toHaveLength(before); // not even a refusal: they learn nothing
    expect((await req()).state).toBe('AWAITING_CONFIRMATION');
  });

  it('Cancel at the preview rejects it without touching the courier', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await tap(deps, `rpno:1:${(await req()).nonce}`);
    expect((await req()).state).toBe('REJECTED');
    expect(bookings(clients)).toEqual([]);
    expect(to(clients, CUSTOMER)).toEqual([]);
    // Idempotent the same way Confirm is.
    await tap(deps, `rpno:1:${(await req()).nonce}`);
    expect(said(clients, ADMIN)).toMatch(/is already REJECTED/);
  });

  it('swallows a tap while the mode is off rather than letting it fall through', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    config.replaceMode = 'off';
    const before = sent(clients).length;
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    expect(bookings(clients)).toEqual([]);
    expect(sent(clients)).toHaveLength(before);
  });

  it('is not ours when the action is not rpok or rpno', async () => {
    const { deps } = await setup();
    expect(RP.route(ORDER, 'vcok:1:101', deps, ADMIN)).toBe(null);
  });
});

describe('the customer message', () => {
  const confirm = async (deps) => {
    await run(deps);
    return tap(deps, `rpok:1:${(await req()).nonce}`);
  };

  it('goes free-form while the 24 hour window is open', async () => {
    const { clients, deps } = await setup();
    await touchInbound(CUSTOMER, NOW);
    await confirm(deps);
    const m = lastTo(clients, CUSTOMER);
    expect(m.type).toBe('text');
    expect(m.body).toMatch(/we are sending a replacement for your order/);
    expect(m.body).toMatch(/collect Noor, size M/);
    expect(m.body).toMatch(/dispatch Noor, size XL/);
    expect((await req()).notified).toMatchObject({ sent: 'session' });
  });

  it('goes as the approved template once the window has closed', async () => {
    const { clients, deps } = await setup();
    await confirm(deps); // the customer never wrote to us
    const m = lastTo(clients, CUSTOMER);
    expect(m.type).toBe('template');
    expect(m.name).toBe('replacement_raised_v1');
    expect((await req()).notified).toMatchObject({ sent: 'template' });
  });

  it('logs the template against the order, so a later refusal reaches someone', async () => {
    // "Never a silent failure" is this function's promise, and a template Meta
    // accepts can still be refused seconds later on a status webhook carrying
    // only the wamid. Without the reverse map onWaStatus names no order and the
    // failure is dropped.
    const { deps } = await setup();
    await confirm(deps); // window closed, so it goes as a template
    const rows = (await table.query(`ORDER#${ORDER}`)).filter((r) => String(r.SK).startsWith('MSG#'));
    const row = rows.find((r) => r.key === 'replacement_raised');
    expect(row).toBeTruthy();
    expect(await getWamidMap(row.wamid)).toMatchObject({ orderId: String(ORDER), key: 'replacement_raised' });
  });

  it('is skipped with the admin told when the order has no OTP verified number', async () => {
    const { clients, deps } = await setup({ over: { customAttributes: [] } });
    await confirm(deps);
    expect(to(clients, CUSTOMER)).toEqual([]);
    expect((await req()).notified).toMatchObject({ skipped: 'no-verified-phone' });
    expect(said(clients, ADMIN)).toMatch(/THE CUSTOMER WAS NOT MESSAGED, because the order has no OTP verified number/);
    // The parcels still went. That is the owner's decision, not the message's.
    expect(bookings(clients)).toEqual(['createReverse', 'createForward']);
  });

  it('is skipped with the admin told when they have opted out', async () => {
    const { clients, deps } = await setup();
    await setOptOut(CUSTOMER, true);
    await confirm(deps);
    expect(to(clients, CUSTOMER)).toEqual([]);
    expect((await req()).notified).toMatchObject({ skipped: 'opted-out' });
    expect(said(clients, ADMIN)).toMatch(/THE CUSTOMER WAS NOT MESSAGED, because they sent STOP/);
  });

  it('is skipped and said out loud when REPLACE_NOTIFY_CUSTOMER is off', async () => {
    config.replaceNotifyCustomer = false;
    const { clients, deps } = await setup();
    await confirm(deps);
    expect(to(clients, CUSTOMER)).toEqual([]);
    expect(said(clients, ADMIN)).toMatch(/REPLACE_NOTIFY_CUSTOMER is off/);
  });

  it('never goes out before both legs exist', async () => {
    const { clients, deps } = await setup({ logistics: { fail: { createForward: { permanent: true, remark: 'wallet' } } } });
    await touchInbound(CUSTOMER, NOW);
    await confirm(deps);
    expect(to(clients, CUSTOMER)).toEqual([]);
  });
});

describe('shadow mode', () => {
  it('performs zero provider writes and zero customer sends, and says what it would have sent', async () => {
    config.replaceMode = 'shadow';
    const { clients, deps } = await setup();
    await touchInbound(CUSTOMER, NOW);
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);

    expect(bookings(clients)).toEqual([]);
    expect(to(clients, CUSTOMER)).toEqual([]);
    expect(writes(clients)).toEqual([]);

    const r = await req();
    expect(r.state).toBe('DONE');
    expect(r.shadow).toBe(true);
    expect(r.returnAwb).toBeUndefined();

    const reply = said(clients, ADMIN);
    expect(reply).toMatch(/REPLACE_MODE is shadow, so nothing was booked/);
    expect(reply).toMatch(/Reverse pickup 1234-REPLACE-1R: Noor, size M/);
    expect(reply).toMatch(/Forward parcel 1234-REPLACE-1F: Noor, size XL, prepaid, surface/);
    expect(reply).toMatch(/HSN 6204/);
  });

  it('still reads the courier, because a shadow run that asks nothing proves nothing', async () => {
    config.replaceMode = 'shadow';
    const { clients, deps } = await setup();
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/reverse pickup yes/);
    expect(said(clients, ADMIN)).toMatch(/pickup Rs 70/);
  });

  it('answers the command and does nothing at all when the mode is off', async () => {
    config.replaceMode = 'off';
    const { clients, deps } = await setup();
    await run(deps);
    expect(said(clients, ADMIN)).toMatch(/switched off/);
    expect(await req()).toBe(null);
  });
});

describe('cancel', () => {
  it('before pickup, cancels both waybills and records CANCELLED', async () => {
    const { clients, deps } = await setup();
    await touchInbound(CUSTOMER, NOW);
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);

    await RP.onOwnerRequest('/replace cancel 1234', deps, ADMIN);
    expect(clients.logistics.calls.filter((c) => c.op === 'cancel').map((c) => c.awb)).toEqual(['FAKEAWB1', 'FAKEAWB2']);
    expect((await req()).state).toBe('CANCELLED');
    // The customer was told a pickup was coming, so the admin is told to unsay it.
    expect(said(clients, ADMIN)).toMatch(/customer WAS already told/);
  });

  it('after pickup, reports what the courier refused and leaves the request alone', async () => {
    const { clients, deps } = await setup({ logistics: { cancelRefusal: 'parcel already picked up' } });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);

    await RP.onOwnerRequest('/replace cancel 1234', deps, ADMIN);
    const reply = said(clients, ADMIN);
    expect(reply).toMatch(/could NOT be cancelled \(parcel already picked up\)/);
    expect(reply).toMatch(/Phone them/);
    // NOT marked cancelled: claiming a cancellation we did not get is worse
    // than reporting the refusal.
    expect((await req()).state).toBe('DONE');
  });

  it('an unconfirmed preview is dropped without the courier being called', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await RP.onOwnerRequest('/replace cancel 1234', deps, ADMIN);
    expect((await req()).state).toBe('REJECTED');
    expect(clients.logistics.calls).toEqual([]);
    expect(said(clients, ADMIN)).toMatch(/never booked and the customer was not messaged/);
  });
});

describe('status, list and help', () => {
  it('status asks the courier directly and reports both legs', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    clients.whatsapp.sent.length = 0;

    await RP.onOwnerRequest('/replace status 1234', deps, ADMIN);
    const reply = said(clients, ADMIN);
    expect(reply).toMatch(/#1234 replacement 1: DONE/);
    expect(reply).toMatch(/Noor, size M back, Noor, size XL out/);
    expect(reply).toMatch(/Pickup FAKEAWB1: Manifested/);
    expect(reply).toMatch(/Delivery FAKEAWB2: Manifested/);
  });

  it('status on an order that never had one says so', async () => {
    const { clients, deps } = await setup();
    await RP.onOwnerRequest('/replace status 1234', deps, ADMIN);
    expect(said(clients, ADMIN)).toMatch(/No replacement has ever been raised/);
  });

  it('list shows what is still open and drops it once it is done', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    await RP.onOwnerRequest('/replace list', deps, ADMIN);
    expect(said(clients, ADMIN)).toMatch(/#1234 \(1\) AWAITING_CONFIRMATION: Noor, size M to Noor, size XL/);

    await tap(deps, `rpok:1:${(await req()).nonce}`);
    clients.whatsapp.sent.length = 0;
    await RP.onOwnerRequest('/replace list', deps, ADMIN);
    expect(said(clients, ADMIN)).toMatch(/No replacement is open/);
  });

  it('list keeps a FAILED request visible, because that is the one needing a human', async () => {
    const { clients, deps } = await setup({ logistics: { fail: { createForward: { permanent: true, remark: 'wallet' } } } });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    clients.whatsapp.sent.length = 0;
    await RP.onOwnerRequest('/replace list', deps, ADMIN);
    expect(said(clients, ADMIN)).toMatch(/FAILED at the forward leg/);
  });

  it('a bare command teaches instead of complaining', async () => {
    const { clients, deps } = await setup();
    await RP.onOwnerRequest('/replace', deps, ADMIN);
    expect(said(clients, ADMIN)).toMatch(/\/replace status 1234/);
  });

  it('a command nobody can read comes back as a sentence plus the help', async () => {
    const { clients, deps } = await setup();
    await RP.onOwnerRequest('/replace 1234 noor', deps, ADMIN);
    expect(said(clients, ADMIN)).toMatch(/could not read a size/);
    expect(await req()).toBe(null);
  });
});

describe('who gets talked to', () => {
  it('only the requesting admin, never every owner phone', async () => {
    config.ownerAlertPhones = ['+919000000001', '+919000000002'];
    const { clients, deps } = await setup();
    await run(deps);
    expect(new Set(sent(clients).map((s) => s.to))).toEqual(new Set([ADMIN]));
  });

  /*
   * The preview carries interactive buttons and no template can, so a closed
   * window means the question cannot be asked. The REPLY still has to land,
   * and the only door left is the approved owner-alert template.
   */
  it('falls back to the owner-alert template when the admin own window has closed', async () => {
    const { clients, deps } = await setup({ openWindows: false });
    await run(deps);
    const m = lastTo(clients, ADMIN);
    expect(m.type).toBe('template');
    expect(m.name).toBe('ops_alert_v2');
    expect(m.components[0].parameters[1].text).toMatch(/Send any message here first/);
    expect(await req()).toBe(null); // and nothing was raised
  });

  it('a stranger typing the command is answered nothing at all', async () => {
    const { clients, deps } = await setup();
    await RP.onOwnerRequest('/replace 1234 noor m xl', deps, STRANGER);
    expect(sent(clients)).toEqual([]);
    expect(await req()).toBe(null);
  });

  it('admission falls back to the owner phones when no admin list is set', async () => {
    config.replaceAdminPhones = [];
    config.ownerAlertPhones = [ADMIN];
    expect(RP.isReplaceAdmin(ADMIN)).toBe(true);
    expect(RP.isReplaceAdmin(STRANGER)).toBe(false);
  });
});

/*
 * `again` is the one flag that clears the "a replacement is already open" stop,
 * so after it the quantity total is the ONLY thing standing between a one-piece
 * order and a second replacement parcel. That total is derived from the request
 * rows; while nothing wrote the per-line quantity it read as zero forever and
 * this refusal could never fire, which is a free extra parcel per `again`.
 */
describe('what has already been replaced is counted', () => {
  const finish = async (deps) => {
    await run(deps);
    await tap(deps, `rpok:${(await req()).seq}:${(await req()).nonce}`);
  };

  it('refuses a second replacement of a line that has had its only piece replaced', async () => {
    const { clients, deps } = await setup();
    await finish(deps);
    expect((await req()).state).toBe('DONE');
    const bookedOnce = bookings(clients).length;

    await run(deps, '/replace 1234 noor m xl again');
    expect(said(clients, ADMIN)).toMatch(/more than there is to replace/);
    // Refused before any booking, and no new request row was opened.
    expect(bookings(clients).length).toBe(bookedOnce);
    expect((await req()).seq).toBe(1);
  });

  it('counts a FAILED request too, because its return leg is already booked', async () => {
    const { clients, deps, fail } = await setup({
      logistics: { fail: { createForward: { remark: 'Low wallet balance', permanent: true, code: 'wallet' } } },
    });
    await finish(deps);
    expect((await req()).state).toBe('FAILED');
    fail.createForward = null;

    await run(deps, '/replace 1234 noor m xl again');
    expect(said(clients, ADMIN)).toMatch(/more than there is to replace/);
  });

  it('does not count a preview nobody confirmed', async () => {
    const { clients, deps } = await setup();
    await run(deps); // AWAITING_CONFIRMATION, nothing booked
    await run(deps, '/replace 1234 noor m xl again');
    // The second command gets a real preview, not a quantity refusal: an
    // unconfirmed preview has consumed nothing.
    expect(said(clients, ADMIN)).not.toMatch(/more than there is to replace/);
    expect((await req()).seq).toBe(2);
  });
});

describe('a preview nobody tapped leaves the open list', () => {
  it('drops it once the deadline has passed, so the digest cannot ask for work nobody can do', async () => {
    const { clients, deps } = await setup();
    await run(deps);
    expect((await store.listOpen(10, NOW)).map((r) => r.seq)).toEqual([1]);

    const later = new Date(NOW.getTime() + (RULES.replace.confirmMinutes + 1) * 60 * 1000);
    expect(await store.listOpen(10, later)).toEqual([]);

    // Nothing was booked and nobody was messaged, which is why dropping it is safe.
    expect(bookings(clients)).toEqual([]);
    expect(to(clients, CUSTOMER)).toEqual([]);
  });

  it('keeps a FAILED request listed however old it is, because that is the one needing a human', async () => {
    // DONE drops off by design (its pointer goes with the terminal state), but
    // FAILED is deliberately not terminal: it usually holds a booked return leg
    // and a customer waiting, so age must never hide it.
    const { deps } = await setup({
      logistics: { fail: { createForward: { remark: 'Low wallet balance', permanent: true, code: 'wallet' } } },
    });
    await run(deps);
    await tap(deps, `rpok:1:${(await req()).nonce}`);
    expect((await req()).state).toBe('FAILED');
    const muchLater = new Date(NOW.getTime() + 30 * 86400 * 1000);
    expect((await store.listOpen(10, muchLater)).map((r) => r.state)).toEqual(['FAILED']);
  });
});

/*
 * F19. Every /replace entry point read the order with getOrderByName and
 * normalizeOrder, so none of them reached the recipient resolver the flows use.
 * On an order with no OTP attribute, from a recovery link, a Cashfree cart
 * checkout or the admin, /replace booked BOTH parcels and told the customer
 * nothing at all, while Flows A, B and C were messaging that same person.
 */
describe('/replace on an order COD King never touched', () => {
  const confirm = async (deps) => {
    await run(deps);
    return tap(deps, `rpok:1:${(await req()).nonce}`);
  };

  const shippingOnly = { customAttributes: [], shippingAddress: { phone: CUSTOMER, zip: '395007', city: 'Surat' } };

  it('notifies the customer through their shipping number', async () => {
    const { clients, deps } = await setup({ over: shippingOnly });
    await confirm(deps);
    expect(to(clients, CUSTOMER).length).toBeGreaterThan(0);
    expect((await req()).notified?.skipped).toBeUndefined();
    // and both parcels still went, which was never the broken part
    expect(bookings(clients)).toEqual(['createReverse', 'createForward']);
  });

  it('records WHICH field the number came from', async () => {
    const { deps } = await setup({ over: shippingOnly });
    await confirm(deps);
    const r = await req();
    expect(r.phoneSource).toBeTruthy();
    expect(r.phoneSource).not.toBe('otp');
  });

  it('records otp when that is where it came from', async () => {
    const { deps } = await setup();
    await confirm(deps);
    expect((await req()).phoneSource).toBe('otp');
  });
});

/*
 * F20. Flow B schedules "we would love to know how it fits" for the day after
 * delivery, and nothing told it a replacement had been raised. So a customer
 * whose size was wrong, whose garment is being collected and whose replacement
 * is still in the post was asked how the first one fitted.
 */
describe('a confirmed replacement holds the review ask', () => {
  // The ask is off by default, and this suite never turns Flow B on: these
  // tests are about the ask being HELD, so it has to be armable first.
  beforeEach(() => {
    RULES.reviewAskEnabled = true;
    config.flows.B = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
  });
  afterEach(() => { RULES.reviewAskEnabled = false; });

  const confirm = async (deps) => {
    await run(deps);
    return tap(deps, `rpok:1:${(await req()).nonce}`);
  };

  it('cancels a review ask that was already scheduled', async () => {
    const { deps } = await setup();
    await B.onDelivered(ORDER, '2026-10-20T06:00:00Z', deps);
    expect(_peekTimers().map((t) => t.name)).toContain(`B-${ORDER}-review_ask`);

    await confirm(deps);

    expect(_peekTimers().map((t) => t.name)).not.toContain(`B-${ORDER}-review_ask`);
    expect((await getState(ORDER)).flowB.skip).toBe('replacement');
  });

  it('and a timer already in EventBridge still sends nothing', async () => {
    const { clients, deps } = await setup();
    await confirm(deps);
    const before = sent(clients).length;
    await B.onReviewTimer(ORDER, deps);
    expect(sent(clients)).toHaveLength(before);
    expect((await getState(ORDER)).flowB.reviewAsked).toBeUndefined();
  });

  it('and a later delivery event does not schedule a new one either', async () => {
    const { deps } = await setup();
    await confirm(deps);
    await B.onDelivered(ORDER, '2026-10-22T06:00:00Z', deps);
    expect(_peekTimers().map((t) => t.name)).not.toContain(`B-${ORDER}-review_ask`);
  });
});

/*
 * N4. The owner's policy is that a size change is the customer's own choice, so
 * they pay two-way freight upfront by UPI. `pays: 'customer'` was RECORDED and
 * nothing ever collected it, so every size change shipped two parcels at the
 * store's expense while the record said the customer was paying.
 */
describe('a customer-paid replacement collects before it books', () => {
  const confirm = async (deps, text) => {
    await run(deps, text);
    return tap(deps, `rpok:1:${(await req()).nonce}`);
  };
  const bodies = (clients) => clients.whatsapp.sent.map((s) => s.body || '').join(' | ');

  it('books NOTHING and asks the customer for the two-way freight', async () => {
    const { clients, deps } = await setup();
    await confirm(deps, '/replace 1234 noor m xl');

    expect(bookings(clients)).toEqual([]);
    expect((await req()).state).toBe('AWAITING_PAYMENT');
    const said = bodies(clients);
    expect(said).toContain('two courier trips');
    // The owner is told plainly that nothing is booked.
    expect(said).toContain('NOTHING IS BOOKED');
  });

  it('asks for the sum of both quotes, rounded up to the rupee', async () => {
    const { clients, deps } = await setup();
    await confirm(deps, '/replace 1234 noor m xl');
    const r = await req();
    // Rounded UP: asking for 184.37 reads as a mistake, and rounding down
    // would collect less than the courier charges.
    expect(r.payAmountInr).toBe(Math.ceil(Number(r.quoteReturnInr) + Number(r.quoteForwardInr)));
    expect(bodies(clients)).toContain(String(r.payAmountInr.toLocaleString('en-IN')));
  });

  it('books both parcels once the owner says the money arrived', async () => {
    const { clients, deps } = await setup();
    await confirm(deps, '/replace 1234 noor m xl');
    await RP.onPaid('1234', deps, ADMIN);
    expect(bookings(clients)).toEqual(['createReverse', 'createForward']);
    expect((await req()).paidAt).toBeTruthy();
  });

  it('refuses /replace paid on a request that is not waiting for it', async () => {
    const { clients, deps } = await setup();
    await confirm(deps, '/replace 1234 noor m xl pays:us');
    await RP.onPaid('1234', deps, ADMIN);
    expect(said(clients, ADMIN)).toMatch(/not waiting for payment/);
  });

  /*
   * The amount was built from a freight quote. Two days later that quote is
   * stale, and honouring it would mean booking at a price nobody has checked.
   */
  it('expires the ask rather than booking on a two-day-old quote', async () => {
    const { clients, deps } = await setup();
    await confirm(deps, '/replace 1234 noor m xl');
    const lateNow = new Date(NOW.getTime() + (RULES.replace.payWindowHours + 1) * 3600 * 1000);
    // The owner typed the command, which is what opens their own 24 hour
    // window: the router touchInbounds before dispatching. Without this the
    // reply is correctly refused and the test would be measuring that instead.
    await touchInbound(ADMIN, lateNow);
    await RP.onPaid('1234', { ...deps, now: lateNow }, ADMIN);
    expect(bookings(clients)).toEqual([]);
    expect((await req()).state).toBe('EXPIRED');
    expect(said(clients, ADMIN)).toMatch(/freight has moved/);
  });

  it('pays:us is untouched and books straight away', async () => {
    const { clients, deps } = await setup();
    await confirm(deps, '/replace 1234 noor m xl pays:us');
    expect(bookings(clients)).toEqual(['createReverse', 'createForward']);
  });

  /*
   * No quote means no honest number to ask for. Inventing one would be asking
   * a customer for money we cannot justify.
   */
  it('refuses to invent an amount when Delhivery would not quote', async () => {
    // The real adapter answers a failed quote with null, so quoteInr: null is
    // the only honest way to simulate one.
    const { clients, deps } = await setup({ logistics: { quoteInr: null } });
    await confirm(deps, '/replace 1234 noor m xl');
    expect(bookings(clients)).toEqual([]);
    expect(said(clients, ADMIN)).toMatch(/would not quote|cannot tell the customer what to pay/);
  });

  it('sends the UPI QR when one is configured, and copes without', async () => {
    RULES.replace.upiQrUrl = 'https://cdn.example.com/upi.png';
    const { clients, deps } = await setup();
    await confirm(deps, '/replace 1234 noor m xl');
    expect(clients.whatsapp.sent.some((s) => s.type === 'image')).toBe(true);
    RULES.replace.upiQrUrl = '';
  });
});
