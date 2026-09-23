import { describe, it, expect } from 'vitest';
import { normalizeOrder, hasTag, riskTag, hasRtoTag } from './order.mjs';
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
  it('removes COD fee + applies discount; saving = discount + fee', () => {
    const a = computeAmounts(normalizeOrder(codOrder()), RULES);
    expect(a.discountPaise).toBe(10000); // ₹100
    expect(a.codFeePaise).toBe(5000);
    expect(a.feeMatches).toBe(true); // 50.0 attr == ₹50 line
    expect(a.newTotalPaise).toBe(149900 - 10000 - 5000); // 134900
    expect(a.savingPaise).toBe(15000);
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
  it('rejects non-COD and pre-startAt', () => {
    expect(flowAEligible(normalizeOrder(codOrder()), 'PARTIAL', { startAt }).reason).toBe('class-PARTIAL');
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
