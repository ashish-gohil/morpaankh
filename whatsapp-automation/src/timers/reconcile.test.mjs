/*
 * reconcile.test.mjs — the order sweep. Nothing checked that a confirmation
 * actually happened, so every way of losing an order between Shopify and the
 * customer's phone was silent and permanent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { ensureState, patchState, patchFlowA, getState } from '../store/orderState.mjs';
import { realClients } from '../clients/index.mjs';
import { _drainQueue, _peekQueue } from '../queue.mjs';
import { sweepUnconfirmed } from './reconcile.mjs';

const START = '2026-09-01T00:00:00Z';
const NOW = new Date('2026-09-26T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

let orders = [];
beforeEach(() => {
  _resetMemory();
  _drainQueue();
  orders = [];
  config.flows.A.enabled = true;
  config.flows.A.startAt = START;
  config.ownerAlertPhones = [];
  vi.spyOn(realClients.shopify, 'ordersUpdatedSince').mockImplementation(async () => orders);
});

const order = (id, createdAt) => ({ id: `gid://shopify/Order/${id}`, createdAt, tags: [] });

describe('orders nobody messaged', () => {
  it('re-arms an order that has no state row at all (the webhook never arrived)', async () => {
    orders = [order('111', hoursAgo(2))];
    const out = await sweepUnconfirmed(NOW);
    expect(out.requeued).toEqual(['111']);
    // and the timer message really is on the queue, addressed to Flow A's first step
    expect(_peekQueue()).toMatchObject([{ message: { kind: 'timer', flow: 'A', orderId: '111', step: 'cod' } }]);
  });

  it('re-arms an order whose timer was never created', async () => {
    orders = [order('222', hoursAgo(5))];
    await ensureState('222', {}); // seen, but the confirmation never went out
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual(['222']);
  });

  it('leaves an order that was already confirmed alone', async () => {
    orders = [order('333', hoursAgo(5))];
    await ensureState('333', {});
    await patchFlowA('333', { codConfirmAt: hoursAgo(4) });
    const out = await sweepUnconfirmed(NOW);
    expect(out.requeued).toEqual([]);
    expect(out.checked).toBe(1); // it looked, and decided correctly
  });

  it('does not race the normal path inside the grace window', async () => {
    // The real confirmation is scheduled at +3 minutes. Sweeping a 4-minute-old
    // order would send a second message to a customer who is about to get one.
    orders = [order('444', new Date(NOW.getTime() - 4 * 60000).toISOString())];
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual([]);
  });

  it('ignores orders from before Flow A was switched on', async () => {
    orders = [order('555', '2026-08-15T00:00:00Z')];
    const out = await sweepUnconfirmed(NOW);
    expect(out.checked).toBe(0);
    expect(out.requeued).toEqual([]);
  });

  it('leaves a stopped or cancelled order alone', async () => {
    orders = [order('666', hoursAgo(5)), order('667', hoursAgo(5))];
    await ensureState('666', {});
    await patchState('666', { stoppedAt: hoursAgo(4) });
    await ensureState('667', {});
    await patchState('667', { cancelledAt: hoursAgo(4) });
    expect((await sweepUnconfirmed(NOW)).requeued).toEqual([]);
  });

  it('gives up after three tries instead of requeueing forever', async () => {
    // An order that can never be confirmed (no verified phone, unreadable class)
    // would otherwise be re-enqueued every hour for as long as it exists.
    orders = [order('888', hoursAgo(5))];
    for (let i = 0; i < 3; i += 1) {
      expect((await sweepUnconfirmed(NOW)).requeued).toEqual(['888']);
    }
    const out = await sweepUnconfirmed(NOW);
    expect(out.requeued).toEqual([]);
    expect(out.stuck).toEqual(['888']);
    expect((await getState('888')).flowA.sweepTries).toBe(3);
  });

  it('does nothing at all while Flow A is off', async () => {
    config.flows.A.enabled = false;
    orders = [order('999', hoursAgo(5))];
    expect((await sweepUnconfirmed(NOW)).skipped).toBe('flow-a-off');
  });

  it('does nothing when there is no start date, because nothing qualifies then', async () => {
    config.flows.A.startAt = '';
    orders = [order('1000', hoursAgo(5))];
    expect((await sweepUnconfirmed(NOW)).skipped).toBe('flow-a-off');
  });
});
