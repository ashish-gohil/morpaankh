import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Configure BEFORE importing modules that read config at load time.
process.env.STATE_BACKEND = 'file';
process.env.STATE_DB_PATH = join(mkdtempSync(join(tmpdir(), 'mo-')), 'state.json');
process.env.DRY_RUN = 'true';

const store = await import('./store.mjs');
const { reconcileOrder } = await import('./reconcile.mjs');
const { config } = await import('./config.mjs');

const deliveredOrder = (over = {}) => ({
  id: 'gid://shopify/Order/9001',
  name: '#9001',
  note: null,
  tags: ['MEDIUM RTO Risk', '✅ COD-Verified'],
  cancelledAt: null,
  updatedAt: new Date().toISOString(),
  currencyCode: 'INR',
  netPaymentSet: { shopMoney: { amount: '1499.0', currencyCode: 'INR' } },
  customer: { id: 'gid://shopify/Customer/1', firstName: 'A', lastName: 'B' },
  shippingAddress: { city: 'Surat', province: 'GJ', zip: '395007', countryCodeV2: 'IN', phone: '+919876543210' },
  fulfillments: [{ displayStatus: 'DELIVERED' }],
  ...over,
});

describe('store (file backend)', () => {
  it('persists records + checkpoint across a reload', async () => {
    const prev = config.dryRun;
    config.dryRun = false; // persistence only happens on live runs
    try {
      await store.initStore();
      store.setRecord('1', { state: 'PLACED' });
      store.setCheckpoint('2026-09-04T00:00:00Z');
      await store.flush();
      store._reset();
      await store.initStore();
      expect(store.getRecord('1').state).toBe('PLACED');
      expect(store.getCheckpoint()).toBe('2026-09-04T00:00:00Z');
    } finally {
      config.dryRun = prev;
    }
  });

  it('flush is a no-op under dry-run (nothing persisted)', async () => {
    store._reset();
    await store.initStore();
    store.setRecord('zzz', { state: 'RTO' });
    await store.flush(); // dry-run: should not write
    store._reset();
    await store.initStore();
    expect(store.getRecord('zzz')).toBeNull();
  });
});

describe('reconcile idempotency (dry-run)', () => {
  it('fires DeliveredPurchase exactly once even if reconciled repeatedly', async () => {
    await store.initStore();
    const o = deliveredOrder();
    const r1 = await reconcileOrder(o);
    const r2 = await reconcileOrder(o);
    const r3 = await reconcileOrder(o);
    expect(r1.state).toBe('DELIVERED_PAID');
    expect(r1.actions).toContain('sent-DeliveredPurchase');
    expect(r1.actions).toContain('audience-add:delivered');
    expect(r2.actions).toEqual(['no-op']);
    expect(r3.actions).toEqual(['no-op']);
    expect(store.getRecord('9001').deliveredSent).toBe(true);
  });

  it('does not fire or audience an undecided IN_TRANSIT order', async () => {
    await store.initStore();
    const o = deliveredOrder({
      id: 'gid://shopify/Order/9002',
      name: '#9002',
      netPaymentSet: { shopMoney: { amount: '0.0', currencyCode: 'INR' } },
      fulfillments: [{ displayStatus: 'IN_TRANSIT' }],
    });
    const r = await reconcileOrder(o);
    expect(r.state).toBe('IN_TRANSIT');
    expect(r.actions).toEqual(['no-op']);
  });

  it('a stale delivered order seeds the audience but skips the (mis-dateable) event', async () => {
    await store.initStore();
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const o = deliveredOrder({ id: 'gid://shopify/Order/9003', name: '#9003', updatedAt: old });
    const r = await reconcileOrder(o);
    expect(r.state).toBe('DELIVERED_PAID');
    expect(r.actions.some((a) => a.startsWith('skipped-DeliveredPurchase'))).toBe(true);
    expect(r.actions).toContain('audience-add:delivered');
  });
});
