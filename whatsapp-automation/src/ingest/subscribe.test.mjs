import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../clients/shopify.mjs', () => ({ shopify: { graphql: vi.fn() } }));

import { shopify } from '../clients/shopify.mjs';
import { config } from '../config.mjs';
import { handler, normalizePhone, normalizeEmail, cleanName, splitName } from './subscribe.mjs';

const ORIGIN = 'https://www.morpaankh.in';
let ipSeq = 0;

/** A POST from the real storefront, each call on a fresh IP so the rate
 *  limiter's memory backend does not leak between tests. */
const post = (body, { origin = ORIGIN, ip } = {}) =>
  handler({
    requestContext: { http: { method: 'POST', sourceIp: ip || `10.0.0.${++ipSeq}` } },
    headers: { origin },
    body: JSON.stringify(body),
  });

const GOOD = { email: 'asha@example.com', phone: '+919876543210', name: 'Asha' };
const body = (r) => JSON.parse(r.body);

beforeEach(() => {
  shopify.graphql.mockReset();
  config.dryRun = false;
});

describe('normalizers', () => {
  it('holds the Indian mobile rule instead of trusting the client', () => {
    expect(normalizePhone('+919876543210')).toBe('+919876543210');
    expect(normalizePhone('+91 98765 43210')).toBe('+919876543210'); // spaces stripped
    expect(normalizePhone('+915876543210')).toBeNull(); // must start 6-9
    expect(normalizePhone('+91987654321')).toBeNull(); // 9 digits
    expect(normalizePhone('9876543210')).toBeNull(); // no country code
    expect(normalizePhone('+14155552671')).toBe('+14155552671'); // other countries pass
  });
  it('rejects an email that could break out of the Shopify search string', () => {
    expect(normalizeEmail('  Asha@Example.com ')).toBe('asha@example.com');
    expect(normalizeEmail('a"b@example.com')).toBeNull();
    expect(normalizeEmail('nope')).toBeNull();
  });
  it('strips control characters from the name', () => {
    expect(cleanName(' As\u0000ha \n')).toBe('Asha');
  });
  it('splits a typed name into the two fields Shopify shows', () => {
    expect(splitName('Asha')).toEqual({ firstName: 'Asha' });
    expect(splitName('Asha  Verma')).toEqual({ firstName: 'Asha', lastName: 'Verma' });
    expect(splitName('Asha Rani Verma')).toEqual({ firstName: 'Asha', lastName: 'Rani Verma' });
    expect(splitName('  ')).toBeNull();
  });
});

