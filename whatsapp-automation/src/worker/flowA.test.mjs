import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { setOptOut } from '../store/phoneProfile.mjs';
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
    const offers = clients.whatsapp.sent.filter((s) => s.type === 'template' && s.name === 'prepaid_offer_v2');
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
    const msg = clients.whatsapp.sent.find((s) => s.name === 'order_shipped_v1');
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
    const msg = clients.whatsapp.sent.find((s) => s.name === 'order_shipped_v1');
    const params = msg.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
    expect(params).toContain('nothing to pay, this order is prepaid');
  });

  it('sends it once, however many times the fulfillment webhook arrives', async () => {
    const { clients, deps } = shipped();
    await A.onFulfillmentCreate('12345', deps);
    await A.onFulfillmentCreate('12345', deps);
    expect(clients.whatsapp.sent.filter((s) => s.name === 'order_shipped_v1')).toHaveLength(1);
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
    await A.onConfirm('12345', deps); // creates the link at 1499 - 100 = 1399
    expect(clients.razorpay.links[0].args.amountPaise).toBe(139900);

    // the order is edited afterwards; the link still charges the old amount
    order.currentTotalPriceSet = { shopMoney: { amount: '1999.00' } };
    await A.onPayOnline('12345', deps);

    const last = clients.whatsapp.sent.filter((s) => s.type === 'cta_url').pop();
    expect(last.buttonText).toBe('Pay ₹1,399');
    expect(last.body).toContain('₹1,399');
    expect(last.body).not.toContain('₹1,899');
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
    expect(clients.whatsapp.sent.filter((s) => s.name === 'order_shipped_v1')).toHaveLength(1);
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
