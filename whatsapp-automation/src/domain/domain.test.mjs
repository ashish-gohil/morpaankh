import { describe, it, expect } from 'vitest';
import { itemLine, heroImageUrl, normalizeOrder, hasTag, riskTag, hasRtoTag } from './order.mjs';
import { classify } from './classify.mjs';
import { computeAmounts } from './amounts.mjs';
import { flowAEligible, excludeFromAll } from './eligibility.mjs';
import { RULES } from '../../messages/rules.mjs';

// A COD order as shopify.getOrder returns it.
function codOrder(overrides = {}) {
  return {
    id: 'gid://shopify/Order/12345',
    name: '#1234',
    tags: ['✅ COD-Verified', 'LOW RTO Risk'],
    test: false,
    createdAt: '2026-09-20T06:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    netPaymentSet: { shopMoney: { amount: '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: [
      { key: '_otpVerifiedPhoneNumber', value: '919812345678' },
      { key: '_codkAmountType', value: 'cod' },
      { key: '_codkAmountValue', value: '50.0' },
    ],
    customer: { firstName: 'Aarav' },
    shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '50.00' } } }] },
    fulfillments: [],
    lineItems: { nodes: [{ id: 'li1', title: 'Bandhan', quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '1449.00' } } }] },
    ...overrides,
  };
}

describe('normalizeOrder', () => {
  it('extracts the fields the flows need', () => {
    const n = normalizeOrder(codOrder());
    expect(n.verifiedPhone).toBe('+919812345678');
    expect(n.codFeePaise).toBe(5000);
    expect(n.currentTotalPaise).toBe(149900);
    expect(n.riskTag).toBe('LOW');
    expect(n.firstName).toBe('Aarav');
    expect(n.numericId).toBe('12345');
  });
  it('tag helpers ignore emoji + case', () => {
    expect(hasTag(['✅ COD-Verified'], 'cod-verified')).toBe(true);
    expect(riskTag(['❌ COD-Cancelled', 'HIGH RTO Risk'])).toBe('HIGH');
  });
});

describe('classify', () => {
  it('COD', () => expect(classify(normalizeOrder(codOrder()))).toBe('COD'));
  it('PREPAID when PAID', () => {
    const n = normalizeOrder(codOrder({ displayFinancialStatus: 'PAID', paymentGatewayNames: ['Cashfree'], netPaymentSet: { shopMoney: { amount: '1499.00' } } }));
    expect(classify(n)).toBe('PREPAID');
  });
  it('PARTIAL when partially paid', () => {
    const n = normalizeOrder(codOrder({ displayFinancialStatus: 'PARTIALLY_PAID' }));
    expect(classify(n)).toBe('PARTIAL');
  });
  it('UNKNOWN only when nothing says how they are paying', () => {
    // No COD gateway, no Cash on Delivery shipping line, no COD King attribute,
    // and nothing collected. This is the shape of an order created by an app or
    // by the API before a payment is chosen.
    const n = normalizeOrder(codOrder({
      displayFinancialStatus: 'AUTHORIZED',
      paymentGatewayNames: [],
      customAttributes: [],
      shippingLines: { nodes: [{ title: 'Standard', originalPriceSet: { shopMoney: { amount: '0.00' } } }] },
    }));
    expect(classify(n)).toBe('UNKNOWN');
  });

  /*
   * The four shapes that used to fall through to UNKNOWN and get no message at
   * all. Each one is a real order from the last 30 days.
   */
  it('COD without COD King: a recovery link order (#1239)', () => {
    const n = normalizeOrder(codOrder({ customAttributes: [] }));
    expect(n.verifiedPhone).toBe(null);
    expect(classify(n)).toBe('COD');
  });
  it('COD on the "manual" gateway: an admin order (#1188)', () => {
    const n = normalizeOrder(codOrder({ paymentGatewayNames: ['manual'] }));
    expect(classify(n)).toBe('COD');
  });
  it('COD from the shipping line alone, whatever the gateway says', () => {
    const n = normalizeOrder(codOrder({ paymentGatewayNames: [], customAttributes: [] }));
    expect(n.codShippingLine).toBe(true);
    expect(classify(n)).toBe('COD');
  });
  it('a COD order with money already collected is not COD any more', () => {
    const n = normalizeOrder(codOrder({
      displayFinancialStatus: 'PAID',
      netPaymentSet: { shopMoney: { amount: '1499.00' } },
    }));
    expect(classify(n)).toBe('PREPAID');
  });
});

