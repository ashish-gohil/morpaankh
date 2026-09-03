import { describe, it, expect } from 'vitest';
import { withKeyLock } from './lock.mjs';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('withKeyLock', () => {
  it('serialises same-key work so a check-then-act race cannot double-fire', async () => {
    // Simulates the DeliveredPurchase guard: read flag, await, then act.
    let sent = 0;
    let flag = false;
    const attempt = () =>
      withKeyLock('order-1', async () => {
        if (flag) return; // already handled
        await tick(); // window where a racing call could slip in
        flag = true;
        sent += 1;
      });

    await Promise.all([attempt(), attempt(), attempt()]);
    expect(sent).toBe(1); // exactly one send despite three concurrent attempts
  });

  it('lets different keys run without blocking each other', async () => {
    const order = [];
    await Promise.all([
      withKeyLock('a', async () => { await tick(20); order.push('a'); }),
      withKeyLock('b', async () => { await tick(1); order.push('b'); }),
    ]);
    expect(order).toEqual(['b', 'a']); // b did not wait on a
  });

  it('keeps serialising after a rejection in the chain', async () => {
    const seen = [];
    const p1 = withKeyLock('k', async () => { seen.push(1); throw new Error('boom'); }).catch(() => {});
    const p2 = withKeyLock('k', async () => { seen.push(2); });
    await Promise.all([p1, p2]);
    expect(seen).toEqual([1, 2]);
  });
});
