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
  it('UNKNOWN when nothing matches', () => {
    const n = normalizeOrder(codOrder({ displayFinancialStatus: 'AUTHORIZED', paymentGatewayNames: ['Cashfree'], customAttributes: [] }));
    expect(classify(n)).toBe('UNKNOWN');
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
  it('rejects only UNKNOWN classes and pre-startAt', () => {
    // PREPAID and PARTIAL qualify now: they get a plain confirmation, not the
    // COD chase. Only an order we could not classify is left alone.
    expect(flowAEligible(normalizeOrder(codOrder()), 'PARTIAL', { startAt }).ok).toBe(true);
    expect(flowAEligible(normalizeOrder(codOrder()), 'PREPAID', { startAt }).ok).toBe(true);
    expect(flowAEligible(normalizeOrder(codOrder()), 'UNKNOWN', { startAt }).reason).toBe('class-UNKNOWN');
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
