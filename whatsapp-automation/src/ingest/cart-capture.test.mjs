import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../store/cartCapture.mjs', () => ({ putCapture: vi.fn() }));
/*
 * putNew has to REFUSE A SECOND WRITE to the same key, not just record the
 * call: every cap in this endpoint is counted by claiming numbered slots until
 * one is free, so a mock that always says yes makes all three uncountable.
 */
const h = vi.hoisted(() => ({ claimed: new Set() }));
vi.mock('../store/table.mjs', () => ({
  table: {
    putNew: vi.fn(async (item) => {
      const k = `${item.PK} ${item.SK}`;
      if (h.claimed.has(k)) return false;
      h.claimed.add(k);
      return true;
    }),
  },
}));
vi.mock('../log.mjs', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metric: vi.fn(),
  maskPhone: (p) => `***${String(p).slice(-4)}`,
}));

import { putCapture } from '../store/cartCapture.mjs';
import { log, metric } from '../log.mjs';
import { handler, cleanToken, cleanItems, cleanAttrs } from './cart-capture.mjs';

const ORIGIN = 'https://www.morpaankh.in';
let ipSeq = 0;

const post = (body, { origin = ORIGIN, method = 'POST', raw } = {}) =>
  handler({
    requestContext: { http: { method, sourceIp: `10.0.0.${++ipSeq}` } },
    headers: { origin },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });

const GOOD = { phone: '919876543210', token: 'abcdefgh12345678', items: [{ id: '54759640039796', qty: 2 }] };

beforeEach(() => {
  h.claimed.clear();
  vi.mocked(putCapture).mockReset().mockResolvedValue('cap_abcdefgh12345678');
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.info).mockReset();
  vi.mocked(log.error).mockReset();
  vi.mocked(metric).mockReset();
});

describe('validation', () => {
  it('reads the bag as variant gids and quantities only', () => {
    expect(cleanItems([{ id: '123456', qty: 1 }])).toEqual([{ id: 'gid://shopify/ProductVariant/123456', qty: 1 }]);
    expect(cleanItems([{ id: '123456', qty: 1 }, { id: 'nope', qty: 1 }])).toBeNull(); // all or nothing
    expect(cleanItems([])).toBeNull();
  });
  it('refuses a token that is not shaped like a Shopify cart token', () => {
    expect(cleanToken('abcdefgh12345678')).toBe('abcdefgh12345678');
    expect(cleanToken('short')).toBeNull();
    expect(cleanToken('../../etc/passwd')).toBeNull();
  });

  /*
   * THE ONE THAT WAS LIVE. /cart.js hands the browser
   * "<token>?key=<credential>" and the old pattern refused the lot, so every
   * post a real shopper's browser made came back invalid_token while the
   * checkout webhook, which sees the token without the suffix, was accepted
   * for the same bag. The suffix must be dropped, not allowed: it is a
   * credential, and keeping it would file one bag under two keys.
   */
  it('drops the key= credential /cart.js staples to the token', () => {
    expect(cleanToken('hWNIX6UNMbUsdHagyPXGGLXF?key=0a1111a11aa11aaaaaa1111a1111a111'))
      .toBe('hWNIX6UNMbUsdHagyPXGGLXF');
    // and both sources then agree on one row
    expect(cleanToken('hWNIX6UNMbUsdHagyPXGGLXF?key=deadbeef'))
      .toBe(cleanToken('hWNIX6UNMbUsdHagyPXGGLXF'));
    expect(cleanToken('short?key=deadbeef')).toBeNull();
  });
  it('never lets the body name the recipient through attrs', () => {
    expect(cleanAttrs({ _otpVerifiedPhoneNumber: '919999999999', _codkAmountType: 'cod' }))
      .toEqual({ _codkAmountType: 'cod' });
  });
});

describe('a captured cart', () => {
  it('is stored and acknowledged', async () => {
    const res = await post(GOOD);
    expect(res.statusCode).toBe(200);
    expect(putCapture).toHaveBeenCalledOnce();
    expect(vi.mocked(putCapture).mock.calls[0][0].phone).toBe('+919876543210');
  });
});

/*
 * THE POINT OF THIS BLOCK. Until 29 Oct 2026 every refusal below answered its
 * status and logged nothing, so the day the storefront stopped capturing carts
 * CloudWatch held only 2ms invocations with no output and the cause could not
 * be read off the logs at all. Each refusal must now name itself.
 */
describe('every refusal is visible in the logs', () => {
  const reasonOf = () => vi.mocked(log.warn).mock.calls.at(-1)?.[1]?.reason;

  it.each([
    ['method_not_allowed', 405, () => post(GOOD, { method: 'GET' })],
    ['forbidden_origin', 403, () => post(GOOD, { origin: 'https://evil.example' })],
    ['bad_json', 400, () => post(null, { raw: '{not json' })],
    ['invalid_phone', 422, () => post({ ...GOOD, phone: '911234567890' })],
    ['invalid_token', 422, () => post({ ...GOOD, token: 'short' })],
    ['invalid_items', 422, () => post({ ...GOOD, items: [{ id: 'nope', qty: 1 }] })],
  ])('%s is logged and counted', async (reason, status, call) => {
    const res = await call();
    expect(res.statusCode).toBe(status);
    expect(log.warn).toHaveBeenCalled();
    expect(reasonOf()).toBe(reason);
    expect(metric).toHaveBeenCalledWith('CartCaptureRejected', 1, { reason });
    expect(putCapture).not.toHaveBeenCalled();
  });

  it('never writes the refused number into the log', async () => {
    await post({ ...GOOD, phone: '911234567890' });
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain('1234567890');
  });

  it('keeps refusing a foreign origin without a CORS header', async () => {
    const res = await post(GOOD, { origin: 'https://evil.example' });
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('a storefront capture is marked as one, and capped', () => {
  it('stamps source storefront, so onFirst knows nobody has vouched for the number', async () => {
    await post(GOOD);
    expect(vi.mocked(putCapture).mock.calls[0][0]).toMatchObject({ source: 'storefront' });
  });

  it('caps one number at 3 a day, because the IP limit never limited who can be messaged', async () => {
    for (let i = 0; i < 3; i++) expect((await post(GOOD)).statusCode).toBe(200);
    const res = await post(GOOD);
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error).toBe('phone_capped');
    // The fourth post stored nothing: three saves, not four.
    expect(vi.mocked(putCapture)).toHaveBeenCalledTimes(3);
  });

  it('caps the endpoint at 60 an hour whatever number or address is posting', async () => {
    // 60 different numbers, so neither the per-phone nor the per-IP cap is what trips.
    for (let i = 0; i < 60; i++) {
      const r = await post({ ...GOOD, phone: `9198765${String(i).padStart(5, '0')}` });
      expect(r.statusCode).toBe(200);
    }
    const res = await post({ ...GOOD, phone: '919000000001' });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error).toBe('global_capped');
  });

  it('raises a flood as an error once a day, never as one line per refused post', async () => {
    for (let i = 0; i < 3; i++) await post(GOOD);
    await post(GOOD);
    await post(GOOD);
    const floods = vi.mocked(log.error).mock.calls.filter((c) => c[0] === 'cart capture flood');
    expect(floods.length).toBe(1);
    // And never the number itself.
    expect(JSON.stringify(floods[0][1])).not.toContain('9876543210');
  });
});
