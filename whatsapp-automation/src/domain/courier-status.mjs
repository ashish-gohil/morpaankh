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

  // THE ORDER OF THE NEXT THREE LINES IS THE WHOLE POINT. Both of the earlier
  // orderings reported a parcel the customer never received as DELIVERED, and
  // onDelhivery routes DELIVERED straight into flowB.onDelivered, so each one
  // was a request to review a garment that never arrived.
  //
  // 1. RTO before delivered. A return that reaches the seller is reported as a
  //    delivery: StatusType 'DL' with an RTO Status string. Proven in
  //    production on orders #1097, #1103 and #1133, whose stored courierStatus
  //    went RTO_INITIATED and was then overwritten to DELIVERED, which is only
  //    reachable through the delivered branch.
  //
  // 2. NDR before delivered. 'undelivered' and 'not delivered' both CONTAIN
  //    the substring 'delivered', so a bare /delivered/ test matches a FAILED
  //    delivery. That made the NDR branch below unreachable for the exact two
  //    strings it was written for: flowC.onNdr could never fire from the
  //    courier path, which is why Flow C had never messaged a customer, and 53
  //    stored states held zero NDR while three orders went to RTO.
  //
  // A contradictory payload (type 'DL' with an undelivered status) is read as
  // NDR on purpose. The status string is the specific signal and UD/DL is an
  // umbrella, and erring toward NDR opens a helpful conversation whereas
  // erring toward DELIVERED asks for a review of a missing parcel.
  if (type === 'RT' || /rto/.test(s)) return /delivered|received/.test(s) ? 'RTO_DELIVERED' : 'RTO_INITIATED';
  if (/undelivered|not delivered|failed|no attempt/.test(s)) return 'NDR';
  if (type === 'DL' || /delivered/.test(s)) return 'DELIVERED';
  if (/manifest/.test(s)) return 'MANIFESTED';
  if (/out for delivery|dispatched/.test(s)) return 'OUT_FOR_DELIVERY';
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
