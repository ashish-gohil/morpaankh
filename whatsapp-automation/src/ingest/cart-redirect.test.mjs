import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RULES } from '../../messages/rules.mjs';
import { _resetMemory } from '../store/table.mjs';
import { ensureRec, patchRec, setCartLinkMap, getRec } from '../store/cartRecovery.mjs';
import { handler, buildTarget } from './cart-redirect.mjs';

const KEY = 'f80d755c9a3f750485d1e79aaf1e8b95';
const RECOVERY = `https://www.morpaankh.in/99862610292/checkouts/ac/hWNHsKi3/recover?key=${KEY}&locale=en-IN`;
const TOKEN = 'tok_abc123';
const ID = '66743166239092';

const rulesWith = (over) => ({ cartRecovery: { ...RULES.cartRecovery, ...over } });

const event = (over = {}) => ({
  pathParameters: { token: TOKEN },
  requestContext: { http: { method: 'GET' } },
  headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' },
  ...over,
});

async function seed(fields = {}) {
  await ensureRec(ID, {
    phone: '+919637361371',
    code: 'MORPAANKHBHARTI47',
    recoveryUrl: RECOVERY,
    codeEndsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    cartItems: [{ v: '54758494110068', q: 1 }],
    ...fields,
  });
  await setCartLinkMap(TOKEN, ID);
}

beforeEach(() => {
  _resetMemory();
});

describe('buildTarget', () => {
  const rec = { code: 'MORPAANKHBHARTI47', recoveryUrl: RECOVERY, cartItems: [{ v: '999', q: 2 }, { v: '888', q: 1 }] };

  it('query style hands the code to the saved checkout', () => {
    const t = buildTarget(rec, rulesWith({ linkTarget: 'checkout', checkoutLinkStyle: 'query' }));
    expect(t).toBe(`${RECOVERY}&discount=MORPAANKHBHARTI47`);
    // The checkout itself is preserved, key and all: that is what makes it
    // THEIR bag rather than a fresh one.
    expect(t).toContain('/checkouts/ac/hWNHsKi3/recover');
  });

  it('path style applies the code first and then forwards to the same checkout', () => {
    const t = buildTarget(rec, rulesWith({ linkTarget: 'checkout', checkoutLinkStyle: 'path' }));
    expect(t.startsWith('https://www.morpaankh.in/discount/MORPAANKHBHARTI47?redirect=')).toBe(true);
    const redirect = decodeURIComponent(new URL(t).searchParams.get('redirect'));
    expect(redirect).toBe(`/99862610292/checkouts/ac/hWNHsKi3/recover?key=${KEY}&locale=en-IN`);
  });

  it('cart style rebuilds the bag as a permalink', () => {
    const t = buildTarget(rec, rulesWith({ linkTarget: 'cart' }));
    expect(t).toBe('https://www.morpaankh.in/cart/999:2,888:1?discount=MORPAANKHBHARTI47&storefront=true');
  });

  it('falls back to the shop rather than build a broken link', () => {
    expect(buildTarget({ code: 'X', recoveryUrl: null }, rulesWith({}))).toBe('https://www.morpaankh.in');
    expect(buildTarget({ code: 'X', recoveryUrl: RECOVERY, cartItems: [] }, rulesWith({ linkTarget: 'cart' })))
      .toBe('https://www.morpaankh.in');
  });
});

describe('GET /r/{token}', () => {
  it('sends them to their checkout with the code applied, and counts the tap', async () => {
    await seed();
    const res = await handler(event());
    expect(res.statusCode).toBe(302);
    /*
     * The style RULES actually ships, measured on the live storefront on
     * 13 Oct: /discount/<CODE>?redirect=... answers 302 and sets the
     * discount_code cookie, while a bare ?discount= sets nothing. If the
     * default is ever moved back, this is the test that notices.
     */
    expect(res.headers.Location).toContain('/discount/MORPAANKHBHARTI47?redirect=');
    const back = decodeURIComponent(new URL(res.headers.Location).searchParams.get('redirect'));
    expect(back).toContain('/checkouts/ac/hWNHsKi3/recover');
    expect(res.headers['Cache-Control']).toBe('no-store');
    const rec = await getRec(ID);
    expect(rec.clicks).toBe(1);
    expect(rec.firstClickAt).toBeTruthy();
  });

  it('an unknown, guessed or truncated token goes to the shop, not an error', async () => {
    const res = await handler(event({ pathParameters: { token: 'nope' } }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('https://www.morpaankh.in');
  });

  it('serves the closed page, still carrying their bag, once the code has ended', async () => {
    await seed({ codeEndsAt: new Date(Date.now() - 1000).toISOString() });
    const res = await handler(event());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Your private code has closed, but your bag is still saved.');
    expect(res.body).toContain('Continue to my bag');
    // Their checkout, without a code, because the code genuinely has gone.
    expect(res.body).toContain('/checkouts/ac/hWNHsKi3/recover');
    expect(res.body).not.toContain('discount=');
    // That button carries the recovery key, so nothing in between may keep it.
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('serves the thank-you page once the order is attributed', async () => {
    await seed();
    await patchRec(ID, { orderId: '5551212' });
    const res = await handler(event());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Your order is placed. Thank you for choosing Morpaankh.');
    expect(res.body).toContain('Visit Morpaankh');
  });

  /*
   * WhatsApp fetches every link it shows to build a preview card, and so does
   * Facebook's scraper. Counting those would have reported a click on every
   * message we ever sent.
   */
  it('does not count a preview fetch, a bot or a HEAD as a tap', async () => {
    for (const ua of ['WhatsApp/2.23', 'facebookexternalhit/1.1', 'Googlebot/2.1', 'TelegramBot']) {
      _resetMemory();
      await seed();
      await handler(event({ headers: { 'user-agent': ua } }));
      expect((await getRec(ID)).clicks).toBeUndefined();
    }
    _resetMemory();
    await seed();
    await handler(event({ requestContext: { http: { method: 'HEAD' } } }));
    expect((await getRec(ID)).clicks).toBeUndefined();
  });

  it('still redirects a bot, so the preview card renders', async () => {
    await seed();
    const res = await handler(event({ headers: { 'user-agent': 'WhatsApp/2.23' } }));
    expect(res.statusCode).toBe(302);
  });

  it('counts a second real tap without moving the first one', async () => {
    await seed();
    await handler(event());
    const first = (await getRec(ID)).firstClickAt;
    await handler(event());
    const rec = await getRec(ID);
    expect(rec.clicks).toBe(2);
    expect(rec.firstClickAt).toBe(first);
  });
});

describe('the recovery key is a credential', () => {
  let lines;
  beforeEach(() => {
    lines = [];
    for (const m of ['log', 'warn', 'error']) vi.spyOn(console, m).mockImplementation((...a) => lines.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('never reaches a log line, on any branch', async () => {
    await seed();
    await handler(event());
    await handler(event({ pathParameters: { token: 'nope' } }));
    await patchRec(ID, { orderId: '1' });
    await handler(event());
    _resetMemory();
    await seed({ codeEndsAt: new Date(Date.now() - 1000).toISOString() });
    await handler(event());

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('key=');
    expect(all).not.toContain('/recover');

    // It does travel in the Location header, which is the one place it has to:
    // that header is what carries the customer into their own saved checkout.
    _resetMemory();
    await seed();
    const res = await handler(event());
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toContain(KEY);
    // And still nothing new in the logs.
    expect(lines.join('\n')).not.toContain(KEY);
  });
});
