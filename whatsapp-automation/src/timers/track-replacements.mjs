/*
 * track-replacements.mjs — N3. Watch both legs of every open replacement.
 *
 * /replace booked a reverse pickup and a forward parcel and then went BLIND.
 * Nothing tracked either waybill, so:
 *
 *   the owner had to remember to add the forward parcel to a pickup, from a
 *     digest line rather than from an event, and
 *   the customer, who had just handed over a garment they paid for, heard
 *     nothing at all until the replacement turned up.
 *
 * REPLACEMENT WAYBILLS ARE DELIBERATELY NOT IN THE POLLER'S INDEX. They carry
 * no `activeShipment` attribute, so they never enter GSI1, because onDelhivery
 * routes any terminal event on a mapped AWB into the ORIGINAL order's flows: a
 * reverse pickup reaching RTO would fire Flow C's RTO flow on an order that was
 * never returned, and the forward parcel reaching DELIVERED would ask the same
 * customer for a second review. See DECISIONS T2.
 *
 * So this tracks them separately and by hand, off the REPLOPEN pointers, and
 * routes each leg to its own outcome rather than into the order's flows.
 */
import { lazy, str, langName, DEFAULT_LANG } from '../../messages/lang.mjs';
import { describeParts } from '../domain/variantChange.mjs';
import { realClients } from '../clients/index.mjs';
import * as store from '../store/replace.mjs';
import { mapCourierStatus } from '../domain/courier-status.mjs';
import { ownerAlert, tpl, isTemplateUnusable } from '../worker/send.mjs';
import { alertOncePerDay } from '../store/cartRecovery.mjs';
import { patchFlowB, getState } from '../store/orderState.mjs';
import { cancelTimer } from './schedule.mjs';
import * as flowB from '../worker/flowB.run.mjs';
import { soft } from '../lib/resilience.mjs';
import { RULES } from '../../messages/rules.mjs';
import { log } from '../log.mjs';

/* Statuses worth acting on, per leg. Everything else is movement. */
const REVERSE_BAD = new Set(['RTO_INITIATED', 'RTO_DELIVERED', 'LOST', 'CANCELLED']);

const deps = () => ({ clients: realClients });

/**
 * One pass over every open replacement.
 *
 * Each outcome is recorded on the REQUEST before its message goes out, so a
 * failure cannot repeat an owner alert or tell a customer twice. The whole
 * function is soft per request: one unreadable waybill must not stop the rest.
 */
export async function trackReplacements(now = new Date()) {
  /*
   * listTrackable, NOT listOpen. The REPLOPEN pointer is dropped when a
   * request reaches a terminal state, and DONE is terminal: it means both
   * parcels were BOOKED and the customer was told, which is exactly when their
   * waybills are moving. Tracking off listOpen would watch every request
   * except the ones that need watching.
   *
   * Bounded by the record's own retention: a replacement older than that is
   * not in flight.
   */
  const sinceISO = new Date(now.getTime() - RULES.replace.recordTtlDays * 86400 * 1000).toISOString();
  const open = await store.listTrackable({ sinceISO });
  const out = { checked: 0, events: [] };

  for (const req of open) {
    const awbs = [req.returnAwb, req.forwardAwb].filter(Boolean);
    if (!awbs.length) continue;
    out.checked += 1;

    const results = await soft('trackReplacementLegs', () => realClients.courier.track(awbs), {
      orderId: req.orderId,
      seq: req.seq,
    });
    if (!results) continue;

    const byAwb = new Map(results.filter((r) => r?.awb).map((r) => [String(r.awb), r]));

    // ---- the reverse leg: the customer's garment coming back to us ---------
    if (req.returnAwb) {
      const state = byAwb.has(req.returnAwb) ? mapCourierStatus(byAwb.get(req.returnAwb)) : null;
      if (state && state !== req.returnStatus) {
        await store.patchRequest(req.orderId, req.seq, { returnStatus: state, returnStatusAt: now.toISOString() });
        out.events.push({ orderName: req.orderName, leg: 'return', state });

        if (state === 'PICKED_UP') {
          /*
           * The ONE operational event in this whole flow. The forward parcel is
           * left Ready to Ship on purpose, because we never request a pickup
           * for it, so somebody has to physically add it to the day's pickup
           * and this is the moment they can.
           */
          await soft('returnPickedAlert', () =>
            ownerAlert(deps(), req.orderName, `return collected for this order. Add the replacement parcel ${req.forwardAwb || '(not booked)'} to today's pickup`), {});
        } else if (REVERSE_BAD.has(state)) {
          await soft('returnBadAlert', () =>
            ownerAlert(deps(), req.orderName, `the replacement PICKUP is ${state} (waybill ${req.returnAwb}). The customer is waiting and nothing is coming back. Call Delhivery`), {});
        }
      }
    }

    // ---- the forward leg: the replacement going out --------------------------
    if (req.forwardAwb) {
      const state = byAwb.has(req.forwardAwb) ? mapCourierStatus(byAwb.get(req.forwardAwb)) : null;
      if (state && state !== req.forwardStatus) {
        await store.patchRequest(req.orderId, req.seq, { forwardStatus: state, forwardStatusAt: now.toISOString() });
        out.events.push({ orderName: req.orderName, leg: 'forward', state });

        if (state === 'PICKED_UP' && !req.shippedNotifiedAt) await notifyShipped(req, now);
        if (state === 'DELIVERED') await finishDelivered(req, now);
        if (REVERSE_BAD.has(state)) {
          await soft('forwardBadAlert', () =>
            ownerAlert(deps(), req.orderName, `the REPLACEMENT parcel is ${state} (waybill ${req.forwardAwb}). The customer has given theirs back and has nothing. Call Delhivery`), {});
        }
      }
    }
  }

  return out;
}

