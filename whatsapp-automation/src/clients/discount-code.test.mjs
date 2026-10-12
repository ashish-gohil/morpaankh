/*
 * The discount mutation Flow R relies on, asserted against what it actually
 * sends Shopify.
 *
 * This matters for money, not just for tidiness. If `combinesWith.orderDiscounts`
 * were ever flipped to true, a cart recovery code would STACK on BUY2, BUY3 or
 * WELCOME150 and the customer would take both, which is a discount nobody
 * approved. If usageLimit were dropped, a private code would become a public
 * one the moment anybody shared it. Flow R reuses this existing mutation rather
 * than writing its own precisely so there is one place to hold that line, so
 * here is the test that holds it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { shopify } from './shopify.mjs';

let bodies;
const dryRunWas = config.dryRun;

beforeEach(() => {
  bodies = [];
  config.dryRun = false;
  vi.stubGlobal('fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } } }),
    };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  config.dryRun = dryRunWas;
});

describe('createDiscountCode', () => {
  it('cannot stack with another order discount, and is single use', async () => {
    await shopify.createDiscountCode({
      code: 'MORPAANKHBHARTI47',
      title: 'Cart recovery #66743166239092',
      startsAt: '2026-10-12T06:30:00.000Z',
      endsAt: '2026-10-13T06:30:00.000Z',
      amountInr: 200,
      minSubtotalInr: 1124,
    });
    const basic = bodies[0].variables.basic;
    expect(basic.combinesWith).toEqual({ orderDiscounts: false, productDiscounts: false, shippingDiscounts: true });
    expect(basic.usageLimit).toBe(1);
    expect(basic.appliesOncePerCustomer).toBe(true);
    expect(basic.context).toEqual({ all: 'ALL' });
    expect(basic.customerGets.value.discountAmount).toEqual({ amount: '200', appliesOnEachItem: false });
    expect(basic.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe('1124');
    // Ends exactly when we told the customer it would.
    expect(basic.endsAt).toBe('2026-10-13T06:30:00.000Z');
    // And carries no phone number, because the title shows in the admin list.
    expect(basic.title).toBe('Cart recovery #66743166239092');
  });

  it('sends nothing at all under DRY_RUN', async () => {
    config.dryRun = true;
    const r = await shopify.createDiscountCode({ code: 'X', title: 't', startsAt: 'a', endsAt: 'b', amountInr: 1, minSubtotalInr: 1 });
    expect(bodies).toHaveLength(0);
    expect(r).toEqual({ id: 'dry_discount', code: 'X' });
  });
});
