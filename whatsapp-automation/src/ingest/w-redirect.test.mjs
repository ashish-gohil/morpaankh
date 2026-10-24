/*
 * GET /w/{token} — the "Shop best sellers" button.
 *
 * This is the only part of Flow W a stranger can reach, and the only input it
 * is allowed to read is the token in the path. HOST, PATH and CODE all come
 * from the record and from a module constant, never from the request, which is
 * what makes it impossible to turn into an open redirect.
 *
 * Mirrors ingest/cart-redirect.mjs, including: an unknown token is a redirect
 * and never an error, click counting is best effort and never decides the
 * response, and every response is no-store.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RULES } from '../../messages/rules.mjs';
import { _resetMemory } from '../store/table.mjs';
import { ensureSubRec, patchSubRec, setSubLinkMap, getSubRec } from '../store/subscriberOffer.mjs';
import { handler } from './w-redirect.mjs';
import { isRealTap } from './cart-redirect.mjs';

const TOKEN = 'tok_w_abc123';
const ID = '25164544835956';
const CODE = 'MORPAANKHPRIYA4729';
const COLLECTION = 'https://www.morpaankh.in/collections/best-sellers';
const APPLIED =
  'https://www.morpaankh.in/discount/MORPAANKHPRIYA4729' +
  '?redirect=%2Fcollections%2Fbest-sellers%3Futm_source%3Dwhatsapp%26utm_medium%3Dautomation%26utm_campaign%3Dwelcome_24h';

const event = (over = {}) => ({
  pathParameters: { token: TOKEN },
  requestContext: { http: { method: 'GET' } },
  headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' },
  ...over,
});

async function seed(fields = {}, { token = TOKEN, channel = 'whatsapp' } = {}) {
  await ensureSubRec(ID, {
    phone: '+919637361371',
    channel,
    code: CODE,
    // The handler has no injected clock: a customer's tap arrives whenever it
    // arrives. So the fixture is anchored to the real now, as cart-redirect's
    // own suite does.
    codeEndsAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    ...fields,
  });
  await setSubLinkMap(token, ID, channel);
}

beforeEach(() => {
  _resetMemory();
});

// ---------------------------------------------------------------------------
describe('a real tap', () => {
  it('applies the code and lands them on the best sellers', async () => {
    await seed();
    const res = await handler(event());
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe(APPLIED);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toBe('');
  });

  it('tags the tap with the channel the link was sent through', async () => {
    await seed({}, { channel: 'email' });
    const res = await handler(event());
    expect(decodeURIComponent(new URL(res.headers.Location).searchParams.get('redirect')))
      .toBe('/collections/best-sellers?utm_source=email&utm_medium=automation&utm_campaign=welcome_24h');
  });

  it('counts the tap, and a second one, without moving the first', async () => {
    await seed();
    await handler(event());
    const first = await getSubRec(ID);
    expect(first.clicks).toBe(1);
    expect(first.firstClickAt).toBeTruthy();

    await handler(event());
    const second = await getSubRec(ID);
    expect(second.clicks).toBe(2);
    expect(second.firstClickAt).toBe(first.firstClickAt);
  });

  it('reads the collection out of RULES, so the landing page is a deploy', async () => {
    expect(RULES.subscriberOffer.collectionHandle).toBe('best-sellers');
    await seed();
    const res = await handler(event());
    expect(res.headers.Location).toContain(encodeURIComponent(`/collections/${RULES.subscriberOffer.collectionHandle}`));
  });
});

// ---------------------------------------------------------------------------
describe('a link that is no use any more', () => {
  it('an unknown, guessed or truncated token goes to the collection, not an error', async () => {
    await seed();
    for (const token of ['nope', '', 'a'.repeat(64), CODE, TOKEN.slice(0, 6)]) {
      const res = await handler(event({ pathParameters: { token } }));
      expect(res.statusCode, token).toBe(302);
      expect(res.headers.Location, token).toBe(COLLECTION);
      expect(res.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('no token at all goes to the collection', async () => {
    const res = await handler(event({ pathParameters: null }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe(COLLECTION);
  });

  it('a token mapped to a record that is gone goes to the collection', async () => {
    await setSubLinkMap(TOKEN, 'nosuchcustomer', 'whatsapp');
    const res = await handler(event());
    expect(res.headers.Location).toBe(COLLECTION);
  });

  it('an expired code goes to the collection WITHOUT a code', async () => {
    await seed({ codeEndsAt: new Date(Date.now() - 1000).toISOString() });
    const res = await handler(event());
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe(COLLECTION);
    // The dead code must not travel: /discount/<dead code> would set a cookie
    // Shopify then silently ignores at checkout.
    expect(res.headers.Location).not.toContain(CODE);
    expect(res.headers.Location).not.toContain('/discount/');
  });

  it('a record with no code at all goes to the collection', async () => {
    await seed({ code: null });
    expect((await handler(event())).headers.Location).toBe(COLLECTION);
  });
});

// ---------------------------------------------------------------------------
describe('only real taps are counted', () => {
  /*
   * WhatsApp fetches every link it shows to build a preview card, and so does
   * Facebook's scraper. Counting those would report a tap on every message we
   * ever sent, which is the difference between measuring this flow and
   * inventing a number for it.
   */
  it('a preview fetch, a bot and a HEAD are redirected but never counted', async () => {
    for (const ua of ['WhatsApp/2.23.20.0', 'facebookexternalhit/1.1', 'Googlebot/2.1', 'TelegramBot (like TwitterBot)', 'Slackbot-LinkExpanding 1.0']) {
      _resetMemory();
      await seed();
      const res = await handler(event({ headers: { 'user-agent': ua } }));
      expect(res.statusCode, ua).toBe(302);
      expect(res.headers.Location, ua).toBe(APPLIED);
      expect((await getSubRec(ID)).clicks, ua).toBeUndefined();
    }

    _resetMemory();
    await seed();
    const head = await handler(event({ requestContext: { http: { method: 'HEAD' } } }));
    expect(head.statusCode).toBe(302);
    expect((await getSubRec(ID)).clicks).toBeUndefined();
  });

  /*
   * R14: isRealTap and its BOT regex are EXPORTED from cart-redirect.mjs and
   * reused here, rather than copied into a second file where the two can
   * drift. This test is what fails if somebody duplicates the regex instead.
   */
  it('shares one bot test with the cart redirect, rather than a second copy', () => {
    expect(typeof isRealTap).toBe('function');
    expect(isRealTap(event())).toBe(true);
    expect(isRealTap(event({ headers: { 'user-agent': 'WhatsApp/2.23.20.0' } }))).toBe(false);
    expect(isRealTap(event({ requestContext: { http: { method: 'HEAD' } } }))).toBe(false);
  });

  it('counts the tap even when a header is missing entirely', async () => {
    await seed();
    await handler(event({ headers: {} }));
    expect((await getSubRec(ID)).clicks).toBe(1);
  });

  it('still answers when the click write fails, because the tap must not be lost', async () => {
    await seed();
    const { table } = await import('../store/table.mjs');
    const spy = vi.spyOn(table, 'update').mockRejectedValue(new Error('dynamo is having a bad minute'));
    try {
      const res = await handler(event());
      expect(res.statusCode).toBe(302);
      expect(res.headers.Location).toBe(APPLIED);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
describe('nothing in the request can change where they go', () => {
  /*
   * THE open-redirect test. Everything a caller controls is tried against the
   * one field that matters, and the Location must come out identical every
   * time. Host, path and code come from the record and from the module's own
   * STORE constant, so there is nothing here for an attacker to steer.
   */
  const attacks = [
    ['a redirect query parameter', { queryStringParameters: { redirect: 'https://evil.example/phish' } }],
    ['a double-encoded redirect', { queryStringParameters: { redirect: '%2F%2Fevil.example' } }],
    ['a code query parameter', { queryStringParameters: { code: 'BUY3', discount: 'BUY3' } }],
    ['a host query parameter', { queryStringParameters: { host: 'evil.example', url: 'https://evil.example' } }],
    ['a forged Host header', { headers: { host: 'evil.example', 'user-agent': 'Mozilla/5.0' } }],
    ['a forged X-Forwarded-Host', { headers: { 'x-forwarded-host': 'evil.example', 'user-agent': 'Mozilla/5.0' } }],
    ['a forged X-Forwarded-Proto', { headers: { 'x-forwarded-proto': 'http', 'user-agent': 'Mozilla/5.0' } }],
    ['a forged Referer', { headers: { referer: 'https://evil.example', 'user-agent': 'Mozilla/5.0' } }],
    ['a rawPath that climbs out of the route', { rawPath: '/w/tok_w_abc123/../../evil', rawQueryString: 'redirect=https://evil.example' }],
    ['a cookie', { headers: { cookie: 'discount_code=BUY3', 'user-agent': 'Mozilla/5.0' } }],
    ['a body, on a GET', { body: JSON.stringify({ redirect: 'https://evil.example' }) }],
    ['multiValue query parameters', { multiValueQueryStringParameters: { redirect: ['https://evil.example'] } }],
    ['a stage variable', { stageVariables: { host: 'evil.example' } }],
  ];

  it.each(attacks)('ignores %s', async (_name, over) => {
    await seed();
    const res = await handler(event(over));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe(APPLIED);
    expect(res.headers.Location).not.toContain('evil.example');
    expect(res.headers.Location).not.toContain('BUY3');
  });

  it('a path-traversal token is just an unknown token', async () => {
    await seed();
    for (const token of ['../../etc/passwd', '..%2f..%2fetc', 'tok_w_abc123/../x', '%00', 'tok_w_abc123%00']) {
      const res = await handler(event({ pathParameters: { token } }));
      expect(res.statusCode, token).toBe(302);
      expect(res.headers.Location, token).toBe(COLLECTION);
    }
  });

  it('an absolute URL as the token cannot become the Location', async () => {
    await seed();
    for (const token of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      const res = await handler(event({ pathParameters: { token } }));
      expect(res.headers.Location, token).toBe(COLLECTION);
    }
  });

  it('a hostile code on the RECORD is still escaped into the path', async () => {
    // Not reachable today, because the code is generated. It is asserted
    // anyway: the record is the only input this route trusts, so "trusted"
    // must not mean "interpolated raw".
    await seed({ code: 'X2222?redirect=https://evil.example' });
    const res = await handler(event());
    expect(res.headers.Location).not.toContain('evil.example');
    const u = new URL(res.headers.Location);
    expect(u.host).toBe('www.morpaankh.in');
    expect(u.pathname).toBe('/discount/X2222%3Fredirect%3Dhttps%3A%2F%2Fevil.example');
    expect([...u.searchParams.keys()]).toEqual(['redirect']);
    expect(decodeURIComponent(u.searchParams.get('redirect'))).toBe(
      '/collections/best-sellers?utm_source=whatsapp&utm_medium=automation&utm_campaign=welcome_24h',
    );
  });

  it('always answers from the one hard-coded store host', async () => {
    await seed();
    const res = await handler(event());
    expect(new URL(res.headers.Location).origin).toBe('https://www.morpaankh.in');
  });
});

// ---------------------------------------------------------------------------
describe('what reaches the logs', () => {
  let lines;
  beforeEach(() => {
    lines = [];
    for (const m of ['log', 'warn', 'error']) vi.spyOn(console, m).mockImplementation((...a) => lines.push(a.join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('never the token, the code or the phone number, on any branch', async () => {
    await seed();
    await handler(event());
    await handler(event({ pathParameters: { token: 'nope' } }));
    _resetMemory();
    await seed({ codeEndsAt: new Date(Date.now() - 1000).toISOString() });
    await handler(event());

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    // The token is a bearer credential for a Rs 200 code, and the code itself
    // is the thing being protected.
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(CODE);
    expect(all).not.toContain('919637361371');
  });
});
