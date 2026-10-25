/*
 * Flow W domain logic. Pure functions only: no table, no clients, no clock
 * except the one handed in.
 *
 * The two tests here that are really contracts rather than arithmetic:
 *
 *   the offer guard, which must pass against the three codes that are actually
 *   live on the store today and must FAIL against a hypothetical WELCOME200;
 *   the code format, which must satisfy the regex the THEME uses to decide
 *   whether to leave a link-supplied code alone (see RECOVERY_CODE below).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RULES } from '../../messages/rules.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { bestPublicSavingPaise, tierMaxPaise } from './cart.mjs';
import {
  istYesterdayWindow,
  onSubscriberAllowlist,
  normalizeCustomer,
  subscriberEligible,
  chooseChannel,
  subscriberOfferGuard,
  subscriberCode,
  cryptoRng,
  phoneSkipReason,
  landingUrl,
  normalizeEmail,
  emailKey,
  escapeHtml,
  topPicks,
  subscriberVars,
} from './subscriberOffer.mjs';

/*
 * COPIED, deliberately, from theme/assets/tapi-offers.js line 42 on main:
 *
 *   var RECOVERY_CODE = /^MORPAANKH[A-Z]*\d+$/;
 *
 * That script auto-replaces whatever code is on the cart with the biggest
 * PUBLIC one unless the applied code matches this pattern. A Flow W code that
 * does not match would be silently swapped for BUY2 the moment the customer
 * reached the cart, so the private offer would simply evaporate. The literal is
 * inlined rather than read off disk because this service must not depend on a
 * path outside itself.
 */
const RECOVERY_CODE = /^MORPAANKH[A-Z]*\d+$/;

/* The three codes that are really live, in the shape publicCodeDiscounts() returns. */
const PUBLIC = [
  { code: 'BUY2', title: 'Buy 2, get 10% off (code BUY2)', type: 'percentage', percentage: 0.1, minQuantity: 2 },
  { code: 'BUY3', title: 'Buy 3, get 15% off (code BUY3)', type: 'percentage', percentage: 0.15, minQuantity: 3 },
  { code: 'WELCOME150', title: 'WELCOME150', type: 'amount', amountPaise: 15000, minSubtotalPaise: 119900 },
];
/* Not live. The one that must shut the offer down if it ever goes live. */
const WELCOME200 = { code: 'WELCOME200', title: 'WELCOME200', type: 'amount', amountPaise: 20000, minSubtotalPaise: 119900 };

const w = () => RULES.subscriberOffer;
/*
 * The guard is measured against the code's OWN minimum, and that minimum is the
 * SHOPIFY one: Rs 1,500.01, not Rs 1,500. The extra paisa is what makes
 * "above Rs 1,500" true rather than "at or above", and it is also what lands
 * the guard in the Rs 200 offer tier instead of the Rs 160 one, so dropping it
 * would refuse every offer this flow is supposed to make.
 */
const minimumPaise = () => Math.round((w().minOrderAboveInr + 0.01) * 100);

const EMAIL_FIXTURE = 'priya.test@example.com';
const UNSUB_FIXTURE = 'https://www.morpaankh.in/unsubscribe?id=abc';

const customer = (over = {}) => ({
  id: 'gid://shopify/Customer/25164544835956',
  createdAt: '2026-10-23T05:00:00Z', // 10:30 IST on 23 Oct
  firstName: 'Priya',
  lastName: 'Sharma',
  // A STRING, as Shopify sends it: numberOfOrders is an UnsignedInt64.
  numberOfOrders: '0',
  tags: [],
  defaultEmailAddress: {
    emailAddress: EMAIL_FIXTURE,
    marketingState: 'SUBSCRIBED',
    marketingUnsubscribeUrl: UNSUB_FIXTURE,
  },
  defaultPhoneNumber: { phoneNumber: '+919637361371' },
  ...over,
});

