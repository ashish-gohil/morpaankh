import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { _resetSecrets } from '../secrets.mjs';
import { getAwaiting } from '../store/phoneProfile.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import * as C from './flowC.run.mjs';

const NOW = fromISTWall(2026, 9, 21, 12, 0); // inside the 08:00-21:00 NDR window
const PHONE = '+919812345678';

function order(overrides = {}) {
  return {
    id: 'gid://shopify/Order/12345',
    name: '#1234',
    tags: [],
    test: false,
    createdAt: '2026-09-15T06:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    netPaymentSet: { shopMoney: { amount: '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919812345678' }],
    customer: { id: 'gid://shopify/Customer/9', firstName: 'Aarav' },
    shippingAddress: { zip: '302001', city: 'Jaipur' },
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

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  config.ownerAlertPhones = ['+919999999999'];
});

const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);
const courierCalls = (co) => co.calls;
const sentText = (wa, re) => wa.sent.some((s) => re.test(s.body || ''));
const sentTemplate = (wa, name) => wa.sent.some((s) => s.type === 'template' && s.name === name);

describe('Flow C: NDR', () => {
  it('sends ndr_action inside the window', async () => {
    const { clients, deps } = setup();
    await C.onNdr('12345', deps);
    expect(sentTemplate(clients.whatsapp, 'ndr_action_v1')).toBe(true);
  });

  it('change address -> asks, then same-pincode edit saves', async () => {
    const { clients, deps } = setup();
    await C.onNdrAddressStart('12345', deps);
    expect(sentText(clients.whatsapp, /complete address/)).toBe(true);
    expect((await getAwaiting(PHONE)).type).toBe('address');

    await C.onAddressText('12345', 'New flat 5, MG Road, Jaipur 302001', deps);
    expect(courierCalls(clients.courier).some((c) => c.op === 'ndrAction' && c.action === 'EDIT_DETAILS')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-ndr-address');
    expect(await getAwaiting(PHONE)).toBeNull();
  });

  it('different pincode -> pincode_changed + alert, no courier edit', async () => {
    const { clients, deps } = setup();
    await C.onNdrAddressStart('12345', deps);
    await C.onAddressText('12345', 'shifted to Bengaluru 560001', deps);
    expect(sentText(clients.whatsapp, /different pincode/)).toBe(true);
    expect(courierCalls(clients.courier).some((c) => c.op === 'ndrAction')).toBe(false);
    expect(sentTemplate(clients.whatsapp, 'ops_alert_v1')).toBe(true);
  });

  it('no pincode -> retry once, then alert', async () => {
    const { clients, deps } = setup();
    await C.onNdrAddressStart('12345', deps);
    await C.onAddressText('12345', 'my street near the temple', deps);
    expect(sentText(clients.whatsapp, /could not find a 6-digit pincode/)).toBe(true);
    await C.onAddressText('12345', 'still no pin', deps);
    expect(sentTemplate(clients.whatsapp, 'ops_alert_v1')).toBe(true);
  });

  it('deliver tomorrow -> RE-ATTEMPT + ok', async () => {
    const { clients, deps } = setup();
    await C.onNdrReattempt('12345', deps);
    expect(courierCalls(clients.courier).some((c) => c.action === 'RE-ATTEMPT')).toBe(true);
    expect(sentText(clients.whatsapp, /try the delivery again/)).toBe(true);
  });
});

describe('Flow C: RTO', () => {
  it('RTO_INITIATED tags RTO and schedules the reason ask', async () => {
    const { clients, deps } = setup();
    await C.onRto('12345', deps);
    expect(tagsAdded(clients.shopify)).toContain('RTO');
    expect(_peekTimers().map((t) => t.name)).toContain('C-12345-rto_reason');
  });

  it('reason changed_mind -> metafield, tags, cod-block, thanks', async () => {
    const { clients, deps } = setup();
    await C.onRtoReason('12345', 'changed_mind', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'metafieldsSet')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('rto-reason-changed-mind');
    expect(tagsAdded(clients.shopify)).toContain('cod-block'); // changed_mind forces it
    expect(sentText(clients.whatsapp, /Thank you for telling us/)).toBe(true);
  });

  it('reason other -> asks for text and awaits it', async () => {
    const { deps } = setup();
    await C.onRtoReason('12345', 'other', deps);
    expect((await getAwaiting(PHONE)).type).toBe('rto_other');
  });
});
