import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { setOptOut, setUndeliverable } from '../store/phoneProfile.mjs';
import { getState } from '../store/orderState.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import * as A from './flowA.run.mjs';

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
});

const types = (wa) => wa.sent.map((s) => s.type);
const names = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);

describe('Flow A happy path', () => {
  it('create -> cod timer -> confirm sent -> convert on payment', async () => {
    const { clients, deps } = setup();

    await A.onOrderCreate('12345', deps);
    expect(_peekTimers().map((t) => t.name)).toContain('A-12345-cod');

    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp)).toContain('cod_confirm_v2');
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

  it('editable courier (manifested/in transit) -> edits to prepaid then converts', async () => {
    const order = codOrder({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] });
    const { clients, deps } = setup(order, { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } });
    await A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 134900 }, deps);
    expect(clients.courier.calls.some((c) => c.op === 'editToPrepaid')).toBe(true);
    expect(clients.shopify.calls.some((c) => c.op === 'convertToPrepaid')).toBe(true);
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
      expect(names(clients.whatsapp), status).not.toContain('cod_confirm_v2');
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
    expect(names(clients.whatsapp)).toContain('cod_confirm_v2');
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
      A.onPaymentPaid('12345', { id: 'plink_1', payment_id: 'pay_1', amount_paid: 114900 }, deps),
    ).rejects.toThrow();

    // the order is still unpaid COD: marking it prepaid would risk shipping it
    // without collecting cash
    expect(tagsAdded(clients.shopify)).not.toContain('PREPAID-CONVERTED');
    expect(tagsAdded(clients.shopify)).not.toContain('wa-prepaid-converted');
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
  it('falls back to the approved template when Meta rejects the new one', async () => {
    const { clients, deps } = setup();
    const real = clients.whatsapp.sendTemplate;
    clients.whatsapp.sendTemplate = async (a) => {
      if (a.name === 'cod_confirm_v2') {
        const e = new Error('template does not exist');
        e.waCode = 132001; // still in review
        throw e;
      }
      return real(a);
    };
    await A.onCodTimer('12345', deps);
    expect(names(clients.whatsapp)).toContain('cod_confirm_v1');
    expect(tagsAdded(clients.shopify)).toContain('wa-cod-sent');
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
    expect(names(clients.whatsapp)).not.toContain('cod_confirm_v2');
  });
});

describe('Flow A never refunds on a read failure', () => {
  it('throws so SQS retries instead of sending the money back', async () => {
    const { clients, deps } = setup();
    clients.shopify.getOrder = async () => null;
    await expect(A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps)).rejects.toThrow(/could not be read/);
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
      await expect(A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps)).rejects.toThrow();
    }
    expect(clients.razorpay.refunds).toHaveLength(1);

    // WhatsApp recovers: the customer is told, and still no second refund
    clients.whatsapp.sendTemplate = real;
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps);
    expect(clients.razorpay.refunds).toHaveLength(1);
    expect(names(clients.whatsapp).filter((n) => n.startsWith('prepaid_refund'))).toHaveLength(1);
  });

  it('converts the order once and still tells the customer after a failed attempt', async () => {
    const { clients, deps } = setup();
    const real = clients.whatsapp.sendText;
    clients.whatsapp.sendText = async () => { throw new Error('meta down'); };
    await A.onConfirm('12345', deps); // opens the 24h window so the notify is a session message

    await expect(A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps)).rejects.toThrow();
    expect(clients.shopify.calls.filter((c) => c.op === 'convertToPrepaid')).toHaveLength(1);

    clients.whatsapp.sendText = real;
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps);
    // converted once, and the customer heard about it exactly once
    expect(clients.shopify.calls.filter((c) => c.op === 'convertToPrepaid')).toHaveLength(1);
    expect(clients.whatsapp.sent.filter((s) => /has come through/.test(s.body || ''))).toHaveLength(1);
  });

  it('keeps the order correct when only the audit trail fails', async () => {
    const { clients, deps } = setup();
    clients.shopify.metafieldsSet = async () => { throw new Error('metafield write failed'); };
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps);
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
    const { clients, deps } = setup(withAwb(), { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } });
    clients.courier.editToPrepaid = async () => { throw new Error('unexpected field pt'); };

    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps);

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
    const { clients, deps } = setup(withAwb(), { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } });
    let calls = 0;
    clients.courier.editToPrepaid = async () => { calls += 1; throw new Error('nope'); };
    await A.onPaymentPaid('12345', { payment_id: 'pay_1', amount_paid: 139900 }, deps);
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
