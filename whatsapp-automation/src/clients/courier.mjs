/*
 * clients/courier.mjs — Courier interface, Delhivery Express API (static token).
 *
 * The account uses the classic Express API (Authorization: Token <token>).
 *
 * THE TWO WRITE ENDPOINTS DO NOT TAKE THE SAME BODY SHAPE, which is the whole
 * reason the NDR call was broken for as long as it was:
 *
 *   /api/p/edit    FLAT:  { waybill, ... }      proven live on 2026-10-23,
 *                                               cancelling both legs of #1222
 *                                               (via clients/logistics).
 *   /api/p/update  NESTED: { data: [ { waybill, act, action_data? } ] }
 *                                               matched to Delhivery's docs on
 *                                               2026-10-26 after a FLAT body was
 *                                               refused with "Invalid data
 *                                               provided" on a real customer's
 *                                               re-attempt. SCHEMA PROVEN LIVE
 *                                               2026-10-26: the production API
 *                                               answered 201 "Request submitted
 *                                               successfully!" + request_id
 *                                               UPL14271544014443516401 to this
 *                                               exact body.
 *
 * Read (tracking) is verified working (2026-09-21). editToPrepaid is the one
 * write still unproven end to end: it is /api/p/edit, so the shape is right,
 * but no order has actually been flipped to prepaid through it. All writes are
 * DRY_RUN-gated.
 *
 * Interface (a Delhivery One impl could swap in behind the same shape):
 *   track(awbs[])                    -> [{ awb, status, statusType, statusDateTime, instructions, statusCode }]
 *   editToPrepaid(awb)               -> { ok }
 *   cancel(awb)                      -> { ok }
 *   ndrAction(awb, action, opts)     -> { requestId }
 *
 * Exact endpoints/field names/prepaid value are OPEN until Phase 7 (verified on
 * staging with a test AWB); marked TODO(Phase 7). Every write is DRY_RUN-gated,
 * so this never calls Delhivery for real until both verified and enabled.
 */
import { config } from '../config.mjs';
import { getSecrets } from '../secrets.mjs';
import { log, metric } from '../log.mjs';
import { withRetry } from '../lib/resilience.mjs';

const BASE = () =>
  process.env.DELHIVERY_STAGING === 'true' ? 'https://staging-express.delhivery.com' : 'https://track.delhivery.com';

async function authHeaders() {
  const s = await getSecrets();
  return { Authorization: `Token ${s.delhiveryToken}`, 'Content-Type': 'application/json' };
}