const NOW = fromISTWall(2026, 9, 24, 11, 0); // 11:00 IST on 24 Oct 2026
const eligible = (over, opts = {}) =>
  subscriberEligible(normalizeCustomer(customer(over)), {
    now: NOW,
    startAt: '2026-10-01T00:00:00Z',
    rules: RULES,
    ...opts,
  });

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('the IST day the sweep asks Shopify for', () => {
  /*
   * The rule is one IST CALENDAR DAY, yesterday, half open: [yesterday 00:00,
   * today 00:00). Expressed in UTC that is an 18:30 to 18:30 pair, and it is
   * the only thing standing between "everyone who signed up yesterday" and
   * "everyone who signed up in the last 24 hours", which at 11:00 would reach
   * half of today as well.
   */
  const cases = [
    ['a normal morning run', fromISTWall(2026, 9, 24, 11, 0), '2026-10-23', '2026-10-22T18:30:00.000Z', '2026-10-23T18:30:00.000Z'],
    ['one second before IST midnight', new Date(fromISTWall(2026, 11, 31, 23, 59).getTime() + 59_000), '2026-12-30', '2026-12-29T18:30:00.000Z', '2026-12-30T18:30:00.000Z'],
    ['exactly IST midnight, a year rollover', fromISTWall(2027, 0, 1, 0, 0), '2026-12-31', '2026-12-30T18:30:00.000Z', '2026-12-31T18:30:00.000Z'],
    ['a month rollover', fromISTWall(2026, 10, 1, 11, 0), '2026-10-31', '2026-10-30T18:30:00.000Z', '2026-10-31T18:30:00.000Z'],
    ['a leap day', fromISTWall(2028, 2, 1, 11, 0), '2028-02-29', '2028-02-28T18:30:00.000Z', '2028-02-29T18:30:00.000Z'],
  ];

  it.each(cases)('%s', (_name, now, date, startISO, endISO) => {
    expect(istYesterdayWindow(now)).toEqual({ date, startISO, endISO });
  });

  it('is exactly 24 hours wide and never overlaps the next day', () => {
    const a = istYesterdayWindow(fromISTWall(2026, 9, 24, 11, 0));
    const b = istYesterdayWindow(fromISTWall(2026, 9, 25, 11, 0));
    expect(Date.parse(a.endISO) - Date.parse(a.startISO)).toBe(24 * 3600 * 1000);
    // Yesterday's end IS today's start: no gap, no double count.
    expect(a.endISO).toBe(b.startISO);
  });

  it('is the same window at 23:59 IST as it was at 00:00 IST the same day', () => {
    expect(istYesterdayWindow(fromISTWall(2026, 9, 24, 0, 0)))
      .toEqual(istYesterdayWindow(new Date(fromISTWall(2026, 9, 24, 23, 59).getTime() + 59_000)));
  });
});

