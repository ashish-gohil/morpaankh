import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory, table } from '../store/table.mjs';
import { getWamidMap } from '../store/maps.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { setOptOut, setUndeliverable, parkOffer, getParkedOffer, clearParkedOffer } from '../store/phoneProfile.mjs';
import { getState, ensureState, patchState } from '../store/orderState.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { RULES } from '../../messages/rules.mjs';
import { SESSION } from '../../messages/session.mjs';
import * as A from './flowA.run.mjs';

// Read at import, before any afterEach can force it false, so the test below
// really does pin what rules.mjs SHIPS and not what a previous test left behind.
const SHIPPED_prepaidOfferEnabled = RULES.prepaidOfferEnabled;
const SHIPPED_LANGUAGE = { ...RULES.language };

// A test that flips RULES.prepaidOfferEnabled on must not leak it into the next one:
// the default is OFF and a leaked true would hide a real regression.
afterEach(() => {
  RULES.prepaidOfferEnabled = SHIPPED_prepaidOfferEnabled;
  RULES.language = { ...SHIPPED_LANGUAGE };
});
import { tpl } from './send.mjs';

const NOW = fromISTWall(2026, 9, 20, 12, 0); // daytime IST, not quiet
const PHONE = '+919812345678';

function codOrder(overrides = {}) {
  const { fulfillments, attrs, ...rest } = overrides;
  return {
    id: 'gid://shopify/Order/12345',
    name: '#1234',
    tags: ['✅ COD-Verified', 'LOW RTO Risk'],
    test: false,
    createdAt: '2026-09-20T06:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    netPaymentSet: { shopMoney: { amount: '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: attrs || [
      { key: '_otpVerifiedPhoneNumber', value: '919812345678' },
      { key: '_codkAmountType', value: 'cod' },
      { key: '_codkAmountValue', value: '50.0' },
    ],
    customer: { firstName: 'Aarav' },
    shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '50.00' } } }] },
    fulfillments: fulfillments || [],
    lineItems: {
      nodes: [
        {
          id: 'li1',
          title: 'Bandhan',
          quantity: 1,
          variantTitle: 'M / Indigo',
          variant: { selectedOptions: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Indigo' }] },
          image: { url: 'https://cdn.shopify.com/s/files/1/x/bandhan.jpg?v=1', width: 960, height: 1280 },
          originalUnitPriceSet: { shopMoney: { amount: '1449.00' } },
        },
      ],
    },
    ...rest,
  };
}

function setup(order = codOrder(), courier = {}) {
  const clients = makeFakeClients({ shopify: {}, courier });
  clients.shopify.seed(order);
  return { clients, deps: { clients, now: NOW } };
}

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  config.flows.A = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
  config.orderAllowlist = [];
  config.ownerAlertPhones = [];
  /*
   * THE LANGUAGE PICKER IS OFF FOR THIS SUITE, STATED RATHER THAN INHERITED.
   *
   * It shipped on for every customer on 2026-11-14 (gate G5), and the picker
   * runs BEFORE the COD confirmation and holds it, so leaving it on put a
   * language_select_v1 in front of every assertion here and 16 of these tests
   * failed on the message order alone.
   *
   * This suite is about the COD chase: what is sent, in what order, how often,
   * and what the retries do. The picker's interaction WITH Flow A is covered
   * in language.test.mjs, which drives these same handlers with the feature on
   * ("asks a new phone and holds the confirmation", "a tap then sends the
   * confirmation once, in Hindi", "no tap: the confirmation goes out in
   * English when the wait is up"), so turning it off here narrows the suite
   * rather than hiding anything.
   */
  RULES.language = { ...SHIPPED_LANGUAGE, enabled: false };
});

const types = (wa) => wa.sent.map((s) => s.type);
const names = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);

describe('Flow A happy path', () => {
  it('create -> cod timer -> confirm sent -> convert on payment', async () => {
    // The offer is OFF by default now (RULES.prepaidOfferEnabled). This test
    // keeps proving the machinery still works for when it is switched back on.
    RULES.prepaidOfferEnabled = true;
    const { clients, deps } = setup();

    await A.onOrderCreate('12345', deps);
    expect(_peekTimers().map((t) => t.name)).toContain('A-12345-cod');

    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp)).toContain('cod_confirm_v3');
    expect(tagsAdded(clients.shopify)).toContain('wa-cod-sent');
    const timerNames = _peekTimers().map((t) => t.name);
    expect(timerNames).toEqual(expect.arrayContaining(['A-12345-reminder', 'A-12345-fallback', 'A-12345-highrisk']));

    await A.onConfirm('12345', deps);
    expect(tagsAdded(clients.shopify)).toContain('wa-confirmed');
    expect(_peekTimers().map((t) => t.name)).not.toContain('A-12345-reminder');
    expect(clients.razorpay.links).toHaveLength(1);
    expect(types(clients.whatsapp)).toContain('cta_url'); // confirmed_with_offer

    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-prepaid-converted');
    expect(clients.shopify.calls.some((c) => c.op === 'metafieldsSet')).toBe(true);
    // window is open (they just confirmed) -> session payment_received
    expect(clients.whatsapp.sent.some((s) => s.type === 'text' && /has come through/.test(s.body))).toBe(true);
  });

  it('creates the payment link only once across duplicate taps', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onConfirm('12345', deps);
    await A.onConfirm('12345', deps);
    expect(clients.razorpay.links).toHaveLength(1);
  });
});

describe('Flow A cancel', () => {
  it('unfulfilled order: orderCancel + wa-cancelled + cancel_done', async () => {
    const { clients, deps } = setup();
    await A.onCancel('12345', deps);
    expect(types(clients.whatsapp)).toContain('buttons'); // cancel_check
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'orderCancel')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-cancelled');
    expect(clients.whatsapp.sent.some((s) => /is cancelled/.test(s.body || ''))).toBe(true);
  });

  /*
   * orderCancel omits the refund argument on purpose, reasoning that COD has
   * nothing captured. Once the customer has paid the prepaid link that is no
   * longer true, and cancelLinkIfAny is soft, so a stale Pay online message
   * stays tappable. The old path took the order away, kept the money, issued no
   * refund and told nobody.
   */
  it('paid order: refuses to cancel, hands off for a refund instead', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    const paid = codOrder({ netPaymentSet: { shopMoney: { amount: '1449.00' } } });
    const { clients, deps } = setup(paid);

    await A.onCancelYes('12345', deps);

    expect(clients.shopify.calls.some((c) => c.op === 'orderCancel')).toBe(false);
    expect(tagsAdded(clients.shopify)).toContain('wa-cancel-refund-review');
    expect(tagsAdded(clients.shopify)).not.toContain('wa-cancelled');
    // and the customer is told why, not fobbed off with "already left for delivery"
    const toCustomer = clients.whatsapp.sent.filter((x) => x.to === PHONE);
    expect(toCustomer.some((x) => /already paid/.test(x.body || ''))).toBe(true);
    expect(toCustomer.some((x) => /already left for delivery/.test(x.body || ''))).toBe(false);
    // and a person is told, with the amount, so the refund can actually happen
    const alert = clients.whatsapp.sent.find((x) => x.name && x.name.startsWith('ops_alert'));
    expect(alert).toBeTruthy();
    expect(JSON.stringify(alert)).toMatch(/1449\.00/);
  });

  it('part paid order hands off too, because a deposit still needs refunding', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    const deposit = codOrder({ netPaymentSet: { shopMoney: { amount: '75.00' } } });
    const { clients, deps } = setup(deposit);
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'orderCancel')).toBe(false);
    expect(tagsAdded(clients.shopify)).toContain('wa-cancel-refund-review');
  });

  it('dispatched order: no cancel, tag wa-cancel-requested + too-late message', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'Out for Delivery', statusType: 'UD' } } });
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'orderCancel')).toBe(false);
    expect(tagsAdded(clients.shopify)).toContain('wa-cancel-requested');
    expect(clients.whatsapp.sent.some((s) => /already left for delivery/.test(s.body || ''))).toBe(true);
  });
});

