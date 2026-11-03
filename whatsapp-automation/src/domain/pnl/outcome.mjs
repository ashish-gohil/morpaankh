/*
 * outcome.mjs — what actually happened to an order.
 *
 * DELHIVERY IS THE TRUTH. Shopify is a fallback and only when Delhivery has no
 * record of the parcel at all. The reason is measured, not stylistic: Shopify
 * shows fulfilment displayStatus DELIVERED with a deliveredAt on #1170, #1183
 * and #1203, all three of which Delhivery returned to us. Reading Shopify
 * first books three RTOs as sales.
 *
 * A PAID financial status proves nothing either. It flips when the courier
 * remits COD cash, which is after delivery, but it also flips on a draft order
 * marked paid at creation and shipped days later (#1233, fulfilled 3 Nov).
 */
import { hasRtoTag } from '../order.mjs';

/** @typedef {import('./types.mjs').NormOrder} NormOrder */
/** @typedef {import('./types.mjs').NormShipment} NormShipment */
/** @typedef {import('./types.mjs').Outcome} Outcome */

const isRtoShipment = (s) =>
  s.state === 'RTO_INITIATED' || s.state === 'RTO_DELIVERED' || Boolean(s.rtoStartedAt) || s.statusType === 'RT';

/**
 * THE TRAP, and the reason this helper exists rather than reading the field.
 *
 * On an RTO parcel Delhivery's deliveredAt is the RETURN-accepted time, not the
 * customer delivery: #1170's is 2026-10-13T16:46:36, identical to its "RETURN
 * Accepted" scan. So deliveredAt is only a customer delivery when the shipment
 * is not an RTO, and nothing in this feature may read it without that branch.
 * @param {NormShipment} s
 */
export function customerDeliveredAt(s) {
  if (isRtoShipment(s)) return null;
  return s.state === 'DELIVERED' ? s.deliveredAt : null;
}

/**
 * @param {NormOrder} order
 * @param {NormShipment[]} shipmentsForOrder the shipments its AWBs point at
 * @returns {{outcome:Outcome, reason:string, inferred:boolean}}
 */
export function deriveOutcome(order, shipmentsForOrder) {
  const ships = shipmentsForOrder || [];

  if (ships.length) {
    /*
     * RTO first, and before DELIVERED. A return that reaches us is reported as
     * a delivery (StatusType 'DL' with Status 'RTO'), and the same ordering bug
     * has already shipped review requests for parcels nobody received. Both
     * legs are charged whether or not the garment is back on the shelf yet, so
     * an RTO still in reverse transit is just as settled for the P&L.
     */
    const rto = ships.filter(isRtoShipment);
    if (rto.length) {
      const back = rto.some((s) => s.returnedAt);
      return {
        outcome: 'RTO',
        reason: back ? 'Delhivery RTO, returned to origin' : 'Delhivery RTO in progress',
        inferred: false,
      };
    }
    if (ships.every((s) => s.state === 'DELIVERED')) {
      return { outcome: 'DELIVERED', reason: 'Delhivery delivered', inferred: false };
    }
    if (ships.some((s) => s.state === 'LOST')) {
      return { outcome: 'LOST', reason: 'Delhivery lost or damaged: claim pending', inferred: false };
    }
    if (order.cancelledAt) {
      return {
        outcome: 'CANCELLED',
        reason: `cancelled in Shopify, Delhivery ${ships.map((s) => s.rawStatus).join('/')}`,
        inferred: false,
      };
    }
    return { outcome: 'PENDING', reason: `Delhivery ${ships.map((s) => s.rawStatus).join('/')}`, inferred: false };
  }

  // ---- No Delhivery record. Shopify only from here, and every guess says so.
  if (order.cancelledAt) {
    return { outcome: 'CANCELLED', reason: 'cancelled in Shopify, no Delhivery record', inferred: false };
  }

  if (hasRtoTag(order.tags)) {
    // hasRtoTag, not a substring test: COD King tags every order "LOW/MEDIUM/
    // HIGH RTO Risk", so /RTO/ matches every order ever placed.
    return { outcome: 'RTO', reason: 'tag RTO, no Delhivery record', inferred: true };
  }

  const ful = order.fulfillments[0] || null;
  if (ful && (order.paymentType === 'cod' || order.paymentType === 'partial')) {
    /*
     * COD cash recorded AFTER the fulfilment means the courier collected it,
     * and a courier only collects on the doorstep. #1205 is the one October
     * order this rescues: its successful COD transaction is 11 seconds after
     * its fulfilment, and it has no AWB in Shopify at all.
     *
     * "After the fulfilment" is the whole test. A COD transaction dated at
     * order creation is the pending authorisation, not cash.
     */
    const cash = order.transactions.find(
      (t) => t.kind === 'SALE' && t.status === 'SUCCESS' && /cash on delivery|\bcod\b/i.test(t.gateway),
    );
    if (cash && Date.parse(cash.createdAt) > Date.parse(ful.createdAt)) {
      return { outcome: 'DELIVERED', reason: 'COD cash collected after fulfilment', inferred: true };
    }
  }
  if (ful && order.paymentType === 'prepaid' && ful.displayStatus === 'DELIVERED') {
    return { outcome: 'DELIVERED', reason: 'prepaid, Shopify fulfilment DELIVERED', inferred: true };
  }

  /*
   * PENDING is NOT inferred. The other fallbacks assert that something
   * happened; this one asserts that nothing did, which is also what we would
   * say if we knew everything. Marking it inferred would put #1233 and #1238
   * on the inferred list beside #1205 and make "one inferred outcome in
   * October" read as three.
   */
  return {
    outcome: 'PENDING',
    reason: ful ? 'fulfilled, no Delhivery record' : 'not shipped',
    inferred: false,
  };
}

/**
 * Where Shopify and Delhivery disagree, for the Data Checks sheet. Delhivery
 * has already won by the time this is called; this only reports the fight.
 * @param {NormOrder} order
 * @param {NormShipment[]} shipmentsForOrder
 * @param {Outcome} outcome
 * @returns {string|null}
 */
export function shopifyConflict(order, shipmentsForOrder, outcome) {
  if (!(shipmentsForOrder || []).length) return null;
  const shopifySaysDelivered = order.fulfillments.some((f) => f.displayStatus === 'DELIVERED' || f.deliveredAt);
  if (shopifySaysDelivered && outcome !== 'DELIVERED') {
    const states = shipmentsForOrder.map((s) => s.rawStatus).join('/');
    return `Shopify fulfilment says DELIVERED, Delhivery says ${states} (${outcome})`;
  }
  return null;
}