// ---------------------------------------------------------------------------
describe('reading a customer', () => {
  it('pulls out every field the gates and the copy need', () => {
    const n = normalizeCustomer(customer());
    expect(n).toMatchObject({
      gid: 'gid://shopify/Customer/25164544835956',
      numericId: '25164544835956',
      createdAt: '2026-10-23T05:00:00Z',
      numberOfOrders: 0,
      email: 'priya.test@example.com',
      emailMarketingState: 'SUBSCRIBED',
      unsubscribeUrl: 'https://www.morpaankh.in/unsubscribe?id=abc',
      rawPhone: '+919637361371',
      phone: '+919637361371',
      rawFirstName: 'Priya',
      firstName: 'Priya',
    });
    expect(n.emailKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts orders as a NUMBER, whatever Shopify sends', () => {
    // numberOfOrders comes back as a string on this API version, and '0' is
    // truthy: a string test would pass every customer through the order gate.
    expect(normalizeCustomer(customer({ numberOfOrders: '0' })).numberOfOrders).toBe(0);
    expect(normalizeCustomer(customer({ numberOfOrders: '3' })).numberOfOrders).toBe(3);
    expect(normalizeCustomer(customer({ numberOfOrders: null })).numberOfOrders).toBe(0);
  });

  it('re-cases a shouted name and falls back to "there"', () => {
    expect(normalizeCustomer(customer({ firstName: 'PRIYA' })).firstName).toBe('Priya');
    expect(normalizeCustomer(customer({ firstName: '' })).firstName).toBe('there');
    expect(normalizeCustomer(customer({ firstName: null })).firstName).toBe('there');
  });

  /*
   * THE RECIPIENT. Owner's decision, 2026-10-24: Flow W messages
   * Customer.defaultPhoneNumber, because a candidate has no order and
   * therefore no `_otpVerifiedPhoneNumber`. It is an explicit, authorised
   * exception to hard rule 1 and the first time this service messages a number
   * that is not OTP-verified.
   *
   * The validation is the EXISTING normalizeVerifiedPhone, not a fork of it:
   * its digit rules already are the check this needs, and they already enforce
   * countryPrefixes ['+91'].
   */
  const phoneForms = [
    ['the 12 digit form Shopify usually stores', '+919637361371', '+919637361371'],
    ['the same without a plus', '919637361371', '+919637361371'],
    ['a bare 10 digit mobile', '9637361371', '+919637361371'],
    ['with spaces and a dash in it', '+91 96373-61371', '+919637361371'],
  ];

  it.each(phoneForms)('normalises %s', (_n, raw, want) => {
    expect(normalizeCustomer(customer({ defaultPhoneNumber: { phoneNumber: raw } })).phone).toBe(want);
  });

  const rejectedPhones = [
    ['a US number', '+14155550123'],
    ['an Indian landline, which is not on WhatsApp', '+912212345678'],
    ['nine digits', '963736137'],
    ['nonsense', 'call me'],
  ];

  it.each(rejectedPhones)('refuses %s, keeping the raw value for the gate to see', (_n, raw) => {
    const n = normalizeCustomer(customer({ defaultPhoneNumber: { phoneNumber: raw } }));
    expect(n.phone).toBe(null);
    // The RAW value has to survive, or the gate cannot tell a bad number
    // (refuse) from no number at all (fall back to email).
    expect(n.rawPhone).toBe(raw);
  });

  it('has no raw phone at all when Shopify holds none', () => {
    const n = normalizeCustomer(customer({ defaultPhoneNumber: null }));
    expect(n.phone).toBe(null);
    expect(n.rawPhone).toBe(null);
  });

  it('lower-cases tags, so a tag check cannot be defeated by capitals', () => {
    expect(normalizeCustomer(customer({ tags: ['No-Marketing', 'VIP'] })).tags).toEqual(['no-marketing', 'vip']);
  });

  it('answers null for nothing at all', () => {
    expect(normalizeCustomer(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
describe('the candidate filter', () => {
  it('passes a brand new customer who has never ordered', () => {
    expect(eligible()).toEqual({ ok: true });
  });

  const refusals = [
    ['created before the flow was switched on', { createdAt: '2026-09-20T05:00:00Z' }, 'before-start'],
    ['no creation time at all', { createdAt: null }, 'no-created-at'],
    ['has already ordered', { numberOfOrders: '1' }, 'already-ordered'],
    ['carries an excluded tag', { tags: ['cod-block'] }, 'excluded-tag'],
    ['carries the other excluded tag, in capitals', { tags: ['NO-MARKETING'] }, 'excluded-tag'],
  ];

  it.each(refusals)('refuses one that %s', (_name, over, reason) => {
    expect(eligible(over)).toEqual({ ok: false, reason });
  });

  /*
   * OWNER'S CORRECTION, 2026-10-24. A number we hold and cannot use is NOT a
   * refusal. SPEC section 10 is "email only when WhatsApp is impossible or
   * refused", and a foreign number, a landline or a typo is exactly WhatsApp
   * being impossible. The countryPrefixes rule is there to stop us PAYING to
   * WhatsApp an international number, not to drop the person entirely, and
   * section 2c hands out an `email:<hash>` group id which only exists because
   * email-only candidates are enqueued for a first send.
   *
   * These two cases previously asserted a terminal `no-phone`. The reason
   * survives, but only as a non-terminal note (phoneSkipReason), never as an
   * outcome. excludeTags and requireAnyTag stay terminal, because "not a
   * candidate at all" is a different statement from "we cannot reach them
   * this way".
   */
  const unusablePhones = [
    ['a foreign number', { defaultPhoneNumber: { phoneNumber: '+14155550123' } }, 'non-india'],
    // Indian, so not 'non-india': it is a number we simply cannot message.
    ['an Indian landline, which is not on WhatsApp', { defaultPhoneNumber: { phoneNumber: '+912212345678' } }, 'bad-phone'],
    ['a typo', { defaultPhoneNumber: { phoneNumber: '963736137' } }, 'bad-phone'],
  ];

  it.each(unusablePhones)('still offers one holding %s, by email, noting why', (_name, over, note) => {
    expect(eligible(over)).toEqual({ ok: true });
    const n = normalizeCustomer(customer(over));
    expect(chooseChannel(n, { rules: RULES })).toEqual({ channel: 'email' });
    expect(phoneSkipReason(n)).toBe(note);
  });

  it('and nothing on file at all is simply no-phone, not an error', () => {
    expect(phoneSkipReason(normalizeCustomer(customer({ defaultPhoneNumber: null })))).toBe('no-phone');
    expect(phoneSkipReason(normalizeCustomer(customer()))).toBe(null);
  });

  it('but an unusable number with no email either is still no-channel', () => {
    expect(eligible({ defaultPhoneNumber: { phoneNumber: '+14155550123' }, defaultEmailAddress: null }))
      .toEqual({ ok: false, reason: 'no-channel' });
  });

  /*
   * numberOfOrders arrives as the STRING "0" (UnsignedInt64). `=== 0` against
   * the raw value is ALWAYS false, so a gate written that way would pass every
   * single zero-order customer straight through the "any order" check. This
   * test is the one that fails if that happens.
   */
  it('passes the string "0" and refuses the string "1"', () => {
    expect(eligible({ numberOfOrders: '0' })).toEqual({ ok: true });
    expect(eligible({ numberOfOrders: '1' })).toEqual({ ok: false, reason: 'already-ordered' });
    expect(eligible({ numberOfOrders: '12' })).toEqual({ ok: false, reason: 'already-ordered' });
  });

  it('refuses a customer with no reachable channel at all', () => {
    expect(eligible({ defaultPhoneNumber: null, defaultEmailAddress: null })).toEqual({ ok: false, reason: 'no-channel' });
  });

  it('refuses nothing', () => {
    expect(subscriberEligible(null, { now: NOW, startAt: '2026-10-01T00:00:00Z', rules: RULES }))
      .toEqual({ ok: false, reason: 'not-found' });
  });

  it('an EMPTY requireAnyTag means everyone, which is the shipped default', () => {
    expect(RULES.subscriberOffer.requireAnyTag).toEqual([]);
    expect(eligible({ tags: [] })).toEqual({ ok: true });
  });

  it('a NON-empty requireAnyTag narrows it to subscribers only', () => {
    const rules = { ...RULES, subscriberOffer: { ...w(), requireAnyTag: ['popup-subscriber', 'newsletter'] } };
    expect(eligible({ tags: ['newsletter'] }, { rules })).toEqual({ ok: true });
    expect(eligible({ tags: ['vip'] }, { rules })).toEqual({ ok: false, reason: 'not-a-subscriber' });
  });

  it('with no startAt at all, nobody qualifies', () => {
    expect(eligible({}, { startAt: '' })).toEqual({ ok: false, reason: 'before-start' });
  });
});

// ---------------------------------------------------------------------------
describe('which channel reaches them', () => {
  const pick = (over) => chooseChannel(normalizeCustomer(customer(over)), { rules: RULES });

  it('WhatsApp whenever there is a usable Indian number', () => {
    expect(pick()).toEqual({ channel: 'whatsapp' });
  });

  it('email when there is no number, which is the whole point of the fallback', () => {
    expect(pick({ defaultPhoneNumber: null })).toEqual({ channel: 'email' });
  });

  /*
   * Email for a number we do not hold AND for one we hold and cannot use:
   * both are WhatsApp being impossible, which is what this channel is for.
   * The difference between them is recorded by phoneSkipReason, not by
   * refusing the person.
   */
  it('email for a record with no number at all, and for a bad one', () => {
    expect(pick({ defaultPhoneNumber: null })).toEqual({ channel: 'email' });
    expect(pick({ defaultPhoneNumber: { phoneNumber: '' } })).toEqual({ channel: 'email' });
    expect(pick({ defaultPhoneNumber: { phoneNumber: '+14155550123' } })).toEqual({ channel: 'email' });
  });

  it('nothing at all when there is neither', () => {
    expect(pick({ defaultPhoneNumber: null, defaultEmailAddress: null })).toEqual({ channel: 'none' });
  });

  /*
   * Owner's decision, 2026-10-24: refuse UNSUBSCRIBED ONLY. The customer
   * record itself is the consent, so NOT_SUBSCRIBED, PENDING and INVALID all
   * pass. There is deliberately no address-format gate; an unusable address
   * fails at SES and lands on `email-send-failed`.
   */
  it.each([['NOT_SUBSCRIBED'], ['PENDING'], ['INVALID'], ['SUBSCRIBED']])('allows an email in state %s', (state) => {
    expect(pick({
      defaultPhoneNumber: null,
      defaultEmailAddress: { emailAddress: EMAIL_FIXTURE, marketingState: state, marketingUnsubscribeUrl: UNSUB_FIXTURE },
    })).toEqual({ channel: 'email' });
  });

  it('refuses an UNSUBSCRIBED email, and only that state', () => {
    expect(pick({
      defaultPhoneNumber: null,
      defaultEmailAddress: { emailAddress: EMAIL_FIXTURE, marketingState: 'UNSUBSCRIBED', marketingUnsubscribeUrl: UNSUB_FIXTURE },
    })).toEqual({ channel: 'none', reason: 'email-unsubscribed' });
  });

  it('nothing when the only email is blank', () => {
    expect(pick({ defaultPhoneNumber: null, defaultEmailAddress: { emailAddress: '   ' } })).toEqual({ channel: 'none' });
  });
});

// ---------------------------------------------------------------------------
describe('the offer guard, against the codes that are really live', () => {
  const guard = (over = {}) =>
    subscriberOfferGuard({
      amountPaise: w().amountInr * 100,
      minimumPaise: minimumPaise(),
      publicCodes: PUBLIC,
      rules: RULES,
      ...over,
    });

  /*
   * R3: both bounds are EQUALITIES with the shipped defaults, so the figures
   * are asserted rather than `ok: true`. Editing offerTiers or beatPublicByInr
   * then fails loudly here instead of silently muting the whole flow.
   */
  it('is built from the two existing cart.mjs primitives, called correctly', () => {
    // tierMaxPaise takes TWO arguments: the paise and rules.cartRecovery.
    expect(tierMaxPaise(minimumPaise(), RULES.cartRecovery)).toBe(20000);
    expect(tierMaxPaise(150000, RULES.cartRecovery)).toBe(16000);
    // BUY2 and BUY3 score nothing because the guard asks with quantity 1 and
    // their minQuantity is 2 and 3.
    expect(bestPublicSavingPaise(PUBLIC, minimumPaise(), 1)).toBe(15000);
    // beatPublicByInr is in RUPEES, so the guard has to multiply by 100.
    expect(RULES.cartRecovery.beatPublicByInr).toBe(50);
  });

  it('the shipped defaults pass against BUY2, BUY3 and WELCOME150 together', () => {
    // THE test this feature exists to keep honest. Rs 200 above Rs 1,500.01:
    // BUY2 and BUY3 need 2 and 3 items so they score nothing on a single-item
    // minimum, WELCOME150 gives Rs 150, so the floor is Rs 150 + Rs 50 = Rs 200
    // and the Rs 2,000 tier ceiling is Rs 200. Exactly on both lines, and that
    // is deliberate: it is the most generous offer the rules allow.
    expect(guard()).toMatchObject({ ok: true, publicBestPaise: 15000, floorPaise: 20000, capPaise: 20000 });
    // Spelled out, because both are exact: 20000 >= 15000 + 5000, 20000 <= 20000.
    expect(w().amountInr * 100).toBe(15000 + RULES.cartRecovery.beatPublicByInr * 100);
    expect(w().amountInr * 100).toBe(tierMaxPaise(minimumPaise(), RULES.cartRecovery));
  });

  it('and it passes against each of the three on its own', () => {
    for (const c of PUBLIC) expect(guard({ publicCodes: [c] }).ok, c.code).toBe(true);
  });

  it('and against no public codes at all', () => {
    expect(guard({ publicCodes: [] })).toMatchObject({ ok: true, floorPaise: 5000 });
  });

  /*
   * If WELCOME200 ever goes live, Rs 200 off stops being a private offer and
   * becomes the same thing anyone can type in off the cart page. The guard must
   * refuse rather than send it.
   */
  it('FAILS the moment a WELCOME200 is live', () => {
    const g = guard({ publicCodes: [...PUBLIC, WELCOME200] });
    expect(g.ok).toBe(false);
    expect(g.reason).toBe('public-offer-better');
    expect(g.floorPaise).toBe(25000);
  });

  it('fails an amount that equals the public best, because equal is not better', () => {
    const g = guard({ amountPaise: 15000 });
    expect(g).toMatchObject({ ok: false, reason: 'public-offer-better' });
  });

  it('fails an amount above the tier ceiling for its own minimum', () => {
    const g = guard({ amountPaise: 30000 });
    expect(g).toMatchObject({ ok: false, reason: 'above-tier-ceiling', capPaise: 20000 });
  });

  /*
   * Rs 1,500 flat lands in the Rs 1,500 tier, whose ceiling is Rs 160, so the
   * Rs 200 offer would be refused. The paisa is not cosmetic.
   */
  it('shows why the minimum is 1500.01 and not 1500', () => {
    expect(guard({ minimumPaise: 150000 })).toMatchObject({ ok: false, reason: 'above-tier-ceiling', capPaise: 16000 });
    expect(guard({ minimumPaise: 150001 })).toMatchObject({ ok: true, capPaise: 20000 });
  });

  it('reads the beat-by figure from cartRecovery, not from a second copy of it', () => {
    const rules = { ...RULES, cartRecovery: { ...RULES.cartRecovery, beatPublicByInr: 100 } };
    expect(guard({ rules })).toMatchObject({ ok: false, reason: 'public-offer-better', floorPaise: 25000 });
  });
});

// ---------------------------------------------------------------------------
describe('the code', () => {
  it('matches the regex the theme uses to leave a private code alone', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = subscriberCode('Priya', RULES);
      expect(RECOVERY_CODE.test(code), code).toBe(true);
    }
  });

  it('is MORPAANKH, the name, and four digits drawn from 2 to 9', () => {
    expect(w().codeDigits).toBe(4);
    for (let i = 0; i < 200; i += 1) {
      expect(subscriberCode('Priya', RULES)).toMatch(/^MORPAANKHPRIYA[2-9]{4}$/);
    }
  });

  it('never uses a 0 or a 1, which read as O and I off a phone screen', () => {
    const digits = new Set();
    for (let i = 0; i < 500; i += 1) {
      for (const d of subscriberCode('Priya', RULES).slice(-4)) digits.add(d);
    }
    expect([...digits].sort().join('')).toBe('23456789');
  });

  it('is drawn from crypto, never from Math.random', () => {
    /*
     * cartCode defaults its rng to Math.random, which is fine for a cart but
     * not for a code that is the only thing standing between a stranger and
     * Rs 200: Math.random is seeded per process and is guessable from a few
     * outputs. So the spy here is the assertion, not a detail.
     */
    const spy = vi.spyOn(Math, 'random');
    for (let i = 0; i < 50; i += 1) subscriberCode('Priya', RULES);
    expect(spy).not.toHaveBeenCalled();
  });

  it('cryptoRng answers inside [0, 1) and does not sit still', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      const v = cryptoRng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('takes an injected rng, so a test can pin the digits', () => {
    expect(subscriberCode('Priya', RULES, { rng: () => 0 })).toBe('MORPAANKHPRIYA2222');
    // 0.999... maps to the top of the 2-9 range.
    expect(subscriberCode('Priya', RULES, { rng: () => 0.999999 })).toBe('MORPAANKHPRIYA9999');
  });

  it('falls back to VIP for a name it cannot render as A to Z', () => {
    expect(subscriberCode('प्रिया', RULES)).toMatch(/^MORPAANKHVIP[2-9]{4}$/);
    expect(subscriberCode('', RULES)).toMatch(/^MORPAANKHVIP[2-9]{4}$/);
  });

  it('shares Flow R prefix and name rules rather than keeping its own', () => {
    expect(subscriberCode('Priya', RULES).startsWith(RULES.cartRecovery.codePrefix)).toBe(true);
    // codeNameMaxLen is 10, so a long name is cut, not left to overflow.
    expect(subscriberCode('Bhavanishankari', RULES)).toMatch(/^MORPAANKHBHAVANISHA[2-9]{4}$/);
  });
});

// ---------------------------------------------------------------------------
describe('the landing link', () => {
  const HOST = 'https://www.morpaankh.in';

  it('applies the code and then forwards to the best sellers, tagged by channel', () => {
    expect(landingUrl({ code: 'MORPAANKHPRIYA4729', channel: 'whatsapp', rules: RULES, host: HOST })).toBe(
      'https://www.morpaankh.in/discount/MORPAANKHPRIYA4729' +
        '?redirect=%2Fcollections%2Fbest-sellers%3Futm_source%3Dwhatsapp%26utm_medium%3Dautomation%26utm_campaign%3Dwelcome_24h',
    );
  });

  it('says email when the email carried it', () => {
    const u = landingUrl({ code: 'MORPAANKHPRIYA4729', channel: 'email', rules: RULES, host: HOST });
    expect(decodeURIComponent(new URL(u).searchParams.get('redirect')))
      .toBe('/collections/best-sellers?utm_source=email&utm_medium=automation&utm_campaign=welcome_24h');
  });

  /*
   * The whole redirect is ONE query parameter, so its own `&` separators have
   * to be percent encoded. Unencoded, utm_medium and utm_campaign would be read
   * as parameters of /discount and the campaign would vanish from GA4.
   */
  it('encodes the redirect so its parameters stay inside it', () => {
    const u = landingUrl({ code: 'X2222', channel: 'whatsapp', rules: RULES, host: HOST });
    expect(u).toContain('%26utm_medium');
    expect([...new URL(u).searchParams.keys()]).toEqual(['redirect']);
  });

  it('escapes anything odd in a code rather than letting it break out of the path', () => {
    const u = landingUrl({ code: 'A/../..?x=1&y=2', channel: 'whatsapp', rules: RULES, host: HOST });
    expect(new URL(u).pathname).toBe('/discount/A%2F..%2F..%3Fx%3D1%26y%3D2');
  });

  it('takes the collection from RULES, so the landing page is a deploy not a template change', () => {
    expect(w().collectionHandle).toBe('best-sellers');
    const rules = { ...RULES, subscriberOffer: { ...w(), collectionHandle: 'new-arrivals' } };
    expect(landingUrl({ code: 'X2222', channel: 'whatsapp', rules, host: HOST })).toContain('%2Fcollections%2Fnew-arrivals');
  });
});

// ---------------------------------------------------------------------------
describe('email addresses', () => {
  it('normalises case and surrounding space', () => {
    expect(normalizeEmail('  Priya.Test@Example.COM ')).toBe('priya.test@example.com');
  });

  it('strips CR and LF, which are a header injection in an address', () => {
    // The address goes into a To: header. A bare CRLF there appends headers of
    // the attacker's choosing to our own message.
    for (const raw of ['priya@example.com\r\nBcc: victim@example.com', 'a@b.com\nX: y', 'a@b.com\rX: y']) {
      expect(normalizeEmail(raw), raw).not.toMatch(/[\r\n]/);
    }
  });

  it('hashes the NORMALISED address, so one person is one key', () => {
    const a = emailKey('  Priya.Test@Example.COM ');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(emailKey('priya.test@example.com'));
    expect(a).not.toBe(emailKey('priya.test2@example.com'));
  });

  /*
   * THE KEY IS AN IDENTITY, NOT AN ADDRESS, and the farm it has to survive is
   * one mailbox wearing many addresses.
   *
   * `a+1@gmail.com`, `a+2@gmail.com` and `a.b@gmail.com` are all the same
   * inbox, but they are three different strings and so were three different
   * lifetime locks. Anyone can register them at /account/register with no
   * phone at all, which makes the email lock the ONLY control standing between
   * one person and a fresh Rs 200 code every day.
   *
   * The sent-to address is normalizeEmail and is deliberately NOT canonicalised
   * here: we must deliver to the address Shopify holds. Only the KEY folds.
   */
  it('folds a plus-tagged alias onto one key, which is the obvious farm', () => {
    const base = emailKey('priya.test@example.com');
    expect(emailKey('priya.test+one@example.com')).toBe(base);
    expect(emailKey('priya.test+two+three@example.com')).toBe(base);
    expect(emailKey('  PRIYA.TEST+Sale@Example.COM  ')).toBe(base);
  });

  it('and folds the gmail dot alias, because that is the same mailbox too', () => {
    const base = emailKey('priyatest@gmail.com');
    expect(emailKey('priya.test@gmail.com')).toBe(base);
    expect(emailKey('p.r.i.y.a.t.e.s.t@gmail.com')).toBe(base);
    // googlemail.com is an alias of gmail.com, not a separate provider.
    expect(emailKey('priya.test+x@googlemail.com')).toBe(base);
  });

  it('but still tells two genuinely different people apart', () => {
    expect(emailKey('a@example.com')).not.toBe(emailKey('b@example.com'));
    expect(emailKey('a@example.com')).not.toBe(emailKey('a@example.net'));
    // A dot is an alias only at Google. Anywhere else it is part of the name,
    // and folding it would deny a real person their one offer.
    expect(emailKey('a.b@example.com')).not.toBe(emailKey('ab@example.com'));
    expect(emailKey('')).toBe(emailKey(null));
  });

  it('is a hash and never the address itself, because the key lands in a DynamoDB PK', () => {
    expect(emailKey('priya.test@example.com')).not.toContain('priya');
    expect(emailKey('priya.test@example.com')).not.toContain('@');
  });

  it('answers empty for nothing', () => {
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
describe('HTML escaping', () => {
  it('escapes every character that could close a tag or an attribute', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes the ampersand FIRST, so an escape cannot be double escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('survives a name shaped like an attribute break-out', () => {
    expect(escapeHtml('" onload="evil()')).toBe('&quot; onload=&quot;evil()');
  });

  it('tolerates a non-string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

// ---------------------------------------------------------------------------
describe('the top picks line', () => {
  const p = (title, over = {}) => ({ title, availableForSale: true, status: 'ACTIVE', ...over });

  it('joins three as "A, B and C"', () => {
    expect(topPicks([p('Khili Dhoop'), p('Bandhan'), p('Morani')])).toBe('Khili Dhoop, Bandhan and Morani');
  });

  it('takes the first three only, in the order it was given', () => {
    expect(topPicks([p('A'), p('B'), p('C'), p('D')])).toBe('A, B and C');
  });

  it('reads naturally with one and with two', () => {
    expect(topPicks([p('A')])).toBe('A');
    expect(topPicks([p('A'), p('B')])).toBe('A and B');
  });

  it('skips a sold-out or draft piece rather than advertising it', () => {
    expect(topPicks([p('Sold', { availableForSale: false }), p('Draft', { status: 'DRAFT' }), p('A'), p('B'), p('C')]))
      .toBe('A, B and C');
  });

  it('falls back when there is nothing to name', () => {
    expect(topPicks([])).toBe('our best sellers');
    expect(topPicks(null)).toBe('our best sellers');
    expect(topPicks([p('', {}), p(null)])).toBe('our best sellers');
  });
});

// ---------------------------------------------------------------------------
describe('the template parameters', () => {
  const rec = { code: 'MORPAANKHPRIYA4729', codeEndsAt: fromISTWall(2026, 9, 25, 11, 0).toISOString() };
  const vars = (over = {}) =>
    subscriberVars({
      n: normalizeCustomer(customer()),
      rec,
      topPicks: 'Khili Dhoop, Bandhan and Morani',
      now: NOW,
      rules: RULES,
      ...over,
    });

  it('renders the SPEC examples exactly', () => {
    expect(vars()).toEqual({
      customer_name: 'Priya',
      code: 'MORPAANKHPRIYA4729',
      saving: '₹200',
      min_order: '₹1,500',
      expires_at: 'tomorrow at 11:00 AM',
      top_picks: 'Khili Dhoop, Bandhan and Morani',
    });
  });

  it('shows the WHOLE rupee minimum to the customer, not the Shopify 1500.01', () => {
    // The code's own minimum carries the extra paisa so that "above Rs 1,500"
    // is literally true. Printing Rs 1,500.01 in the message would be correct
    // and unreadable.
    expect(vars().min_order).toBe('₹1,500');
  });

  /*
   * A WhatsApp body parameter may not contain a newline, a tab, or a run of
   * four or more spaces: Meta rejects the send outright. Every one of these
   * values is interpolated from either Shopify data or a customer's own name.
   */
  it('never contains a newline, a tab or a run of four spaces', () => {
    const hostile = vars({
      n: normalizeCustomer(customer({ firstName: 'Pri\nya\tSharma    x' })),
      topPicks: 'A\nB\tC    D',
    });
    for (const [k, v] of Object.entries(hostile)) {
      expect(/[\n\t]/.test(v), `${k}: ${JSON.stringify(v)}`).toBe(false);
      expect(/ {4,}/.test(v), `${k}: ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('caps every value, so one long product title cannot blow the body past 1024', () => {
    const long = Array.from({ length: 20 }, (_, i) => `A very long piece name number ${i}`).join(', ');
    const out = vars({ topPicks: long });
    for (const [k, v] of Object.entries(out)) expect(v.length, k).toBeLessThanOrEqual(300);
  });

  it('every placeholder is filled, because a blank where a price goes is worse than a crash', () => {
    for (const [k, v] of Object.entries(vars())) expect(String(v).trim(), k).not.toBe('');
  });
});

/*
 * SHADOW MODE HAS TO BE ABLE TO REACH BOTH CHANNELS.
 *
 * The allowlist was compared against the phone alone, which failed CLOSED for
 * an email-only candidate: safe, but it meant a three-day soak could not send
 * one real email, and the email channel would have gone live as the only path
 * in the feature nobody had ever exercised against a real inbox.
 */
describe('the shadow-mode allowlist names either channel', () => {
  const whatsappCandidate = { phone: '+919999999999', email: 'someone@example.com' };
  const emailOnly = { phone: null, email: 'owner@example.com' };

  it('matches a phone entry against a phone candidate', () => {
    expect(onSubscriberAllowlist(whatsappCandidate, ['+919999999999'])).toBe(true);
    expect(onSubscriberAllowlist(whatsappCandidate, ['+918888888888'])).toBe(false);
  });

  it('matches an email entry against a candidate who has no usable number', () => {
    expect(onSubscriberAllowlist(emailOnly, ['owner@example.com'])).toBe(true);
    expect(onSubscriberAllowlist(emailOnly, ['+919999999999'])).toBe(false);
  });

  it('canonicalises BOTH sides, so a plus-tagged entry still matches the record', () => {
    expect(onSubscriberAllowlist({ phone: null, email: 'owner@gmail.com' }, ['ow.ner+soak@googlemail.com'])).toBe(true);
  });

  it('one list can carry both channels at once', () => {
    const list = ['+919999999999', 'owner@example.com'];
    expect(onSubscriberAllowlist(whatsappCandidate, list)).toBe(true);
    expect(onSubscriberAllowlist(emailOnly, list)).toBe(true);
    expect(onSubscriberAllowlist({ phone: '+917777777777', email: 'stranger@example.com' }, list)).toBe(false);
  });

  it('and nothing matches an empty entry, a null candidate or an empty list', () => {
    expect(onSubscriberAllowlist(emailOnly, ['', '  '])).toBe(false);
    expect(onSubscriberAllowlist(null, ['owner@example.com'])).toBe(false);
    expect(onSubscriberAllowlist(emailOnly, [])).toBe(false);
  });
});
