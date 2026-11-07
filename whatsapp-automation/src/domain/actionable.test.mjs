/*
 * The predicates the ingest uses to decide whether the worker cares.
 *
 * The risk being tested is DRIFT: the ingest dropping an event the worker would
 * have acted on. So the last test here reads the worker's router and asserts
 * every topic it branches on is one this module knows about.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { shopifyActionable, waStatusActionable, FULFILLMENT_EVENT_STATUSES } from './actionable.mjs';

describe('shopifyActionable', () => {
  it('always acts on an order being created, cancelled or fulfilled', () => {
    for (const topic of ['orders/create', 'orders/cancelled', 'fulfillments/create', 'fulfillments/update']) {
      expect(shopifyActionable(topic, {})).toBe(true);
    }
  });

  /*
   * orders/updated fires on EVERY tag write, including the ones this service
   * makes itself (wa-cod-sent, wa-confirmed, wa-review-asked...), so it was the
   * single biggest source of worker runs that decided nothing.
   */
  it('acts on orders/updated only for the COD-Cancelled tag', () => {
    expect(shopifyActionable('orders/updated', { tags: 'COD-Cancelled, LOW RTO Risk' })).toBe(true);
    expect(shopifyActionable('orders/updated', { tags: ['COD-Cancelled'] })).toBe(true);
    expect(shopifyActionable('orders/updated', { tags: 'wa-cod-sent, LOW RTO Risk' })).toBe(false);
    expect(shopifyActionable('orders/updated', { tags: '' })).toBe(false);
    expect(shopifyActionable('orders/updated', {})).toBe(false);
  });

  it('acts on the three courier statuses the flows read, and not on a transit scan', () => {
    for (const status of ['delivered', 'attempted_delivery', 'failure']) {
      expect(shopifyActionable('fulfillment_events/create', { status })).toBe(true);
    }
    for (const status of ['in_transit', 'confirmed', 'label_printed', '']) {
      expect(shopifyActionable('fulfillment_events/create', { status })).toBe(false);
    }
  });

  it('acts on a checkout only when it carries the OTP attribute and is not complete', () => {
    const otp = [{ name: '_otpVerifiedPhoneNumber', value: '919812345678' }];
    expect(shopifyActionable('checkouts/update', { note_attributes: otp })).toBe(true);
    expect(shopifyActionable('checkouts/update', { note_attributes: [] })).toBe(false);
    expect(shopifyActionable('checkouts/create', {})).toBe(false);
    // They bought: there is nothing to win back.
    expect(shopifyActionable('checkouts/update', { note_attributes: otp, completed_at: '2026-11-06T10:00:00Z' })).toBe(false);
  });

  /*
   * Shopify can only send what we subscribed to, so an unrecognised topic means
   * this file is behind the subscription list. Dropping it is the worse of the
   * two failures: a customer who hears nothing.
   */
  it('keeps an unknown topic rather than dropping it', () => {
    expect(shopifyActionable('refunds/create', {})).toBe(true);
  });
});

describe('waStatusActionable', () => {
  it('keeps delivered and failed', () => {
    expect(waStatusActionable('delivered')).toBe(true);
    expect(waStatusActionable('failed')).toBe(true);
  });

  it('drops sent and read, which nothing reads', () => {
    expect(waStatusActionable('sent')).toBe(false);
    expect(waStatusActionable('read')).toBe(false);
    expect(waStatusActionable(undefined)).toBe(false);
  });
});

/*
 * THE DRIFT GUARD.
 *
 * If the worker learns to act on something new and this module does not learn
 * it in the same commit, the ingest silently stops delivering it. That failure
 * is invisible: no error, no metric, just a flow that stopped happening. So the
 * router's own source is the fixture.
 */
describe('the ingest and the worker agree on every topic', () => {
  const router = readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8');

  it('knows every shopify topic the router branches on', () => {
    const topics = new Set();
    for (const m of router.matchAll(/topic === '([^']+)'/g)) topics.add(m[1]);
    for (const m of router.matchAll(/topic\.startsWith\('([^']+)'\)/g)) topics.add(m[1]);
    expect(topics.size).toBeGreaterThan(4); // the fixture is really being read

    for (const topic of topics) {
      // Either it is unconditionally actionable, or this module has a branch
      // naming it. A topic the module has never heard of falls through to the
      // keep-everything default, which is safe but means the saving is not
      // being made and nobody knows.
      const named = topic === 'orders/updated'
        || topic === 'fulfillment_events/create'
        || topic.startsWith('checkouts/')
        || shopifyActionable(topic, {}) === true;
      expect(named, `the actionable predicates do not know the topic "${topic}"`).toBe(true);
    }
  });

  it('acts on every fulfillment_events status the router branches on', () => {
    const statuses = new Set();
    for (const m of router.matchAll(/payload\?\.status === '([^']+)'/g)) statuses.add(m[1]);
    expect(statuses.size).toBeGreaterThan(1);
    for (const status of statuses) {
      expect(FULFILLMENT_EVENT_STATUSES.has(status), `status "${status}" would be dropped by the ingest`).toBe(true);
    }
  });
});
