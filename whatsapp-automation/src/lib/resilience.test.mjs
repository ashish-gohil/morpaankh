import { describe, it, expect, vi } from 'vitest';
import { withRetry, soft, neverSent, maybeSent } from './resilience.mjs';

const httpErr = (status) => Object.assign(new Error(`http ${status}`), { status });
const netErr = (code) => Object.assign(new Error(code), { cause: { code } });

describe('classifying a failed provider call', () => {
  it('knows a refusal the provider never processed', () => {
    for (const e of [httpErr(429), httpErr(503), netErr('ENOTFOUND'), netErr('ECONNREFUSED')]) {
      expect(neverSent(e), e.message).toBe(true);
    }
  });
  it('knows an outcome it cannot be sure about', () => {
    for (const e of [httpErr(500), httpErr(502), httpErr(504), netErr('ECONNRESET')]) {
      expect(maybeSent(e), e.message).toBe(true);
      expect(neverSent(e), e.message).toBe(false);
    }
  });
  it('treats a plain rejection as neither, so it is never retried', () => {
    const e = httpErr(400);
    expect(neverSent(e)).toBe(false);
    expect(maybeSent(e)).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries a rate limit even for money, because it was never processed', async () => {
    let calls = 0;
    const out = await withRetry('refund', async () => {
      calls += 1;
      if (calls < 3) throw httpErr(429);
      return 'done';
    }, { baseMs: 1 });
    expect(calls).toBe(3);
    expect(out).toBe('done');
  });

  it('NEVER retries an unknown outcome for a non-idempotent call', async () => {
    // A 500 from a refund may already have refunded. Retrying could pay twice.
    let calls = 0;
    await expect(
      withRetry('refund', async () => {
        calls += 1;
        throw httpErr(500);
      }, { baseMs: 1 }),
    ).rejects.toThrow('http 500');
    expect(calls).toBe(1);
  });

  it('retries an unknown outcome when the caller says it is safe to repeat', async () => {
    let calls = 0;
    const out = await withRetry('getOrder', async () => {
      calls += 1;
      if (calls < 2) throw httpErr(500);
      return 'order';
    }, { baseMs: 1, idempotent: true });
    expect(calls).toBe(2);
    expect(out).toBe('order');
  });

  it('gives up after the attempt budget and rethrows the real error', async () => {
    let calls = 0;
    await expect(
      withRetry('x', async () => { calls += 1; throw httpErr(429); }, { attempts: 3, baseMs: 1 }),
    ).rejects.toThrow('http 429');
    expect(calls).toBe(3);
  });

  it('does not retry a permanent rejection', async () => {
    let calls = 0;
    await expect(
      withRetry('x', async () => { calls += 1; throw httpErr(401); }, { baseMs: 1 }),
    ).rejects.toThrow('http 401');
    expect(calls).toBe(1);
  });
});

describe('soft', () => {
  it('swallows the failure so the caller carries on', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await soft('tagsAdd', async () => { throw new Error('shopify down'); }, { orderId: '1' });
    expect(out).toBe(null);
    // swallowed is not hidden: it still logs at error level so it is emailed
    const line = JSON.parse(err.mock.calls[0][0]);
    expect(line.level).toBe('error');
    expect(line.soft).toBe(true);
    expect(line.label).toBe('tagsAdd');
    expect(line.orderId).toBe('1');
    err.mockRestore();
  });
  it('returns the value when nothing goes wrong', async () => {
    expect(await soft('x', async () => 42)).toBe(42);
  });
});
