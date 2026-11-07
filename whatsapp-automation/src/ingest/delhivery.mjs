/*
 * ingest/delhivery.mjs — Delhivery status push (enabled by Delhivery on request;
 * until then the poller is source of truth). Shared-secret header + dedupe by
 * AWB + Status + StatusDateTime. Exact payload shape is verified at Phase 7;
 * this reads the documented Status envelope defensively.
 */
import { makeIngest } from './base.mjs';
import { verifySharedSecret } from '../lib/signature.mjs';
import { getAwbMap, markDelhiveryPush } from '../store/maps.mjs';
import { log } from '../log.mjs';

// Header name agreed with Delhivery (OPEN, confirm at Phase 7).
const SECRET_HEADER = 'x-delhivery-token';

function shipmentsOf(body) {
  if (Array.isArray(body?.Shipments)) return body.Shipments;
  if (body?.Shipment) return [body.Shipment];
  if (Array.isArray(body)) return body;
  return [];
}

export const delhiveryIngest = {
  name: 'delhivery',
  verify: (_raw, h, s) => verifySharedSecret(h[SECRET_HEADER], s.delhiveryPushSecret),
  /*
   * GROUPED BY ORDER, NOT BY WAYBILL.
   *
   * The FIFO queue serialises by group, and every other handler for an order
   * uses `order:<id>`. Grouping these by `awb:<awb>` put courier events in a
   * group of their own, so a DELIVERED push and the orders/updated for the same
   * order could run at once: both read the state row, both write it, and the
   * loser's write is lost. That is the shape that erases a conversion stamp or
   * a review schedule.
   *
   * It has never bitten because Delhivery has not enabled the push for this
   * account (2 invocations in 30 days, against the poller's 452), and the
   * poller already groups by order. This is the thing to have fixed BEFORE that
   * webhook is switched on, not after.
   *
   * The AWB group remains the fallback for a waybill we have no mapping for,
   * which is better than dropping the event: the worker logs it as an unknown
   * AWB and a human can see it.
   */
  async toItems(_h, body) {
    const out = [];
    for (const sh of shipmentsOf(body)) {
      const awb = sh.AWB || sh.Waybill || sh.waybill;
      const status = sh.Status?.Status || sh.status;
      const at = sh.Status?.StatusDateTime || sh.StatusDateTime || '';
      if (!awb) continue;
      let groupId = `awb:${awb}`;
      try {
        const map = await getAwbMap(String(awb));
        if (map?.orderId) groupId = `order:${map.orderId}`;
        else log.warn('delhivery push: no order for this waybill, grouping by waybill', { awb: String(awb) });
      } catch (e) {
        // A table read failure must not lose a courier event. The AWB group is
        // the old behaviour, so the worst case is the race this fix removes.
        log.error('delhivery push: could not resolve the waybill to an order', { err: e.message });
      }
      out.push({
        message: { kind: 'delhivery', awb: String(awb), status, at, shipment: sh },
        groupId,
        dedupId: `dl-${awb}-${status}-${at}`,
      });
    }
    /*
     * Record that the push delivered something. The poller reads this to decide
     * whether it still needs to run hourly, and an observation is the only
     * honest answer to "is the push live": a config flag says what somebody
     * believed when they set it, and the failure that matters is the push going
     * quiet without anybody noticing.
     *
     * Recorded even for a payload we enqueue nothing from, because the question
     * is whether Delhivery is talking to us, not whether this particular scan
     * was interesting.
     */
    if (out.length || shipmentsOf(body).length) {
      await markDelhiveryPush();
    }
    return out;
  },
};

export const handler = makeIngest(delhiveryIngest);
