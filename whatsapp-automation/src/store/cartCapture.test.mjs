/*
 * The capture row's one security property: a browser cannot talk its way into
 * the verification Shopify granted, or into the number that verification
 * covers. Both sources write the same primary key, which is what makes this
 * worth a test of its own.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetMemory } from './table.mjs';
import { putCapture, getCapture } from './cartCapture.mjs';

const TOKEN = 'Z2NwLWFzaWEtc291dGgx';
const SHOPPER = '+919637361371';
const STRANGER = '+918123456789';
const items = [{ id: 'gid://shopify/ProductVariant/1', qty: 1 }];

beforeEach(_resetMemory);

describe('putCapture', () => {
  it('marks a storefront write as one and leaves verifiedBy unset', async () => {
    const id = await putCapture({ token: TOKEN, phone: SHOPPER, items });
    const row = await getCapture(id);
    expect(row.source).toBe('storefront');
    expect(row.verifiedBy).toBeUndefined();
  });

  it('records the checkout webhook as proof', async () => {
    const id = await putCapture({
      token: TOKEN, phone: SHOPPER, items, source: 'checkout-webhook', verifiedBy: 'checkout-webhook',
    });
    expect((await getCapture(id)).verifiedBy).toBe('checkout-webhook');
  });

  it('refuses to let a later storefront post downgrade the verification or move the number', async () => {
    const id = await putCapture({
      token: TOKEN, phone: SHOPPER, items, source: 'checkout-webhook', verifiedBy: 'checkout-webhook',
    });
    // Same cart token, a stranger's number, through the public endpoint.
    await putCapture({ token: TOKEN, phone: STRANGER, items: [{ id: 'gid://shopify/ProductVariant/2', qty: 3 }] });
    const row = await getCapture(id);
    expect(row.verifiedBy).toBe('checkout-webhook');
    expect(row.phone).toBe(SHOPPER);
    // The bag and the clock still refresh: this is a real shopper's cart changing.
    expect(row.items).toEqual([{ id: 'gid://shopify/ProductVariant/2', qty: 3 }]);
  });

  it('still lets the webhook correct a number a storefront row guessed', async () => {
    const id = await putCapture({ token: TOKEN, phone: STRANGER, items });
    await putCapture({
      token: TOKEN, phone: SHOPPER, items, source: 'checkout-webhook', verifiedBy: 'checkout-webhook',
    });
    const row = await getCapture(id);
    expect(row.phone).toBe(SHOPPER);
    expect(row.verifiedBy).toBe('checkout-webhook');
  });
});
