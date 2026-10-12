import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _drainQueue } from '../queue.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { ensureRec } from '../store/cartRecovery.mjs';
import { sweepAbandonedCarts } from './cart-sweep.mjs';
import { handler as reconcileHandler } from './reconcile.mjs';

const NOW = fromISTWall(2026, 9, 12, 12, 0); // 12:00 IST

const cart = (id, over = {}) => ({
  id: `gid://shopify/AbandonedCheckout/${id}`,
  name: `#${id}`,
  createdAt: '2026-10-12T05:00:00Z', // 90 minutes before NOW
  completedAt: null,
  abandonedCheckoutUrl: `https://www.morpaankh.in/9/checkouts/ac/${id}/recover?key=K`,
  totalDiscountSet: { shopMoney: { amount: '0.0' } },
  customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919637361371' }],
  customer: { id: 'gid://shopify/Customer/1', firstName: 'Bharti' },
  lineItems: {
    nodes: [{
      title: 'Khili Dhoop', quantity: 1,
      originalUnitPriceSet: { shopMoney: { amount: '1249.0' } },
      image: { url: 'https://cdn.shopify.com/a.jpg', width: 1200, height: 1500 },
      variant: { id: 'gid://shopify/ProductVariant/9', availableForSale: true, selectedOptions: [{ name: 'Size', value: 'XS' }] },
    }],
  },
  ...over,
});

function setup(carts) {
  const clients = makeFakeClients({});
  for (const c of carts) clients.shopify.seedCheckout(c);
  return clients;
}

beforeEach(() => {
  _resetMemory();
  _drainQueue();
  config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
});

