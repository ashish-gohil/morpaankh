/*
 * amounts.mjs — Flow A money, in integer paise. Pure.
 *
 * newTotal = currentTotal - prepaidDiscount - (removeCodFee ? codFee : 0)
 * saving   = prepaidDiscount + (removeCodFee ? codFee : 0)
 *
 * feeMatches guards the offer: the Cash on Delivery shipping line must equal the
 * COD King `_codkAmountValue`; if not, make no offer and alert (spec section 7).
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
  const feeMatches = codkValuePaise == null ? false : codkValuePaise === codFeePaise;

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
