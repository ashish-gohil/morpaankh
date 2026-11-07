/*
 * O6. No client passed a `signal` to fetch, and Node's fetch has no default
 * timeout. A provider that accepted the connection and then stopped answering
 * held the worker to its 60 second Lambda limit, the SQS message came back 6
 * minutes later, and it BLOCKED ITS GROUP the whole while: one hung call
 * stalling every event for that order.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deadline, awsTimeouts, TIMEOUT_MS } from './timeout.mjs';
import { withRetry, maybeSent, neverSent } from './resilience.mjs';

afterEach(() => vi.useRealTimers());

describe('deadline', () => {
  it('gives fetch a signal that aborts', async () => {
    const opts = deadline(20);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(opts.signal.aborted).toBe(true);
    expect(opts.signal.reason?.name).toBe('TimeoutError');
  });

  /*
   * Spread into the options rather than returned as a signal, so a runtime
   * without AbortSignal.timeout yields `{}` and not `{ signal: undefined }`,
   * which Node rejects outright.
   */
  it('yields an empty object rather than an undefined signal', () => {
    const saved = AbortSignal.timeout;
    try {
      // @ts-expect-error deliberately removing it
      AbortSignal.timeout = undefined;
      expect(deadline(10)).toEqual({});
    } finally {
      AbortSignal.timeout = saved;
    }
  });

  /*
   * THE BUDGET. withRetry does up to 3 attempts, so a retried call has to fit
   * three timeouts plus backoff inside the worker's 60 s, with room to spare.
   */
  it('keeps three attempts of every retried deadline under 40 seconds', () => {
    for (const [name, ms] of Object.entries(TIMEOUT_MS)) {
      expect(ms * 3 + 2_000, `${name} leaves no room for three attempts`).toBeLessThanOrEqual(62_000);
    }
    expect(TIMEOUT_MS.delhiveryTrack * 3 + 2_000).toBeLessThanOrEqual(47_000);
  });
});

describe('a timeout is a maybe-sent failure', () => {
  const timeoutErr = () => Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });

  /*
   * AbortSignal.timeout rejects with a DOMException named 'TimeoutError' and NO
   * `code`, so it fell through every classification and was treated as a
   * permanent fault. The request left this process, so whether the other end
   * acted on it is unknown, which is exactly what `idempotent` resolves.
   */
  it('is unknown, not never-sent', () => {
    expect(maybeSent(timeoutErr())).toBe(true);
    expect(neverSent(timeoutErr())).toBe(false);
  });

  it('is retried for an idempotent call', async () => {
    let calls = 0;
    const fn = async () => { calls += 1; if (calls < 2) throw timeoutErr(); return 'ok'; };
    await expect(withRetry('t', fn, { baseMs: 1, idempotent: true })).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('is NOT retried for a call that could repeat itself', async () => {
    let calls = 0;
    const fn = async () => { calls += 1; throw timeoutErr(); };
    await expect(withRetry('t', fn, { baseMs: 1, idempotent: false })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('awsTimeouts', () => {
  it('is tighter in an ingest, which Shopify abandons after 5 seconds', () => {
    expect(awsTimeouts({ ingest: true }).requestHandler.requestTimeout)
      .toBeLessThan(awsTimeouts().requestHandler.requestTimeout);
    expect(awsTimeouts({ ingest: true }).requestHandler.requestTimeout).toBeLessThan(5_000);
  });
});

/*
 * THE GUARD. A new client with no deadline is invisible until the day a
 * provider hangs, so the check is structural rather than behavioural.
 */
describe('every outbound fetch carries a deadline', () => {
  const walk = (dir, rel = '') => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) out.push(...walk(full, path));
      else if (name.endsWith('.mjs') && !name.includes('.test.')) out.push([path, full]);
    }
    return out;
  };

  it('no fetch( in src/ without a deadline in the same call', () => {
    const src = new URL('..', import.meta.url).pathname;
    const offenders = [];
    for (const [path, full] of walk(src)) {
      const text = readFileSync(full, 'utf8');
      // Every fetch call's options, up to the closing of that call.
      for (const m of text.matchAll(/\bawait fetch\(/g)) {
        const tail = text.slice(m.index, m.index + 600);
        const upToNextFetch = tail.split('await fetch(').slice(0, 2).join('await fetch(');
        if (!/deadline\(/.test(upToNextFetch)) offenders.push(`${path}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders, 'add ...deadline(TIMEOUT_MS.x) to these fetch calls').toEqual([]);
  });
});
