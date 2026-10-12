/*
 * cart-sweep.mjs — Flow R's only starter. Runs every five minutes on the
 * reconcile Lambda with { mode: 'carts' }.
 *
 * There is no webhook for "a customer gave up", so this is a poll by
 * necessity. It stays cheap by asking Shopify one question (open checkouts
 * created in the last maxCheckoutAgeHours) and doing every other filter in
 * memory, and it stays SAFE by deciding nothing: it only enqueues, and
 * onFirst re-reads Shopify and re-checks every gate before anything is sent.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { realClients } from '../clients/index.mjs';
import { normalizeCheckout, cartEligible } from '../domain/cart.mjs';
import { getRec } from '../store/cartRecovery.mjs';
import { withinWindow } from '../lib/time.mjs';
import { enqueue } from '../queue.mjs';
import { log } from '../log.mjs';

export async function sweepAbandonedCarts(clients = realClients, now = new Date()) {
  const r = RULES.cartRecovery;
  if (!config.flows.R.enabled) return { skipped: 'flow-r-off' };
  /*
   * Outside the window we stop here rather than queueing for later. The sweep
   * runs again in five minutes, and a checkout that is still eligible when the
   * window opens will be picked up then; one that has aged past
   * maxCheckoutAgeHours overnight SHOULD be dropped, and queueing it would
   * have meant a 09:30 burst of messages about bags abandoned at midnight.
   */
  if (!withinWindow(now, r.sendWindow)) return { skipped: 'outside-window' };

  const sinceISO = new Date(now.getTime() - r.maxCheckoutAgeHours * 3600 * 1000).toISOString();
  const raw = await clients.shopify.listAbandonedCheckouts(sinceISO);

  const out = { listed: raw.length, enqueued: [], skipped: {} };
  const note = (reason) => {
    out.skipped[reason] = (out.skipped[reason] || 0) + 1;
  };
  // Newest first, so the first checkout seen for a phone is the one to use.
  const seenPhone = new Set();

  for (const c of raw) {
    const n = normalizeCheckout(c);
    if (!n) {
      note('not-found');
      continue;
    }
    const e = cartEligible(n, { now, startAt: config.flows.R.startAt, rules: RULES });
    if (!e.ok) {
      note(e.reason || 'ineligible');
      continue;
    }
    /*
     * One sequence per phone, decided here as well as by the 30-day lock. A
     * customer who abandons the same bag twice in two days (which is a real
     * case: one phone did exactly that on 10 and 12 Oct) must not get two
     * sequences, and the newest checkout is the one whose recovery link still
     * matches what they were looking at.
     */
    if (seenPhone.has(n.verifiedPhone)) {
      note('older-checkout-for-phone');
      continue;
    }
    seenPhone.add(n.verifiedPhone);

    // Already in flight, finished, or deliberately stopped.
    if (await getRec(n.numericId)) {
      note('already-started');
      continue;
    }

    await enqueue(
      { kind: 'cart', step: 'first', checkoutId: n.numericId },
      { groupId: `phone:${n.verifiedPhone}`, dedupId: `cart-first-${n.numericId}` },
    );
    out.enqueued.push(n.numericId);
  }

  if (out.enqueued.length) log.info('cart sweep enqueued', { count: out.enqueued.length, skipped: out.skipped });
  return out;
}