describe('computeAmounts', () => {
  it('saves exactly the tier amount, with the COD fee counted inside it', () => {
    const a = computeAmounts(normalizeOrder(codOrder()), RULES);
    // Rs 1,499 order less the Rs 50 fee is Rs 1,449 of goods, so the Rs 150
    // tier. Rs 150 total: Rs 50 COD fee no longer charged + Rs 100 line
    // discount. The fee must NOT stack on top of the discount, or we give away
    // Rs 200.
    expect(a.codFeePaise).toBe(5000);
    expect(a.discountPaise).toBe(10000);
    expect(a.savingPaise).toBe(15000);
    expect(a.newTotalPaise).toBe(149900 - 15000); // 134900
    expect(a.savingInr).toBe(150);
    expect(a.gift).toBe(true);
    expect(a.feeMatches).toBe(true); // 50.0 attr == Rs 50 line
  });

  /*
   * ORDER #1252, 2026-11-13. A Rs 2,499 garment carrying a Rs 150 automatic
   * discount, plus the Rs 50 COD fee. The quote was right and the CONVERSION
   * was what broke: Shopify refused to stack the prepaid discount on the line,
   * the payment dead-lettered, and the order stayed PENDING at Rs 2,399 with
   * the customer's Rs 2,249 in Razorpay.
   *
   * So the quote still promises the whole tier saving, and convertToPrepaid
   * re-adds the line carrying both discounts as one to deliver it. This test
   * pins the number the customer is asked for; the route that honours it is
   * pinned in clients/shopify.prepaid.test.mjs. If the two ever disagree, the
   * payment handler's own check refuses rather than marking anything paid.
   */
  it('quotes the full tier saving even when the order already carries a discount', () => {
    const a = computeAmounts(
      normalizeOrder(
        codOrder({
          currentTotalPriceSet: { shopMoney: { amount: '2399.00' } },
          totalPriceSet: { shopMoney: { amount: '2399.00' } },
          lineItems: {
            nodes: [
              {
                id: 'li1',
                title: 'Kalika',
                quantity: 1,
                originalUnitPriceSet: { shopMoney: { amount: '2499.00' } },
                discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: '150.00' } } }],
              },
            ],
          },
        }),
      ),
      RULES,
    );
    expect(a.discountPaise).toBe(10000); // Rs 150 tier less the Rs 50 fee
    expect(a.savingPaise).toBe(15000);
    expect(a.newTotalPaise).toBe(224900); // exactly what #1252 was asked for and paid
    expect(a.savingInr).toBe(150);
  });

  /*
   * The allocation the conversion has to carry. normalizeOrder sums it per
   * line because Shopify allocates once per discount application, so a line
   * can hold several, and carrying only the first would lose the rest off the
   * order total.
   */
  it('reads the discount already allocated to a line, summed', () => {
    const n = normalizeOrder(
      codOrder({
        lineItems: {
          nodes: [
            {
              id: 'li1',
              title: 'Bandhan',
              quantity: 1,
              originalUnitPriceSet: { shopMoney: { amount: '1449.00' } },
              discountAllocations: [
                { allocatedAmountSet: { shopMoney: { amount: '100.00' } } },
                { allocatedAmountSet: { shopMoney: { amount: '50.00' } } },
              ],
            },
          ],
        },
      }),
    );
    expect(n.lineItems[0].discountPaise).toBe(15000);
  });

  it('reads an undiscounted line as carrying nothing', () => {
    const n = normalizeOrder(codOrder());
    expect(n.lineItems[0].discountPaise).toBe(0);
  });

  it('never discounts below zero when the COD fee already covers the saving', () => {
    const order = codOrder({
      shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '150.00' } } }] },
    });
    const a = computeAmounts(normalizeOrder(order), RULES);
    expect(a.discountPaise).toBe(0);
    expect(a.savingPaise).toBe(15000); // the fee alone
  });
  it('flags a fee mismatch (no offer should be made)', () => {
    const a = computeAmounts(normalizeOrder(codOrder({ shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '99.00' } } }] } })), RULES);
    expect(a.feeMatches).toBe(false);
  });
});