describe('Flow A payment edge cases', () => {
  it('courier not editable -> full refund + prepaid_refund, no conversion', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'Out for Delivery', statusType: 'UD' } } });
    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.razorpay.refunds).toHaveLength(1);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(false);
    // window closed -> refund goes as the prepaid_refund template
    expect(clients.whatsapp.sent.some((s) => s.name === 'prepaid_refund_v2' || /on its way back/.test(s.body || ''))).toBe(true);
  });

  it('a waybill still in our hands (manifested) -> edits to prepaid then converts', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'Manifested', statusType: 'UD' } } });
    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.courier.calls.some((c) => c.op === 'editToPrepaid')).toBe(true);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
  });

  /*
   * F3. IN_TRANSIT and PENDING used to count as editable, and Delhivery
   * refuses /api/p/edit after pickup. The edit failed, the order was converted
   * anyway, and the waybill stayed COD, so the courier collected the money a
   * second time at the door. A refund is the only honest ending here.
   */
  it('a parcel already picked up -> refunds, and never claims the waybill was changed', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } });
    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.courier.calls.some((c) => c.op === 'editToPrepaid')).toBe(false);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(false);
    expect(clients.razorpay.refunds).toHaveLength(1);
  });
});

describe('Flow A exclusions + guards', () => {
  it('PARTIAL and PREPAID get a plain confirmation, never the COD chase', async () => {
    for (const status of ['PARTIALLY_PAID', 'PAID']) {
      _resetMemory();
      _resetTimers();
      const { clients, deps } = setup(codOrder({ displayFinancialStatus: status }));
      await A.onCodTimer('12345', deps);
      expect(names(clients.whatsapp), status).toContain('order_confirmed_v1');
      expect(names(clients.whatsapp), status).not.toContain('cod_confirm_v3');
      expect(tagsAdded(clients.shopify), status).toContain('wa-order-confirmed');
      // nothing to chase: no reminder, no marketing fallback, no high-risk hold
      expect(_peekTimers(), status).toHaveLength(0);
    }
  });

  it('no verified phone -> tag wa-no-verified-phone, no message', async () => {
    const { clients, deps } = setup(codOrder({ attrs: [{ key: '_codkAmountType', value: 'cod' }, { key: '_codkAmountValue', value: '50.0' }] }));
    await A.onCodTimer('12345', deps);
    expect(tagsAdded(clients.shopify)).toContain('wa-no-verified-phone');
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('opted-out phone gets no cod_confirm', async () => {
    const { clients, deps } = setup();
    await setOptOut(PHONE, true);
    await A.onCodTimer('12345', deps);
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('marketing fallback respects the 7-day cap', async () => {
    // The offer is OFF by default now (RULES.prepaidOfferEnabled). This test
    // keeps proving the machinery still works for when it is switched back on.
    RULES.prepaidOfferEnabled = true;
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps); // step = confirm_sent
    await A.onFallback('12345', deps);
    await A.onFallback('12345', deps);
    const offers = clients.whatsapp.sent.filter((s) => s.type === 'template' && s.name === 'prepaid_offer_v3');
    expect(offers).toHaveLength(1);
  });
});

describe('Flow A staged rollout (SEND_ALLOWLIST)', () => {
  it('a skipped send leaves the order unmarked, and it still sends once the allowlist comes off', async () => {
    const { clients, deps } = setup();
    const realSend = clients.whatsapp.sendTemplate.bind(clients.whatsapp);
    // what the real client returns for a recipient outside SEND_ALLOWLIST
    clients.whatsapp.sendTemplate = async () => ({ messageId: 'not_allowlisted:dry', skipped: 'not_allowlisted' });

    await A.onCodTimer('12345', deps);

    // nothing may be written to a real customer's order for a message we never sent
    expect(tagsAdded(clients.shopify)).not.toContain('wa-cod-sent');
    expect(_peekTimers().map((t) => t.name)).not.toContain('A-12345-reminder');

    // allowlist removed: the order must NOT be stuck as already-confirmed
    clients.whatsapp.sendTemplate = realSend;
    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp)).toContain('cod_confirm_v3');
    expect(tagsAdded(clients.shopify)).toContain('wa-cod-sent');
  });
});

describe('Flow A prepaid conversion tagging', () => {
  it('never tags PREPAID-CONVERTED when the conversion fails', async () => {
    const { clients, deps } = setup(); // no AWB, so the pendingCourierPrepaid branch
    clients.shopify.convertToPrepaid = async () => {
      throw new Error('prepaid conversion not verified on a test order yet');
    };

    await A.onCodTimer('12345', deps);
    await A.onConfirm('12345', deps);
    await expect(
      // The real prepaid total, so this reaches the conversion and fails THERE
      // rather than being stopped by F21's amount check first.
      A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps),
    ).rejects.toThrow();

    // the order is still unpaid COD: marking it prepaid would risk shipping it
    // without collecting cash
    expect(tagsAdded(clients.shopify)).not.toContain('PREPAID-CONVERTED');
    expect(tagsAdded(clients.shopify)).not.toContain('wa-prepaid-converted');
  });

  /*
   * ORDER #1252, 2026-11-13: paid at 08:31, the conversion refused five times
   * by 08:57, and the customer was told nothing whatsoever. Everything that
   * speaks to them lives after the conversion, so a throw there was silence.
   */
  it('tells the customer and the owner when a payment cannot be applied', async () => {
    const { clients, deps } = setup();
    clients.shopify.convertToPrepaid = async () => {
      throw new Error('orderEditAddLineItemDiscount: the order has a discount');
    };

    await A.onCodTimer('12345', deps);
    await A.onConfirm('12345', deps);
    await expect(
      A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps),
    ).rejects.toThrow();

    const said = clients.whatsapp.sent.map((x) => `${x.body || ''}`).join(' | ');
    // their money arrived and is being looked at, which is the truth
    expect(said).toContain('Our team is checking');
    // findable in Shopify without reading a log
    expect(tagsAdded(clients.shopify)).toContain('wa-payment-unapplied');
    // and the owner has the figure
    expect(said).toContain('1,349');
  });

  it('says it once, however many times SQS retries', async () => {
    const { clients, deps } = setup();
    clients.shopify.convertToPrepaid = async () => {
      throw new Error('orderEditAddLineItemDiscount: the order has a discount');
    };
    await A.onCodTimer('12345', deps);
    await A.onConfirm('12345', deps);
    const paid = { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 };
    for (let i = 0; i < 3; i += 1) {
      await expect(A.onPaymentPaid('12345', paid, deps)).rejects.toThrow();
    }
    const checking = clients.whatsapp.sent.filter((x) =>
      String(x.body || '').includes('Our team is checking'),
    );
    expect(checking).toHaveLength(1);
  });
});