describe('guards', () => {
  it('refuses an origin that is not the storefront, with no CORS header', async () => {
    const r = await post(GOOD, { origin: 'https://evil.example' });
    expect(r.statusCode).toBe(403);
    expect(r.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(shopify.graphql).not.toHaveBeenCalled();
  });

  it('answers the preflight for an allowed origin', async () => {
    const r = await handler({
      requestContext: { http: { method: 'OPTIONS' } },
      headers: { origin: ORIGIN },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
  });

  it('looks successful to a bot but writes nothing', async () => {
    const r = await post({ ...GOOD, hp: 'http://spam.example' });
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({ ok: true, status: 'created' });
    expect(shopify.graphql).not.toHaveBeenCalled();
  });

  it('rejects a missing name, a bad phone and a typo-ed email before touching Shopify', async () => {
    expect(body(await post({ ...GOOD, name: '' })).error).toBe('invalid_name');
    expect(body(await post({ ...GOOD, name: 'A' })).error).toBe('invalid_name');
    expect(body(await post({ ...GOOD, phone: '12345' })).error).toBe('invalid_phone');
    // Optional does not mean anything goes: a half typed address is still 422.
    expect(body(await post({ ...GOOD, email: 'nope' })).error).toBe('invalid_email');
    expect(shopify.graphql).not.toHaveBeenCalled();
  });

  it('rate limits the sixth attempt from one IP', async () => {
    shopify.graphql.mockResolvedValue({ customerByIdentifier: null, customerCreate: { userErrors: [], customer: { id: 'gid://shopify/Customer/1', defaultPhoneNumber: { phoneNumber: GOOD.phone } } } });
    const ip = '203.0.113.9';
    for (let i = 0; i < 5; i++) expect((await post(GOOD, { ip })).statusCode).toBe(200);
    const sixth = await post(GOOD, { ip });
    expect(sixth.statusCode).toBe(429);
    expect(body(sixth).error).toBe('rate_limited');
  });
});

describe('saving', () => {
  /* The lookup is two exact reads (email, then phone), not one search, so the
   * mocks below queue them in that order. */
  const none = () => ({ customerByIdentifier: null });
  /* Subscribed by default so the update tests need no consent mock; the two
   * consent tests below override marketingState explicitly. */
  const found = (c) => ({
    customerByIdentifier: {
      defaultEmailAddress: { emailAddress: GOOD.email, marketingState: 'SUBSCRIBED' },
      ...c,
    },
  });
  const updated = { customerUpdate: { userErrors: [], customer: { id: 'x' } } };

  it('creates a customer carrying the phone, consent and both tags', async () => {
    shopify.graphql
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce({ customerCreate: { userErrors: [], customer: { id: 'gid://shopify/Customer/1', tags: [], defaultPhoneNumber: { phoneNumber: GOOD.phone } } } });

    const r = await post(GOOD);
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({ ok: true, status: 'created' });

    const input = shopify.graphql.mock.calls[2][1].input;
    expect(input.phone).toBe('+919876543210');
    expect(input.firstName).toBe('Asha');
    expect(input.emailMarketingConsent.marketingState).toBe('SUBSCRIBED');
    expect(input.tags).toEqual(['popup-subscriber', 'whatsapp-optin']);
  });

  it('updates the customer found by email, keeps their tags, and says already', async () => {
    shopify.graphql
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/7', tags: ['vip'], defaultPhoneNumber: null }))
      .mockResolvedValueOnce(updated);

    expect(body(await post(GOOD))).toEqual({ ok: true, status: 'already' });
    const input = shopify.graphql.mock.calls[1][1].input;
    expect(input.id).toBe('gid://shopify/Customer/7');
    expect(input.tags).toEqual(['vip', 'popup-subscriber', 'whatsapp-optin']);
    expect(input.phone).toBe('+919876543210'); // had none on file, so fill it
  });

  it('finds them by phone when they sign up again under a new email', async () => {
    shopify.graphql
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/10', tags: [], defaultPhoneNumber: { phoneNumber: GOOD.phone } }))
      .mockResolvedValueOnce(updated);

    expect(body(await post(GOOD))).toEqual({ ok: true, status: 'already' });
    expect(shopify.graphql.mock.calls[2][1].input.id).toBe('gid://shopify/Customer/10');
  });

  it('never overwrites a number already on file, and flags the conflict', async () => {
    shopify.graphql
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/8', tags: [], defaultPhoneNumber: { phoneNumber: '+919000000001' } }))
      .mockResolvedValueOnce(updated);

    await post(GOOD);
    const input = shopify.graphql.mock.calls[1][1].input;
    expect(input.phone).toBeUndefined();
    expect(input.tags).toContain('phone-mismatch');
  });

  /* Regression: this returned 502 in production. Two submits seconds apart both
   * passed the lookup, and the second died on "Email has already been taken"
   * instead of reporting that they were already on the list. */
  it('recovers when the create collides on an email that the lookup missed', async () => {
    shopify.graphql
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce({ customerCreate: { userErrors: [{ field: ['email'], message: 'Email has already been taken' }] } })
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/11', tags: [], defaultPhoneNumber: null }))
      .mockResolvedValueOnce(updated);

    const r = await post(GOOD);
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({ ok: true, status: 'already' });
    expect(shopify.graphql.mock.calls[4][1].input.id).toBe('gid://shopify/Customer/11');
  });

  it('recovers when the phone already belongs to another customer', async () => {
    shopify.graphql
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce({ customerCreate: { userErrors: [{ field: ['phone'], message: 'Phone has already been taken' }] } })
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/9', tags: [], defaultPhoneNumber: { phoneNumber: GOOD.phone } }))
      .mockResolvedValueOnce(updated);

    const r = await post(GOOD);
    expect(r.statusCode).toBe(200);
    expect(shopify.graphql.mock.calls[5][1].input.id).toBe('gid://shopify/Customer/9');
  });

  /* emailMarketingConsent is rejected by customerUpdate at runtime even though
   * it validates against the schema, so consent on the update path is its own
   * mutation. This is what a live 502 taught us. */
  it('sets consent through its own mutation when they were not subscribed', async () => {
    shopify.graphql
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/12', tags: [], defaultPhoneNumber: null, defaultEmailAddress: { marketingState: 'NOT_SUBSCRIBED' } }))
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce({ customerEmailMarketingConsentUpdate: { userErrors: [], customer: { id: 'x' } } });

    expect(body(await post(GOOD))).toEqual({ ok: true, status: 'already' });
    const [query, vars] = shopify.graphql.mock.calls[2];
    expect(query).toContain('customerEmailMarketingConsentUpdate');
    expect(vars.input.customerId).toBe('gid://shopify/Customer/12');
    expect(vars.input.emailMarketingConsent.marketingState).toBe('SUBSCRIBED');
    // and never on customerUpdate, which is what Shopify refuses
    expect(shopify.graphql.mock.calls[1][1].input.emailMarketingConsent).toBeUndefined();
  });

  it('leaves consent alone when they are already subscribed', async () => {
    shopify.graphql
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/13', tags: [] }))
      .mockResolvedValueOnce(updated);
    await post(GOOD);
    expect(shopify.graphql).toHaveBeenCalledTimes(2);
  });

  /* The popup makes the email optional: WhatsApp is the channel this list is
   * for. Shopify accepts a customer with "a name, phone number or email
   * address", so the name and phone are enough to create one. */
  it('creates a customer with no email at all, and asks for no consent', async () => {
    shopify.graphql
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce({ customerCreate: { userErrors: [], customer: { id: 'gid://shopify/Customer/20', tags: [], defaultPhoneNumber: { phoneNumber: GOOD.phone } } } });

    const r = await post({ phone: GOOD.phone, name: 'Asha Verma' });
    expect(body(r)).toEqual({ ok: true, status: 'created' });

    // One lookup, not two: with no email there is nothing to look up by.
    expect(shopify.graphql).toHaveBeenCalledTimes(2);
    expect(shopify.graphql.mock.calls[0][1].id.phoneNumber).toBe(GOOD.phone);

    const input = shopify.graphql.mock.calls[1][1].input;
    expect(input.phone).toBe(GOOD.phone);
    expect(input.firstName).toBe('Asha');
    expect(input.lastName).toBe('Verma');
    expect(input.tags).toEqual(['popup-subscriber', 'whatsapp-optin']);
    expect(input.email).toBeUndefined();
    expect(input.emailMarketingConsent).toBeUndefined();
  });

  it('adds an email to a record that has none, and then asks for consent', async () => {
    shopify.graphql
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/21', tags: [], defaultEmailAddress: null, defaultPhoneNumber: { phoneNumber: GOOD.phone } }))
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce({ customerEmailMarketingConsentUpdate: { userErrors: [], customer: { id: 'x' } } });

    expect(body(await post(GOOD))).toEqual({ ok: true, status: 'already' });
    expect(shopify.graphql.mock.calls[1][1].input.email).toBe(GOOD.email);
    expect(shopify.graphql.mock.calls[2][0]).toContain('customerEmailMarketingConsentUpdate');
  });

  it('never overwrites an address already on file', async () => {
    shopify.graphql
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/22', tags: [], defaultEmailAddress: { emailAddress: 'old@example.com', marketingState: 'SUBSCRIBED' }, defaultPhoneNumber: { phoneNumber: GOOD.phone } }))
      .mockResolvedValueOnce(updated);

    await post(GOOD);
    expect(shopify.graphql.mock.calls[2][1].input.email).toBeUndefined();
  });

  it('skips consent entirely for a signup with no email on either side', async () => {
    shopify.graphql
      .mockResolvedValueOnce(found({ id: 'gid://shopify/Customer/23', tags: [], defaultEmailAddress: null, defaultPhoneNumber: { phoneNumber: GOOD.phone } }))
      .mockResolvedValueOnce(updated);

    expect(body(await post({ phone: GOOD.phone, name: 'Asha' }))).toEqual({ ok: true, status: 'already' });
    expect(shopify.graphql).toHaveBeenCalledTimes(2); // lookup + update, no consent
  });

  it('reports a Shopify failure as 502 without leaking the reason', async () => {
    shopify.graphql.mockRejectedValue(new Error('boom'));
    const r = await post(GOOD);
    expect(r.statusCode).toBe(502);
    expect(body(r)).toEqual({ ok: false, error: 'save_failed' });
  });
});
