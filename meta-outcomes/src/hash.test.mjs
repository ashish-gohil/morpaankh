import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hashEmail, hashPhone, buildUserData, sha256Hex } from './hash.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('hashEmail', () => {
  it('lowercases and trims before hashing', () => {
    expect(hashEmail('  Test@Example.COM ')).toBe(sha('test@example.com'));
  });
  it('is 64-char lowercase hex', () => {
    expect(hashEmail('a@b.com')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns null for empty', () => {
    expect(hashEmail('')).toBeNull();
    expect(hashEmail(null)).toBeNull();
  });
});

describe('hashPhone', () => {
  it('strips formatting and keeps the country code', () => {
    expect(hashPhone('+91 98765 43210')).toBe(sha('919876543210'));
  });
  it('prepends 91 to a bare 10-digit Indian number', () => {
    expect(hashPhone('9876543210')).toBe(sha('919876543210'));
  });
  it('drops a leading zero', () => {
    expect(hashPhone('09876543210')).toBe(sha('919876543210'));
  });
  it('returns null for empty', () => {
    expect(hashPhone('')).toBeNull();
  });
});

describe('buildUserData', () => {
  it('emits hashed em/ph arrays and never the raw values', () => {
    const ud = buildUserData({ email: 'Buyer@Example.com', phone: '+91 98765 43210' });
    expect(ud.em).toEqual([sha('buyer@example.com')]);
    expect(ud.ph).toEqual([sha('919876543210')]);
    // no raw PII leaked into any field
    const flat = JSON.stringify(ud);
    expect(flat).not.toContain('Buyer@Example.com');
    expect(flat).not.toContain('98765');
  });
  it('hashes external_id and omits absent fields', () => {
    const ud = buildUserData({ externalId: 6001 });
    expect(ud.external_id).toEqual([sha256Hex('6001')]);
    expect(ud.em).toBeUndefined();
    expect(ud.ph).toBeUndefined();
  });
});
