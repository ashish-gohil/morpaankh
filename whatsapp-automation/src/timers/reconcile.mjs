/*
 * reconcile.mjs — the safety net. Two modes, two schedules:
 *
 *   orders (hourly)  sweepUnconfirmed: any order the confirmation never reached.
 *   full  (nightly)  the sweep, plus re-assert the Shopify webhook
 *                    subscriptions and re-track every active AWB.
 *
 * The webhook and AWB halves are the expensive ones and a day late is fine for
 * both. The order sweep is not: a confirmation that arrives a day after the
 * order is worth almost nothing, so it runs every hour.
 */
import { config } from '../config.mjs';
import { realClients } from '../clients/index.mjs';
import { tpl } from '../worker/send.mjs';
import { trackActiveShipments } from './track-active.mjs';
import { getState, patchFlowA, runOnce } from '../store/orderState.mjs';
import { afterStart } from '../domain/eligibility.mjs';
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
// After this many sweeps an order is not going to fix itself: something about it
// is permanently unsendable (no verified phone, a class we cannot read). Keep
// requeueing and we hammer Shopify and the queue forever for an order that can
// never be confirmed, which is a worse failure than the one we are repairing.
const MAX_TRIES = 3;

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

    const st = await getState(orderId);
    if (st?.flowA?.codConfirmAt) continue; // told
    if (st?.flowA?.codSkip) continue; // looked at it and decided not to; see codSkip in flowA.run
    if (st?.stoppedAt || st?.cancelledAt) continue; // nothing to tell them

    const tries = st?.flowA?.sweepTries || 0;
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

    await patchFlowA(orderId, { sweepTries: tries + 1 });
    await enqueue(
      { kind: 'timer', flow: 'A', orderId, step: 'cod' },
      { groupId: `order:${orderId}`, dedupId: `sweep-cod-${orderId}-${tries + 1}` },
    );
    out.requeued.push(orderId);
    log.warn('reconcile: order had no confirmation, re-armed', { orderId, tries: tries + 1 });
  }
  return out;
}

export const handler = async (event = {}) => {
  const mode = event?.mode === 'orders' ? 'orders' : 'full';
  const out = { mode, webhooks: [], shipments: null, orders: null };

  try {
    out.orders = await sweepUnconfirmed();
  } catch (e) {
    log.error('reconcile order sweep failed', { err: e.message });
  }

  if (mode === 'full') {
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
