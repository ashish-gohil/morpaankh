/*
 * variantChange.test.mjs — the whole conversation, driven through the fakes.
 *
 * The property that matters most and is asserted everywhere below: NOTHING is
 * written to the order until the customer taps the confirm button. Every step
 * before it only reads.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers } from '../timers/schedule.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { ensureState, patchState, patchFlowA, getState } from '../store/orderState.mjs';
import { decodePayload } from '../lib/ids.mjs';
import { touchInbound } from '../store/phoneProfile.mjs';
import * as A from './flowA.run.mjs';
import * as VC from './variantChange.run.mjs';

const PHONE = '+919812345678';
const STRANGER = '+919800000000';
const ORDER = '12345';
const PRODUCT = 'gid://shopify/Product/9';
const VAR = (n) => `gid://shopify/ProductVariant/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;

const sizeOnly = (s) => [{ name: 'Size', value: s }];
const sizeColour = (s, c) => [{ name: 'Size', value: s }, { name: 'Color', value: c }];

const variant = (id, opts, over = {}) => ({
  id: VAR(id),
  title: opts.map((o) => o.value).join(' / '),
  price: '1249.00',
  availableForSale: true,
  inventoryQuantity: 5,
  selectedOptions: opts,
  ...over,
});

const node = (liId, varId, opts, over = {}) => ({
  id: LI(liId),
  title: 'Khili Dhoop',
  quantity: 1,
  currentQuantity: 1,
  variantTitle: opts.map((o) => o.value).join(' / '),
  product: { id: PRODUCT, handle: 'khili-dhoop' },
  variant: { id: VAR(varId), selectedOptions: opts },
  image: { url: 'https://cdn/x.jpg', width: 500, height: 500 },
  originalUnitPriceSet: { shopMoney: { amount: '1249.00' } },
  discountAllocations: [],
  ...over,
});

const codOrder = (over = {}) => ({
  id: `gid://shopify/Order/${ORDER}`,
  name: '#1234',
  tags: ['LOW RTO Risk'],
  test: false,
  createdAt: '2026-10-01T06:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PENDING',
  paymentGatewayNames: ['Cash on Delivery (COD)'],
  netPaymentSet: { shopMoney: { amount: '0.00' } },
  currentTotalPriceSet: { shopMoney: { amount: '1299.00' } },
  totalPriceSet: { shopMoney: { amount: '1299.00' } },
  customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919812345678' }],
  customer: { firstName: 'Aarav' },
  shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '50.00' } } }] },
  fulfillments: [],
  lineItems: { nodes: [node(1, 100, sizeOnly('XS'))] },
  ...over,
});

const sizeProduct = {
  id: PRODUCT,
  handle: 'khili-dhoop',
  title: 'Khili Dhoop',
  options: [{ name: 'Size', values: ['XS', 'M', 'L'] }],
  variants: { nodes: [variant(100, sizeOnly('XS')), variant(101, sizeOnly('M')), variant(102, sizeOnly('L'))] },
};

const colourProduct = {
  id: PRODUCT,
  handle: 'khili-dhoop',
  title: 'Khili Dhoop',
  options: [{ name: 'Size', values: ['M', 'L'] }, { name: 'Color', values: ['Brown', 'Indigo'] }],
  variants: {
    nodes: [
      variant(100, sizeColour('M', 'Brown')),
      variant(101, sizeColour('L', 'Brown')),
      variant(102, sizeColour('M', 'Indigo')),
      variant(103, sizeColour('L', 'Indigo')),
    ],
  },
};

async function setup(order = codOrder(), product = sizeProduct, shopifyOpts = {}) {
  const clients = makeFakeClients({ shopify: { products: { [PRODUCT]: product }, ...shopifyOpts } });
  clients.shopify.seed(order);
  await ensureState(ORDER, {});
  await patchState(ORDER, { class: 'COD', verifiedPhone: PHONE, name: '#1234' });
  return { clients, deps: { clients, now: new Date('2026-10-02T09:00:00Z') } };
}

const sent = (c) => c.whatsapp.sent;
const last = (c) => sent(c)[sent(c).length - 1];
const bodies = (c) => sent(c).map((s) => s.body || '').join('\n');
const rowActions = (msg) => (msg.rows || []).map((r) => decodePayload(r.id).action);
const btnActions = (msg) => (msg.buttons || []).map((b) => decodePayload(b.id).action);
const ops = (c) => c.shopify.calls.map((x) => x.op);
const writes = (c) => ops(c).filter((o) => o !== 'getOrder' && o !== 'getProductVariants');

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  config.flows.A = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
  config.orderAllowlist = [];
  config.ownerAlertPhones = [];
  config.variantChangeEnabled = true;
});

describe('with the flag off, nothing about today changes', () => {
  it('Cancel still sends the old two-button cancel_check', async () => {
    config.variantChangeEnabled = false;
    const { clients, deps } = await setup();
    await A.onCancel(ORDER, deps);
    expect(last(clients).type).toBe('buttons');
    expect(btnActions(last(clients))).toEqual(['cancel_yes', 'cancel_no']);
    expect(bodies(clients)).toMatch(/should we cancel/);
    expect(bodies(clients)).not.toMatch(/change the size/);
  });

  it('a vc tap that arrives anyway is swallowed, never acted on', async () => {
    config.variantChangeEnabled = false;
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vc', deps, PHONE);
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    expect(sent(clients)).toHaveLength(0);
    expect(writes(clients)).toEqual([]);
  });
});

describe('the Cancel button offers the change first', () => {
  it('offers change, cancel and keep when the order can still take a change', async () => {
    const { clients, deps } = await setup();
    await A.onCancel(ORDER, deps);
    expect(btnActions(last(clients))).toEqual(['vc', 'cancel_yes', 'cancel_no']);
    expect(bodies(clients)).toMatch(/change the size or colour/);
  });

  it('falls back to the plain cancel question once an AWB exists', async () => {
    const o = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = await setup(o);
    await A.onCancel(ORDER, deps);
    expect(btnActions(last(clients))).toEqual(['cancel_yes', 'cancel_no']);
  });

  it('falls back once the order has already been changed once', async () => {
    const { clients, deps } = await setup();
    await patchFlowA(ORDER, { variantChanges: 1 });
    await A.onCancel(ORDER, deps);
    expect(btnActions(last(clients))).toEqual(['cancel_yes', 'cancel_no']);
  });
});

describe('a single-colour product goes straight to sizes', () => {
  it('lists the other in-stock sizes and nothing else', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vc', deps, PHONE);
    const m = last(clients);
    expect(m.type).toBe('list');
    expect(m.buttonText).toBe('Choose size');
    expect(m.rows.map((r) => r.title)).toEqual(['M', 'L']);
    expect(rowActions(m)).toEqual(['vcs:1:101', 'vcs:1:102']);
    expect(writes(clients)).toEqual([]);
  });

  /*
   * A real customer on order #1196 tapped through to the confirmation and
   * stopped there. The old copy said "order X changes from S to L", present
   * tense, which reads as already done to someone who has just picked a size.
   * The message must ASK, and must say outright that the order is untouched.
   */
  it('asks rather than announces, and says the order is still untouched', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcs:1:101', deps, PHONE);
    const body = last(clients).body;
    expect(body).toMatch(/Nothing has changed yet/);
    expect(body).toMatch(/\?/); // it is a question
    expect(body).not.toMatch(/order #\d+ changes from/i); // never the old statement form
    expect(writes(clients)).toEqual([]); // and it is true: nothing was written
  });

  it('shows a confirmation with the unchanged amount, and writes nothing yet', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcs:1:101', deps, PHONE);
    const m = last(clients);
    expect(m.type).toBe('buttons');
    expect(m.body).toMatch(/from Khili Dhoop, size XS to Khili Dhoop, size M/);
    expect(m.body).toMatch(/amount stays Rs 1,299/);
    expect(btnActions(m)).toEqual(['vcok:1:101', 'vc']);
    // THE POINT: the order is untouched until the confirm tap.
    expect(writes(clients)).toEqual([]);
  });

  it('applies the change only on the confirm tap', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    const applied = clients.shopify.calls.find((c) => c.op === 'changeLineItemVariant');
    expect(applied).toBeTruthy();
    expect(applied.args).toMatchObject({ lineItemId: LI(1), newVariantId: VAR(101) });
    expect(clients.shopify.calls.some((c) => c.op === 'tagsAdd' && c.tags.includes('wa-variant-changed'))).toBe(true);
    expect(bodies(clients)).toMatch(/Done\. Order #1234 is now Khili Dhoop, size M/);
    expect((await getState(ORDER))?.flowA?.variantChanges).toBe(1);
  });

  it('asks for a restock so the garment they are not taking goes back to stock', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    // The restock itself lives in the real client; what the flow owes it is the
    // discount to carry and the staff note.
    const args = clients.shopify.calls.find((c) => c.op === 'changeLineItemVariant').args;
    expect(args.staffNote).toMatch(/size XS changed to Khili Dhoop, size M/);
    expect(args.carryDiscountPaise).toBe(0);
  });

  it('carries the line discount across, which 9 of the last 15 orders had', async () => {
    const o = codOrder({
      lineItems: { nodes: [node(1, 100, sizeOnly('XS'), { discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: '150.00' } } }] })] },
    });
    const { clients, deps } = await setup(o);
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    expect(clients.shopify.calls.find((c) => c.op === 'changeLineItemVariant').args.carryDiscountPaise).toBe(15000);
  });
});

