/*
 * purchase-guard.test.mjs — this service must never become a second Purchase
 * sender.
 *
 * Meta counts an order once only when every Purchase for it shares one
 * event_id. The Shopify Facebook & Instagram channel owns that pairing. On
 * 24 Oct 2026 a second, unrelated Purchase (Meta's Automatic events, bound to
 * COD King's "Complete order" button) reached the same dataset with its own
 * event_id and no value, and one COD order started counting as three.
 *
 * These tests run LIVE (dryRun false) with fetch stubbed, so they assert on the
 * payload actually put on the wire, not on a dry-run log line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_BACKEND = 'file';
process.env.STATE_DB_PATH = join(mkdtempSync(join(tmpdir(), 'mo-guard-')), 'state.json');
process.env.DRY_RUN = 'false';
process.env.META_DATASET_ID = '2138165280468636';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_AD_ACCOUNT_ID = 'act_1046985611096981';

const store = await import('./store.mjs');
const { reconcileOrder } = await import('./reconcile.mjs');
const { config } = await import('./config.mjs');

// A delivered-and-paid COD order, the only shape that sends a CAPI event.
const codOrder = (over = {}) => ({
  id: 'gid://shopify/Order/9001',
  name: '#9001',
  note: null,
  tags: ['✅ COD-Verified'],
  cancelledAt: null,
  updatedAt: new Date().toISOString(),
  currencyCode: 'INR',
  netPaymentSet: { shopMoney: { amount: '2149.0', currencyCode: 'INR' } },
  customer: { id: 'gid://shopify/Customer/1', firstName: 'A', lastName: 'B' },
  shippingAddress: {
    city: 'Surat', province: 'GJ', zip: '395007', countryCodeV2: 'IN', phone: '+919876543210',
  },
  fulfillments: [{ displayStatus: 'DELIVERED' }],
  ...over,
});

/** Every CAPI event posted, flattened out of the stubbed fetch calls. */
function eventsFrom(calls) {
  return calls
    .filter(([url]) => String(url).includes('/events'))
    .flatMap(([, init]) => JSON.parse(init.body).data || []);
}

let calls;
let realFetch;

beforeEach(async () => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    // customaudiences lookup returns a list; everything else an ack.
    const body = String(url).includes('customaudiences') && (!init || init.method !== 'POST')
      ? { data: [{ id: 'aud_1', name: config.meta.audienceDelivered }] }
      : { events_received: 1, id: 'aud_1' };
    return { ok: true, status: 200, json: async () => body };
  };
  store._reset();
  await store.initStore();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Purchase is never sent from this service', () => {
  it('a COD order and its retry send one CAPI event, and it is not Purchase', async () => {
    const order = codOrder();

    await reconcileOrder(order);          // the webhook
    await reconcileOrder(order);          // the retry / replay

    const events = eventsFrom(calls);
    expect(events).toHaveLength(1);
    expect(events[0].event_name).toBe('DeliveredPurchase');
    expect(events.filter((e) => /^purchase$/i.test(e.event_name))).toHaveLength(0);
  });

  it('the event_id is the Shopify order id, so a replay can only collapse', async () => {
    await reconcileOrder(codOrder());
    const [event] = eventsFrom(calls);
    expect(event.event_id).toBe('9001');
    expect(event.custom_data.value).toBe(2149);
    expect(event.custom_data.currency).toBe('INR');
  });

  it('refuses to send when the event name is configured as Purchase', async () => {
    const prev = config.meta.deliveredEventName;
    config.meta.deliveredEventName = 'Purchase';
    try {
      await expect(reconcileOrder(codOrder())).rejects.toThrow(/must not be "Purchase"/);
      expect(eventsFrom(calls)).toHaveLength(0);
    } finally {
      config.meta.deliveredEventName = prev;
    }
  });
});
