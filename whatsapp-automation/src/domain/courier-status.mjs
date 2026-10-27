/*
 * courier-status.mjs — map Delhivery Status/StatusType/StatusCode to our enum.
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

/** @param {{status?:string, statusType?:string, instructions?:string, statusCode?:string}} t */
export function mapCourierStatus(t = {}) {
  const s = String(t.status || '').toLowerCase();
  const type = String(t.statusType || '').toUpperCase(); // DL delivered, RT RTO, UD undelivered-umbrella
  const code = String(t.statusCode || '').toUpperCase(); // EOD-* end-of-day disposition, X-* movement

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
  /*
   * A failed delivery attempt, read off the END-OF-DAY disposition code.
   *
   * Delhivery never sends any of the strings the line above tests for. A real
   * failed attempt arrives as Status 'Pending' with StatusType 'UD' and the
   * outcome in StatusCode, so every one of them fell through to the /pending/
   * branch at the bottom and was stored as PENDING. NDR was unreachable from
   * the courier for the whole life of the service: 0 NDR in every daily digest
   * while orders #1165 and #1170 went out for delivery, failed, and RTO'd
   * without the customer ever being asked a thing.
   *
   * EOD- is the discriminator, and 'UD' alone is NOT (mapping the umbrella
   * would call every in-transit scan a failed delivery and message the lot).
   * From order #1165's own 23 scans on 2026-10-16:
   *   X-DDD3FD  UD  Out for delivery          movement
   *   EOD-6O    UD  Code verified cancellation THE FAILED ATTEMPT
   *   RT-108    RT  No client instructions...  return leg
   *   EOD-148   RT  Recipient unavailable      return leg, NOT the customer's
   *   RD-AC     DL  RETURN Accepted            terminal
   * So: end-of-day + still undelivered = the delivery day ended without it
   * being handed over. The RT leg is already claimed by the line above, which
   * is what keeps EOD-148 (our own warehouse being shut) from being read as
   * the customer refusing a parcel.
   *
   * EOD-38 is the delivered disposition and arrives as 'DL', so the type test
   * excludes it already; it is named here so a contradictory UD/EOD-38 payload
   * can never ask someone to rescue a parcel they have in their hands.
   */
  if (type === 'UD' && /^EOD-/.test(code) && code !== 'EOD-38') return 'NDR';
  if (type === 'DL' || /delivered/.test(s)) return 'DELIVERED';
  if (/manifest/.test(s)) return 'MANIFESTED';
  if (/out for delivery|dispatched/.test(s)) return 'OUT_FOR_DELIVERY';
  /*
   * "NOT PICKED" CONTAINS "PICKED", so the test below matched a shipment the
   * courier never collected and called it collected. Third generation of the
   * substring trap documented twice above, and the negative has to be read
   * before the positive for the same reason.
   *
   * Order #1217 (AWB 59152210001713), read from production on 2026-10-27:
   * Status 'Not Picked', UD, DTUP-210, "Seller cancelled the order", after an
   * X-PNP "Shipment not received from client". The customer had asked to cancel,
   * Delhivery honoured it, and our stored state still said PICKED_UP five days
   * later.
   *
   * MANIFESTED rather than UNKNOWN because it is the truth: the parcel is still
   * in our hands, which keeps isCourierEditable and isBeforePickup true, so a
   * COD-to-prepaid flip and a cancellation both stay open on a waybill where
   * both really are. PICKED_UP closed them and sent the owner an alert about a
   * waybill that was perfectly editable.
   */
  if (/not picked|not received/.test(s)) {
    return /cancel/.test(s) || /cancel/.test(String(t.instructions || '').toLowerCase())
      ? 'CANCELLED'
      : 'MANIFESTED';
  }
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
