import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  safeEqual,
  rawBody,
  verifyShopify,
  verifyWhatsApp,
  verifyRazorpay,
  verifySharedSecret,
} from './signature.mjs';

const raw = Buffer.from(JSON.stringify({ id: 123, ok: true }), 'utf8');
const secret = 'shhh-secret';

describe('safeEqual', () => {
  it('true for equal, false for different or length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(null, '')).toBe(true);
  });
});

describe('rawBody', () => {
  it('decodes base64 when isBase64Encoded', () => {
    const b64 = raw.toString('base64');
    expect(rawBody({ body: b64, isBase64Encoded: true }).equals(raw)).toBe(true);
  });
  it('utf8 otherwise', () => {
    expect(rawBody({ body: raw.toString('utf8') }).equals(raw)).toBe(true);
  });
});

describe('verifyShopify (base64)', () => {
  const good = createHmac('sha256', secret).update(raw).digest('base64');
  it('accepts a valid signature', () => expect(verifyShopify(raw, good, secret)).toBe(true));
  it('rejects a tampered body', () => {
    const t = Buffer.from(raw.toString('utf8') + ' ', 'utf8');
    expect(verifyShopify(t, good, secret)).toBe(false);
  });
  it('rejects a wrong signature / missing header / missing secret', () => {
    expect(verifyShopify(raw, 'AAAA', secret)).toBe(false);
    expect(verifyShopify(raw, '', secret)).toBe(false);
    expect(verifyShopify(raw, good, '')).toBe(false);
  });
});

describe('verifyWhatsApp (sha256=hex)', () => {
  const hex = createHmac('sha256', secret).update(raw).digest('hex');
  it('accepts sha256=<hex>', () => expect(verifyWhatsApp(raw, `sha256=${hex}`, secret)).toBe(true));
  it('rejects hex without the prefix', () => expect(verifyWhatsApp(raw, hex, secret)).toBe(false));
});

describe('verifyRazorpay (hex)', () => {
  const hex = createHmac('sha256', secret).update(raw).digest('hex');
  it('accepts a valid hex signature', () => expect(verifyRazorpay(raw, hex, secret)).toBe(true));
  it('rejects a tampered signature', () => expect(verifyRazorpay(raw, hex.replace(/.$/, '0'), secret)).toBe(false));
});

describe('verifySharedSecret', () => {
  it('constant-time equality', () => {
    expect(verifySharedSecret('tok', 'tok')).toBe(true);
    expect(verifySharedSecret('tok', 'nope')).toBe(false);
    expect(verifySharedSecret('', 'tok')).toBe(false);
  });
});