/** The replacement has left us. Tell the customer, once. */
async function notifyShipped(req, now) {
  if (!req.verifiedPhone) {
    log.info('replacement: shipped but no recipient on the request', { orderId: req.orderId, seq: req.seq });
    return;
  }
  // Recorded FIRST, so a failure below cannot send a second copy.
  await store.patchRequest(req.orderId, req.seq, { shippedNotifiedAt: now.toISOString() });
  try {
    await tpl(deps(), req.verifiedPhone, 'replacement_shipped', {
      customer_name: lazy((l) => langName(l, req.customerName)),
      order_number: req.orderName,
      new_item: lazy((l) => newItemLine(req, l)),
      awb: req.forwardAwb,
    }, { token: req.forwardAwb, orderId: req.orderId });
  } catch (e) {
    if (!isTemplateUnusable(e)) throw e;
    await soft('shippedTemplateAlert', async () => {
      if (await alertOncePerDay('replacement-shipped-template', now)) {
        await ownerAlert(deps(), req.orderName, 'the replacement_shipped template is not approved on WhatsApp yet, so customers are not being told their replacement has shipped. Submit it');
      }
    }, {});
    log.warn('replacement: shipped template not usable', { orderId: req.orderId, waCode: e.waCode });
  }
}

/**
 * The replacement arrived. The exchange is finished, so the review ask that
 * F20 held back can be armed again.
 */
async function finishDelivered(req, now) {
  await store.patchRequest(req.orderId, req.seq, { state: 'DONE_DELIVERED', deliveredAt: now.toISOString() });
  /*
   * NOW the review ask makes sense: they have the garment they actually
   * wanted. F20 set flowB.skip when the replacement was confirmed, which is
   * why this has to clear it before scheduling, and onDelivered re-checks every
   * one of its own gates anyway.
   */
  await soft('rearmReviewAsk', async () => {
    const st = await getState(String(req.orderId));
    if (st?.flowB?.skip !== 'replacement') return;
    await cancelTimer({ flow: 'B', orderId: String(req.orderId), step: 'review_ask' });
    await patchFlowB(String(req.orderId), { skip: null, scheduled: false, assumedDelivery: false });
    await flowB.onDelivered(String(req.orderId), now.toISOString(), deps());
    log.info('replacement: delivered, review ask re-armed', { orderId: req.orderId });
  }, { orderId: req.orderId });
}

/**
 * "Noor, size XL", from the request's own snapshot, in the customer's language.
 *
 * `parts` when the row has them. A request raised before /replace started
 * storing them carries only the joined English `name`, and that is still
 * better than a blank where a garment should be.
 */
function newItemLine(req, lang = DEFAULT_LANG) {
  const first = (req.items?.forward || [])[0];
  if (!first) return str(lang, 'yourReplacement');
  const line = first.parts ? describeParts(first.parts, lang) : first.name;
  return line || str(lang, 'yourReplacement');
}
