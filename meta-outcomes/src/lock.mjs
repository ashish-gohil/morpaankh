/*
 * lock.mjs — a per-key in-process async mutex.
 *
 * Two webhooks for the SAME order can arrive within milliseconds (e.g.
 * orders/updated and fulfillments/update for one delivery). Without
 * serialisation both could read the ledger before either writes it, both see
 * deliveredSent=false, and both fire DeliveredPurchase. This chains work per
 * order id so the same order is never processed concurrently. (Meta also
 * de-dupes by event_id as a second line of defence; this removes the race
 * entirely and avoids wasted audience writes.)
 */
const chains = new Map();

export function withKeyLock(key, fn) {
  const k = String(key);
  const prev = chains.get(k) || Promise.resolve();
  // Run fn after whatever is queued for this key settles (success or failure).
  const run = prev.then(() => fn(), () => fn());
  // Keep the chain alive even if fn rejects, so later work still serialises.
  const guarded = run.then(
    () => {},
    () => {},
  );
  chains.set(k, guarded);
  // Drop the map entry once this is the tail and it has settled (avoid leak).
  guarded.then(() => {
    if (chains.get(k) === guarded) chains.delete(k);
  });
  return run; // caller sees the real result / error
}
