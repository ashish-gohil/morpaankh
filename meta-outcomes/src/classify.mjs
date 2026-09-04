/*
 * classify.mjs — the outcome state machine.
 *
 * Every order is reduced to exactly ONE of five states:
 *
 *   PLACED             order created, not yet actioned
 *   CANCELLED_ON_CALL  cancelled before dispatch (COD confirmation call)
 *   IN_TRANSIT         dispatched, outcome still open
 *   RTO                shipped and coming back / returned to origin
 *   DELIVERED_PAID     delivered AND money actually collected (net > 0)
 *
 * This module is pure and dependency free so it can be unit tested without a
 * network, a Shopify token, or a Meta token. The webhook server normalises a
 * live Shopify order into the small shape `classifyOrder` expects, then calls
 * this.
 *
 * The one rule that matters most for money: RTO is checked BEFORE
 * DELIVERED_PAID. A parcel a courier marked returned is not revenue, even if
 * Shopify still shows a stray DELIVERED scan on the fulfillment. That is the
 * real case in the merchant's data and it must never be counted as paid.
 */

export const STATES = Object.freeze({
  PLACED: 'PLACED',
  CANCELLED_ON_CALL: 'CANCELLED_ON_CALL',
  IN_TRANSIT: 'IN_TRANSIT',
  RTO: 'RTO',
  DELIVERED_PAID: 'DELIVERED_PAID',
});

/*
 * Shopify FulfillmentDisplayStatus values that mean "it left the warehouse and
 * the outcome is not yet decided". DELIVERED and ATTEMPTED_DELIVERY are handled
 * separately because they decide the outcome. Anything here maps to IN_TRANSIT
 * unless a stronger signal (return note, delivered + paid) overrides it.
 */
const SHIPPED_STATUSES = new Set([
  'SUBMITTED',
  'CONFIRMED',
  'IN_PROGRESS',
  'FULFILLED',
  'MARKED_AS_FULFILLED',
  'LABEL_PRINTED',
  'LABEL_PURCHASED',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'PARTIALLY_DELIVERED',
  'NOT_DELIVERED',
  'FAILURE',
]);

/*
 * IMPORTANT policy (per the merchant): a courier "return"/"returned" note is NOT
 * a lost sale. For this store those are almost always customer-requested
 * REPLACEMENTS, and since change-of-mind returns are not accepted, the buyer has
 * kept and paid for the item. So the free-text note is NOT used to decide the
 * outcome. Only two things matter: a genuine failed delivery (fulfillment
 * displayStatus ATTEMPTED_DELIVERY) is a real loss (RTO), and money actually
 * collected (net > 0 on a DELIVERED order) is what counts as paid.
 */

function normaliseTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  // REST webhooks deliver tags as a single comma separated string.
  if (typeof tags === 'string') {
    return tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Classify one normalised order into exactly one state.
 *
 * @param {object} order
 * @param {string|number} order.id            numeric Shopify order id
 * @param {string|null}   [order.cancelledAt] ISO timestamp or null
 * @param {string[]|string} [order.tags]      order tags (array or CSV string)
 * @param {string|null}   [order.note]        free text courier status note
 * @param {number}        [order.netPayment]  money actually received, shop currency
 * @param {string}        [order.currency]    ISO currency, defaults INR
 * @param {Array<{displayStatus:string}>} [order.fulfillments]
 * @param {object} [opts]                      reserved; the courier note is not used
 * @returns {{state:string, orderId:string, eventId:string, value:number, currency:string}}
 */
export function classifyOrder(order, opts = {}) {
  const tags = normaliseTags(order.tags);
  const netPayment = Number.isFinite(Number(order.netPayment)) ? Number(order.netPayment) : 0;
  const currency = order.currency || 'INR';

  const statuses = (Array.isArray(order.fulfillments) ? order.fulfillments : [])
    .map((f) => (f && f.displayStatus ? String(f.displayStatus).toUpperCase() : ''))
    .filter(Boolean);

  const attempted = statuses.includes('ATTEMPTED_DELIVERY');
  const delivered = statuses.includes('DELIVERED');
  const shipped = statuses.some((s) => SHIPPED_STATUSES.has(s));

  // Genuine return-to-origin, marked either manually by the merchant (exact tag
  // "RTO", applied at day-end) or automatically by Shiprocket ("RTO Initiated
  // via Shiprocket"). MUST match precisely: the risk-score tags "HIGH/MEDIUM/LOW
  // RTO Risk" contain "RTO" but are NOT actual RTOs and must never trigger it.
  const rtoTagged = tags.some((t) => {
    const s = t.trim().toLowerCase();
    return s === 'rto' || s.includes('rto initiated');
  });

  const cancelled =
    Boolean(order.cancelledAt) ||
    tags.some((t) => t.toLowerCase() === 'cod-cancelled');

  const out = (state) => ({
    state,
    orderId: String(order.id),
    eventId: String(order.id), // same convention as the browser + server Purchase
    value: netPayment,
    currency,
  });

  // 1) Genuine return-to-origin = a real loss (RTO): a courier failed-delivery
  //    status, or an explicit RTO tag (merchant "RTO", or Shiprocket's). The
  //    free-text "return" NOTE is deliberately NOT used (see policy note above):
  //    those are paid customer replacements, not losses.
  if (attempted || rtoTagged) return out(STATES.RTO);

  // 2) Delivered AND money actually collected. A replacement/return note does
  //    not demote this: if the cash was collected, it counts as paid.
  if (delivered && netPayment > 0) return out(STATES.DELIVERED_PAID);

  // 3) Cancelled on the confirmation call (never shipped, or app-tagged).
  if (cancelled) return out(STATES.CANCELLED_ON_CALL);

  // 4) Dispatched, outcome still open. This also holds a delivered scan whose
  //    COD payment has not reconciled yet (net == 0); a later orders/updated
  //    with net > 0 flips it to DELIVERED_PAID.
  if (shipped || delivered) return out(STATES.IN_TRANSIT);

  // 5) Placed, nothing has happened yet.
  return out(STATES.PLACED);
}

/*
 * Map a Shopify Admin GraphQL order onto the small shape classifyOrder wants.
 * The webhook is only a trigger; the server re-reads the order over GraphQL so
 * displayStatus and netPaymentSet are canonical (webhook bodies lag and use a
 * different shape). netPayment is the real collected amount and becomes the
 * DeliveredPurchase value.
 */
export function normaliseFromGraphql(order) {
  const gidTail = (gid) => String(gid || '').split('/').pop();
  const amount = order?.netPaymentSet?.shopMoney?.amount;
  return {
    id: gidTail(order.id),
    cancelledAt: order.cancelledAt || null,
    tags: Array.isArray(order.tags) ? order.tags : [],
    note: order.note || '',
    netPayment: amount != null ? Number(amount) : 0,
    currency: order?.netPaymentSet?.shopMoney?.currencyCode || order.currencyCode || 'INR',
    fulfillments: (order.fulfillments || []).map((f) => ({ displayStatus: f.displayStatus })),
  };
}

/*
 * Pull the contact fields Meta matches on out of a GraphQL order. Returns RAW
 * PII (the hashing layer turns it into hashes); never log this object.
 */
export function extractContact(order) {
  const gidTail = (gid) => String(gid || '').split('/').pop();
  const addr = order.shippingAddress || {};
  return {
    email: order.email || null,
    phone: order.phone || addr.phone || null,
    externalId: gidTail(order.customer?.id) || gidTail(order.id),
    firstName: order.customer?.firstName || null,
    lastName: order.customer?.lastName || null,
    city: addr.city || null,
    state: addr.province || null,
    zip: addr.zip || null,
    country: addr.countryCodeV2 || null,
  };
}