describe('eligibility', () => {
  const startAt = '2026-09-01T00:00:00Z';
  it('COD order after startAt is eligible', () => {
    expect(flowAEligible(normalizeOrder(codOrder()), 'COD', { startAt }).ok).toBe(true);
  });
  it('excludes cancelled / COD-Cancelled / unlisted test order', () => {
    expect(excludeFromAll(normalizeOrder(codOrder({ cancelledAt: '2026-09-20T07:00:00Z' }))).excluded).toBe(true);
    expect(excludeFromAll(normalizeOrder(codOrder({ tags: ['❌ COD-Cancelled'] }))).excluded).toBe(true);
    expect(excludeFromAll(normalizeOrder(codOrder({ test: true }))).excluded).toBe(true);
    expect(excludeFromAll(normalizeOrder(codOrder({ test: true })), { orderAllowlist: ['12345'] }).excluded).toBe(false);
  });
  it('rejects only an unrecognised class and pre-startAt', () => {
    // PREPAID, PARTIAL and UNKNOWN all qualify: they get a plain confirmation,
    // not the COD chase. UNKNOWN was rejected here until 2026-11-02, which is
    // what left four orders with no message of any kind.
    expect(flowAEligible(normalizeOrder(codOrder()), 'PARTIAL', { startAt }).ok).toBe(true);
    expect(flowAEligible(normalizeOrder(codOrder()), 'PREPAID', { startAt }).ok).toBe(true);
    expect(flowAEligible(normalizeOrder(codOrder()), 'UNKNOWN', { startAt }).ok).toBe(true);
    expect(flowAEligible(normalizeOrder(codOrder()), 'SOMETHING-NEW', { startAt }).reason).toBe('class-SOMETHING-NEW');
    expect(flowAEligible(normalizeOrder(codOrder()), 'COD', { startAt: '2026-12-01T00:00:00Z' }).reason).toBe('before-startAt');
    expect(flowAEligible(normalizeOrder(codOrder()), 'COD', {}).reason).toBe('before-startAt'); // no startAt => nothing qualifies
  });
});

describe('hasRtoTag vs the COD King risk tags', () => {
  it('does not treat "LOW/MEDIUM/HIGH RTO Risk" as an RTO', () => {
    // every COD King order carries one of these, so a substring match on 'RTO'
    // silently suppressed every Flow B review ask and broke the digest counts
    expect(hasRtoTag(['LOW RTO Risk', '✅ COD-Verified'])).toBe(false);
    expect(hasRtoTag(['MEDIUM RTO Risk'])).toBe(false);
    expect(hasRtoTag(['HIGH RTO Risk'])).toBe(false);
  });

  it('still detects a real RTO tag, including an emoji prefixed one', () => {
    expect(hasRtoTag(['RTO'])).toBe(true);
    expect(hasRtoTag(['❌ RTO', 'LOW RTO Risk'])).toBe(true);
    expect(hasRtoTag(['rto'])).toBe(true);
  });

  it('is false for no tags', () => {
    expect(hasRtoTag([])).toBe(false);
    expect(hasRtoTag(undefined)).toBe(false);
  });
});

