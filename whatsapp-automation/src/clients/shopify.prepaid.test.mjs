/*
 * convertToPrepaid, at the GraphQL level.
 *
 * Nothing used to drive this sequence in a test. The flow tests all go through
 * the fake client, which records `convertToPrepaid` as one call and never sees
 * the five mutations it really is, so the order of those mutations and the
 * arithmetic between them were only ever checked by hand on a live order.
 *
 * That is where #1252 was lost on 2026-11-13: Shopify refused
 * orderEditAddLineItemDiscount on a line that already carried a Rs 150
 * automatic discount, the customer's Rs 2,249 stayed in Razorpay, and the
 * order stayed PENDING at Rs 2,399.
 *
 * These stub fetch, so they cannot prove what Shopify accepts. What they pin
 * is everything on our side of that call: which route is taken, what the
 * carried discount adds up to, and that a total which does not match what the
 * customer paid is refused BEFORE the commit, with no commit and no
 * orderMarkAsPaid behind it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shopify } from './shopify.mjs';
import { config } from '../config.mjs';

const realFetch = globalThis.fetch;
const realDry = config.dryRun;
const realVerified = process.env.CONVERSION_VERIFIED;
const realShop = config.shopDomain;

/**
 * A Shopify that answers the order-edit sequence, keeping a running total the
 * way the real calculated order does. `prices` maps a variant gid to the unit
 * price Shopify would charge for it today, which is the one thing the sequence
 * cannot control.
 */
function fakeShopify({ startPaise, lineNetPaise, prices = {}, refuseDiscountOnLine = null }) {
  const ops = [];
  let totalPaise = startPaise;
  const money = () => ({ shopMoney: { amount: (totalPaise / 100).toFixed(2) } });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const q = body.query;
    const v = body.variables || {};
    // attempt() reads res.text() and parses it, so the body has to be HERE
    // and not only in json(): a fake that fills json() alone answers every
    // mutation with {} and every assertion below becomes a crash.
    const reply = (data) => {
      const payload = JSON.stringify({ data });
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    };

    if (q.includes('orderEditBegin')) {
      ops.push('begin');
      return reply({
        orderEditBegin: {
          calculatedOrder: {
            id: 'gid://shopify/CalculatedOrder/1',
            totalPriceSet: money(),
            lineItems: {
              nodes: [
                {
                  id: 'gid://shopify/CalculatedLineItem/111',
                  quantity: 1,
                  restockable: true,
                  originalUnitPriceSet: { shopMoney: { amount: '2499.00' } },
                },
              ],
            },
            shippingLines: [{ id: 'gid://shopify/CalculatedShippingLine/9', title: 'Cash on Delivery' }],
          },
          userErrors: [],
        },
      });
    }
    if (q.includes('orderEditSetQuantity')) {
      ops.push('removeLine');
      /*
       * Removing a line takes off what it was CONTRIBUTING, which is its price
       * less the discount allocated to it, not its sticker price. Verified on
       * #1252: Rs 2,399 became Rs 50 when a Rs 2,499 line carrying a Rs 150
       * allocation was removed, with the Rs 50 COD line still on.
       */
      totalPaise -= lineNetPaise;
      return reply({ orderEditSetQuantity: { calculatedOrder: { totalPriceSet: money() }, userErrors: [] } });
    }
    if (q.includes('orderEditAddVariant')) {
      ops.push(`addVariant:${v.variantId}:${v.quantity}`);
      totalPaise += prices[v.variantId] ?? 249900;
      return reply({
        orderEditAddVariant: {
          calculatedLineItem: { id: 'gid://shopify/CalculatedLineItem/new' },
          calculatedOrder: { totalPriceSet: money() },
          userErrors: [],
        },
      });
    }
    if (q.includes('orderEditAddLineItemDiscount')) {
      ops.push(`discount:${v.lineItemId}:${v.discount.fixedValue.amount}`);
      if (refuseDiscountOnLine && v.lineItemId === refuseDiscountOnLine) {
        return reply({
          orderEditAddLineItemDiscount: {
            calculatedOrder: null,
            userErrors: [
              { field: ['discount'], message: 'The order has a discount which prevents applying additional discounts to this line item.' },
            ],
          },
        });
      }
      totalPaise -= Math.round(Number(v.discount.fixedValue.amount) * 100);
      return reply({ orderEditAddLineItemDiscount: { calculatedOrder: { totalPriceSet: money() }, userErrors: [] } });
    }
    if (q.includes('orderEditRemoveShippingLine')) {
      ops.push('removeShipping');
      totalPaise -= 5000;
      return reply({ orderEditRemoveShippingLine: { calculatedOrder: { totalPriceSet: money() }, userErrors: [] } });
    }
    if (q.includes('orderEditCommit')) {
      ops.push('commit');
      return reply({
        orderEditCommit: {
          order: { id: 'gid://shopify/Order/1252', totalOutstandingSet: money() },
          userErrors: [],
        },
      });
    }
    if (q.includes('orderMarkAsPaid')) {
      ops.push('markPaid');
      return reply({
        orderMarkAsPaid: {
          order: { id: 'gid://shopify/Order/1252', displayFinancialStatus: 'PAID', netPaymentSet: money() },
          userErrors: [],
        },
      });
    }
    throw new Error(`unexpected mutation: ${q.slice(0, 60)}`);
  };
  return { ops, total: () => totalPaise };
}

