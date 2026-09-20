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
  const discountPaise = rules.prepaidDiscountInr * 100;
  const removeCod = rules.removeCodFee;
  const codFeePaise = n.codFeePaise || 0;
  const codkValuePaise = n.codkAmountValue != null ? toPaise(n.codkAmountValue) : null;
  const feeMatches = codkValuePaise == null ? false : codkValuePaise === codFeePaise;

  const newTotalPaise = n.currentTotalPaise - discountPaise - (removeCod ? codFeePaise : 0);
  const savingPaise = discountPaise + (removeCod ? codFeePaise : 0);

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
