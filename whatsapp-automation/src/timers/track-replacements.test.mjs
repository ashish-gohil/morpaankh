/*
 * N3. /replace booked a reverse pickup and a forward parcel and then went
 * BLIND. Nothing tracked either waybill, so the owner had to remember to add
 * the forward parcel to a pickup, and the customer, who had just handed over a
 * garment they paid for, heard nothing until the replacement turned up.
 *
 * Tracked SEPARATELY from the main poll, because replacement waybills are
 * deliberately kept out of GSI1: onDelhivery routes any terminal event on a
 * mapped AWB into the ORIGINAL order's flows, so a reverse pickup reaching RTO
 * would fire Flow C's RTO flow on an order that was never returned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from './schedule.mjs';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import * as store from '../store/replace.mjs';
import { ensureState, patchState, patchFlowB, getState } from '../store/orderState.mjs';
import { realClients } from '../clients/index.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { trackReplacements } from './track-replacements.mjs';

const ORDER = '12345';
const CUSTOMER = '+919637361371';
let clients;

const statuses = (map) => {
  clients = makeFakeClients({ courier: { statuses: map } });
  vi.spyOn(realClients.courier, 'track').mockImplementation((a) => clients.courier.track(a));
  vi.spyOn(realClients.whatsapp, 'sendTemplate').mockImplementation((a) => clients.whatsapp.sendTemplate(a));
  vi.spyOn(realClients.whatsapp, 'sendText').mockImplementation((a) => clients.whatsapp.sendText(a));
};

const openRequest = async (over = {}) => {
  await store.createRequest(ORDER, {
    orderName: '#1234',
    verifiedPhone: CUSTOMER,
    customerName: 'Aarav',
    returnAwb: 'REV1',
    forwardAwb: 'FWD1',
    items: { forward: [{ name: 'Noor', size: 'XL' }] },
    ...over,
  });
  await store.patchRequest(ORDER, 1, { state: 'DONE' });
};

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  config.dryRun = false;
  config.ownerAlertPhones = ['+919999999999'];
});

const alerts = () => clients.whatsapp.sent.filter((s) => s.name && s.name.startsWith('ops_alert'));
const toCustomer = () => clients.whatsapp.sent.filter((s) => s.to === CUSTOMER);

describe('the reverse leg', () => {
  it('tells the owner to add the replacement parcel to today s pickup', async () => {
    statuses({ REV1: { status: 'Picked Up', statusType: 'UD' }, FWD1: { status: 'Manifested', statusType: 'UD' } });
    await openRequest();
    await trackReplacements();
    // The one operational event: the forward parcel is left Ready to Ship on
    // purpose, so somebody has to physically add it to the day's pickup.
    expect(JSON.stringify(alerts())).toContain('FWD1');
    expect(JSON.stringify(alerts())).toContain("today's pickup");
  });

  it('shouts when the pickup itself goes wrong, because nothing is coming back', async () => {
    statuses({ REV1: { status: 'RTO Initiated', statusType: 'RT' }, FWD1: { status: 'Manifested', statusType: 'UD' } });
    await openRequest();
    await trackReplacements();
    expect(JSON.stringify(alerts())).toContain('RTO_INITIATED');
  });

  it('says nothing twice for the same status', async () => {
    statuses({ REV1: { status: 'Picked Up', statusType: 'UD' }, FWD1: { status: 'Manifested', statusType: 'UD' } });
    await openRequest();
    await trackReplacements();
    const first = alerts().length;
    await trackReplacements();
    expect(alerts()).toHaveLength(first);
  });
});

describe('the forward leg', () => {
  it('tells the CUSTOMER their replacement is on its way, once', async () => {
    statuses({ REV1: { status: 'Delivered', statusType: 'DL' }, FWD1: { status: 'Picked Up', statusType: 'UD' } });
    await openRequest();
    await trackReplacements();
    await trackReplacements();
    const mine = toCustomer();
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0])).toContain('FWD1');
  });

  /*
   * F20 held the review ask when the replacement was confirmed, because asking
   * "how does it fit" about a garment being collected is the wrong question.
   * THIS is the right moment: they have the one they actually wanted.
   */
  it('re-arms the review ask once the replacement has arrived', async () => {
    RULES.reviewAskEnabled = true;
    config.flows.B = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
    await ensureState(ORDER, {});
    await patchState(ORDER, { verifiedPhone: CUSTOMER, name: '#1234' });
    await patchFlowB(ORDER, { skip: 'replacement' });
    statuses({ REV1: { status: 'Delivered', statusType: 'DL' }, FWD1: { status: 'Delivered', statusType: 'DL' } });
    await openRequest();

    // The order has to be readable for onDelivered to schedule anything.
    vi.spyOn(realClients.shopify, 'getOrder').mockResolvedValue({
      id: `gid://shopify/Order/${ORDER}`, name: '#1234', tags: [], test: false,
      createdAt: '2026-10-01T06:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID',
      paymentGatewayNames: ['Cash on Delivery (COD)'],
      netPaymentSet: { shopMoney: { amount: '1499.00' } },
      currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
      totalPriceSet: { shopMoney: { amount: '1499.00' } },
      customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919637361371' }],
      customer: { firstName: 'Aarav' }, shippingLines: { nodes: [] }, fulfillments: [],
      lineItems: { nodes: [{ id: 'li1', title: 'Noor', quantity: 1, product: { id: 'gid://shopify/Product/1' }, originalUnitPriceSet: { shopMoney: { amount: '1499.00' } } }] },
    });

    await trackReplacements();

    const st = await getState(ORDER);
    expect(st.flowB.skip).toBeFalsy();
    expect(_peekTimers().map((t) => t.name)).toContain(`B-${ORDER}-review_ask`);
    const req = await store.latestRequest(ORDER);
    expect(req.state).toBe('DONE_DELIVERED');
    RULES.reviewAskEnabled = false;
  });

  it('shouts when the replacement itself is lost: they have given theirs back', async () => {
    statuses({ REV1: { status: 'Delivered', statusType: 'DL' }, FWD1: { status: 'Lost', statusType: 'UD' } });
    await openRequest();
    await trackReplacements();
    expect(JSON.stringify(alerts())).toContain('LOST');
  });
});

describe('nothing to do', () => {
  it('skips a request with no waybills booked yet', async () => {
    statuses({});
    await store.createRequest(ORDER, { orderName: '#1234', verifiedPhone: CUSTOMER });
    const out = await trackReplacements();
    expect(out.checked).toBe(0);
  });
});
