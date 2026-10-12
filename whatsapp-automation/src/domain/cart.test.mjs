import { describe, it, expect } from 'vitest';
import { RULES } from '../../messages/rules.mjs';
import { itemLine, heroImageUrl } from './order.mjs';
import {
  normalizeCheckout, properFirstName, isPartialAdvance, cartEligible, computeCartOffer,
  bestPublicSavingPaise, personalCodeName, codeDigits, cartCode, recoveryTimes,
  formatExpiresAt, formatTimeLeft,
} from './cart.mjs';

// The three live public codes, in the shape shopify.publicCodeDiscounts() returns.
const PUBLIC = [
  { code: 'BUY2', type: 'percentage', percentage: 0.1, minQuantity: 2 },
  { code: 'BUY3', type: 'percentage', percentage: 0.15, minQuantity: 3 },
  { code: 'WELCOME150', type: 'amount', amountPaise: 15000, minSubtotalPaise: 119900 },
];

const offer = (bagInr, quantity, ownInr = 0, publicCodes = PUBLIC) =>
  computeCartOffer({ bagPaise: bagInr * 100, quantity, ownDiscountPaise: ownInr * 100, publicCodes, rules: RULES });

const checkout = (over = {}) => ({
  id: 'gid://shopify/AbandonedCheckout/66743166239092',
  name: '#66743166239092',
  createdAt: '2026-10-12T06:00:00Z',
  completedAt: null,
  abandonedCheckoutUrl: 'https://www.morpaankh.in/99862610292/checkouts/ac/tok/recover?key=secret&locale=en-IN',
  totalDiscountSet: { shopMoney: { amount: '0.0' } },
  customAttributes: [
    { key: '_otpVerifiedPhoneNumber', value: '919637361371' },
    { key: '_codkAmountType', value: 'cod' },
  ],
  customer: { id: 'gid://shopify/Customer/1', firstName: 'Bharti' },
  shippingAddress: { firstName: 'Bharti' },
  lineItems: {
    nodes: [
      {
        title: 'Khili Dhoop',
        quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1249.0' } },
        image: { url: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1', width: 1200, height: 1500 },
        variant: { id: 'gid://shopify/ProductVariant/9', availableForSale: true, selectedOptions: [{ name: 'Size', value: 'M' }] },
      },
    ],
  },
  ...over,
});

describe('the section 3 offer fixtures', () => {
  /*
   * These six are the contract. Each one is a bag that really exists or really
   * could, paired with what the customer could already get without us. The
   * offer must always beat that, which is the only reason this flow is worth
   * sending at all.
   */
  const cases = [
    ['1,249 one piece, WELCOME150 open but not applied', 1249, 1, 0, 200],
    ['2,199 one piece, WELCOME150 already applied', 2199, 1, 150, 220],
    ['2,698 two pieces, BUY2 applied', 2698, 2, 269.8, 320],
    ['3,198 two pieces, BUY2 applied', 3198, 2, 319.8, 370],
    ['999 one piece, nothing eligible at all', 999, 1, 0, 100],
    ['4,500 three pieces, BUY3 applied', 4500, 3, 675, 730],
  ];
  it.each(cases)('%s -> Rs %d', (_label, bag, qty, own, expected) => {
    const r = offer(bag, qty, own);
    expect(r.offerPaise).toBe(expected * 100);
    expect(r.ok).toBe(true);
  });

  it('always beats what the bag can already get, and never exceeds 20% of it', () => {
    for (const [, bag, qty, own] of cases) {
      const r = offer(bag, qty, own);
      expect(r.offerPaise).toBeGreaterThan(r.floorPaise);
      expect(r.offerPaise).toBeLessThanOrEqual(bag * 100 * 0.2);
    }
  });

  it('refuses when the cap cannot beat what they already have', () => {
    // A bag carrying a hand-made discount far better than 20% of it.
    const r = offer(1300, 1, 300);
    expect(r.ok).toBe(false);
    expect(r.offerPaise).toBeLessThanOrEqual(r.floorPaise);
  });

  it('min subtotal is floored from the bag, so the code still applies to this bag', () => {
    const r = offer(1249, 1);
    expect(r.minSubtotalInr).toBe(1124);
    expect(r.minSubtotalInr * 100).toBeLessThanOrEqual(r.bagPaise);
  });

  it('a public code whose minimum is not met does not raise the floor', () => {
    expect(bestPublicSavingPaise(PUBLIC, 99900, 1)).toBe(0); // under WELCOME150's 1,199
    expect(bestPublicSavingPaise(PUBLIC, 269800, 1)).toBe(15000); // one item: BUY2 is out
    expect(bestPublicSavingPaise(PUBLIC, 269800, 2)).toBe(26980); // two items: BUY2 wins
  });

  it('with no public codes readable at all the floor is only what is applied', () => {
    const r = offer(1249, 1, 0, []);
    expect(r.floorPaise).toBe(0);
    // Which is exactly why onFirst must refuse to send when the discounts read
    // fails: 10% of this bag is Rs 130 and WELCOME150 gives Rs 150, so the
    // "private" code would be worth less than the one on the cart page.
    expect(r.offerPaise).toBe(13000);
    expect(r.offerPaise).toBeLessThan(bestPublicSavingPaise(PUBLIC, 124900, 1));
  });
});

describe('normalizeCheckout feeds the existing order helpers unchanged', () => {
  it('itemLine and heroImageUrl work on a checkout', () => {
    const n = normalizeCheckout(checkout());
    expect(itemLine(n)).toBe('Khili Dhoop, size M');
    expect(heroImageUrl(n)).toContain('width=800');
    expect(heroImageUrl(n)).toContain('crop=center');
  });

  it('reads the bag at list price, not the discounted total', () => {
    const n = normalizeCheckout(
      checkout({ totalDiscountSet: { shopMoney: { amount: '269.8' } } }),
    );
    expect(n.bagPaise).toBe(124900);
    expect(n.ownDiscountPaise).toBe(26980);
  });

  it('takes the phone only from the verified attribute', () => {
    expect(normalizeCheckout(checkout()).verifiedPhone).toBe('+919637361371');
    const noPhone = checkout({ customAttributes: [{ key: '_codkAmountType', value: 'cod' }] });
    expect(normalizeCheckout(noPhone).verifiedPhone).toBe(null);
  });

  it('falls back through customer, shipping, billing for the name', () => {
    expect(normalizeCheckout(checkout({ customer: null })).firstName).toBe('Bharti');
    const onlyBilling = checkout({ customer: null, shippingAddress: null, billingAddress: { firstName: 'Meera' } });
    expect(normalizeCheckout(onlyBilling).firstName).toBe('Meera');
    expect(normalizeCheckout(checkout({ customer: null, shippingAddress: null })).firstName).toBe('there');
  });

  it('re-cases a shouted name but leaves a typed one alone', () => {
    expect(properFirstName('AARAV')).toBe('Aarav');
    expect(properFirstName('McKay')).toBe('McKay');
    expect(properFirstName('  bharti devi ')).toBe('bharti');
    expect(properFirstName('')).toBe('there');
  });
});

describe('partial advance', () => {
  it('skips a real partial advance', () => {
    expect(isPartialAdvance({ codkAmountType: 'percentage', codkAmountValue: '5.0' })).toBe(true);
  });

  /*
   * The live trap. Checkout #66761819390324 is fully prepaid, has full line
   * prices, and still carries _partialPaymentProduct: "true". Keying the skip
   * off that attribute would have thrown away good checkouts.
   */
  it('does NOT skip a 100% prepaid checkout that carries _partialPaymentProduct', () => {
    const n = normalizeCheckout(
      checkout({
        customAttributes: [
          { key: '_otpVerifiedPhoneNumber', value: '919910661110' },
          { key: '_partialPaymentProduct', value: 'true' },
          { key: '_codkAmountType', value: 'percentage' },
          { key: '_codkAmountValue', value: '100.0' },
        ],
      }),
    );
    expect(isPartialAdvance(n)).toBe(false);
    expect(cartEligible(n, { now: new Date('2026-10-12T07:00:00Z'), startAt: '2026-01-01T00:00:00Z', rules: RULES }).ok).toBe(true);
  });

  it('treats an unreadable percentage as partial, because we cannot price it', () => {
    expect(isPartialAdvance({ codkAmountType: 'percentage', codkAmountValue: null })).toBe(true);
  });

  it('a cod checkout is never partial', () => {
    expect(isPartialAdvance({ codkAmountType: 'cod', codkAmountValue: '50.0' })).toBe(false);
  });
});

describe('cartEligible', () => {
  const now = new Date('2026-10-12T07:00:00Z'); // 12:30 IST, 60 min after createdAt
  const base = { now, startAt: '2026-01-01T00:00:00Z', rules: RULES };
  const check = (over, opts = {}) => cartEligible(normalizeCheckout(checkout(over)), { ...base, ...opts });

  it('passes a good one', () => {
    expect(check({})).toEqual({ ok: true });
  });

  /*
   * The headline loophole. `updatedAt` is not customer activity, so an old
   * checkout can look fresh. Age comes from createdAt and nothing else.
   */
  it('refuses a checkout older than 12h however fresh updatedAt looks', () => {
    expect(check({ createdAt: '2026-10-11T06:00:00Z', updatedAt: '2026-10-12T06:59:00Z' }).reason).toBe('too-old');
  });

  it('refuses one younger than 20 minutes', () => {
    expect(check({ createdAt: '2026-10-12T06:50:00Z' }).reason).toBe('too-fresh');
  });

  it('refuses anything created before the flow was switched on', () => {
    expect(check({}, { startAt: '2026-10-12T06:30:00Z' }).reason).toBe('before-start');
    // No startAt at all means nothing qualifies, same as every other flow.
    expect(check({}, { startAt: '' }).reason).toBe('before-start');
  });

  it('refuses completed, phoneless, sold out, empty and valueless bags', () => {
    expect(check({ completedAt: '2026-10-12T06:30:00Z' }).reason).toBe('completed');
    expect(check({ customAttributes: [] }).reason).toBe('no-verified-phone');
    const soldOut = checkout();
    soldOut.lineItems.nodes[0].variant.availableForSale = false;
    expect(cartEligible(normalizeCheckout(soldOut), base).reason).toBe('sold-out');
    expect(check({ lineItems: { nodes: [] } }).reason).toBe('no-items');
  });

  it('refuses a null checkout rather than throwing', () => {
    expect(cartEligible(null, base)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('the personal code', () => {
  it('strips diacritics and upper-cases', () => {
    expect(personalCodeName('Aarâv', RULES)).toBe('AARAV');
    expect(personalCodeName('josé maria', RULES)).toBe('JOSE');
  });
  it('falls back to VIP for a non-Latin name', () => {
    expect(personalCodeName('राज', RULES)).toBe('VIP');
    expect(personalCodeName('李明', RULES)).toBe('VIP');
  });
  it('falls back to VIP for one letter or nothing', () => {
    expect(personalCodeName('A', RULES)).toBe('VIP');
    expect(personalCodeName('', RULES)).toBe('VIP');
    expect(personalCodeName('   ', RULES)).toBe('VIP');
  });
  it('falls back to VIP rather than print a moderation word in bold', () => {
    expect(personalCodeName('Shit', RULES)).toBe('VIP');
    expect(personalCodeName('Randini', RULES)).toBe('VIP');
  });
  it('caps the name at 10 letters', () => {
    expect(personalCodeName('Priyadarshini', RULES)).toBe('PRIYADARSH');
    expect(personalCodeName('Priyadarshini', RULES).length).toBe(10);
  });
  it('takes the first word only', () => {
    expect(personalCodeName('Aarav Kumar Sharma', RULES)).toBe('AARAV');
  });
  it('draws digits from 2 to 9 only, because 0 reads as O and 1 as I', () => {
    for (let i = 0; i < 200; i += 1) {
      for (const ch of codeDigits(3)) expect('23456789').toContain(ch);
    }
    expect(codeDigits(2).length).toBe(2);
    expect(codeDigits(3).length).toBe(3);
  });
  it('builds MORPAANKH + NAME + digits', () => {
    const code = cartCode('AARAV', 2, RULES, () => 0.5);
    expect(code).toBe('MORPAANKHAARAV66');
    expect(code).toMatch(/^MORPAANKH[A-Z]{2,10}[2-9]{2}$/);
  });
  it('is longer than Meta caps a COPY_CODE button at, which is why there is no such button', () => {
    expect(cartCode('AARAV', 2, RULES, () => 0.5).length).toBeGreaterThan(15);
  });
});

describe('recoveryTimes', () => {
  const t = (iso) => recoveryTimes(new Date(iso), RULES);

  it('closes 24h after the first message when the reminder lands in the window', () => {
    // 16:30 IST -> ends 16:30 next day, reminder 14:30, both inside 09:30-22:30.
    const r = t('2026-10-12T11:00:00Z');
    expect(r.codeEndsAt.toISOString()).toBe('2026-10-13T11:00:00.000Z');
    expect(r.reminderAt.toISOString()).toBe('2026-10-13T09:00:00.000Z');
  });

  it('moves a reminder that lands before the window opens, and the end moves with it', () => {
    // 10:00 IST -> reminder would be 08:00, before 09:30. Reminder goes to
    // 09:30 and the code end to 11:30, so the code lives LONGER, never shorter.
    const r = t('2026-10-12T04:30:00Z');
    expect(r.reminderAt.toISOString()).toBe('2026-10-13T04:00:00.000Z'); // 09:30 IST
    expect(r.codeEndsAt.toISOString()).toBe('2026-10-13T06:00:00.000Z'); // 11:30 IST
  });

  it('the code end only ever moves later, for every minute of the day', () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      const first = new Date(Date.UTC(2026, 9, 12, 0, 0) + m * 60000);
      const r = recoveryTimes(first, RULES);
      expect(r.codeEndsAt.getTime()).toBeGreaterThanOrEqual(first.getTime() + 24 * 3600 * 1000);
      expect(r.reminderAt.getTime()).toBeLessThan(r.codeEndsAt.getTime());
      // And the reminder is always somewhere we are allowed to send.
      expect(r.reminderAt.getTime()).toBeGreaterThan(first.getTime());
    }
  });
});

describe('the customer-facing time words', () => {
  const now = new Date('2026-10-12T11:00:00Z'); // 16:30 IST 12 Oct

  it('names today and tomorrow, and dates anything further out', () => {
    expect(formatExpiresAt(new Date('2026-10-12T15:50:00Z'), now)).toBe('today at 9:20 PM');
    expect(formatExpiresAt(new Date('2026-10-13T15:50:00Z'), now)).toBe('tomorrow at 9:20 PM');
    expect(formatExpiresAt(new Date('2026-10-14T15:50:00Z'), now)).toBe('14 Oct at 9:20 PM');
  });

  it('reads midnight and noon the way a person does', () => {
    expect(formatExpiresAt(new Date('2026-10-12T18:30:00Z'), now)).toBe('tomorrow at 12:00 AM');
    expect(formatExpiresAt(new Date('2026-10-12T06:30:00Z'), now)).toBe('today at 12:00 PM');
  });

  it('rounds the time left to 5 minutes', () => {
    expect(formatTimeLeft(120 * 60000)).toBe('2 hours');
    expect(formatTimeLeft(100 * 60000)).toBe('1 hour 40 minutes');
    expect(formatTimeLeft(50 * 60000)).toBe('50 minutes');
    expect(formatTimeLeft(117 * 60000)).toBe('1 hour 55 minutes');
    expect(formatTimeLeft(60 * 60000)).toBe('1 hour');
    expect(formatTimeLeft(-5000)).toBe('0 minutes');
  });
});
