/*
 * money.mjs — integer paise everywhere; format for display only at the edge.
 * Never do arithmetic on rupee floats.
 */

/** Shopify money amount ("1499.00") or a number of rupees -> integer paise. */
export function toPaise(amount) {
  if (amount == null || amount === '') return 0;
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount));
  if (!Number.isFinite(n)) throw new Error(`toPaise: not a number: ${amount}`);
  return Math.round(n * 100);
}

/** Whole rupees -> paise. */
export function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

/** Paise -> "₹1,499" (no decimals when whole) / "₹1,149.50" otherwise, en-IN grouping. */
export function formatINR(paise) {
  const whole = paise % 100 === 0;
  const nf = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  return `₹${nf.format(paise / 100)}`;
}
