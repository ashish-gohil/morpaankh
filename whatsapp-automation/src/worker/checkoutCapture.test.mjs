import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../store/cartCapture.mjs', () => ({
  putCapture: vi.fn(async () => 'cap_tok'),
  getCapture: vi.fn(),
  listCaptures: vi.fn(async () => []),
}));

import { putCapture } from '../store/cartCapture.mjs';
import { onCheckoutSeen } from './cartRecovery.run.mjs';
import { shopifyIngest } from '../ingest/shopify.mjs';

/*
 * A REAL COD King checkout, trimmed. The attribute names and the shape of
 * note_attributes are copied from live payloads on this store, because the
 * entire value of this path is that Shopify hands us the verified number
 * without us having to watch COD King's user interface for it.
 */
const CHECKOUT = {
  token: 'hWNIV3Gkef85j1R6nr2cSecm',
  cart_token: 'Z2NwLWFzaWEtc291dGgxOjAx',
  completed_at: null,
  created_at: '2026-10-28T17:41:01Z',
  updated_at: '2026-10-28T17:44:02Z',
  note_attributes: [
    { name: '_otpVerifiedPhoneNumber', value: '918058375151' },
    { name: '_codkSessionId', value: '9a221ac6-47de-41e9-90e5-1ad6cf353330' },
    { name: '_codkAmountType', value: 'cod' },
    { name: '_codkAmountValue', value: '50.0' },
  ],
  line_items: [
    { variant_id: 56157664412020, quantity: 1 },
    { variant_id: 54786029879668, quantity: 2 },
  ],
};

const headers = (topic) => ({ 'x-shopify-topic': topic, 'x-shopify-webhook-id': 'wh-1' });

beforeEach(() => vi.mocked(putCapture).mockReset().mockResolvedValue('cap_tok'));

describe('the ingest keeps a checkout off the order path', () => {
  it('routes it by its own token, not as an order', () => {
    const [item] = shopifyIngest.toItems(headers('checkouts/create'), CHECKOUT);
    expect(item.message.kind).toBe('checkout');
    expect(item.groupId).toBe('checkout:Z2NwLWFzaWEtc291dGgxOjAx');
    // An order id would serialise this behind someone else's order and feed
    // the order flows a thing that is not an order.
    expect(item.message.orderId).toBeUndefined();
  });

  it('drops a checkout they completed, because there is nothing to win back', () => {
    expect(shopifyIngest.toItems(headers('checkouts/update'), { ...CHECKOUT, completed_at: '2026-10-28T18:00:00Z' })).toEqual([]);
  });

  it('still routes an order normally', () => {
    const [item] = shopifyIngest.toItems(headers('orders/create'), { id: 123, updated_at: 'x' });
    expect(item.message.kind).toBe('shopify');
    expect(item.groupId).toBe('order:123');
  });
});

describe('a checkout becomes the same captured cart the sweep already reads', () => {
  it('files the bag under the CART token with the verified number', async () => {
    const res = await onCheckoutSeen(CHECKOUT, {});
    expect(res).toEqual({ captured: 'cap_tok' });
    const arg = vi.mocked(putCapture).mock.calls[0][0];
    // cart_token, so a storefront capture of the same bag lands on ONE row.
    expect(arg.token).toBe('Z2NwLWFzaWEtc291dGgxOjAx');
    expect(arg.phone).toBe('+918058375151');
    expect(arg.items).toEqual([
      { id: 'gid://shopify/ProductVariant/56157664412020', qty: 1 },
      { id: 'gid://shopify/ProductVariant/54786029879668', qty: 2 },
    ]);
  });

  it('carries the COD King amount attrs, which decide a partial advance', async () => {
    await onCheckoutSeen(CHECKOUT, {});
    const { attrs } = vi.mocked(putCapture).mock.calls[0][0];
    expect(attrs._codkAmountType).toBe('cod');
    expect(attrs._codkAmountValue).toBe('50.0');
    // The recipient is rebuilt from the phone this function validated, so the
    // payload must never be able to name it a second time.
    expect(attrs._otpVerifiedPhoneNumber).toBeUndefined();
  });

  it.each([
    ['no verified number', { ...CHECKOUT, note_attributes: [{ name: '_codkAmountType', value: 'cod' }] }, 'no-verified-phone'],
    ['a number that is not an Indian mobile', { ...CHECKOUT, note_attributes: [{ name: '_otpVerifiedPhoneNumber', value: '911234567890' }] }, 'no-verified-phone'],
    ['no readable bag', { ...CHECKOUT, line_items: [] }, 'unreadable-items'],
    ['a line we cannot price', { ...CHECKOUT, line_items: [{ variant_id: null, quantity: 1 }] }, 'unreadable-items'],
  ])('writes nothing for %s', async (_label, payload, reason) => {
    expect(await onCheckoutSeen(payload, {})).toEqual({ skipped: reason });
    expect(putCapture).not.toHaveBeenCalled();
  });
});

/*
 * F1. This payload arrived with Shopify's HMAC on it, so the number in its
 * note attributes is proof and onFirst is allowed to act on it without a
 * second lookup. The public endpoint gets no such stamp.
 */
describe('the webhook is the one source that can vouch for a number', () => {
  it('stamps verifiedBy, so onFirst skips the Shopify vouch', async () => {
    await onCheckoutSeen(CHECKOUT, {});
    expect(vi.mocked(putCapture).mock.calls[0][0]).toMatchObject({
      source: 'checkout-webhook',
      verifiedBy: 'checkout-webhook',
    });
  });
});
