/*
 * classify.mjs — decide an order's class once, at first sight, then store it.
 * NEVER reclassify: a COD order becomes PAID after delivery, so a later read
 * would wrongly look PREPAID. Pure function over a normalized order.
 *
 * COD     : paying the courier (isCodOrder) and nothing collected yet
 * PARTIAL : PARTIALLY_PAID or codk_partially_paid == "true"
 * PREPAID : PAID
 * UNKNOWN : an order we cannot read the payment of. Still gets the plain
 *           order confirmation (see onCodTimer): it was never a reason to say
 *           nothing, only a reason not to promise anything about payment.
 */
import { isCodOrder } from './order.mjs';

export function classify(n) {
  const status = String(n.financialStatus || '').toUpperCase();
  const collected = status === 'PAID' || status === 'PARTIALLY_PAID' || n.receivedPaise > 0;

  /*
   * COD no longer requires COD King's `_codkAmountType` or the exact gateway
   * string, only that the courier is collecting and we have collected nothing.
   * The old test (`codkAmountType === 'cod' && codGateway && PENDING`) silently
   * demoted every COD order that did not come through COD King's popup to
   * UNKNOWN, which is how recovery-link order #1239, admin order #1188 and
   * storefront orders #1175 and #1232 were never confirmed.
   */
  if (isCodOrder(n) && !collected) return 'COD';
  if (status === 'PARTIALLY_PAID' || n.codkPartiallyPaid === 'true') return 'PARTIAL';
  if (status === 'PAID') return 'PREPAID';
  return 'UNKNOWN';
}