describe('Flow A dispatch message', () => {
  const shipped = (order = codOrder()) =>
    setup({ ...order, fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB9', company: 'Delhivery' }] }] });

  it('tells a COD customer exactly what to keep ready, with the tracking number', async () => {
    const { clients, deps } = shipped();
    await A.onFulfillmentCreate('12345', deps);
    const msg = clients.whatsapp.sent.find((s) => s.name === 'order_shipped_v2');
    expect(msg).toBeDefined();
    const params = msg.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
    expect(params).toContain('please keep ₹1,499 ready');
    expect(params).toContain('Bandhan, size M');
    expect(params).toContain('AWB9');
    // the Track button carries the waybill as the URL suffix
    expect(msg.components.find((c) => c.sub_type === 'url').parameters[0].text).toBe('AWB9');
  });

  it('tells a prepaid customer there is nothing to pay', async () => {
    const { clients, deps } = shipped(
      codOrder({ displayFinancialStatus: 'PAID', netPaymentSet: { shopMoney: { amount: '1499.00' } } }),
    );
    await A.onFulfillmentCreate('12345', deps);
    const msg = clients.whatsapp.sent.find((s) => s.name === 'order_shipped_v2');
    const params = msg.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
    expect(params).toContain('nothing to pay, this order is prepaid');
  });

  it('sends it once, however many times the fulfillment webhook arrives', async () => {
    const { clients, deps } = shipped();
    await A.onFulfillmentCreate('12345', deps);
    await A.onFulfillmentCreate('12345', deps);
    expect(clients.whatsapp.sent.filter((s) => s.name === 'order_shipped_v2')).toHaveLength(1);
  });
});

describe('Flow A quotes only what it can actually charge', () => {
  /*
   * The fallback slot has two jobs that want opposite answers, and this pair of
   * tests is the guard. A version still in Meta review must fall back to the
   * previous APPROVED version, which keeps both prices. Only a genuinely
   * unquotable price may drop them. Sharing one slot would have meant dropping
   * the prepaid price from every confirmation for the hours a review takes.
   */
  it('keeps the prices when the new copy is still in Meta review', async () => {
    const { clients, deps } = setup();
    const real = clients.whatsapp.sendTemplate;
    clients.whatsapp.sendTemplate = async (a) => {
      if (a.name === 'cod_confirm_v3') {
        const e = new Error('template does not exist');
        e.waCode = 132001; // still in review
        throw e;
      }
      return real(a);
    };
    await A.onCodTimer('12345', deps);
    // v2, which quotes cod_total AND prepaid_total. NOT v1.
    expect(names(clients.whatsapp)).toContain('cod_confirm_v2');
    expect(names(clients.whatsapp)).not.toContain('cod_confirm_v1');
    expect(tagsAdded(clients.shopify)).toContain('wa-cod-sent');
  });

  it('drops to the price-free version only when no prepaid price can be quoted', async () => {
    // Driven through tpl() directly: preferLegacy is set inside onCodTimer from
    // !offerOk, and the routing is what this asserts, not how offerOk is
    // computed. flowA passes exactly this ctx when it cannot honour an offer.
    const { clients, deps } = setup();
    const vars = {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      cod_total: 'Rs 1,499',
      prepaid_total: 'Rs 1,349',
      order_total: 'Rs 1,499',
    };
    await tpl(deps, PHONE, 'cod_confirm', vars, { orderId: '12345', preferLegacy: true, imageUrl: 'https://cdn/x.jpg' });
    expect(names(clients.whatsapp)).toEqual(['cod_confirm_v1']);
  });

  it('sends the price-free version when the product has no photo for the header', async () => {
    // cod_confirm_v3 and v2 both carry an IMAGE header, so v1 is the only one
    // that can go out at all without a photo. Same as before this change.
    const { clients, deps } = setup();
    await tpl(
      deps,
      PHONE,
      'cod_confirm',
      { customer_name: 'Aarav', order_number: '#1234', item_line: 'X', cod_total: 'a', prepaid_total: 'b', order_total: 'c' },
      { orderId: '12345' }, // no imageUrl
    );
    expect(names(clients.whatsapp)).toEqual(['cod_confirm_v1']);
  });

  it('quotes the open payment link, not a total that changed after it was made', async () => {
    const order = codOrder();
    const { clients, deps } = setup(order);
    await A.onConfirm('12345', deps); // creates the link at 1499 - 150 = 1349
    expect(clients.razorpay.links[0].args.amountPaise).toBe(134900);

    // the order is edited afterwards; the link still charges the old amount
    order.currentTotalPriceSet = { shopMoney: { amount: '1999.00' } };
    await A.onPayOnline('12345', deps);

    const last = clients.whatsapp.sent.filter((s) => s.type === 'cta_url').pop();
    expect(last.buttonText).toBe('Pay ₹1,349');
    expect(last.body).toContain('₹1,349');
    expect(last.body).not.toContain('₹1,849');
  });

  it('keeps the prepaid nudge alive when a Pay online tap never becomes a payment', async () => {
    // The offer is OFF by default now (RULES.prepaidOfferEnabled). This test
    // keeps proving the machinery still works for when it is switched back on.
    RULES.prepaidOfferEnabled = true;
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onPayOnline('12345', deps);
    // asking for a link is not paying, so the 6h fallback must still be armed
    expect(_peekTimers().map((t) => t.name)).toContain('A-12345-fallback');
    expect(_peekTimers().map((t) => t.name)).not.toContain('A-12345-reminder');
  });

  it('refuses to quote a prepaid price when the COD fee does not match', async () => {
    const { clients, deps } = setup(
      codOrder({ shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '99.00' } } }] } }),
    );
    await A.onCodTimer('12345', deps);
    // the mismatch means no link can be created, so the price-free version goes
    expect(names(clients.whatsapp)).toContain('cod_confirm_v1');
    expect(names(clients.whatsapp)).not.toContain('cod_confirm_v3');
  });
});

describe('Flow A never refunds on a read failure', () => {
  it('throws so SQS retries instead of sending the money back', async () => {
    const { clients, deps } = setup();
    clients.shopify.getOrder = async () => null;
    await expect(A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps)).rejects.toThrow(/could not be read/);
    expect(clients.razorpay.refunds).toHaveLength(0);
  });
});

describe('Flow A tracking arrives late', () => {
  it('handles a repeat fulfillment webhook without sending twice', async () => {
    // Shopify commonly creates the fulfillment first and adds tracking after,
    // so the same order legitimately arrives here more than once.
    const order = codOrder();
    const { clients, deps } = setup(order);
    await A.onFulfillmentCreate('12345', deps); // no AWB yet: nothing to say
    expect(clients.whatsapp.sent).toHaveLength(0);

    order.fulfillments = [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB9', company: 'Delhivery' }] }];
    await A.onFulfillmentCreate('12345', deps);
    await A.onFulfillmentCreate('12345', deps);
    expect(clients.whatsapp.sent.filter((s) => s.name === 'order_shipped_v2')).toHaveLength(1);
  });
});

describe('Flow A: an error must never reach the customer twice', () => {
  it('does not resend the confirmation when the bookkeeping after it fails', async () => {
    const { clients, deps } = setup();
    clients.shopify.tagsAdd = async () => { throw new Error('shopify down'); };

    await A.onCodTimer('12345', deps); // must not throw: tagging is not the customer's problem
    expect(names(clients.whatsapp).filter((n) => n.startsWith('cod_confirm'))).toHaveLength(1);

    // the timer fires again (SQS redelivery, a duplicate webhook, a retry)
    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp).filter((n) => n.startsWith('cod_confirm'))).toHaveLength(1);
  });

  it('does not resend the reminder or the offer after a redelivery', async () => {
    // The offer is OFF by default now (RULES.prepaidOfferEnabled). This test
    // keeps proving the machinery still works for when it is switched back on.
    RULES.prepaidOfferEnabled = true;
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onReminder('12345', deps);
    await A.onReminder('12345', deps);
    expect(names(clients.whatsapp).filter((n) => n.startsWith('cod_reminder'))).toHaveLength(1);

    await A.onFallback('12345', deps);
    await A.onFallback('12345', deps);
    expect(names(clients.whatsapp).filter((n) => n.startsWith('prepaid_offer'))).toHaveLength(1);
  });

  it('still sends the confirmation when the owner alert cannot be delivered', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    const { clients, deps } = setup(
      codOrder({ shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '99.00' } } }] } }),
    );
    const real = clients.whatsapp.sendTemplate;
    clients.whatsapp.sendTemplate = async (a) => {
      if (a.name.startsWith('ops_alert')) throw new Error('owner phone unreachable');
      return real(a);
    };
    await A.onCodTimer('12345', deps);
    await A.onConfirm('12345', deps); // alerts the owner about the fee mismatch
    expect(names(clients.whatsapp).some((n) => n.startsWith('cod_confirm'))).toBe(true);
  });
});

