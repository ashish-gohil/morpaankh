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

export function computeAmounts(n, rules) {
  const removeCod = rules.removeCodFee;
  const codFeePaise = n.codFeePaise || 0;
  const codkValuePaise = n.codkAmountValue != null ? toPaise(n.codkAmountValue) : null;
  const feeMatches = codkValuePaise == null ? false : codkValuePaise === codFeePaise;

  // The COD fee we stop charging counts toward the promised saving, so the
  // customer saves exactly prepaidTotalSavingInr and not that plus the fee.
  const targetSavingPaise = rules.prepaidTotalSavingInr * 100;
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
    currentTotalPaise: n.currentTotalPaise,
  };
}