describe('what the customer sees of their own order', () => {
  const li = (over = {}) => ({
    id: 'li',
    title: 'Sahaj',
    quantity: 1,
    variantTitle: 'S / Lavender',
    variant: { selectedOptions: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Lavender' }] },
    image: { url: 'https://cdn.shopify.com/f/sahaj.jpg?v=9', width: 473, height: 593 },
    originalUnitPriceSet: { shopMoney: { amount: '1149.00' } },
    ...over,
  });
  const order = (nodes) => normalizeOrder({ id: 'gid://shopify/Order/1', lineItems: { nodes } });

  it('reads the size from the Size option, never from variantTitle alone', () => {
    // "S / Lavender" as a size would read as a colour, so selectedOptions wins.
    expect(itemLine(order([li()]))).toBe('Sahaj, size S');
  });
  it('falls back to variantTitle only for a single-option variant', () => {
    expect(itemLine(order([li({ variant: null, variantTitle: 'XS' })]))).toBe('Sahaj, size XS');
    expect(itemLine(order([li({ variant: null, variantTitle: 'Default Title' })]))).toBe('Sahaj');
    expect(itemLine(order([li({ variant: null, variantTitle: 'S / Lavender' })]))).toBe('Sahaj');
  });
  it('counts the rest instead of listing them, and stays on one line', () => {
    const line = itemLine(order([li(), li({ title: 'Bel', quantity: 2 })]));
    expect(line).toBe('Sahaj, size S and 2 more items');
    expect(line).not.toMatch(/[\n\t]/);
  });
  it('says pieces when more than one of the same item was ordered', () => {
    expect(itemLine(order([li({ quantity: 3 })]))).toBe('Sahaj, size S, 3 pieces');
  });
  it('has nothing to say about an empty order', () => {
    expect(itemLine(order([]))).toBe(null);
    expect(heroImageUrl(order([]))).toBe(null);
  });
  it('never asks the CDN to upscale, because it silently returns the original', () => {
    // 473x593 source: asking for 800 would come back 473x593 portrait, so the
    // square edge is clamped to the shorter side.
    const u = new URL(heroImageUrl(order([li()])));
    expect(u.searchParams.get('width')).toBe('473');
    expect(u.searchParams.get('height')).toBe('473');
    expect(u.searchParams.get('crop')).toBe('center');
  });
  it('caps the square at the requested maximum for a large source', () => {
    const u = new URL(heroImageUrl(order([li({ image: { url: 'https://cdn/x.jpg', width: 1600, height: 2000 } })])));
    expect(u.searchParams.get('width')).toBe('800');
  });
  it('skips a line item with no photo and takes the next one', () => {
    const u = heroImageUrl(order([li({ image: null }), li({ title: 'Bel' })]));
    expect(u).toMatch(/sahaj\.jpg/);
  });

  /*
   * A removed line stays on the order with its original quantity and drops to
   * currentQuantity 0. Reading quantity described the order as placed, so a
   * hand-edited order named the wrong garment at dispatch. Order #1182 is the
   * live shape: XS removed, 2XL added, same product and price.
   */
  const sized = (size, over) => li({
    variant: { selectedOptions: [{ name: 'Size', value: size }] },
    variantTitle: size,
    ...over,
  });

  it('names the garment the customer is actually getting, not the removed one', () => {
    const n = order([sized('XS', { currentQuantity: 0 }), sized('2XL', { currentQuantity: 1 })]);
    expect(itemLine(n)).toBe('Sahaj, size 2XL');
  });

  it('does not count a removed line as "and 1 more item"', () => {
    const n = order([sized('XS', { currentQuantity: 0 }), sized('2XL', { currentQuantity: 1 })]);
    expect(itemLine(n)).not.toMatch(/more item/);
  });

  it('never puts the removed product photo in the message header', () => {
    const n = order([
      sized('XS', { currentQuantity: 0, image: { url: 'https://cdn/removed.jpg', width: 500, height: 500 } }),
      sized('2XL', { currentQuantity: 1, image: { url: 'https://cdn/kept.jpg', width: 500, height: 500 } }),
    ]);
    expect(heroImageUrl(n)).toMatch(/kept\.jpg/);
  });

  it('still describes a voided order, where EVERY line is at currentQuantity 0', () => {
    // 33 of the last 150 orders look like this. Dropping every line would leave
    // the digest and any late message with nothing to name, so the order as
    // placed is the truthful answer.
    const n = order([sized('S', { currentQuantity: 0 })]);
    expect(n.lineItems).toHaveLength(1);
    expect(itemLine(n)).toBe('Sahaj, size S');
  });

  it('reports the quantity actually standing, not the quantity placed', () => {
    expect(order([li({ quantity: 3, currentQuantity: 1 })]).lineItems[0].quantity).toBe(1);
    expect(itemLine(order([li({ quantity: 3, currentQuantity: 1 })]))).toBe('Sahaj, size S');
  });

  it('is unchanged for an order whose lines never carried currentQuantity', () => {
    // Every pre-existing caller and fixture is in this shape.
    expect(itemLine(order([li({ quantity: 2 })]))).toBe('Sahaj, size S, 2 pieces');
    expect(order([li()]).lineItems).toHaveLength(1);
  });
});

/*
 * The prepaid saving is tiered on the ORDER VALUE, which is the merchandise
 * total with the COD fee taken out. Getting the side of the line wrong is a
 * real Rs 50 either way, so the boundary is pinned here.
 */
describe('prepaid saving tiers', () => {
  const at = (goodsInr, feeInr = 50) =>
    computeAmounts(
      normalizeOrder(
        codOrder({
          currentTotalPriceSet: { shopMoney: { amount: String(goodsInr + feeInr) } },
          totalPriceSet: { shopMoney: { amount: String(goodsInr + feeInr) } },
          shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: String(feeInr) } } }] },
          customAttributes: [
            { key: '_otpVerifiedPhoneNumber', value: '919812345678' },
            { key: '_codkAmountType', value: 'cod' },
            { key: '_codkAmountValue', value: `${feeInr}.0` },
          ],
        }),
      ),
      RULES,
    );

  it('gives Rs 150 and a gift at exactly the Rs 1,299 threshold', () => {
    const a = at(1299);
    expect(a.savingInr).toBe(150);
    expect(a.gift).toBe(true);
  });

  it('gives Rs 100 and no gift one rupee below it', () => {
    const a = at(1298);
    expect(a.savingInr).toBe(100);
    expect(a.gift).toBe(false);
  });

  it('tiers on the goods, not on the goods plus the COD fee', () => {
    // Rs 1,260 of goods + Rs 50 fee is Rs 1,310 charged, but the order is
    // Rs 1,260, so it is the lower tier. Tiering on the charged total would
    // hand out Rs 150 on the strength of a fee we are about to stop charging.
    const a = at(1260);
    expect(a.orderValuePaise).toBe(126000);
    expect(a.savingInr).toBe(100);
  });

  it('never lets the saving push the total below what the tier promises', () => {
    const a = at(2000);
    expect(a.savingPaise).toBe(15000);
    expect(a.newTotalPaise).toBe(205000 - 15000);
  });
});

