/*
 * reconcile.mjs — the safety net. Two modes, two schedules:
 *
 *   orders (hourly)  sweepUnconfirmed: any order the confirmation never reached.
 *   full  (nightly)  the sweep, plus re-assert the Shopify webhook
 *                    subscriptions and re-track every active AWB.
 *   carts  (5 min)   Flow R: abandoned checkouts old enough to be messaged.
 *                    Handled first and returned, and NOT folded into 'full':
 *                    see the handler.
 *   subscribers      Flow W: yesterday's new customers, once a day at 11:00
 *        (daily)     IST. Handled and returned at the top for the same reason.
 *
 * The webhook and AWB halves are the expensive ones and a day late is fine for
 * both. The order sweep is not: a confirmation that arrives a day after the
 * order is worth almost nothing, so it runs every hour.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { realClients } from '../clients/index.mjs';
import { tpl } from '../worker/send.mjs';
import { trackActiveShipments } from './track-active.mjs';
import { sweepAbandonedCarts } from './cart-sweep.mjs';
import { sweepNewSubscribers } from './subscriber-sweep.mjs';
import { getState, patchFlowA, runOnce } from '../store/orderState.mjs';
import { table } from '../store/table.mjs';
import { afterStart } from '../domain/eligibility.mjs';
import * as flowB from '../worker/flowB.run.mjs';
import { enqueue } from '../queue.mjs';
import { soft } from '../lib/resilience.mjs';
import { log } from '../log.mjs';

// How far back the sweep looks. Long enough to cover a whole night of missed
// webhooks plus the nightly pass, short enough that it stays one Shopify query.
const LOOKBACK_HOURS = 36;
// The first confirmation is scheduled at +3 minutes and SQS retries a failing
// record five times, so nothing is "late" before this. Sweeping earlier would
// race the normal path and send twice.
const GRACE_MINUTES = 20;
/*
 * The sweep runs every 10 minutes (ReconcileOrdersRule), so an order that lost
 * its webhook is confirmed within half an hour instead of within the hour.
 *
 * The RETRY spacing is deliberately kept at an hour. MAX_TRIES is a budget for
 * a transient fault, and a ten minute sweep would otherwise burn all three in
 * half an hour: a Shopify outage lasting forty minutes would exhaust every
 * order's tries, raise a stuck alert for each one and then never try again,
 * which is a worse failure than the one the sweep repairs.
 */
const RETRY_SPACING_MINUTES = 55;
// After this many sweeps an order is not going to fix itself: something about it
// is permanently unsendable (no verified phone, a class we cannot read). Keep
// requeueing and we hammer Shopify and the queue forever for an order that can
// never be confirmed, which is a worse failure than the one we are repairing.
const MAX_TRIES = 3;
/*
 * How old an order may be and still be re-armed.
 *
 * LOOKBACK_HOURS is 36 and reads orders by UPDATED time, which is not the same
 * question. Every tag this service writes updates the order, so a two-week-old
 * parcel that was merely scanned yesterday came back in this list, and with no
 * age limit the sweep re-armed it: a shipped order was sent cod_confirm, "ready
 * to be packed", a fortnight late. Pausing Flow A for a day and switching it
 * back on did the same thing to every order in between.
 *
 * A confirmation that arrives a day after the order is worth almost nothing
 * anyway, which is the same reasoning that puts this sweep on an hourly timer.
 */
const MAX_AGE_HOURS = 24;

async function alert(text, orderName = 'reconcile') {
  const deps = { clients: realClients };
  for (const phone of config.ownerAlertPhones) {
    await tpl(deps, phone, 'ops_alert', { order_number: orderName, alert_text: text }, {});
  }
}

/**
 * Find orders that never got their Flow A confirmation, and re-arm them.
 *
 * Nothing did this before. The confirmation depends on a chain with four places
 * to lose an order silently and no check at the end of it: Shopify has to
 * deliver orders/create, the ingest has to enqueue it, the worker has to create
 * a one-time EventBridge timer, and that timer has to fire. A dropped webhook, a
 * timer that was never created, or five failed SQS receives all end the same
 * way, with a real customer who is never told anything and nothing anywhere
 * saying so. codConfirmAt was written by the send and read only by the send's
 * own stale-timer guard, so the one field that records "this customer was told"
 * was never used to ask who wasn't.
 *
 * Re-enqueueing is safe: onCodTimer re-reads the order from Shopify, re-checks
 * eligibility, and returns early on codConfirmAt, so a false positive is a
 * no-op rather than a second message.
 */
