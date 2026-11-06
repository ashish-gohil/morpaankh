/*
 * reconcile.test.mjs — the order sweep. Nothing checked that a confirmation
 * actually happened, so every way of losing an order between Shopify and the
 * customer's phone was silent and permanent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { ensureState, patchState, patchFlowA, patchFlowB, patchFlowC, getState } from '../store/orderState.mjs';
import { realClients } from '../clients/index.mjs';
import { _drainQueue, _peekQueue } from '../queue.mjs';
import { _resetTimers, _peekTimers } from './schedule.mjs';
import { RULES } from '../../messages/rules.mjs';
import { sweepUnconfirmed, sweepUnreviewed } from './reconcile.mjs';

// The sweep's whole job is scheduling an ask, so these tests enable it.
beforeEach(() => { RULES.reviewAskEnabled = true; });
afterEach(() => { RULES.reviewAskEnabled = true; });

const START = '2026-09-01T00:00:00Z';
const NOW = new Date('2026-09-26T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

let orders = [];
beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _drainQueue();
  orders = [];
  config.flows.A.enabled = true;
  config.flows.A.startAt = START;
  config.ownerAlertPhones = [];
  vi.spyOn(realClients.shopify, 'ordersUpdatedSince').mockImplementation(async () => orders);
});

const order = (id, createdAt) => ({ id: `gid://shopify/Order/${id}`, createdAt, tags: [] });

describe('orders nobody messaged', () => {
  it('re-arms an order that has no state row at all (the webhook never arrived)', async () => {
    orders = [order('111', hoursAgo(2))];
    const out = await sweepUnconfirmed(NOW);
    expect(out.requeued).toEqual(['111']);
    // and the timer message really is on the queue, addressed to Flow A's first step
    expect(_peekQueue()).toMatchObject([{ message: { kind: 'timer', flow: 'A', orderId: '111', step: 'cod' } }]);
  });

  it('re-arms an order whose timer was never created', async () => {
    orders = [order('222', hoursAgo(5))];
    await ensureState('222', {}); // seen, but the confirmation never went out
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual(['222']);
  });

  it('leaves an order that was already confirmed alone', async () => {
    orders = [order('333', hoursAgo(5))];
    await ensureState('333', {});
    await patchFlowA('333', { codConfirmAt: hoursAgo(4) });
    const out = await sweepUnconfirmed(NOW);
    expect(out.requeued).toEqual([]);
    expect(out.checked).toBe(1); // it looked, and decided correctly
  });

  it('does not race the normal path inside the grace window', async () => {
    // The real confirmation is scheduled at +3 minutes. Sweeping a 4-minute-old
    // order would send a second message to a customer who is about to get one.
    orders = [order('444', new Date(NOW.getTime() - 4 * 60000).toISOString())];
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual([]);
  });

  it('ignores orders from before Flow A was switched on', async () => {
    orders = [order('555', '2026-08-15T00:00:00Z')];
    const out = await sweepUnconfirmed(NOW);
    expect(out.checked).toBe(0);
    expect(out.requeued).toEqual([]);
  });

  /*
   * This test used to write `stoppedAt` on the state row, which is a field
   * NOTHING IN PRODUCTION HAS EVER WRITTEN, so it proved the check worked
   * against data that only the test created. onStop records a stop as
   * flowA.step, and that is what the sweep reads now.
   */
  it('leaves a stopped or cancelled order alone', async () => {
    orders = [order('666', hoursAgo(5)), order('667', hoursAgo(5))];
    await ensureState('666', {});
    await patchFlowA('666', { step: 'stopped' });
    await ensureState('667', {});
    await patchState('667', { cancelledAt: hoursAgo(4) });
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual([]);
  });

  it('gives up after three tries instead of requeueing forever', async () => {
    // An order that can never be confirmed (no verified phone, unreadable class)
    // would otherwise be re-enqueued every hour for as long as it exists.
    orders = [order('888', hoursAgo(5))];
    // An hour apart, because the sweep now runs every 10 minutes and spaces its
    // RETRIES an hour apart: three tries must still mean three hours, not half
    // an hour, or one Shopify outage would spend every order's budget at once.
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(NOW.getTime() + i * 60 * 60000);
      expect((await sweepUnconfirmed(at)).requeued).toEqual(['888']);
    }
    const out = await sweepUnconfirmed(new Date(NOW.getTime() + 3 * 60 * 60000));
    expect(out.requeued).toEqual([]);
    expect(out.stuck).toEqual(['888']);
    expect((await getState('888')).flowA.sweepTries).toBe(3);
  });

  it('a ten minute sweep does not spend the retry budget in half an hour', async () => {
    orders = [order('889', hoursAgo(5))];
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual(['889']);
    // The next five sweeps are ten minutes apart: all of them leave it alone.
    for (let i = 1; i <= 5; i += 1) {
      const at = new Date(NOW.getTime() + i * 10 * 60000);
      expect((await sweepUnconfirmed(at)).requeued).toEqual([]);
    }
    expect((await getState('889')).flowA.sweepTries).toBe(1);
    // An hour after the first try it is eligible again.
    expect((await sweepUnconfirmed(new Date(NOW.getTime() + 56 * 60000))).requeued).toEqual(['889']);
  });

  it('does nothing at all while Flow A is off', async () => {
    config.flows.A.enabled = false;
    orders = [order('999', hoursAgo(5))];
    expect((await sweepUnconfirmed(NOW)).skipped).toBe('flow-a-off');
  });

  it('does nothing when there is no start date, because nothing qualifies then', async () => {
    config.flows.A.startAt = '';
    orders = [order('1000', hoursAgo(5))];
    expect((await sweepUnconfirmed(NOW)).skipped).toBe('flow-a-off');
  });
});

