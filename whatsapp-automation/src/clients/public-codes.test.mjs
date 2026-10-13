/*
 * publicCodeDiscounts: the read the whole offer rests on.
 *
 * Two things here are money, not tidiness.
 *
 * 1. What counts as "public". A code the customer could already use raises the
 *    floor; one of OUR OWN single-use recovery codes must never do that, or
 *    the floor would climb on every send until nothing qualified.
 * 2. The ten-minute cache. It is module-level state on the pricing path and
 *    the fake bypasses it entirely, so the expiry arithmetic had never run.
 *
 * fetch is stubbed; this reaches no Shopify store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shopify } from './shopify.mjs';

const node = (over) => ({
  cursor: 'c',
  node: {
    id: 'gid://shopify/DiscountCodeNode/1',
    discount: {
      __typename: 'DiscountCodeBasic',
      title: 'Buy 2, get 10% off (code BUY2)',
      status: 'ACTIVE',
      usageLimit: null,
      appliesOncePerCustomer: false,
      context: { __typename: 'DiscountBuyerSelectionAll' },
      codes: { nodes: [{ code: 'BUY2' }] },
      customerGets: { value: { percentage: 0.1 } },
      minimumRequirement: { greaterThanOrEqualToQuantity: '2' },
      ...over,
    },
  },
});

let calls;

function stub(edges) {
  calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: { discountNodes: { edges, pageInfo: { hasNextPage: false, endCursor: null } } } }),
    };
  });
}

beforeEach(() => shopify._resetCodeCache());
afterEach(() => {
  vi.unstubAllGlobals();
  shopify._resetCodeCache();
});

describe('publicCodeDiscounts', () => {
  it('reads a public code once and serves the next ten minutes from cache', async () => {
    const t = 1_760_000_000_000;
    stub([node({})]);

    const first = await shopify.publicCodeDiscounts({ now: t });
    expect(first).toEqual([{ code: 'BUY2', title: 'Buy 2, get 10% off (code BUY2)', type: 'percentage', percentage: 0.1, minQuantity: 2 }]);
    expect(calls).toBe(1);

    // Inside the window: same answer, no second round trip.
    expect(await shopify.publicCodeDiscounts({ now: t + 9 * 60 * 1000 })).toEqual(first);
    expect(calls).toBe(1);

    // Past it: asked again, because a code the owner just switched off must
    // stop raising the floor within ten minutes and not a deploy later.
    await shopify.publicCodeDiscounts({ now: t + 10 * 60 * 1000 + 1 });
    expect(calls).toBe(2);
  });

  it('never counts one of our own recovery codes as public', async () => {
    stub([
      // Single use: that alone disqualifies it, whatever it is called.
      node({ title: 'Cart recovery #66743166239092', usageLimit: 1, codes: { nodes: [{ code: 'MORPAANKHBHARTI47' }] } }),
      // Belt: the title prefix, for a code that somehow has no usage limit.
      node({ title: 'Cart recovery #66748125053300', usageLimit: null, codes: { nodes: [{ code: 'MORPAANKHRAJNEESH64' }] } }),
      // Not open to everybody, so not something this customer can just use.
      node({ context: { __typename: 'DiscountBuyerSelectionCustomerSegments' }, codes: { nodes: [{ code: 'VIPONLY' }] } }),
      // Switched off.
      node({ status: 'EXPIRED', codes: { nodes: [{ code: 'OLDCODE' }] } }),
      // An app's automatic discount is not a code anyone can type.
      { cursor: 'c', node: { id: 'gid://shopify/DiscountAutomaticNode/9', discount: { __typename: 'DiscountAutomaticApp' } } },
    ]);
    expect(await shopify.publicCodeDiscounts({ now: 1 })).toEqual([]);
  });
});