describe('Flow A: money moves at most once, whatever fails afterwards', () => {
  const cancelled = () => codOrder({ cancelledAt: '2026-09-20T07:00:00Z' });

  it('refunds exactly once even when every later step keeps failing', async () => {
    const { clients, deps } = setup(cancelled());
    const real = clients.whatsapp.sendTemplate;
    clients.whatsapp.sendTemplate = async () => { throw new Error('meta down'); };

    // three redeliveries, all failing after the refund has already happened
    for (let i = 0; i < 3; i += 1) {
      await expect(A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps)).rejects.toThrow();
    }
    expect(clients.razorpay.refunds).toHaveLength(1);

    // WhatsApp recovers: the customer is told, and still no second refund
    clients.whatsapp.sendTemplate = real;
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.razorpay.refunds).toHaveLength(1);
    expect(names(clients.whatsapp).filter((n) => n.startsWith('prepaid_refund'))).toHaveLength(1);
  });

  it('converts the order once and still tells the customer after a failed attempt', async () => {
    const { clients, deps } = setup();
    const real = clients.whatsapp.sendText;
    clients.whatsapp.sendText = async () => { throw new Error('meta down'); };
    await A.onConfirm('12345', deps); // opens the 24h window so the notify is a session message

    await expect(A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps)).rejects.toThrow();
    expect(clients.shopify.calls.filter((c) => c.op === 'convertToPrepaid')).toHaveLength(1);

    clients.whatsapp.sendText = real;
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps);
    // converted once, and the customer heard about it exactly once
    expect(clients.shopify.calls.filter((c) => c.op === 'convertToPrepaid')).toHaveLength(1);
    expect(clients.whatsapp.sent.filter((s) => /has come through/.test(s.body || ''))).toHaveLength(1);
  });

  it('keeps the order correct when only the audit trail fails', async () => {
    const { clients, deps } = setup();
    clients.shopify.metafieldsSet = async () => { throw new Error('metafield write failed'); };
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
    expect(clients.razorpay.refunds).toHaveLength(0);
    expect(names(clients.whatsapp).some((n) => n.startsWith('prepaid_confirmed'))).toBe(true);
  });

  it('sends nothing and lets SQS retry when the order cannot be read at all', async () => {
    const { clients, deps } = setup();
    clients.shopify.getOrder = async () => { throw Object.assign(new Error('gateway'), { status: 503 }); };
    await expect(A.onCodTimer('12345', deps)).rejects.toThrow('gateway');
    expect(clients.whatsapp.sent).toHaveLength(0);
  });
});

describe('Flow A: tidying up never fails the work it belongs to', () => {
  it('stops the flow even though the paid link cannot be cancelled', async () => {
    // Razorpay refuses to cancel a paid link. This really happened on order
    // #1150: the customer cancelled after paying, and orders/cancelled failed
    // five times and went to the DLQ, so Flow A was never stopped.
    const { clients, deps } = setup();
    await A.onConfirm('12345', deps); // creates the link
    clients.razorpay.cancelLink = async () => {
      throw new Error('cannot cancel or expire an already paid / partially paid link');
    };
    await expect(A.onStop('12345', deps)).resolves.not.toThrow();
  });

  it('still tells a cancelling customer it is done when the cleanup fails', async () => {
    const { clients, deps } = setup();
    await A.onConfirm('12345', deps);
    clients.razorpay.cancelLink = async () => { throw new Error('already paid'); };
    clients.shopify.tagsAdd = async () => { throw new Error('shopify down'); };
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'orderCancel')).toBe(true);
    expect(clients.whatsapp.sent.some((s) => /is cancelled/.test(s.body || ''))).toBe(true);
  });
});

describe('Flow A: an unverified courier API must not strand a real payment', () => {
  const withAwb = () => codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });

  it('converts, tells the customer and raises an urgent alert when the courier edit fails', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    const { clients, deps } = setup(withAwb(), { statuses: { AWB1: { status: 'Manifested', statusType: 'UD' } } });
    clients.courier.editToPrepaid = async () => { throw new Error('unexpected field pt'); };

    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps);

    // the customer is served: order converted, money kept, message sent
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
    expect(clients.razorpay.refunds).toHaveLength(0);
    expect(names(clients.whatsapp).some((n) => n.startsWith('prepaid_confirmed'))).toBe(true);
    // and the waybill is flagged for a human before it ships
    expect(tagsAdded(clients.shopify)).toContain('wa-courier-still-cod');
    const alert = clients.whatsapp.sent.find((s) => s.name && s.name.startsWith('ops_alert'));
    expect(JSON.stringify(alert.components)).toContain('collect the money a second time');
  });

  it('retries the courier edit on a later attempt rather than recording the failure', async () => {
    const { clients, deps } = setup(withAwb(), { statuses: { AWB1: { status: 'Manifested', statusType: 'UD' } } });
    let calls = 0;
    clients.courier.editToPrepaid = async () => { calls += 1; throw new Error('nope'); };
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 134900 }, deps);
    await A.onFulfillmentCreate('12345', deps); // the AWB webhook arrives again
    expect(calls).toBeGreaterThan(1);
  });
});

describe('Flow A: a template still in review must not cost a customer their confirmation', () => {
  const prepaid = () => codOrder({ displayFinancialStatus: 'PAID' });

  it('comes back later instead of failing the order or dropping it', async () => {
    const { clients, deps } = setup(prepaid());
    const real = clients.whatsapp.sendTemplate;
    clients.whatsapp.sendTemplate = async (a) => {
      if (a.name.startsWith('order_confirmed')) {
        throw Object.assign(new Error('template does not exist'), { waCode: 132001 });
      }
      return real(a);
    };
    // must not throw: a real order may not go to the DLQ over a pending review
    await expect(A.onCodTimer('12345', deps)).resolves.not.toThrow();
    expect(clients.whatsapp.sent).toHaveLength(0);
    // and it is queued to try again rather than forgotten
    expect(_peekTimers().map((t) => t.name)).toContain('A-12345-cod');

    // Meta approves it; the next attempt delivers
    clients.whatsapp.sendTemplate = real;
    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp)).toContain('order_confirmed_v1');
    expect(tagsAdded(clients.shopify)).toContain('wa-order-confirmed');
  });

  it('stops trying after a day and tells the owner', async () => {
    const { clients, deps } = setup(prepaid());
    clients.whatsapp.sendTemplate = async () => {
      throw Object.assign(new Error('template does not exist'), { waCode: 132001 });
    };
    for (let i = 0; i < 14; i += 1) await A.onCodTimer('12345', deps);
    const st = await getState('12345');
    expect(st.flowA.confirmDeferred).toBeLessThanOrEqual(13);
  });
});

/*
 * Regression: the three faults the live logs showed between 22 and 24 Sept.
 * Every one of them was invisible to the suite because the fakes were kinder
 * than the real providers.
 */
describe('Flow A refunds only with a real payment id', () => {
  const noPayEntity = { id: 'plink_TfKl4KKqyc4wS5', amount_paid: 134900 };

  it('does not send a plink_ id to the refund endpoint', async () => {
    const order = codOrder({ cancelledAt: '2026-09-20T07:00:00Z' });
    const { clients, deps } = setup(order);
    config.ownerAlertPhones = [PHONE];

    await A.onPaymentPaid('12345', noPayEntity, deps);

    expect(clients.razorpay.refunds).toHaveLength(0);
  });

  it('never tells the customer money is on its way back when it is not', async () => {
    const order = codOrder({ cancelledAt: '2026-09-20T07:00:00Z' });
    const { clients, deps } = setup(order);
    config.ownerAlertPhones = [PHONE];

    await A.onPaymentPaid('12345', noPayEntity, deps);

    expect(names(clients.whatsapp).some((n) => n.startsWith('prepaid_refund'))).toBe(false);
    expect(clients.whatsapp.sent.some((s) => /could NOT be refunded/i.test(JSON.stringify(s)))).toBe(true);
  });

  it('still refunds normally when the webhook carries the pay_ id', async () => {
    const order = codOrder({ cancelledAt: '2026-09-20T07:00:00Z' });
    const { clients, deps } = setup(order);

    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);

    expect(clients.razorpay.refunds).toHaveLength(1);
    expect(clients.razorpay.refunds[0].paymentId).toBe('pay_1');
    expect(names(clients.whatsapp).some((n) => n.startsWith('prepaid_refund'))).toBe(true);
  });
});

/*
 * Live 24 Sept: order_shipped_v1 is not approved on the WABA and the key had no
 * LEGACY fallback, so three real orders shipped with the customer told nothing.
 * The only trace was a WARN. The fulfillment record must still survive, but the
 * owner has to hear about it.
 *
 * v1 is now the fallback for v2, so this case only arises when BOTH are
 * unusable. That is the point of the fallback: one bad template no longer
 * silences the dispatch message.
 */
