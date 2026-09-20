/*
 * classify.mjs — decide an order's class once, at first sight, then store it.
 * NEVER reclassify: a COD order becomes PAID after delivery, so a later read
 * would wrongly look PREPAID. Pure function over a normalized order.
 *
 * COD     : _codkAmountType == "cod" AND a Cash on Delivery gateway AND PENDING AND received 0
 * PARTIAL : PARTIALLY_PAID or codk_partially_paid == "true"
 * PREPAID : PAID
 * UNKNOWN : anything else (no Flow A; alert once)
 */
export function classify(n) {
  const status = String(n.financialStatus || '').toUpperCase();
  const codGateway = (n.gateways || []).some((g) => /cash on delivery/i.test(g));

  if (n.codkAmountType === 'cod' && codGateway && status === 'PENDING' && n.receivedPaise === 0) return 'COD';
  if (status === 'PARTIALLY_PAID' || n.codkPartiallyPaid === 'true') return 'PARTIAL';
  if (status === 'PAID') return 'PREPAID';
  return 'UNKNOWN';
}
