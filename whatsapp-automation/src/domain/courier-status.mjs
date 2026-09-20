/*
 * courier-status.mjs — map Delhivery Status/StatusType/NSL to our internal enum.
 * Best-known mapping; refined against real payloads at Phase 7. Friendly customer
 * text lives in messages/labels.mjs (COURIER_STATUS_TEXT).
 */
export const STATES = [
  'MANIFESTED',
  'PICKED_UP',
  'IN_TRANSIT',
  'PENDING',
  'OUT_FOR_DELIVERY',
  'NDR',
  'DELIVERED',
  'RTO_INITIATED',
  'RTO_DELIVERED',
  'LOST',
  'CANCELLED',
  'UNKNOWN',
];

/** @param {{status?:string, statusType?:string, instructions?:string, nsl?:string}} t */
export function mapCourierStatus(t = {}) {
  const s = String(t.status || '').toLowerCase();
  const type = String(t.statusType || '').toUpperCase(); // DL delivered, RT RTO, UD undelivered-umbrella
  // Delhivery StatusType 'UD' covers in-transit, pending, OFD AND NDR, so the
  // Status string (not the type) distinguishes them. Only DL/RT are decisive.
  if (type === 'DL' || (/delivered/.test(s) && type !== 'RT')) return 'DELIVERED';
  if (type === 'RT' || /rto/.test(s)) return /delivered|received/.test(s) ? 'RTO_DELIVERED' : 'RTO_INITIATED';
  if (/manifest/.test(s)) return 'MANIFESTED';
  if (/out for delivery|dispatched/.test(s)) return 'OUT_FOR_DELIVERY';
  if (/undelivered|not delivered|failed|no attempt/.test(s)) return 'NDR';
  if (/picked/.test(s)) return 'PICKED_UP';
  if (/lost/.test(s)) return 'LOST';
  if (/cancel/.test(s)) return 'CANCELLED';
  if (/transit/.test(s)) return 'IN_TRANSIT';
  if (/pending/.test(s)) return 'PENDING';
  return 'UNKNOWN';
}

/** Editable window for COD->prepaid + cancel (before pickup / dispatch). */
export function isCourierEditable(state) {
  return ['MANIFESTED', 'IN_TRANSIT', 'PENDING'].includes(state);
}
export function isBeforePickup(state) {
  return state === 'MANIFESTED';
}