describe('Flow A dispatch message when the template is not approved', () => {
  function shippedWithUnusableTemplate() {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB9', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order);
    config.ownerAlertPhones = [PHONE];
    const realSend = clients.whatsapp.sendTemplate;
    clients.whatsapp.sendTemplate = async (a) => {
      if (a.name === 'order_shipped_v2' || a.name === 'order_shipped_v1') {
        const e = new Error('template does not exist');
        /** @type {any} */ (e).waCode = 132001;
        throw e;
      }
      return realSend(a);
    };
    return { clients, deps };
  }

  it('does not fail the fulfillment record', async () => {
    const { deps } = shippedWithUnusableTemplate();
    await expect(A.onFulfillmentCreate('12345', deps)).resolves.toBeUndefined();
  });

  it('tells the owner the customer was never messaged', async () => {
    const { clients, deps } = shippedWithUnusableTemplate();
    await A.onFulfillmentCreate('12345', deps);
    const alerts = clients.whatsapp.sent.filter((s) => /dispatch message NOT sent/i.test(JSON.stringify(s)));
    expect(alerts).toHaveLength(1);
  });

  it('alerts once per order, not once per fulfillment update', async () => {
    const { clients, deps } = shippedWithUnusableTemplate();
    await A.onFulfillmentCreate('12345', deps);
    await A.onFulfillmentCreate('12345', deps);
    await A.onFulfillmentCreate('12345', deps);
    const alerts = clients.whatsapp.sent.filter((s) => /dispatch message NOT sent/i.test(JSON.stringify(s)));
    expect(alerts).toHaveLength(1);
  });
});

/*
 * "Yes, cancel it" on an order that is ALREADY cancelled (the owner did it in
 * Shopify, or COD King did). orderCancel returns a userError for that and the
 * client throws on userErrors, so the record failed five times into the DLQ and
 * the customer was never answered, on an order already in the state they asked
 * for.
 */
describe('Flow A cancel on an already cancelled order', () => {
  const cancelled = () => setup(codOrder({ cancelledAt: '2026-09-20T07:00:00Z' }));

  it('does not call orderCancel again', async () => {
    const { clients, deps } = cancelled();
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.filter((c) => c.op === 'orderCancel')).toHaveLength(0);
  });

  it('still confirms the cancellation to the customer', async () => {
    const { clients, deps } = cancelled();
    await A.onCancelYes('12345', deps);
    expect(clients.whatsapp.sent.some((s) => /cancel/i.test(JSON.stringify(s)))).toBe(true);
  });

  it('does not throw, so the record is never parked in the DLQ', async () => {
    const { deps } = cancelled();
    await expect(A.onCancelYes('12345', deps)).resolves.toBeUndefined();
  });

  it('still cancels an order that is genuinely open', async () => {
    const { clients, deps } = setup();
    await A.onCancelYes('12345', deps);
    expect(clients.shopify.calls.filter((c) => c.op === 'orderCancel')).toHaveLength(1);
  });
});

/*
 * An unreadable courier status used to fall into the else-branch and REFUND a
 * customer who had just paid. mapCourierStatus returns UNKNOWN for a tracking
 * call that came back empty or with a string Delhivery has not shown us before,
 * so a courier API hiccup reversed a real payment.
 */
describe('Flow A refuses to decide on a courier status it cannot read', () => {
  const paid = { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 };
  const shipped = (courier) =>
    setup(
      codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB9', company: 'Delhivery' }] }] }),
      courier,
    );

  it('does not refund when the courier returns a status we do not recognise', async () => {
    const { clients, deps } = shipped({ statuses: { AWB9: { status: 'Something Delhivery invented' } } });
    await expect(A.onPaymentPaid('12345', paid, deps)).rejects.toThrow(/could not be read/);
    expect(clients.razorpay.refunds).toHaveLength(0);
  });

  it('does not refund when tracking comes back empty', async () => {
    const { clients, deps } = shipped({ statuses: {} });
    await expect(A.onPaymentPaid('12345', paid, deps)).rejects.toThrow(/could not be read/);
    expect(clients.razorpay.refunds).toHaveLength(0);
  });

  it('still refunds when the courier genuinely says it is too late', async () => {
    const { clients, deps } = shipped({ statuses: { AWB9: { status: 'Out for delivery' } } });
    await A.onPaymentPaid('12345', paid, deps);
    expect(clients.razorpay.refunds).toHaveLength(1);
  });

  it('still converts when the courier says it is editable', async () => {
    const { clients, deps } = shipped({ statuses: { AWB9: { status: 'Manifested' } } });
    await A.onPaymentPaid('12345', paid, deps);
    expect(clients.razorpay.refunds).toHaveLength(0);
    expect(tagsAdded(clients.shopify)).toContain('PREPAID-CONVERTED');
  });
});

/*
 * Meta says 131026 once; setUndeliverable recorded it and nothing read it, so
 * the dead number kept being billed for every future message and dragging the
 * number's quality rating down.
 */
