import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../store/cartCapture.mjs', () => ({ putCapture: vi.fn() }));
vi.mock('../store/table.mjs', () => ({ table: { putNew: vi.fn(async () => true) } }));
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
  vi.mocked(putCapture).mockReset().mockResolvedValue('cap_abcdefgh12345678');
  vi.mocked(log.warn).mockReset();
  vi.mocked(log.info).mockReset();
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
