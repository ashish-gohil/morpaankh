/*
 * clients/courier.mjs — Courier interface, Delhivery Express API (static token).
 *
 * The account uses the classic Express API (Authorization: Token <token>). The
 * tracking endpoint below is verified working (2026-09-21). The edit-to-prepaid
 * (/api/p/edit) and NDR (/api/p/update) endpoints/fields are still best-known and
 * get verified on a staging AWB at Flow C go-live (DECISIONS E4-E6). All writes
 * are DRY_RUN-gated.
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

  // TODO(Phase 7): confirm NDR endpoint + action names + next-day cutoff.
  async ndrAction(awb, action, opts = {}) {
    if (config.dryRun) return { requestId: `dry_${awb}`, skipped: 'dry_run' };
    const json = await req('POST', '/api/p/update', { waybill: awb, act: action, ...opts });
    return { requestId: json.request_id || json.UPL };
  },
};