describe('Flow A stops messaging a number WhatsApp says is dead', () => {
  it('skips the confirmation for an undeliverable number', async () => {
    const { clients, deps } = setup();
    await setUndeliverable(PHONE);
    await A.onCodTimer('12345', deps);
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('leaves the order unmarked so nothing downstream thinks it was told', async () => {
    const { deps } = setup();
    await setUndeliverable(PHONE);
    await A.onCodTimer('12345', deps);
    expect((await getState('12345'))?.flowA?.codConfirmAt).toBeUndefined();
  });

  it('still reaches the owner, whose alerts must never go quiet', async () => {
    const { clients, deps } = setup();
    config.ownerAlertPhones = [PHONE];
    await setUndeliverable(PHONE);
    await A.onCodTimer('12345', deps);
    const { ownerAlert } = await import('./send.mjs');
    await ownerAlert({ clients }, '#1234', 'something needs you');
    expect(clients.whatsapp.sent.length).toBeGreaterThan(0);
  });
});

/*
 * The three message-frequency decisions of 2026-10-10, pinned down.
 *
 * All three are driven by live numbers, so the tests assert the DEFAULT (off,
 * quiet) behaviour. The four tests above already cover the enabled path.
 */
describe('fewer messages, by default', () => {
  const bodyParams = (wa, name) => {
    const s = wa.sent.find((x) => x.type === 'template' && x.name.startsWith(name));
    const body = (s?.components || []).find((c) => c.type === 'body');
    return (body?.parameters || []).map((p) => p.text);
  };

  it('a PARTIAL order is told what it paid and what is still due at the door', async () => {
    // #1162 and #1197 for real: Rs 1,099 total, Rs 62.45 deposit taken at COD
    // King's checkout, Rs 1,036.55 owed at the door.
    const { clients, deps } = setup(
      codOrder({
        displayFinancialStatus: 'PARTIALLY_PAID',
        netPaymentSet: { shopMoney: { amount: '62.45' } },
        currentTotalPriceSet: { shopMoney: { amount: '1099.00' } },
        totalPriceSet: { shopMoney: { amount: '1099.00' } },
      }),
    );
    await A.onOrderCreate('12345', deps);
    await A.onCodTimer('12345', deps);

    const params = bodyParams(clients.whatsapp, 'order_confirmed');
    const total = params.find((t) => t.includes('1,099'));
    expect(total).toBe('₹1,099 (₹62.45 paid online, ₹1,036.55 at delivery)');
    // One message, and no COD chase: a paid order has nothing to confirm.
    expect(names(clients.whatsapp)).toEqual([expect.stringContaining('order_confirmed')]);
  });

  it('a plain COD order still reads as one number, with no payment split', async () => {
    const { clients, deps } = setup();
    await A.onOrderCreate('12345', deps);
    await A.onCodTimer('12345', deps);
    const params = bodyParams(clients.whatsapp, 'cod_confirm');
    expect(params.some((t) => t.includes('paid online'))).toBe(false);
    expect(params).toContain('₹1,499');
  });

  /*
   * The reminder and the offer must never be due at the same moment.
   *
   * Both were codReminderAfterMin/codMarketingFallbackAfterMin = 360 for one
   * commit, which was invisible only because prepaidOfferEnabled was false and
   * nothing read the second value. Switching the offer back on at 360 would
   * have fired a UTILITY reminder and a MARKETING offer within seconds of each
   * other. This is the test that catches that, on the TIMES rather than on the
   * rule values, so it still holds if the numbers change again.
   */
  it('spaces the reminder and the prepaid offer apart', async () => {
    const { deps } = setup();
    await A.onOrderCreate('12345', deps);
    await A.onCodTimer('12345', deps);
    const at = (n) => _peekTimers().find((t) => t.name === `A-12345-${n}`)?.at?.getTime();
    const reminder = at('reminder');
    const fallback = at('fallback');
    expect(reminder).toBeDefined();
    expect(fallback).toBeDefined();
    expect(fallback).toBeGreaterThan(reminder);
    // Far enough apart to read as two separate touches, not a double send.
    expect(fallback - reminder).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('still sends nothing for a fallback timer once the offer is switched off', async () => {
    RULES.prepaidOfferEnabled = false;
    const { clients, deps } = setup();
    await A.onOrderCreate('12345', deps);
    await A.onCodTimer('12345', deps);
    const before = clients.whatsapp.sent.length;
    await A.onFallback('12345', deps); // a timer EventBridge still holds
    expect(clients.whatsapp.sent.length).toBe(before);
    expect(names(clients.whatsapp).some((n) => n.startsWith('prepaid_offer'))).toBe(false);
  });
});

it('ships with the prepaid offer switched on', () => {
  expect(SHIPPED_prepaidOfferEnabled).toBe(true);
});

/*
 * A send that Meta accepts and then refuses has to be traceable back to its
 * order, or the failure reaches nobody.
 *
 * The status webhook carries the wamid and no order, so onWaStatus looks the
 * order up through the reverse map written at send time. Only the confirmation
 * and the shipped notice wrote one. The reminder and the prepaid offer did not,
 * so a failure on either updated no row, added no wa-undeliverable tag and sent
 * no owner alert: the handler resolved nothing and returned.
 *
 * Order #1230 paid for it on 2026-10-27. The prepaid fallback went out at
 * 06:24:37Z with a 1,999 rupee payment link, Meta refused it with 131049
 * thirteen seconds later, and nobody found out. The order shipped COD
 * unconfirmed while the owner had no idea the offer had not arrived.
 *
 * These two assert the half that was missing, the map. router.test.mjs asserts
 * the other half, that a map plus a failed status produces the tag and one
 * owner alert.
 */
describe('Flow A: a reminder or an offer that fails can be traced back', () => {
  const msgRows = async (orderId = '12345') =>
    (await table.query(`ORDER#${orderId}`)).filter((r) => String(r.SK).startsWith('MSG#'));

  it('leaves a wamid the reminder failure webhook can resolve', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onReminder('12345', deps);

    const row = (await msgRows()).find((r) => r.key === 'cod_reminder');
    expect(row).toBeTruthy();
    expect(row.template).toBe(names(clients.whatsapp).find((n) => n.startsWith('cod_reminder')));
    expect(await getWamidMap(row.wamid)).toMatchObject({ orderId: '12345', key: 'cod_reminder' });
  });

  it('leaves a wamid the prepaid offer failure webhook can resolve', async () => {
    RULES.prepaidOfferEnabled = true;
    const { deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onFallback('12345', deps);

    const row = (await msgRows()).find((r) => r.key === 'prepaid_offer');
    expect(row).toBeTruthy();
    expect(await getWamidMap(row.wamid)).toMatchObject({ orderId: '12345', key: 'prepaid_offer' });
  });

  it('records each send once, so the order history is not duplicated', async () => {
    RULES.prepaidOfferEnabled = true;
    const { deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onReminder('12345', deps);
    await A.onFallback('12345', deps);
    const keys = (await msgRows()).map((r) => r.key).sort();
    expect(keys).toEqual(['cod_confirm', 'cod_reminder', 'prepaid_offer']);
  });
});

/*
 * F3. One rule, asked in three places: offer and convert only while the
 * waybill is still in our hands. onFallback used to skip only OFD, DELIVERED
 * and RTO, so it offered a discount on a parcel that was merely PICKED_UP, and
 * the two taps made links with no courier check at all.
 */
describe('Flow A never offers online payment on a parcel the courier already has', () => {
  const picked = () =>
    codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
  const inTransit = { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } };
  const manifested = { statuses: { AWB1: { status: 'Manifested', statusType: 'UD' } } };
  const bodies = (wa) => wa.sent.filter((s) => s.type === 'text').map((s) => s.body);

  beforeEach(async () => {
    RULES.prepaidOfferEnabled = true;
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'confirm_sent' } });
  });

  it('the 12h offer goes nowhere, and mints no link', async () => {
    const { clients, deps } = setup(picked(), inTransit);
    await A.onFallback('12345', deps);
    expect(names(clients.whatsapp)).not.toContain('prepaid_offer_v1');
    expect(clients.razorpay.links ?? []).toHaveLength(0);
  });

  it('Pay online answers with what to have ready, rather than reading as a failed tap', async () => {
    const { clients, deps } = setup(picked(), inTransit);
    await A.onPayOnline('12345', deps);
    expect(bodies(clients.whatsapp).join(' ')).toContain('no longer switch to online payment');
    expect(bodies(clients.whatsapp).join(' ')).toContain('1,499');
    expect(clients.razorpay.links ?? []).toHaveLength(0);
  });

  // F4's state gate reaches a dispatched order before this one does, and says
  // so plainly rather than acknowledging a confirmation that is now moot.
  it('Confirm says the parcel has left, and mints nothing', async () => {
    const { clients, deps } = setup(picked(), inTransit);
    await A.onConfirm('12345', deps);
    expect(bodies(clients.whatsapp).join(' ')).toContain('already left us with Delhivery');
    expect(clients.razorpay.links ?? []).toHaveLength(0);
  });

  it('still offers while the parcel is manifested and ours to change', async () => {
    const { clients, deps } = setup(picked(), manifested);
    await A.onPayOnline('12345', deps);
    expect(clients.razorpay.links.length).toBeGreaterThan(0);
  });

  it('and an order with no waybill at all is untouched by any of this', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPayOnline('12345', deps);
    expect(clients.razorpay.links.length).toBeGreaterThan(0);
    expect(clients.courier.calls.some((c) => c.op === 'track')).toBe(false);
  });
});

/*
 * F4. THE FLOW A TAP MATRIX.
 *
 * WhatsApp buttons never expire, so every one of these cells is reachable by
 * an ordinary customer scrolling back through their chat. Before the state
 * gate, "Keep cash on delivery" after paying online replied "stays on cash on
 * delivery" and overwrote flowA.step `converted`, and "Confirm" on a cancelled
 * order added wa-confirmed and minted a Razorpay link.
 *
 * One test per cell, driven off the table, so a new tap or a new state cannot
 * be added without a row here.
 */