export async function sweepUnconfirmed(now = new Date()) {
  const out = { checked: 0, requeued: [], stuck: [] };
  if (!config.flows.A.enabled || !config.flows.A.startAt) {
    return { ...out, skipped: 'flow-a-off' };
  }
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const orders = await realClients.shopify.ordersUpdatedSince(since);

  for (const o of orders) {
    const orderId = String(o.id).split('/').pop();
    if (!afterStart({ createdAt: o.createdAt }, config.flows.A.startAt)) continue;
    const ageMin = (now.getTime() - new Date(o.createdAt).getTime()) / 60000;
    if (!Number.isFinite(ageMin) || ageMin < GRACE_MINUTES) continue;
    out.checked += 1;

    if (ageMin > MAX_AGE_HOURS * 60) continue; // see MAX_AGE_HOURS

    const st = await getState(orderId);
    if (st?.flowA?.codConfirmAt) continue; // told
    if (st?.flowA?.codSkip) continue; // looked at it and decided not to; see codSkip in flowA.run
    /*
     * This read `st.stoppedAt`, and NOTHING HAS EVER WRITTEN THAT FIELD. onStop
     * records a stop as flowA.step === 'stopped', so the check matched nothing:
     * a cancelled order stayed in the sweep until MAX_TRIES ran out and then
     * raised a stuck alert about an order that was correctly never messaged.
     *
     * st.cancelledAt is not written on the state row yet either. It is left in
     * because F23 starts writing it on a WhatsApp cancel, at which point this
     * line covers that case too without a second edit.
     */
    if (st?.flowA?.step === 'stopped' || st?.cancelledAt) continue; // nothing to tell them

    const tries = st?.flowA?.sweepTries || 0;
    const lastTry = st?.flowA?.sweptAt ? new Date(st.flowA.sweptAt).getTime() : 0;
    if (lastTry && now.getTime() - lastTry < RETRY_SPACING_MINUTES * 60 * 1000) continue;
    if (tries >= MAX_TRIES) {
      out.stuck.push(orderId);
      // Once per order, ever. The owner gets a name they can act on instead of
      // an hourly repeat of the same unfixable order.
      await soft('sweepStuckAlert', () =>
        runOnce(orderId, 'sweep-stuck', async () => {
          await alert(
            `this order got NO WhatsApp confirmation after ${MAX_TRIES} automatic retries. Check it by hand and contact the customer`,
            st?.name || orderId,
          );
          return { alerted: true };
        }),
        { orderId },
      );
      continue;
    }

    await patchFlowA(orderId, { sweepTries: tries + 1, sweptAt: now.toISOString() });
    await enqueue(
      { kind: 'timer', flow: 'A', orderId, step: 'cod' },
      { groupId: `order:${orderId}`, dedupId: `sweep-cod-${orderId}-${tries + 1}` },
    );
    out.requeued.push(orderId);
    log.warn('reconcile: order had no confirmation, re-armed', { orderId, tries: tries + 1 });
  }
  return out;
}

/**
 * Find orders we KNOW were delivered but never scheduled a review ask, and
 * schedule one.
 *
 * This is the hole that meant no customer was ever asked for a review. Flow B
 * starts from an EDGE: either a Shopify fulfilment event saying delivered, or
 * the Delhivery poller seeing the status CHANGE to DELIVERED. Nothing re-reads
 * it. So any order whose delivery landed while Flow B was switched off, or
 * whose webhook was dropped, or whose SQS record failed five times, is finished
 * with: `courierStatus` is already DELIVERED, so the poller skips it as
 * unchanged, and the AWB has been removed from the GSI so it is not even
 * tracked any more. Eighteen delivered orders sat in exactly that state.
 *
 * Deliberately bounded to the last `reviewSweepLookbackDays`. The sweep is here
 * to repair a FRESH hole, not to message everyone whose parcel arrived a
 * fortnight ago: a review ask for a three-week-old order reads as a mailing
 * list, and that decision belongs to the owner, not to a nightly cron.
 *
 * onDelivered does all the real work and re-checks every gate (flow enabled,
 * cancelled, RTO, refunded, startAt, verified phone, already asked), so a false
 * positive here is a no-op rather than a message.
 */
