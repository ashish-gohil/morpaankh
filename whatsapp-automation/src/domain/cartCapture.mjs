/*
 * cartCapture.mjs — turn a cart the STOREFRONT captured into the exact shape
 * an AbandonedCheckout arrives in, so every downstream step of Flow R runs on
 * it unchanged.
 *
 * WHY THIS FILE EXISTS. Shopify only files an AbandonedCheckout once the
 * shopper reaches its own contact step, and on this store the OTP happens
 * BEFORE that, in COD King's popup. Measured 17 to 19 Oct: five people passed
 * OTP and left, and Shopify recorded none of them. The checkout list is the
 * narrower source, so it became the fallback rather than the only one.
 *
 * TWO RULES HOLD THIS TOGETHER.
 *
 * 1. NOTHING ABOUT MONEY COMES FROM THE BROWSER. The payload carries variant
 *    ids and quantities and nothing else of consequence; every price, title,
 *    option and image is read back from Shopify. The offer is a percentage OF
 *    THE BAG, so a client that could name its own prices could name its own
 *    discount. The capture endpoint is public and unsigned, so this is not a
 *    theoretical worry.
 *
 * 2. THE OUTPUT IS AN AbandonedCheckout NODE, not a new shape. normalizeCheckout,
 *    cartEligible, computeCartOffer, itemLine and heroImageUrl are shared with
 *    the Shopify path and must not learn that captured carts exist.
 */
/*
 * The id scheme lives HERE, not in the store, so this module stays pure and
 * jsconfig's checkJs boundary holds: `include` is lib + domain, and a domain
 * file that reached into src/store would drag DynamoDB's untyped surface into
 * the checked program with it.
 *
 * Lower case and no slash, so `String(id).split('/').pop()` in
 * normalizeCheckout returns it intact rather than a fragment.
 */
export const CAPTURE_PREFIX = 'cap_';

/** `cap_<token>` from a raw Shopify cart token, and back. */
export const captureIdFor = (token) => `${CAPTURE_PREFIX}${token}`;
export const tokenFromCaptureId = (id) => String(id || '').slice(CAPTURE_PREFIX.length);

/** True for an id this module minted, as opposed to a Shopify checkout id. */
export const isCapturedId = (id) => String(id || '').startsWith(CAPTURE_PREFIX);

/**
 * A captured row plus the variants Shopify returned for it, as a checkout.
 *
 * Returns null when nothing in the bag still resolves, which is the honest
 * answer for a cart whose products were deleted: cartEligible would say
 * `no-items` anyway, and a null here keeps that decision in one place.
 *
 * @param {{id: string, phone: string, items: {id: string, qty: number}[],
 *          attrs?: Record<string,string>, capturedAt: string,
 *          completedAt?: string|null}} row
 * @param {any[]} variants ProductVariant nodes from getVariantsByIds
 */
export function capturedToCheckout(row, variants) {
  if (!row) return null;
  const byGid = new Map((variants || []).filter((v) => v?.id).map((v) => [String(v.id), v]));

  const nodes = [];
  for (const line of row.items || []) {
    const v = byGid.get(String(line.id));
    // A variant Shopify no longer returns is dropped, not guessed at.
    if (!v) continue;
    const qty = Math.max(1, Math.min(50, Number(line.qty) || 1));
    const image = v.image || v.product?.featuredImage || null;
    nodes.push({
      // The PRODUCT title, matching what a checkout line carries; the size and
      // colour travel in selectedOptions, which is where itemLine reads them.
      title: v.product?.title || v.title || 'Item',
      quantity: qty,
      // Shopify's price, never the browser's.
      originalUnitPriceSet: { shopMoney: { amount: String(v.price ?? '0') } },
      image: image ? { url: image.url, width: image.width, height: image.height } : null,
      variant: {
        id: v.id,
        availableForSale: v.availableForSale !== false,
        selectedOptions: v.selectedOptions || [],
      },
    });
  }
  if (!nodes.length) return null;

  /*
   * customAttributes is rebuilt from the row rather than passed through, so
   * the verified phone the sweep will act on is the one the ENDPOINT validated
   * and stored, not whatever the browser last put in the cart. Any other COD
   * King attribute rides along untouched, because isPartialAdvance reads
   * _codkAmountType and _codkAmountValue off it.
   */
  const attrs = { ...(row.attrs || {}), _otpVerifiedPhoneNumber: row.phone };
  return {
    id: row.id,
    name: row.id,
    createdAt: row.capturedAt,
    completedAt: row.completedAt || null,
    /*
     * No abandonedCheckoutUrl exists for a cart that never became a checkout.
     * Null rather than a guess: buildTarget reads rec.cartItems and builds a
     * /cart permalink for exactly this case, and a fabricated URL here would
     * send somebody to a checkout that is not theirs.
     */
    abandonedCheckoutUrl: null,
    totalPriceSet: { shopMoney: { amount: '0' } },
    // A cart carries no applied discount we can read, so the offer floor rests
    // on the live public codes alone. Understating it is safe: computeCartOffer
    // takes the MAX of this and the best public code.
    totalDiscountSet: { shopMoney: { amount: '0' } },
    customAttributes: Object.entries(attrs).map(([key, value]) => ({ key, value: String(value) })),
    customer: null,
    shippingAddress: null,
    billingAddress: null,
    lineItems: { nodes },
  };
}

/** The variant gids to ask Shopify about for this row. */
export const variantGidsOf = (row) =>
  Array.from(new Set((row?.items || []).map((i) => String(i.id)).filter(Boolean)));