/*
 * F6. feeMatches answered false whenever COD King had recorded nothing, which
 * reads "the fee does not match" when the truth is "nobody claimed a second
 * figure". It hit every COD order that did not come through COD King's popup:
 * recovery-link orders, admin orders, plain storefront checkouts. #1232 and
 * #1239 are live examples, and they got a price-free confirmation and a "Pay
 * online" button that answered "it stays on cash on delivery".
 */
describe('computeAmounts when COD King recorded no fee', () => {
  const order = (over = {}) => ({
    currentTotalPaise: 149900,
    codFeePaise: 5000,
    codkAmountValue: null,
    ...over,
  });

  it('reads the COD shipping line as the fee, and says where it came from', () => {
    const a = computeAmounts(order(), RULES);
    expect(a.feeMatches).toBe(true);
    expect(a.feeSource).toBe('shipping-line');
    expect(a.codFeePaise).toBe(5000);
  });

  it('treats a COD order with no shipping line at all as a zero fee', () => {
    const a = computeAmounts(order({ codFeePaise: 0 }), RULES);
    expect(a.feeMatches).toBe(true);
    expect(a.codFeePaise).toBe(0);
  });

  it('still compares, and still refuses, when COD King did record a figure', () => {
    const agree = computeAmounts(order({ codkAmountValue: '50.0' }), RULES);
    expect(agree.feeMatches).toBe(true);
    expect(agree.feeSource).toBe('codk');
    const disagree = computeAmounts(order({ codkAmountValue: '99.0' }), RULES);
    expect(disagree.feeMatches).toBe(false);
  });
});