export async function sweepUnreviewed(now = new Date()) {
  const out = { checked: 0, scheduled: [] };
  if (!config.flows.B.enabled) return { ...out, skipped: 'flow-b-off' };

  const cutoff = now.getTime() - RULES.reviewSweepLookbackDays * 24 * 60 * 60 * 1000;
  const deps = { clients: realClients, now };

  for (const st of await table.scanStates()) {
    /*
     * From the PK, not from a field, because the field is not always there.
     *
     * ensureState writes orderId, but track-active reaches a delivery through
     * patchState, and patching a row that does not exist yet creates it with
     * only PK, SK, version and the fields passed. Eleven live rows are exactly
     * that: courierStatus DELIVERED and nothing else. Reading the field on
     * those gives undefined, and the sweep would have called onDelivered with
     * it. The PK is the one thing every row has.
     */
    const orderId = String(st.PK || '').replace('ORDER#', '');
    if (!orderId) continue;
    if (st.courierStatus !== 'DELIVERED') continue;
    if (st.flowB?.scheduled || st.flowB?.reviewAsked || st.flowB?.reviewed) continue;
    if (st.cancelledAt || st.flowC?.rto) continue;
    /*
     * courierStatusAt is written by track-active at the moment the status
     * changed, so it is the delivery time and nothing else moves it. It is also
     * what bounds the sweep.
     *
     * NOT updatedAt, which every write to the row bumps: an order delivered a
     * fortnight ago whose state was touched yesterday would read as a delivery
     * from yesterday and be messaged. A row with no courierStatusAt at all is
     * from before this was recorded, and is left alone rather than guessed at.
     */
    const at = new Date(st.courierStatusAt || 0).getTime();
    if (!at || at < cutoff) continue;
    out.checked += 1;
    try {
      await flowB.onDelivered(orderId, st.courierStatusAt, deps);
      const after = await getState(orderId);
      if (after?.flowB?.scheduled) out.scheduled.push(orderId);
    } catch (e) {
      log.error('reconcile: review schedule failed', { orderId, err: e.message });
    }
  }
  if (out.scheduled.length) log.warn('reconcile: delivered orders had no review ask, scheduled', out);
  return out;
}

export const handler = async (event = {}) => {
  /*
   * 'carts' is handled FIRST and returns, before anything else in this
   * function runs.
   *
   * This is not tidiness. The mode line below collapses every unrecognised
   * mode to 'full', and the cart sweep is on a FIVE MINUTE rule, so a 'carts'
   * event that fell through would run the whole nightly pass 288 times a day:
   * sweepUnreviewed() calls flowB.onDelivered(), which SENDS a review ask to a
   * real customer, plus ensureWebhooks and a full Delhivery re-track each time.
   *
   * Returning inside the `mode === 'full'` block would not be enough either,
   * because sweepUnconfirmed() runs unconditionally above it and would re-arm
   * Flow A timers every five minutes.
   */
  if (event?.mode === 'carts') {
    const carts = await sweepAbandonedCarts();
    log.info('reconcile carts done', carts);
    return { ok: true, mode: 'carts', carts };
  }

  /*
   * 'subscribers' is handled here for exactly the same reason, and the stakes
   * are the same: the mode line below collapses every unrecognised mode to
   * 'full', and 'full' runs sweepUnreviewed(), which calls flowB.onDelivered()
   * and SENDS a review ask to a real customer. sweepUnconfirmed() also runs
   * unconditionally above that branch, so returning inside it would not be
   * enough either.
   *
   * Flow W's own rule fires once a day at 11:00 IST, so the damage would be
   * one unwanted nightly pass a day rather than 288, which is worse in a
   * different way: it would be mistaken for the real nightly run.
   */
  if (event?.mode === 'subscribers') {
    const subscribers = await sweepNewSubscribers();
    log.info('reconcile subscribers done', subscribers);
    return { ok: true, mode: 'subscribers', subscribers };
  }

  const mode = event?.mode === 'orders' ? 'orders' : 'full';
  const out = { mode, webhooks: [], shipments: null, orders: null, reviews: null };

  try {
    out.orders = await sweepUnconfirmed();
  } catch (e) {
    log.error('reconcile order sweep failed', { err: e.message });
  }

  if (mode === 'full') {
    // After trackActiveShipments, so a delivery the nightly poll has just
    // noticed is picked up in the same run rather than a day later.
    try {
      out.webhooks = await realClients.shopify.ensureWebhooks({ dryRun: config.dryRun });
    } catch (e) {
      log.error('reconcile webhooks failed', { err: e.message });
    }
    try {
      out.shipments = await trackActiveShipments();
    } catch (e) {
      log.error('reconcile track failed', { err: e.message });
    }
    try {
      out.reviews = await sweepUnreviewed();
    } catch (e) {
      log.error('reconcile review sweep failed', { err: e.message });
    }
  }

  const repaired = (out.webhooks || []).filter((w) => w.status === 'created' || w.status === 'error');
  if (repaired.length && !config.dryRun) {
    await soft('alertWebhooks', () => alert(`reconciliation repaired webhook subscriptions: ${repaired.map((r) => r.topic).join(', ')}`), {});
  }
  // A re-arm is deliberately NOT alerted. It fires hourly, says only that the
  // safety net did its job, and gives the owner nothing to do: either the
  // re-arm works and the customer is told, or it runs out of tries and the
  // once-per-order stuck alert above says so with the order name. Alerting on
  // the attempt meant one unsendable order sent four messages about a fact the
  // owner had already been told. The log line in sweepUnconfirmed is the record.
  log.info('reconcile done', out);
  return { ok: true, ...out };
};