async function req(method, path, body, { idempotent = false } = {}) {
  const headers = await authHeaders();
  return withRetry(`delhivery.${path}`, async () => {
    const res = await fetch(`${BASE()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Feeds the wa-courier-failures alarm. No dimensions, to match the alarm.
      metric('CourierError', 1);
      const e = new Error(`delhivery ${method} ${path} failed: ${JSON.stringify(json).slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    return json;
  }, { idempotent });
}

export const courier = {
  // Reads are safe (no DRY_RUN gate). TODO(Phase 7): confirm path + max waybills/call (default 25).
  async track(awbs) {
    const list = (Array.isArray(awbs) ? awbs : [awbs]).slice(0, 25).join(',');
    const json = await req('GET', `/api/v1/packages/json/?waybill=${encodeURIComponent(list)}`, undefined, { idempotent: true });
    const shipments = json.ShipmentData || [];
    return shipments.map((sd) => {
      const sh = sd.Shipment || {};
      const st = sh.Status || {};
      return {
        awb: sh.AWB,
        status: st.Status,
        statusType: st.StatusType,
        statusDateTime: st.StatusDateTime,
        instructions: st.Instructions,
        /*
         * Status.StatusCode, NOT Shipment.NSLCode.
         *
         * NSLCode is not a field this endpoint returns. It was read for a year
         * and was `undefined` on every shipment, so the one input that can
         * identify a failed delivery attempt never reached the mapper and
         * flowC.onNdr could not fire. Verified against all 7 live AWBs on
         * 2026-10-16: every Shipment lacks NSLCode and every Status carries
         * StatusCode (EOD-38 delivered, RD-AC return accepted, X-* movement).
         */
        statusCode: st.StatusCode,
      };
    });
  },

  // TODO(Phase 7): confirm /api/p/edit field names + accepted prepaid value.
  async editToPrepaid(awb) {
    if (config.dryRun) {
      log.info('courier editToPrepaid skipped (dry_run)', { awb });
      return { ok: true, skipped: 'dry_run' };
    }
    await req('POST', '/api/p/edit', { waybill: awb, pt: 'Pre-paid', cod: 0 });
    return { ok: true };
  },

  async cancel(awb) {
    if (config.dryRun) return { ok: true, skipped: 'dry_run' };
    await req('POST', '/api/p/edit', { waybill: awb, cancellation: 'true' });
    return { ok: true };
  },

  /*
   * The NDR action body, as Delhivery documents it: a `data` ARRAY of action
   * items, each carrying its per-action fields in a nested `action_data`.
   *
   *   { data: [ { waybill, act: 'RE-ATTEMPT' },
   *             { waybill, act: 'EDIT_DETAILS', action_data: { name, add, phone } },
   *             { waybill, act: 'DEFER_DLV',    action_data: { deferred_date } } ] }
   *
   * This posted a FLAT { waybill, act, ...opts } until 2026-10-26, when a real
   * customer tapped "deliver tomorrow" on order 12712549155188 and Delhivery
   * refused it with "Invalid data provided". Flow C caught the throw, told them
   * a person would call, and alerted the owner, so the only cost was a delivery
   * that was never re-booked and one ERROR line. The field names had never been
   * checked against the docs: this call still carried "TODO(Phase 7): confirm
   * NDR endpoint + action names" above it.
   *
   * action_data is a strict ALLOW LIST, because an unknown key is how a whole
   * body gets rejected and that is exactly the failure above. The endpoint
   * documents name, add and phone for EDIT_DETAILS and deferred_date for
   * DEFER_DLV, and NO pincode field anywhere. The old caller sent `address` and
   * `pin`; neither exists, and Flow C only ever edits an address whose pincode
   * is unchanged, so there is nothing for a pincode field to carry.
   *
   * RE-ATTEMPT and DEFER_DLV also need the package to be pending on one of a
   * listed set of status codes. We do not pre-check that here: the action is
   * asynchronous, so a per-waybill refusal comes back from the NDR status API
   * rather than from this call, and guessing the precondition is what produced
   * the bug above.
   *
   * ponytail: A REQUEST ID IS A RECEIPT FOR QUEUEING, NOT FOR A RE-ATTEMPT.
   * Proven on 2026-10-26 by submitting waybill 00000000000000, fourteen zeros
   * and not a real AWB: the API still answered 201 with a request_id. So
   * submission validates the SCHEMA and nothing else, and Flow C's
   * ndr_reattempt_ok message still tells the customer "done" on the strength of
   * a queued request. Closing that needs the Get NDR status API polled on the
   * UPL id, which is the next piece of work here; until then a package that was
   * ineligible fails silently, exactly as before, just no longer for every
   * package.
   */
  async ndrAction(awb, action, opts = {}) {
    if (config.dryRun) return { requestId: `dry_${awb}`, skipped: 'dry_run' };
    const ACTION_FIELDS = ['name', 'add', 'phone', 'deferred_date'];
    const actionData = Object.fromEntries(
      ACTION_FIELDS.filter((k) => opts[k] !== undefined && opts[k] !== null).map((k) => [k, opts[k]]),
    );
    const item = { waybill: awb, act: action };
    if (Object.keys(actionData).length) item.action_data = actionData;
    const json = await req('POST', '/api/p/update', { data: [item] });
    /*
     * The endpoint is ASYNCHRONOUS: a 200 means "queued" and the UPL id is the
     * receipt. A 200 carrying no id means nothing was queued, and the caller
     * would otherwise tag the order and tell the customer their delivery is
     * re-booked on the strength of an empty reply, which is the same silent
     * failure in a politer form.
     */
    const requestId = json.request_id || json.UPL;
    if (!requestId) {
      throw new Error(`delhivery POST /api/p/update queued nothing: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return { requestId };
  },
};
