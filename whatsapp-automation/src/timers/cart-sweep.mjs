/*
 * cart-sweep.mjs — Flow R's only starter. Runs every five minutes on the
 * reconcile Lambda with { mode: 'carts' }.
 *
 * There is no webhook for "a customer gave up", so this is a poll by
 * necessity. It stays SAFE by deciding nothing: it only enqueues, and onFirst
 * re-reads the cart and re-checks every gate before anything is sent.
 *
 * TWO SOURCES, and the order matters.
 *
 *   1. CAPTURED CARTS, from the storefront. Primary.
 *   2. Shopify's abandonedCheckouts. Fallback.
 *
 * Shopify files an AbandonedCheckout only once a shopper reaches its OWN
 * contact step. On this store the OTP is earlier, in COD King's popup, so
 * everyone who verified a number and left before that step is invisible to
 * the checkout list. Measured 17 to 19 Oct 2026: five people passed OTP and
 * walked away, Shopify recorded none of them, and this sweep logged
 * `listed: 0` on all 864 runs. Hence the capture endpoint, and hence this
 * reading both.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { realClients } from '../clients/index.mjs';
import { normalizeCheckout, cartEligible } from '../domain/cart.mjs';
import { capturedToCheckout, variantGidsOf } from '../domain/cartCapture.mjs';
import { listCaptures } from '../store/cartCapture.mjs';
import { getRec } from '../store/cartRecovery.mjs';
import { withinWindow } from '../lib/time.mjs';
import { enqueue } from '../queue.mjs';
import { log } from '../log.mjs';


/**
 * The carts the STOREFRONT captured, as checkouts.
 *
 * This is the primary source. Shopify files an AbandonedCheckout only once a
 * shopper reaches its own contact step, and COD King's OTP happens before
 * that, so the checkout list misses everyone who verified and left earlier.
 *
 * ORDER OF WORK IS DELIBERATE. Age and the already-started check run FIRST,
 * against rows we already hold, and only what survives costs a Shopify call.
 * This runs every five minutes against rows that live for three days, so
 * resolving variants up front would mean paying for the same expired carts
 * roughly eight hundred times a day.
 *
 * A failure here is logged and returns nothing rather than throwing: the
 * Shopify list below is a working fallback and is the whole reason it was
 * kept, so a bad minute in DynamoDB must not take the sweep down with it.
 */
async function collectCaptured(clients, now, r, out) {
  let rows = [];
  try {
    rows = await listCaptures();
  } catch (e) {
    log.warn('cart sweep: could not read captured carts, falling back to Shopify only', { err: e.message });
    return [];
  }
  out.captured = { rows: rows.length, eligible: 0 };

  /*
   * Silent, not counted as a skip. A capture is kept for three days but is
   * only actionable for maxCheckoutAgeHours, so most rows here are expected to
   * be out of range and counting them would bury the real skip reasons.
   */
  const inWindow = rows.filter((row) => {
    const ageMin = (now.getTime() - new Date(row.capturedAt).getTime()) / 60000;
    return Number.isFinite(ageMin) && ageMin >= r.firstAfterMin && ageMin <= r.maxCheckoutAgeHours * 60;
  });

  const pending = [];
  for (const row of inWindow) {
    if (await getRec(row.id)) continue; // already in flight, finished or stopped
    pending.push(row);
  }
  if (!pending.length) return [];

  const gids = Array.from(new Set(pending.flatMap(variantGidsOf)));
  let variants = [];
  try {
    variants = await clients.shopify.getVariantsByIds(gids);
  } catch (e) {
    // Without live variants there is no trustworthy price, and an untrusted
    // price is an untrusted discount. Drop the captures, keep the fallback.
    log.warn('cart sweep: could not price captured carts, falling back to Shopify only', { err: e.message });
    return [];
  }

  const built = pending.map((row) => capturedToCheckout(row, variants)).filter(Boolean);
  out.captured.eligible = built.length;
  return built;
}

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
  const out = { listed: 0, enqueued: [], skipped: {} };

  /*
   * BOTH sources, then one list. The storefront captures are primary and the
   * Shopify checkouts are the fallback, but they are not ranked by source:
   * they go through the same newest-per-phone rule below, because when a
   * person appears in both they are the same shopping session and the newer
   * row is the bag they were actually last holding. A Shopify row winning
   * there is a GOOD outcome, since it carries a real recover URL that lands
   * them back in their own checkout rather than a rebuilt cart.
   */
  const captured = await collectCaptured(clients, now, r, out);

  /*
   * Sorted here, not trusted from the query. listAbandonedCheckouts asks for
   * CREATED_AT reverse, but the newest-per-phone rule below is the difference
   * between recovering the bag they last looked at and recovering one they
   * have since changed, so it does not rest on a sortKey argument staying put.
   * The captures are interleaved by the same sort, so neither source can jump
   * the queue by arriving first in the array.
   */
  const raw = [...captured, ...(await clients.shopify.listAbandonedCheckouts(sinceISO))]
    .sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime());

  out.listed = raw.length;
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

  if (out.enqueued.length) log.info('cart sweep enqueued', { count: out.enqueued.length, captured: out.captured, skipped: out.skipped });
  return out;
}