describe('Flow A taps by order state', () => {
  // The longest literal run in a message, which is enough to tell any two of
  // them apart and does not go stale when a placeholder is renamed.
  const fragment = (key) =>
    SESSION[key].body
      .split(/\{\{[^}]+\}\}/)
      .map((x) => x.trim())
      .sort((a, b) => b.length - a.length)[0];

  const withAwb = (over = {}) =>
    codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }], ...over });

  const STATES = {
    'COD, no AWB': { order: () => codOrder(), courier: {} },
    'COD, AWB not picked up': { order: withAwb, courier: { statuses: { AWB1: { status: 'Manifested', statusType: 'UD' } } } },
    'COD, picked up': { order: withAwb, courier: { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } } },
    'paid online': {
      order: () => codOrder({ displayFinancialStatus: 'PAID', netPaymentSet: { shopMoney: { amount: '1499.00' } } }),
      courier: {},
    },
    cancelled: { order: () => codOrder({ cancelledAt: '2026-09-21T06:00:00Z' }), courier: {} },
  };

  /* Expected session message per cell. */
  const MATRIX = {
    'COD, no AWB': {
      onConfirm: 'confirmed_with_offer',
      onPayOnline: 'pay_online_offer',
      onKeepCod: 'keep_cod_ack',
      onCancel: 'cancel_check',
      onCancelYes: 'cancel_done',
    },
    'COD, AWB not picked up': {
      onConfirm: 'confirmed_with_offer',
      onPayOnline: 'pay_online_offer',
      onKeepCod: 'keep_cod_ack',
      onCancel: 'cancel_check',
      onCancelYes: 'cancel_done',
    },
    'COD, picked up': {
      onConfirm: 'already_shipped',
      onPayOnline: 'pay_at_door',
      onKeepCod: 'already_shipped',
      onCancel: 'cancel_check',
      onCancelYes: 'cancel_too_late',
    },
    'paid online': {
      onConfirm: 'already_paid',
      onPayOnline: 'already_paid',
      onKeepCod: 'already_paid',
      onCancel: 'cancel_check',
      onCancelYes: 'cancel_refund_review',
    },
    cancelled: {
      onConfirm: 'order_closed',
      onPayOnline: 'order_closed',
      onKeepCod: 'order_closed',
      onCancel: 'order_closed',
      onCancelYes: 'cancel_done',
    },
  };

  for (const [stateName, { order, courier }] of Object.entries(STATES)) {
    for (const [tap, expected] of Object.entries(MATRIX[stateName])) {
      it(`${stateName}: ${tap} answers ${expected}`, async () => {
        RULES.prepaidOfferEnabled = true;
        // Off, so "Change or cancel" is deterministic: with it on, row 1 would
        // offer the size list instead, which is the matrix's own caveat.
        config.variantChangeEnabled = false;
        config.ownerAlertPhones = ['+919999999999'];
        await ensureState('12345', {});
        await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'confirm_sent' } });
        const { clients, deps } = setup(order(), courier);

        await A[tap]('12345', deps);

        // Every session shape, because the offers go as cta_url and the rest
        // as text or buttons.
        const said = clients.whatsapp.sent.map((s) => s.body || '').join(' | ');
        expect(said).toContain(fragment(expected));
      });
    }
  }

  /*
   * The two writes the stale buttons used to make. Separate from the table
   * because they are about what did NOT happen, which is the actual defect.
   */
  it('never overwrites the converted step, however late Keep COD is tapped', async () => {
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'converted', convertedAt: '2026-09-21T06:00:00Z' } });
    const { clients, deps } = setup(codOrder({ displayFinancialStatus: 'PAID', netPaymentSet: { shopMoney: { amount: '1499.00' } } }));
    await A.onKeepCod('12345', deps);
    expect((await getState('12345')).flowA.step).toBe('converted');
    expect(tagsAdded(clients.shopify)).not.toContain('wa-confirmed');
  });

  it('never confirms, tags or bills a cancelled order', async () => {
    RULES.prepaidOfferEnabled = true;
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'confirm_sent' } });
    const { clients, deps } = setup(codOrder({ cancelledAt: '2026-09-21T06:00:00Z' }));
    await A.onConfirm('12345', deps);
    expect(tagsAdded(clients.shopify)).not.toContain('wa-confirmed');
    expect(clients.razorpay.links ?? []).toHaveLength(0);
    expect((await getState('12345')).flowA.step).toBe('confirm_sent');
  });
});

/*
 * F5. Nothing pre-dispatch goes out after dispatch.
 *
 * cod_confirm says the order is "ready to be packed", cod_reminder says "we are
 * still holding your order", and the high-risk path asks the owner to hold it.
 * None of the three checked whether the parcel had already gone, so all three
 * were reachable on a shipment in transit: once from a timer that fired late,
 * and once from the reconcile sweep re-arming an old order.
 */
describe('Flow A sends nothing pre-dispatch once the parcel has gone', () => {
  const shipped = (over = {}) =>
    codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }], ...over });

  it('the +3min confirmation is skipped, and recorded as looked-at', async () => {
    const { clients, deps } = setup(shipped());
    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp).some((x) => x.startsWith('cod_confirm'))).toBe(false);
    // codSkip, not a bare return: otherwise the sweep re-arms it three times
    // and then alerts the owner about an order that is perfectly fine.
    expect((await getState('12345')).flowA.codSkip).toBe('already-fulfilled');
  });

  it('the 6h reminder never asks them to release a parcel in transit', async () => {
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'confirm_sent' } });
    const { clients, deps } = setup(shipped());
    await A.onReminder('12345', deps);
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect((await getState('12345')).flowA.reminderSkip).toBe('reminder:already-dispatched');
  });

  it('the 24h hold check never asks the owner to hold something already gone', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'confirm_sent' } });
    const { clients, deps } = setup(shipped({ tags: ['HIGH RTO Risk'] }));
    await A.onHighRisk('12345', deps);
    expect(tagsAdded(clients.shopify)).not.toContain('wa-hold-unconfirmed');
    expect((await getState('12345')).flowA.reminderSkip).toBe('highrisk:already-dispatched');
  });

  it('still confirms an order that has not shipped', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp).some((x) => x.startsWith('cod_confirm'))).toBe(true);
  });
});

/*
 * F6. The other half: a COD order with no COD King attributes now gets a
 * working "Pay online", and a genuinely mismatched order alerts the owner once
 * rather than once per tap.
 */
describe('Flow A serves a COD order COD King never touched', () => {
  // No _codkAmountType or _codkAmountValue: a recovery-link, admin or plain
  // storefront COD order, which is how #1232 and #1239 arrived.
  const noCodk = () => codOrder({ attrs: [{ key: '_otpVerifiedPhoneNumber', value: '919812345678' }] });

  beforeEach(async () => {
    RULES.prepaidOfferEnabled = true;
    config.ownerAlertPhones = ['+919999999999'];
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'confirm_sent' } });
  });

  it('makes a real payment link instead of answering "it stays on cash on delivery"', async () => {
    const { clients, deps } = setup(noCodk());
    await A.onPayOnline('12345', deps);
    expect(clients.razorpay.links.length).toBeGreaterThan(0);
    expect(clients.whatsapp.sent.map((s) => s.body || '').join(' ')).not.toContain('stays on cash on delivery');
  });

  it('and no longer alerts the owner about a mismatch that was never claimed', async () => {
    const { clients, deps } = setup(noCodk());
    await A.onPayOnline('12345', deps);
    expect(clients.whatsapp.sent.filter((s) => s.name && s.name.startsWith('ops_alert'))).toHaveLength(0);
  });

  it('alerts once per order, not once per tap, when the figures really do disagree', async () => {
    const mismatched = () =>
      codOrder({
        attrs: [
          { key: '_otpVerifiedPhoneNumber', value: '919812345678' },
          { key: '_codkAmountType', value: 'cod' },
          { key: '_codkAmountValue', value: '99.0' }, // the line says 50
        ],
      });
    const { clients, deps } = setup(mismatched());
    await A.onPayOnline('12345', deps);
    await A.onPayOnline('12345', deps);
    await A.onConfirm('12345', deps);
    expect(clients.whatsapp.sent.filter((s) => s.name && s.name.startsWith('ops_alert'))).toHaveLength(1);
  });

  it('tells them online payment is unavailable rather than pretending they chose COD', async () => {
    const mismatched = () =>
      codOrder({
        attrs: [
          { key: '_otpVerifiedPhoneNumber', value: '919812345678' },
          { key: '_codkAmountValue', value: '99.0' },
        ],
      });
    const { clients, deps } = setup(mismatched());
    await A.onPayOnline('12345', deps);
    expect(clients.whatsapp.sent.map((s) => s.body || '').join(' ')).toContain('not available for order');
  });
});

/*
 * F7, the other half. A parked offer is delivered free-form the moment the
 * customer writes in, which is the only thing that clears Meta's per-user
 * marketing cap for us. Everything is re-asked, because this runs minutes to
 * hours after the refusal.
 */