describe('a multi-colour product asks which to change', () => {
  const brownM = codOrder({ lineItems: { nodes: [node(1, 100, sizeColour('M', 'Brown'))] } });

  it('offers size, colour or keep', async () => {
    const { clients, deps } = await setup(brownM, colourProduct);
    await VC.route(ORDER, 'vc', deps, PHONE);
    const m = last(clients);
    expect(m.type).toBe('buttons');
    expect(btnActions(m)).toEqual(['vcos:1', 'vcoc:1', 'cancel_no']);
  });

  it('lists only the other colours', async () => {
    const { clients, deps } = await setup(brownM, colourProduct);
    await VC.route(ORDER, 'vcoc:1', deps, PHONE);
    const m = last(clients);
    expect(m.rows.map((r) => r.title)).toEqual(['Indigo']);
    expect(rowActions(m)).toEqual(['vcc:1:102']);
  });

  it('then lists the sizes within the colour they chose', async () => {
    const { clients, deps } = await setup(brownM, colourProduct);
    await VC.route(ORDER, 'vcc:1:102', deps, PHONE);
    const m = last(clients);
    expect(m.buttonText).toBe('Choose size');
    expect(m.rows.map((r) => r.title)).toEqual(['M', 'L']);
    expect(rowActions(m)).toEqual(['vcs:1:102', 'vcs:1:103']);
    expect(writes(clients)).toEqual([]);
  });

  it('keeps the current colour when they chose size', async () => {
    const { clients, deps } = await setup(brownM, colourProduct);
    await VC.route(ORDER, 'vcos:1', deps, PHONE);
    // Brown only: L in Brown, not the Indigos.
    expect(rowActions(last(clients))).toEqual(['vcs:1:101']);
  });
});