describe('the cart sweep', () => {
  it('enqueues an eligible checkout on its own phone group', async () => {
    const clients = setup([cart('A1')]);
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual(['A1']);
    const q = _drainQueue();
    expect(q).toHaveLength(1);
    expect(q[0].message).toEqual({ kind: 'cart', step: 'first', checkoutId: 'A1' });
    expect(q[0].groupId).toBe('phone:+919637361371');
  });

  it('does nothing when the flow is off', async () => {
    config.flows.R = { enabled: false, startAt: '2026-10-01T00:00:00Z' };
    const clients = setup([cart('A1')]);
    expect(await sweepAbandonedCarts(clients, NOW)).toEqual({ skipped: 'flow-r-off' });
    expect(_drainQueue()).toHaveLength(0);
  });

  it('does nothing outside the send window, and does not queue for later', async () => {
    const clients = setup([cart('A1')]);
    // 23:00 IST, past 22:30.
    expect(await sweepAbandonedCarts(clients, fromISTWall(2026, 9, 12, 23, 0))).toEqual({ skipped: 'outside-window' });
    expect(_drainQueue()).toHaveLength(0);
  });

  /*
   * The headline loophole: `updatedAt` on an abandoned checkout is not customer
   * activity. One created 3 Aug read updatedAt 12 Oct. Age comes from createdAt.
   */
  it('never messages a checkout older than 12h however fresh updatedAt looks', async () => {
    const clients = setup([cart('OLD', { createdAt: '2026-10-11T05:00:00Z', updatedAt: '2026-10-12T06:29:00Z' })]);
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual([]);
    expect(_drainQueue()).toHaveLength(0);
    /*
     * And it is bounded by the QUERY, not by luck: the sweep asks Shopify only
     * for checkouts created inside maxCheckoutAgeHours, so an old one with a
     * fresh updatedAt is never even listed. cartEligible's `too-old` branch is
     * the second line of defence, for one that ages out between the sweep and
     * the worker picking it up.
     */
    const listed = clients.shopify.calls.find((c) => c.op === 'listAbandonedCheckouts');
    const windowHours = (NOW.getTime() - new Date(listed.sinceISO).getTime()) / 3600000;
    expect(windowHours).toBe(RULES.cartRecovery.maxCheckoutAgeHours);
  });

  it('leaves one that is still inside the 20 minute wait', async () => {
    const clients = setup([cart('NEW', { createdAt: '2026-10-12T06:20:00Z' })]); // 10 min before NOW
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.skipped).toMatchObject({ 'too-fresh': 1 });
  });

  it('on first enable, only touches checkouts created at or after startAt', async () => {
    config.flows.R = { enabled: true, startAt: '2026-10-12T06:00:00Z' };
    const clients = setup([cart('BEFORE', { createdAt: '2026-10-12T05:00:00Z' })]);
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual([]);
    expect(out.skipped).toMatchObject({ 'before-start': 1 });
  });

  it('with no startAt at all, nothing qualifies', async () => {
    config.flows.R = { enabled: true, startAt: '' };
    const clients = setup([cart('A1')]);
    expect((await sweepAbandonedCarts(clients, NOW)).enqueued).toEqual([]);
  });

  /*
   * One phone really did abandon the same bag twice in two days (10 and 12
   * Oct). Only the newest is worth recovering: its recovery link is the one
   * that matches what they were last looking at.
   */
  it('takes only the newest checkout per phone', async () => {
    const clients = setup([
      cart('OLDER', { createdAt: '2026-10-12T04:00:00Z' }),
      cart('NEWER', { createdAt: '2026-10-12T05:30:00Z' }),
    ]);
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual(['NEWER']);
    expect(out.skipped).toMatchObject({ 'older-checkout-for-phone': 1 });
  });

  it('skips anything that already has a record, whatever its outcome', async () => {
    const clients = setup([cart('A1')]);
    await ensureRec('A1', { outcome: 'shadow' });
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual([]);
    expect(out.skipped).toMatchObject({ 'already-started': 1 });
    expect(_drainQueue()).toHaveLength(0);
  });

  it('skips a completed checkout, one with no verified phone, and a sold-out bag', async () => {
    const soldOut = cart('SOLD');
    soldOut.lineItems.nodes[0].variant.availableForSale = false;
    const clients = setup([
      cart('DONE', { completedAt: '2026-10-12T06:00:00Z' }),
      cart('NOPHONE', { customAttributes: [] }),
      soldOut,
    ]);
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual([]);
    // DONE is filtered by listAbandonedCheckouts itself (status:open).
    expect(out.skipped['no-verified-phone']).toBe(1);
    expect(out.skipped['sold-out']).toBe(1);
  });

  it('skips a partial-advance checkout', async () => {
    const clients = setup([cart('PART', {
      customAttributes: [
        { key: '_otpVerifiedPhoneNumber', value: '919637361371' },
        { key: '_codkAmountType', value: 'percentage' },
        { key: '_codkAmountValue', value: '5.0' },
      ],
    })]);
    expect((await sweepAbandonedCarts(clients, NOW)).skipped).toMatchObject({ 'partial-advance': 1 });
  });
});

/*
 * The single most dangerous line in this feature. reconcile's mode line maps
 * anything that is not 'orders' to 'full', and the cart rule fires every five
 * minutes. 'full' runs sweepUnreviewed, which SENDS review asks to real
 * customers, plus a webhook re-assert and a full Delhivery re-track. And
 * sweepUnconfirmed runs ABOVE the mode branch, so returning inside it would
 * not have been enough either.
 */
describe('the reconcile mode dispatch', () => {
  it("{ mode: 'carts' } runs the cart sweep and nothing else", async () => {
    config.flows.R = { enabled: false, startAt: '' };
    const out = await reconcileHandler({ mode: 'carts' });
    expect(out.mode).toBe('carts');
    expect(out.carts).toEqual({ skipped: 'flow-r-off' });
    // None of the full-pass keys are even present.
    expect(out.orders).toBeUndefined();
    expect(out.reviews).toBeUndefined();
    expect(out.shipments).toBeUndefined();
    expect(out.webhooks).toBeUndefined();
  });

  it("'orders' and the nightly pass still behave exactly as before", async () => {
    const orders = await reconcileHandler({ mode: 'orders' });
    expect(orders.mode).toBe('orders');
    expect(orders.carts).toBeUndefined();
    expect(orders.orders).toBeTruthy();
    expect(orders.reviews).toBe(null); // not run in 'orders' mode

    const full = await reconcileHandler({});
    expect(full.mode).toBe('full');
    expect(full.carts).toBeUndefined();
  });
});
