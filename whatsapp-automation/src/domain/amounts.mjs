/*
 * amounts.mjs — Flow A money, in integer paise. Pure.
 *
 * newTotal = currentTotal - prepaidDiscount - (removeCodFee ? codFee : 0)
 * saving   = prepaidDiscount + (removeCodFee ? codFee : 0)
 *
 * feeMatches guards the offer: when COD King recorded a fee, the Cash on
 * Delivery shipping line must equal its `_codkAmountValue`; if not, make no
 * offer and alert (spec section 7).
 *
 * WHEN COD KING RECORDED NOTHING THERE IS NOTHING TO DISAGREE WITH.
 *
 * This used to answer false for a missing value, which reads "the fee does not
 * match" when the truth is "nobody claimed a second figure". It hit every COD
 * order that did not come through COD King's popup: a recovery-link order, an
 * order placed in the admin, a plain storefront checkout. #1232 and #1239 are
 * live examples. Those customers got cod_confirm with no prices and a "Pay
 * online" button that answered "it stays on cash on delivery", and the owner
 * got an alert about a mismatch on every tap.
 *
 * So the COD shipping line IS the fee in that case, which is what Shopify is
 * charging them either way, and feeSource records which of the two answers was
 * used so an owner asking "where did this number come from" has one.
 */
import { toPaise } from '../lib/money.mjs';

/**
 * The saving tier this order qualifies for. Tiers are read top down, so they
 * must be ordered highest threshold first; the last one should have a zero
 * threshold so there is always a match.
 */
export function pickTier(orderValuePaise, rules) {
  const tiers = rules.prepaidTiers || [];
  return tiers.find((t) => orderValuePaise >= t.minOrderInr * 100) || { savingInr: 0, gift: false };
}

export function computeAmounts(n, rules) {
  const removeCod = rules.removeCodFee;
  const codFeePaise = n.codFeePaise || 0;
  const codkValuePaise = n.codkAmountValue != null ? toPaise(n.codkAmountValue) : null;
  const feeSource = codkValuePaise == null ? 'shipping-line' : 'codk';
  const feeMatches = codkValuePaise == null ? true : codkValuePaise === codFeePaise;

  // Order value for tiering: the merchandise total, with the COD fee taken out.
  const orderValuePaise = Math.max(0, n.currentTotalPaise - codFeePaise);
  const tier = pickTier(orderValuePaise, rules);

  // The COD fee we stop charging counts toward the promised saving, so the
  // customer saves exactly the tier amount and not that plus the fee.
  const targetSavingPaise = tier.savingInr * 100;
  const creditedFeePaise = removeCod ? codFeePaise : 0;
  const discountPaise = Math.max(0, targetSavingPaise - creditedFeePaise);
  const savingPaise = discountPaise + creditedFeePaise;
  const newTotalPaise = n.currentTotalPaise - savingPaise;

  return {
    codFeePaise,
    codkValuePaise,
    feeSource,
    feeMatches,
    discountPaise,
    newTotalPaise,
    savingPaise,
    orderValuePaise,
    savingInr: tier.savingInr,
    gift: Boolean(tier.gift),
    currentTotalPaise: n.currentTotalPaise,
  };
}