describe('a multi-line order asks which item', () => {
  const twoLines = codOrder({
    lineItems: { nodes: [node(1, 100, sizeOnly('XS')), node(2, 100, sizeOnly('XS'), { title: 'Bandhan' })] },
  });

  it('lists the changeable items first', async () => {
    const { clients, deps } = await setup(twoLines);
    await VC.route(ORDER, 'vc', deps, PHONE);
    const m = last(clients);
    expect(m.buttonText).toBe('Choose item');
    expect(m.rows.map((r) => r.title)).toEqual(['Khili Dhoop', 'Bandhan']);
    expect(rowActions(m)).toEqual(['vcl:1', 'vcl:2']);
  });

  it('carries the chosen line through to the sizes', async () => {
    const { clients, deps } = await setup(twoLines);
    await VC.route(ORDER, 'vcl:2', deps, PHONE);
    expect(rowActions(last(clients))).toEqual(['vcs:2:101', 'vcs:2:102']);
  });
});

describe('a typed message in the middle changes nothing', () => {
  /*
   * The worry: a customer types "is L available?" between picking a size and
   * confirming, and the confirm button goes dead.
   *
   * It cannot, and the reason is structural. Every step's state lives in the
   * PAYLOAD (v1|A|<orderId>|vcok:<line>:<variant>), never in a conversation
   * state that a message could clear, and onWaInbound checks for a payload
   * BEFORE it looks at text or at any awaiting state. A tap always carries a
   * payload, so it always routes. inHumanTakeover, which could have suppressed
   * it, is dead code that nothing calls.
   */
  it('still applies the change when a text arrives between the pick and the confirm', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcs:1:101', deps, PHONE); // confirmation shown
    // the customer types something; it touches no variant-change state
    await touchInbound(PHONE, new Date());
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    const applied = clients.shopify.calls.find((c) => c.op === 'changeLineItemVariant');
    expect(applied).toBeTruthy();
    expect(applied.args.newVariantId).toBe(VAR(101));
  });

  it('still applies it much later, because the payload carries everything', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcs:1:101', deps, PHONE);
    // a tap that arrives a long time afterwards is re-validated from scratch,
    // not trusted, and still works while the order still qualifies
    const later = { ...deps, now: new Date(deps.now.getTime() + 3 * 24 * 3600 * 1000) };
    await VC.route(ORDER, 'vcok:1:101', later, PHONE);
    expect(clients.shopify.calls.some((c) => c.op === 'changeLineItemVariant')).toBe(true);
  });
});