/*
 * The sweep used to read "no codConfirmAt" as "we lost this order". It also
 * covers "we read this order and decided there was nothing to send", and those
 * need opposite handling. Order #1188 was the live case: duplicated by hand to
 * swap a size, so its gateway was `manual`, so classify() returned UNKNOWN, so
 * Flow A correctly sent nothing. The sweep then re-armed it once an hour, each
 * re-arm alerted the owner, and the fourth hour raised a stuck alert about a
 * condition the owner had already been told about by order name.
 */
describe('an order we deliberately decided not to message', () => {
  it('is left alone instead of re-armed', async () => {
    orders = [order('1188', hoursAgo(3))];
    await ensureState('1188', {});
    await patchFlowA('1188', { codSkip: 'class-unknown' });

    const out = await sweepUnconfirmed(NOW);

    expect(out.requeued).toEqual([]);
    expect(out.stuck).toEqual([]);
    expect(_peekQueue()).toEqual([]);
  });

  it('still counts as checked, so a real miss in the same batch is not masked', async () => {
    orders = [order('1188', hoursAgo(3)), order('999', hoursAgo(3))];
    await ensureState('1188', {});
    await patchFlowA('1188', { codSkip: 'no-verified-phone' });

    const out = await sweepUnconfirmed(NOW);

    expect(out.checked).toBe(2);
    expect(out.requeued).toEqual(['999']);
  });

  it('does not burn a sweepTry, so the stuck alert is never reached', async () => {
    orders = [order('1188', hoursAgo(3))];
    await ensureState('1188', {});
    await patchFlowA('1188', { codSkip: 'class-unknown' });

    await sweepUnconfirmed(NOW);
    await sweepUnconfirmed(NOW);
    await sweepUnconfirmed(NOW);
    await sweepUnconfirmed(NOW);

    expect((await getState('1188'))?.flowA?.sweepTries).toBeUndefined();
  });
});

/*
 * The hole that meant nobody was ever asked for a review.
 *
 * Flow B starts from an EDGE and nothing re-reads it: a Shopify fulfilment
 * event saying delivered, or the Delhivery poller seeing the status CHANGE to
 * DELIVERED. An order whose delivery landed while Flow B was off is then
 * finished with, because courierStatus is already DELIVERED so the poller skips
 * it as unchanged and the AWB has been dropped from the GSI. Eighteen delivered
 * orders sat in exactly that state with no flowB row at all.
 */