// Order #1252: one Rs 2,499 garment carrying a Rs 150 allocation, plus the
// Rs 50 COD fee, so Rs 2,399 charged and Rs 2,249 quoted.
const order1252 = {
  gid: 'gid://shopify/Order/12772442669428',
  numericId: '12772442669428',
  lineItems: [
    {
      id: 'gid://shopify/LineItem/111',
      title: 'Kalika',
      quantity: 1,
      unitPaise: 249900,
      discountPaise: 15000,
      variantGid: 'gid://shopify/ProductVariant/56157664412020',
    },
  ],
};
const amounts1252 = { discountPaise: 10000, codFeePaise: 5000, newTotalPaise: 224900 };

beforeEach(() => {
  config.dryRun = false;
  config.shopDomain = 'test.myshopify.com';
  process.env.CONVERSION_VERIFIED = 'true';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  config.dryRun = realDry;
  config.shopDomain = realShop;
  if (realVerified === undefined) delete process.env.CONVERSION_VERIFIED;
  else process.env.CONVERSION_VERIFIED = realVerified;
});

describe('convertToPrepaid on an order that already carries a discount', () => {
  it('re-adds the line with both discounts in one, and lands on what was paid', async () => {
    const fake = fakeShopify({ startPaise: 239900, lineNetPaise: 234900 });
    const r = await shopify.convertToPrepaid({
      order: order1252,
      amounts: amounts1252,
      paymentId: 'pay_TzaxCI8CVqlukY',
      linkId: 'plink_1',
    });

    expect(fake.ops).toEqual([
      'begin',
      'removeLine',
      'addVariant:gid://shopify/ProductVariant/56157664412020:1',
      // Rs 150 the line already had + Rs 100 prepaid, as ONE discount
      'discount:gid://shopify/CalculatedLineItem/new:250.00',
      'removeShipping',
      'commit',
      'markPaid',
    ]);
    expect(fake.total()).toBe(224900);
    expect(r.applied).toBe(true);
    expect(r.method).toBe('order_edit_line_replaced');
    expect(r.carriedDiscountPaise).toBe(15000);
  });

  it('leaves an undiscounted order on the plain one-mutation route', async () => {
    const fake = fakeShopify({ startPaise: 149900, lineNetPaise: 144900 });
    const r = await shopify.convertToPrepaid({
      order: {
        ...order1252,
        lineItems: [{ ...order1252.lineItems[0], unitPaise: 144900, discountPaise: 0 }],
      },
      amounts: { discountPaise: 10000, codFeePaise: 5000, newTotalPaise: 134900 },
      paymentId: 'pay_1',
    });
    expect(fake.ops).toEqual([
      'begin',
      'discount:gid://shopify/CalculatedLineItem/111:100.00',
      'removeShipping',
      'commit',
      'markPaid',
    ]);
    expect(r.method).toBe('order_edit');
  });

  /*
   * The one thing the re-add cannot control. If the variant has been repriced
   * since the order was placed, the line comes back at TODAY's price and the
   * total stops matching what the customer paid. That must be caught while
   * nothing has been applied, because an order edit cannot be rolled back and
   * orderMarkAsPaid settles whatever is outstanding.
   */
  it('refuses before committing when a repriced variant moves the total', async () => {
    const fake = fakeShopify({
      startPaise: 239900,
      lineNetPaise: 234900,
      prices: { 'gid://shopify/ProductVariant/56157664412020': 269900 }, // Rs 2,699 now
    });
    await expect(
      shopify.convertToPrepaid({ order: order1252, amounts: amounts1252, paymentId: 'pay_1' }),
    ).rejects.toThrow(/staged edit totals 244900 but the customer paid 224900/);

    expect(fake.ops).not.toContain('commit');
    expect(fake.ops).not.toContain('markPaid');
  });

  it('never marks an order paid when Shopify refuses the discount', async () => {
    const fake = fakeShopify({
      startPaise: 239900,
      lineNetPaise: 234900,
      refuseDiscountOnLine: 'gid://shopify/CalculatedLineItem/new',
    });
    await expect(
      shopify.convertToPrepaid({ order: order1252, amounts: amounts1252, paymentId: 'pay_1' }),
    ).rejects.toThrow(/orderEditAddLineItemDiscount/);
    expect(fake.ops).not.toContain('commit');
    expect(fake.ops).not.toContain('markPaid');
  });

  it('says so plainly when a discounted line has no variant to re-add', async () => {
    fakeShopify({ startPaise: 239900, lineNetPaise: 234900 });
    await expect(
      shopify.convertToPrepaid({
        order: { ...order1252, lineItems: [{ ...order1252.lineItems[0], variantGid: null }] },
        amounts: amounts1252,
        paymentId: 'pay_1',
      }),
    ).rejects.toThrow(/no variant to re-add/);
  });
});
