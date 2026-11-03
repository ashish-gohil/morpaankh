/*
 * gst.mjs — output GST, per line, in integer paise.
 *
 * Two facts drive everything here.
 *
 * 1. Our prices are GST-INCLUSIVE. So the tax in a Rs 1,099 line at 5% is
 *    1099 * 5/105, not 1099 * 5/100. Backing it out is the only correct
 *    direction; adding it on would invent revenue we never charged.
 * 2. Apparel GST is slab-based and the slab is chosen PER LINE on the
 *    DISCOUNTED UNIT price: 5% up to Rs 2,500 before GST, 18% above. In
 *    shelf-price terms that boundary is 2500 * 1.05 = Rs 2,625.
 *
 * Shopify's own taxLines are never used to compute. They are wrong in two
 * measured ways: Gujarat orders are billed CGST 2.5% + SGST 5% instead of
 * 2.5% + 2.5% (#1172, #1184, #1202), and #1227 (Raat Rani at Rs 2,749 after
 * discount) was taxed 5% when the slab says 18%. They are read only to report
 * the mismatch, which is what shopifyTaxMismatch() is for.
 */

/** @typedef {import('./types.mjs').NormOrder} NormOrder */
/** @typedef {{ratePct:number, upToPaise:number}} GstSlab */

/**
 * The slab rate for one unit price (discounted, incl. GST).
 * Slabs are read in order; the open-ended slab carries upToPaise Infinity.
 * @param {number} unitPaise
 * @param {GstSlab[]} slabs
 */
export function pickSlabRatePct(unitPaise, slabs) {
  const hit = slabs.find((s) => unitPaise <= s.upToPaise);
  // No match can only mean the last slab is not open-ended; its rate is still
  // the right answer for anything above it.
  return hit ? hit.ratePct : slabs[slabs.length - 1].ratePct;
}

/**
 * The GST inside a GST-inclusive amount: inclusive * r / (100 + r).
 *
 * One Math.round on the whole amount, so the result is deterministic and the
 * same inputs always produce the same paise. Never round per unit and multiply:
 * 3 x round(1099 * 5/105) and round(3297 * 5/105) differ by a paisa, and the
 * workbook's totals have to tie out to the row values exactly.
 * @param {number} inclusivePaise
 * @param {number} ratePct
 */
export function backOutGst(inclusivePaise, ratePct) {
  if (!inclusivePaise || !ratePct) return 0;
  return Math.round((inclusivePaise * ratePct) / (100 + ratePct));
}

/**
 * Output GST on one line, and the slab it fell in.
 * @param {number} discountedUnitPaise after all discounts, incl. GST
 * @param {number} qty current quantity (an edited-away line is 0 and pays none)
 * @param {GstSlab[]} slabs
 * @returns {{ratePct:number, gstPaise:number, linePaise:number}}
 */
export function lineGstPaise(discountedUnitPaise, qty, slabs) {
  const ratePct = pickSlabRatePct(discountedUnitPaise, slabs);
  const linePaise = discountedUnitPaise * Math.max(0, qty);
  return { ratePct, gstPaise: backOutGst(linePaise, ratePct), linePaise };
}

/**
 * Is this unit price within `flagPaise` of a slab boundary? A Rs 100 discount
 * change then moves it across and swings the tax on it by 13 points, so the
 * owner is told rather than finding out from a notice.
 * @param {number} unitPaise
 * @param {GstSlab[]} slabs
 * @param {number} flagPaise
 */
export function nearSlabBoundary(unitPaise, slabs, flagPaise) {
  return slabs.some((s) => Number.isFinite(s.upToPaise) && Math.abs(unitPaise - s.upToPaise) <= flagPaise);
}

/**
 * What Shopify's taxLines disagree with us about, for the Data Checks sheet.
 *
 * `computedLineGstPaise` must be the LINE GST only, with no GST on the COD
 * fee: Shopify demonstrably excludes the fee from tax (#1170 is a Rs 1,099
 * line plus a Rs 50 fee and its IGST is 52.33, the line alone), so comparing
 * our fee-inclusive figure would flag all 53 COD orders and bury the three
 * real bugs.
 *
 * @param {NormOrder} order
 * @param {number} computedLineGstPaise
 * @param {number} computedTopRatePct the highest slab rate across its live lines
 * @returns {string[]} human-readable notes, empty when Shopify agrees
 */
export function shopifyTaxMismatch(order, computedLineGstPaise, computedTopRatePct) {
  const lines = order.shopifyTaxLines || [];
  if (!lines.length) return [];
  const notes = [];

  const shopifyPaise = lines.reduce((a, l) => a + l.pricePaise, 0);
  if (shopifyPaise !== computedLineGstPaise) {
    notes.push(
      `Shopify GST ${(shopifyPaise / 100).toFixed(2)} vs slab ${(computedLineGstPaise / 100).toFixed(2)}`,
    );
  }

  // The Gujarat split bug: CGST and SGST must be equal halves of one rate.
  const cgst = lines.find((l) => /cgst/i.test(l.title));
  const sgst = lines.find((l) => /sgst/i.test(l.title));
  if (cgst && sgst && cgst.ratePct !== sgst.ratePct) {
    notes.push(`CGST ${cgst.ratePct}% vs SGST ${sgst.ratePct}%: split is wrong, not a half each`);
  }

  const shopifyTop = Math.max(...lines.map((l) => l.ratePct));
  if (shopifyTop !== computedTopRatePct) {
    notes.push(`Shopify charged ${shopifyTop}% where the slab says ${computedTopRatePct}%`);
  }

  return notes;
}