describe('delivered orders nobody asked for a review', () => {
  const PHONE = '+919812345678';
  const delivered = (id, when, extra = {}) =>
    ensureState(id, { orderId: id }).then(() =>
      patchState(id, {
        courierStatus: 'DELIVERED',
        // The delivery time has to be a FIELD, not the row's updatedAt: any
        // later write bumps updatedAt, so a backdated delivery written through
        // patchState still looks like it happened just now.
        courierStatusAt: when,
        verifiedPhone: PHONE,
        name: `#${id}`,
        ...extra,
      }),
    );

  const shopOrder = (id) => ({
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    tags: [],
    test: false,
    createdAt: hoursAgo(200),
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
  });

  beforeEach(() => {
    config.flows.B = { enabled: true, startAt: START };
    vi.spyOn(realClients.shopify, 'getOrder').mockImplementation(async (gid) => shopOrder(String(gid).split('/').pop()));
  });

  it('schedules the ask for a delivery that never reached Flow B', async () => {
    await delivered('900', hoursAgo(10));
    const out = await sweepUnreviewed(NOW);
    expect(out.scheduled).toEqual(['900']);
    expect((await getState('900')).flowB.scheduled).toBe(true);
    expect(_peekTimers().map((t) => t.name)).toContain('B-900-review_ask');
  });

  it('still finds a row that only ever recorded a courier status', async () => {
    // Eleven live rows look exactly like this: the poller reached the delivery
    // through patchState on a row ensureState had never created, so it holds
    // courierStatus and nothing else - no orderId field at all. Reading
    // st.orderId there gives undefined.
    await patchState('906', { courierStatus: 'DELIVERED', courierStatusAt: hoursAgo(10) });
    expect(await getState('906')).not.toHaveProperty('orderId');
    const out = await sweepUnreviewed(NOW);
    expect(out.scheduled).toEqual(['906']);
  });

  it('leaves an order whose ask is already scheduled or sent alone', async () => {
    await delivered('901', hoursAgo(10));
    await patchFlowB('901', { scheduled: true });
    await delivered('902', hoursAgo(10));
    await patchFlowB('902', { reviewAsked: true });
    const out = await sweepUnreviewed(NOW);
    expect(out.scheduled).toEqual([]);
  });

  it('does not wake up a delivery older than the lookback', async () => {
    // The sweep repairs a FRESH hole. Asking for a review on a parcel that
    // arrived a fortnight ago reads as a mailing list, and widening this is the
    // owner's decision, not a nightly cron's.
    await delivered('903', hoursAgo(24 * (RULES.reviewSweepLookbackDays + 2)));
    const out = await sweepUnreviewed(NOW);
    expect(out.checked).toBe(0);
    expect(out.scheduled).toEqual([]);
  });

  it('never asks about a parcel that came back', async () => {
    await delivered('904', hoursAgo(10));
    await patchFlowC('904', { rto: true });
    const out = await sweepUnreviewed(NOW);
    expect(out.scheduled).toEqual([]);
  });

  it('does nothing at all while Flow B is switched off', async () => {
    config.flows.B.enabled = false;
    await delivered('905', hoursAgo(10));
    expect(await sweepUnreviewed(NOW)).toMatchObject({ skipped: 'flow-b-off' });
  });
});

/*
 * F5. The sweep reads orders by UPDATED time over a 36 hour lookback, and every
 * tag this service writes updates the order. So a two-week-old parcel that was
 * merely scanned yesterday came back in the list, and with no age limit the
 * sweep re-armed it and sent cod_confirm, "ready to be packed", a fortnight
 * late. Pausing Flow A for a day and switching it back on did the same to every
 * order in between.
 */
describe('the sweep repairs fresh orders only', () => {
  it('re-arms an order from this morning', async () => {
    orders = [order('901', hoursAgo(5))];
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual(['901']);
  });

  it('leaves an order from two days ago alone, however recently it was touched', async () => {
    // Inside LOOKBACK_HOURS by update time, far outside it by order age: this
    // is exactly the shape a tag write produces.
    orders = [order('902', hoursAgo(48))];
    const out = await sweepUnconfirmed(NOW);
    expect(out.requeued).toEqual([]);
    expect(_peekQueue()).toEqual([]);
  });

  it('draws the line at 24 hours', async () => {
    orders = [order('903', hoursAgo(23)), order('904', hoursAgo(25))];
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual(['903']);
  });

  it('raises no stuck alert for an old order, because it never enters the sweep', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    orders = [order('905', hoursAgo(72))];
    const out = await sweepUnconfirmed(NOW);
    expect(out.stuck).toEqual([]);
  });
});
