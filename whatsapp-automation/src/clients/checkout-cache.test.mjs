/*
 * listAbandonedCheckouts: the memo that stops Flow W timing the worker out.
 *
 * abandonedCheckouts CANNOT be filtered by customer, phone or id. The
 * documented filter set is default, created_at, email_state, id,
 * recovery_state, status and updated_at, and the `id:` forms come back empty
 * for a checkout that is definitely there. So Flow W's cart gate lists and
 * matches in JS, once per candidate, and without this memo a sweep of
 * maxPerRun (100) candidates would be a hundred paginated reads inside one
 * 60 second worker invocation.
 *
 * Same shape as public-codes.test.mjs, for the same reason: the cache is
 * module-level state that the fake client bypasses entirely, so the only place
 * its arithmetic ever runs is here.
 *
 * fetch is stubbed; this reaches no Shopify store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shopify } from './shopify.mjs';
import { RULES } from '../../messages/rules.mjs';

const T = 1_760_000_000_000;
const DAY = 86400 * 1000;
const at = (ms) => new Date(ms).toISOString();

let calls;

/** One page of checkouts, newest first, as the real query returns them. */
function stub(checkouts) {
  calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            abandonedCheckouts: {
              edges: checkouts.map((c) => ({ cursor: 'c', node: c })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
    };
  });
}

const CARTS = [
  { id: 'gid://shopify/AbandonedCheckout/1', name: '#1', createdAt: at(T - 1 * DAY), completedAt: null },
  { id: 'gid://shopify/AbandonedCheckout/2', name: '#2', createdAt: at(T - 5 * DAY), completedAt: null },
];

beforeEach(() => shopify._resetCheckoutCache());
afterEach(() => {
  vi.unstubAllGlobals();
  shopify._resetCheckoutCache();
});

describe('the abandoned-checkout memo', () => {
  it('reads once and serves the next two minutes from memory', async () => {
    stub(CARTS);
    const since = at(T - 7 * DAY);

    expect(await shopify.listAbandonedCheckouts(since, { now: T })).toHaveLength(2);
    expect(calls).toBe(1);

    expect(await shopify.listAbandonedCheckouts(since, { now: T + 60 * 1000 })).toHaveLength(2);
    expect(calls).toBe(1);

    // Past the TTL: asked again, because a cart abandoned since must be seen
    // before Flow W tells that person they have no cart.
    await shopify.listAbandonedCheckouts(since, { now: T + 2 * 60 * 1000 + 1 });
    expect(calls).toBe(2);
  });

  it('serves a NARROWER window out of the same read, which is what makes it hit', async () => {
    /*
     * THE POINT OF THE WHOLE MEMO. Every Flow W candidate asks for its own
     * seven days back from its own signup time, so the argument is never
     * byte-identical twice. A later sinceISO is a SUBSET of what is already
     * held, so it is filtered rather than re-read.
     */
    stub(CARTS);
    expect(await shopify.listAbandonedCheckouts(at(T - 7 * DAY), { now: T })).toHaveLength(2);
    expect(calls).toBe(1);

    const narrow = await shopify.listAbandonedCheckouts(at(T - 3 * DAY), { now: T + 1000 });
    expect(narrow.map((c) => c.name)).toEqual(['#1']);
    expect(calls).toBe(1);
  });

  it('but re-reads for an EARLIER window, which the memo does not cover', async () => {
    stub(CARTS);
    await shopify.listAbandonedCheckouts(at(T - 3 * DAY), { now: T });
    expect(calls).toBe(1);
    // Seven days back is not inside three days of cached rows, so believing
    // the memo here would report "no cart" for a cart we never looked for.
    await shopify.listAbandonedCheckouts(at(T - 7 * DAY), { now: T + 1000 });
    expect(calls).toBe(2);
  });

  it('is per process, so one sweep of maxPerRun candidates makes ONE call', async () => {
    // The timeout this exists to prevent: 100 candidates, 100 list calls, one
    // 60 second worker. Each candidate asks for its own window, a few minutes
    // apart, exactly as the worker computes it.
    stub(CARTS);
    const base = T - 7 * DAY;
    for (let i = 0; i < RULES.subscriberOffer.maxPerRun; i += 1) {
      await shopify.listAbandonedCheckouts(at(base + i * 60 * 1000), { now: T + i });
    }
    expect(calls).toBe(1);
  });

  it('_resetCheckoutCache clears it, so one test cannot answer another', async () => {
    stub(CARTS);
    await shopify.listAbandonedCheckouts(at(T - 7 * DAY), { now: T });
    expect(calls).toBe(1);
    shopify._resetCheckoutCache();
    await shopify.listAbandonedCheckouts(at(T - 7 * DAY), { now: T });
    expect(calls).toBe(2);
  });
});
