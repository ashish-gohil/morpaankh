/*
 * ingest/delhivery.mjs — Delhivery status push (enabled by Delhivery on request;
 * until then the poller is source of truth). Shared-secret header + dedupe by
 * AWB + Status + StatusDateTime. Exact payload shape is verified at Phase 7;
 * this reads the documented Status envelope defensively.
 */
import { makeIngest } from './base.mjs';
import { verifySharedSecret } from '../lib/signature.mjs';

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
  toItems(_h, body) {
    return shipmentsOf(body)
      .map((sh) => {
        const awb = sh.AWB || sh.Waybill || sh.waybill;
        const status = sh.Status?.Status || sh.status;
        const at = sh.Status?.StatusDateTime || sh.StatusDateTime || '';
        if (!awb) return null;
        return {
          message: { kind: 'delhivery', awb: String(awb), status, at, shipment: sh },
          groupId: `awb:${awb}`,
          dedupId: `dl-${awb}-${status}-${at}`,
        };
      })
      .filter(Boolean);
  },
};

export const handler = makeIngest(delhiveryIngest);