describe('Flow A delivers a refused offer when the window opens', () => {
  const PHONE = '+919812345678';
  const hour = 3600 * 1000;

  beforeEach(async () => {
    RULES.prepaidOfferEnabled = true;
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: PHONE, name: '#1234', flowA: { step: 'confirm_sent' } });
    await parkOffer(PHONE, '12345', NOW.getTime() + 12 * hour, NOW);
  });

  it('sends the offer as a session message and clears the park', async () => {
    const { clients, deps } = setup(codOrder());
    const out = await A.onWindowOpen(PHONE, deps);
    expect(out).toMatchObject({ sent: true });
    // Free-form, so it carries no category and no marketing cap applies.
    expect(names(clients.whatsapp)).not.toContain('prepaid_offer_v1');
    expect(clients.whatsapp.sent.map((s) => s.body || '').join(' ')).toContain('Your link for order');
    expect(await getParkedOffer(PHONE)).toBeNull();
  });

  it('drops it rather than offering a discount on a parcel already picked up', async () => {
    const shipped = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(shipped, { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } });
    const out = await A.onWindowOpen(PHONE, deps);
    expect(out).toMatchObject({ dropped: 'state:shipped' });
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(await getParkedOffer(PHONE)).toBeNull();
  });

  it('drops it once the link it was holding has expired', async () => {
    await parkOffer(PHONE, '12345', NOW.getTime() - hour, NOW);
    const { clients, deps } = setup(codOrder());
    expect(await A.onWindowOpen(PHONE, deps)).toMatchObject({ dropped: 'link-expired' });
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('does nothing at all for a phone with nothing parked', async () => {
    await clearParkedOffer(PHONE);
    const { clients, deps } = setup(codOrder());
    expect(await A.onWindowOpen(PHONE, deps)).toBeUndefined();
    expect(clients.whatsapp.sent).toHaveLength(0);
  });
});

/*
 * F14. ensurePaymentLink was a bare runOnce(orderId, 'paylink'), so once the
 * Razorpay link passed its expire_by every "Pay online" tap handed back the
 * same dead link, forever, and nothing in the flow noticed. And two session
 * messages linked to the raw Razorpay shortUrl, which bypasses every guard in
 * /p/{token} for exactly the customers most likely to need them.
 */
describe('Flow A gives out a live link, behind our own URL', () => {
  const hour = 3600 * 1000;

  beforeEach(async () => {
    RULES.prepaidOfferEnabled = true;
    config.publicBaseUrl = 'https://wa.example.com';
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: '+919812345678', name: '#1234', flowA: { step: 'confirm_sent' } });
  });

  it('reuses the open link while it is still good', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPayOnline('12345', deps);
    await A.onPayOnline('12345', deps);
    expect(clients.razorpay.links).toHaveLength(1);
  });

  it('makes a new one once the old one is nearly dead, and cancels the old', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPayOnline('12345', deps);
    const first = clients.razorpay.links[0];

    // A day later: the first link is past expire_by.
    const later = new Date(NOW.getTime() + 25 * hour);
    await A.onPayOnline('12345', { ...deps, now: later });

    expect(clients.razorpay.links).toHaveLength(2);
    const second = clients.razorpay.links[1];
    expect(second.id).not.toBe(first.id);
    // And the customer is quoted the live one.
    const bodies = clients.whatsapp.sent.map((s) => `${s.body || ''} ${s.url || ''}`).join(' ');
    expect(bodies).not.toContain(first.shortUrl || 'NEVER');
  });

  it('stops renewing rather than minting a link a day for a stale button', async () => {
    const { clients, deps } = setup(codOrder());
    for (let i = 0; i <= 5; i++) {
      await A.onPayOnline('12345', { ...deps, now: new Date(NOW.getTime() + i * 25 * hour) });
    }
    // Three links, ever, and then it says so instead of handing out a fourth.
    expect(clients.razorpay.links).toHaveLength(3);
    expect(clients.whatsapp.sent.map((s) => s.body || '').join(' ')).toContain('not available for order');
  });

  it('never hands the customer a raw Razorpay URL', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPayOnline('12345', deps);
    await A.onConfirm('12345', deps);
    const urls = clients.whatsapp.sent.map((s) => s.url).filter(Boolean);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/^https:\/\/wa\.example\.com\/p\/[A-Za-z0-9_-]+$/);
      expect(u).not.toContain('razorpay');
    }
  });
});

/*
 * F15. The reconcile sweep re-arms any order with no codConfirmAt and no
 * codSkip, three times, and then tells the owner it "got NO WhatsApp
 * confirmation after 3 automatic retries". An opted-out customer and a number
 * that is not on WhatsApp both returned without recording anything, so both
 * produced that alert about a condition nothing can change.
 */
describe('Flow A records why a confirmation was not sent', () => {
  it('marks an opted-out customer, so the sweep stops chasing it', async () => {
    await setOptOut('+919812345678', true);
    const { clients, deps } = setup(codOrder());
    await A.onCodTimer('12345', deps);
    expect((await getState('12345')).flowA.codSkip).toBe('opted-out');
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('marks a number that cannot take WhatsApp, and tells the owner once', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    await setUndeliverable('+919812345678');
    const { clients, deps } = setup(codOrder());
    await A.onCodTimer('12345', deps);
    await A.onCodTimer('12345', deps); // a redelivery must not alert twice
    expect((await getState('12345')).flowA.codSkip).toBe('undeliverable');
    const alerts = clients.whatsapp.sent.filter((s) => s.name && s.name.startsWith('ops_alert'));
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0].components)).toContain('call the customer');
  });

  it('leaves a dry-run order completely unmarked, so it is messaged when the gate lifts', async () => {
    // The allowlist and DRY_RUN gates live in the real WhatsApp client, so the
    // skip is injected at the same place that client returns it from.
    const { clients, deps } = setup(codOrder());
    clients.whatsapp.sendTemplate = async () => ({ skipped: 'dry_run' });
    await A.onCodTimer('12345', deps);
    const st = await getState('12345');
    // Nothing on flowA at all: not a skip, not a send.
    expect(st.flowA?.codSkip).toBeUndefined();
    expect(st.flowA?.codConfirmAt).toBeUndefined();
  });
});

/*
 * F21. The conversion used a freshly computed amount and then called
 * orderMarkAsPaid, without comparing either to what Razorpay actually
 * collected. The link is made once and the order can be edited afterwards, so
 * Shopify could be marked fully paid for money nobody paid.
 */
describe('Flow A reconciles what was paid against what the order needs', () => {
  const NEED = 134900; // 1499.00 less the 150 saving, which absorbs the 50 COD fee

  beforeEach(async () => {
    config.ownerAlertPhones = ['+919999999999'];
    await ensureState('12345', {});
    await patchState('12345', { class: 'COD', verifiedPhone: '+919812345678', name: '#1234' });
  });

  it('converts when the money matches', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: NEED }, deps);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
  });

  it('converts nothing and refunds nothing when they underpaid', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: NEED - 20000 }, deps);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(false);
    // Not a refund either: which way this goes is the owner's decision.
    expect(clients.razorpay.refunds).toHaveLength(0);
    expect(tagsAdded(clients.shopify)).toContain('wa-payment-mismatch');
  });

  it('catches an overpayment too, which nobody used to notice', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: NEED + 5000 }, deps);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(false);
    expect(tagsAdded(clients.shopify)).toContain('wa-payment-mismatch');
  });

  it('names both numbers to the owner', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: NEED - 20000 }, deps);
    const alert = clients.whatsapp.sent.find((s) => s.name && s.name.startsWith('ops_alert'));
    expect(JSON.stringify(alert.components)).toContain('1,149');
    expect(JSON.stringify(alert.components)).toContain('1,349');
  });

  it('tells the customer their money arrived and is being checked', async () => {
    const { clients, deps } = setup(codOrder());
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: NEED - 20000 }, deps);
    const said = clients.whatsapp.sent.filter((s) => s.to === '+919812345678').map((s) => s.body || '').join(' ');
    expect(said).toContain('checking it against your order');
    // and never that it is confirmed
    expect(said).not.toContain('is paid');
  });
});