describe('safety properties', () => {
  it('a redelivered confirm tap writes exactly once', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    expect(clients.shopify.calls.filter((c) => c.op === 'changeLineItemVariant')).toHaveLength(1);
    expect((await getState(ORDER))?.flowA?.variantChanges).toBe(1);
  });

  it('a stranger tapping a payload changes nothing', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcok:1:101', deps, STRANGER);
    expect(clients.shopify.calls.some((c) => c.op === 'changeLineItemVariant')).toBe(false);
  });

  it('a crafted payload naming another product changes nothing', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcok:1:999999', deps, PHONE);
    expect(clients.shopify.calls.some((c) => c.op === 'changeLineItemVariant')).toBe(false);
    expect(bodies(clients)).toMatch(/could not make that change/);
  });

  it('an AWB appearing mid-conversation stops the confirm dead', async () => {
    const { clients, deps } = await setup();
    await VC.route(ORDER, 'vcs:1:101', deps, PHONE); // confirmation shown
    const o = clients.shopify.store.get(`gid://shopify/Order/${ORDER}`);
    o.fulfillments = [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB9', company: 'Delhivery' }] }];
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    expect(clients.shopify.calls.some((c) => c.op === 'changeLineItemVariant')).toBe(false);
    expect(bodies(clients)).toMatch(/stays exactly as it is/);
  });

  it('a failed apply changes nothing, tags the order and tells a person', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    const { clients, deps } = await setup(codOrder(), sizeProduct, { failChangeVariant: 'orderEditCommit: boom' });
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    expect(clients.shopify.calls.some((c) => c.op === 'tagsAdd' && c.tags.includes('wa-variant-change-requested'))).toBe(true);
    expect(clients.shopify.calls.some((c) => c.op === 'tagsAdd' && c.tags.includes('wa-variant-changed'))).toBe(false);
    expect(bodies(clients)).toMatch(/Someone from our team will message you shortly/);
    expect(sent(clients).some((s) => s.name && s.name.startsWith('ops_alert'))).toBe(true);
  });

  it('says so plainly when the product has nothing else in stock', async () => {
    const soldOut = {
      ...sizeProduct,
      variants: { nodes: [variant(100, sizeOnly('XS')), variant(101, sizeOnly('M'), { inventoryQuantity: 0 })] },
    };
    const { clients, deps } = await setup(codOrder(), soldOut);
    await VC.route(ORDER, 'vc', deps, PHONE);
    expect(bodies(clients)).toMatch(/do not have another size or colour/);
    expect(writes(clients)).toEqual([]);
  });

  it('hands off rather than guessing when the product carries an unknown option', async () => {
    const odd = { ...sizeProduct, options: [{ name: 'Size', values: ['XS'] }, { name: 'Fit', values: ['Regular'] }] };
    const { clients, deps } = await setup(codOrder(), odd);
    await VC.route(ORDER, 'vc', deps, PHONE);
    expect(bodies(clients)).toMatch(/do not have another size or colour/);
    expect(writes(clients)).toEqual([]);
  });

  it('warns URGENTLY if the total moved despite the pre-commit check', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    const { clients, deps } = await setup();
    clients.shopify.changeLineItemVariant = async (args) => {
      clients.shopify.calls.push({ op: 'changeLineItemVariant', args });
      return { applied: true, drifted: true, currentTotal: '1399.00', outstanding: '1399.00' };
    };
    await VC.route(ORDER, 'vcok:1:101', deps, PHONE);
    const alert = sent(clients).find((s) => s.name && s.name.startsWith('ops_alert') && /URGENT/.test(JSON.stringify(s)));
    expect(alert).toBeTruthy();
  });
});
