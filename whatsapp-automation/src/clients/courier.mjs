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
 *   ndrAction(awb, action, opts)     -> { requestId, confirmed } (throws if refused)
 *   ndrStatus(requestId)             -> { status, remark, failed[], success[] }
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
    const text = await res.text();
    let json = null; // null means the body was not JSON
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = null;
    }
    const fail = (detail, status) => {
      // Feeds the wa-courier-failures alarm. No dimensions, to match the alarm.
      metric('CourierError', 1);
      const e = new Error(`delhivery ${method} ${path} failed: ${String(detail).slice(0, 200)}`);
      if (status) e.status = status;
      throw e;
    };
    if (!res.ok) fail(text || res.statusText, res.status);
    /*
     * A NON-JSON BODY MEANS /api/p/edit, AND THAT ENDPOINT REFUSES WITH HTTP
     * 200. Observed against production on 2026-10-27 for an impossible waybill:
     *
     *   200 <root><error>Incorrect Waybill/OrderID, please try again</error>
     *       <status>Failure</status>...</root>
     *
     * This used to be `res.json().catch(() => ({}))`, so the XML never parsed,
     * the catch turned a refusal into `{}`, res.ok was true and editToPrepaid
     * and cancel both answered { ok: true }. That silently disarmed the already
     * correct recovery in flowA, which sets pendingCourierPrepaid, tags
     * wa-courier-still-cod and alerts the owner only when this THROWS: a
     * customer could pay online, have Shopify flipped to prepaid, and still be
     * asked for cash on delivery with nobody told. Delhivery refuses edits on
     * Dispatched, Picked Up, Collected, Delivered, LOST, RTO and DTO packages,
     * which is precisely when a prepaid link gets paid late.
     *
     * Scoped to non-JSON on purpose: /api/p/update and /api/cmu/get_bulk_upl
     * answer JSON, and get_bulk_upl carries status "Failure" as DATA that
     * ndrAction reads per waybill. Throwing on that would lose the reason.
     *
     * No retry is wanted here and none happens: the thrown error carries no
     * retryable status or code, so withRetry treats it as definitive.
     */
    if (json === null) {
      const tag = (name) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1]?.trim();
      const error = tag('error');
      const status = tag('status');
      if (error || /fail/i.test(status || '')) fail(error || `status ${status}`);
      return { ok: true, raw: text };
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
   * A REQUEST ID IS A RECEIPT FOR QUEUEING, NOT FOR A RE-ATTEMPT, so this does
   * not return until the status API has confirmed the waybill. Proven on
   * 2026-10-26 by submitting waybill 00000000000000, fourteen zeros and not a
   * real AWB: production still answered 201 with a request_id. Polling that same
   * id on 2026-10-27 returned status Failure and "Incorrect waybill", so the
   * re-attempt had never happened and the 201 said nothing about it.
   *
   * Timed against production the same day: a fresh request reads "Preload" for
   * about a second and is definitive by ~2s. That is why confirmation is INLINE
   * rather than on a timer; it costs a few seconds in a handler that already
   * does Shopify reads, and it needs no new state and no new schedule.
   */
  async ndrAction(awb, action, opts = {}, { delayMs = 700, attempts = 4 } = {}) {
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

    /*
     * Now find out whether the waybill was actually actioned. "Preload" means
     * Delhivery has not decided yet, so wait and ask again.
     *
     * NOT CONFIRMED IS TREATED AS FAILED, deliberately. Flow C's replies are
     * firm claims ("Done. Our courier partner will try again", "has the new
     * address"), both call sites catch a throw and send the handoff plus an
     * owner alert, and for a delivery the safe direction is to put a human on
     * it. A false negative costs one owner alert and a phone call; a false
     * positive costs a customer their parcel and tells them it is on the way.
     */
    for (let attempt = 1; ; attempt += 1) {
      const st = await courier.ndrStatus(requestId);
      const mine = (list) => list.find((w) => String(w.waybill) === String(awb));
      const bad = mine(st.failed);
      if (bad) {
        metric('CourierNdrRefused', 1);
        throw new Error(
          `delhivery refused ${action} on ${awb}: ${bad.message || st.remark || st.status} (${requestId})`,
        );
      }
      if (mine(st.success)) return { requestId, confirmed: true };
      if (attempt >= attempts) {
        metric('CourierNdrUnconfirmed', 1);
        throw new Error(
          `delhivery ${action} on ${awb} not confirmed after ${attempt} checks (${requestId}, status ${st.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  },

  /*
   * Get NDR status: the only place that says whether an NDR action really
   * happened. Documented path, verified against PRODUCTION on 2026-10-27 (the
   * docs publish it under the staging host only):
   *
   *   GET /api/cmu/get_bulk_upl/<UPL id>?verbose=true
   *   200 { status, remark, request_id, failed_wbns[], success_wbns[] }
   *
   * status is Preload while undecided, then Success, Partial or Failure. One
   * request can carry several waybills, so the per-waybill verdict lives in the
   * two lists and not in `status`: a Partial is a success for one waybill and a
   * refusal for another. Each entry carries Delhivery's own reason, e.g.
   * "Package in incorrect status" or "Incorrect waybill".
   *
   * A read, so no DRY_RUN gate, like track().
   */
  async ndrStatus(requestId) {
    const json = await req(
      'GET',
      `/api/cmu/get_bulk_upl/${encodeURIComponent(requestId)}?verbose=true`,
      undefined,
      { idempotent: true },
    );
    return {
      status: json.status,
      remark: json.remark ?? null,
      requestId: json.request_id || requestId,
      failed: json.failed_wbns || [],
      success: json.success_wbns || [],
    };
  },
};
