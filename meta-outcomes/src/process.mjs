/*
 * process.mjs — real-time path: process ONE order by id (used by the optional
 * webhook server). The scheduled poll is the primary path; this exists for a
 * future always-on deployment. Serialised per order id and persisted after each
 * order, so concurrent webhooks can never double-fire.
 */
import { getOrderByNumericId } from './shopify.mjs';
import { reconcileOrder } from './reconcile.mjs';
import { flush } from './store.mjs';
import { withKeyLock } from './lock.mjs';

/**
 * Process one order by numeric id. Re-reads the order over GraphQL (webhook
 * bodies lag / differ), reconciles it, and persists. Returns a summary.
 */
export function processOrder(numericId) {
  return withKeyLock(numericId, async () => {
    const order = await getOrderByNumericId(numericId);
    if (!order) return { orderId: String(numericId), skipped: 'order-not-found', actions: ['no-op'] };
    const r = await reconcileOrder(order);
    await flush();
    return r;
  });
}
