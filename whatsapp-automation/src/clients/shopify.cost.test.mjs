/*
 * O2. Shopify's limit is cost-based: a standard plan holds 1,000 points and
 * restores 100 a second, and a throttle is an HTTP 200 carrying a THROTTLED
 * error. The client mapped that to 429 and left it to withRetry, which waits
 * about 300 ms and then 600 ms. A 500-point query needs five SECONDS of refill,
 * so both attempts failed, the SQS message failed with them, and it came back 6
 * minutes later having blocked its order's group throughout.
 *
 * All of it for a limit whose exact refill time was in the response we already
 * had, in extensions.cost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { realClients } from './index.mjs';
import { _resetSecrets } from '../secrets.mjs';

const okBody = (data, cost) => ({
  ok: true,
  status: 200,
  headers: new Map(),
  text: async () => JSON.stringify({ data, extensions: { cost } }),
});

const throttledBody = (cost) => ({
  ok: true,
  status: 200,
  headers: new Map(),
  text: async () => JSON.stringify({
    errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    extensions: { cost },
  }),
});

const bucket = (available, restoreRate = 100) => ({
  requestedQueryCost: 300,
  actualQueryCost: null,
  throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate },
});

let realFetch;
beforeEach(() => {
  _resetSecrets();
  process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_test';
  process.env.SHOP_DOMAIN = 'test.myshopify.com';
  realFetch = globalThis.fetch;
  vi.useFakeTimers();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('a throttled query waits for the bucket, not for a guess', () => {
  // getOrder, deliberately: publicCodeDiscounts memoises for two minutes and a
  // cached answer would make either of these pass without a request going out.
  const getOrder = () => realClients.shopify.getOrder('12345');

  it('retries once, after a wait the response itself specified', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      // Throttled once: 300 requested against 100 available at 100/s, so the
      // bucket needs 2 s. withRetry would have waited 300 ms and failed.
      return n === 1 ? throttledBody(bucket(100)) : okBody({ order: { id: 'gid://shopify/Order/12345' } }, bucket(1000));
    });

    const p = getOrder();
    // Nothing yet: the wait has not elapsed, so there has been ONE request.
    await vi.advanceTimersByTimeAsync(500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_500);
    await expect(p).resolves.toMatchObject({ id: 'gid://shopify/Order/12345' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not wait a second time, however long the bucket stays empty', async () => {
    globalThis.fetch = vi.fn(async () => throttledBody(bucket(0)));
    const p = getOrder().catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
    /*
     * Each withRetry attempt gets one measured wait and one retry, so three
     * attempts is at most six requests. The point is that it is BOUNDED: the
     * old code could not wait at all, and an unbounded wait would hold the
     * worker past its own timeout.
     */
    expect(globalThis.fetch.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
