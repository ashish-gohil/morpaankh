import { describe, it, expect } from 'vitest';
import {
  normalizeVerifiedPhone,
  verifiedPhoneFromNoteAttributes,
  verifiedPhoneFromCustomAttributes,
} from './phone.mjs';

describe('normalizeVerifiedPhone', () => {
  it('accepts 12-digit 91 + valid mobile', () => {
    expect(normalizeVerifiedPhone('919812345678')).toBe('+919812345678');
  });
  it('accepts a bare 10-digit mobile and prefixes 91', () => {
    expect(normalizeVerifiedPhone('9812345678')).toBe('+919812345678');
  });
  it('strips spaces, dashes and a leading +', () => {
    expect(normalizeVerifiedPhone('+91 98123-45678')).toBe('+919812345678');
  });
  it('rejects a 10-digit number not starting 6-9', () => {
    expect(normalizeVerifiedPhone('1234567890')).toBeNull();
  });
  it('rejects 12 digits whose mobile part is invalid', () => {
    expect(normalizeVerifiedPhone('915012345678')).toBeNull();
  });
  it('rejects non-Indian / wrong length / junk / empty', () => {
    expect(normalizeVerifiedPhone('14155552671')).toBeNull();
    expect(normalizeVerifiedPhone('98123')).toBeNull();
    expect(normalizeVerifiedPhone('not a phone')).toBeNull();
    expect(normalizeVerifiedPhone('')).toBeNull();
    expect(normalizeVerifiedPhone(null)).toBeNull();
  });
});

describe('verified phone extraction from order attributes', () => {
  it('reads note_attributes (REST webhook shape)', () => {
    const attrs = [
      { name: 'foo', value: 'bar' },
      { name: '_otpVerifiedPhoneNumber', value: '919812345678' },
    ];
    expect(verifiedPhoneFromNoteAttributes(attrs)).toBe('+919812345678');
  });
  it('reads customAttributes (GraphQL shape)', () => {
    const attrs = [{ key: '_otpVerifiedPhoneNumber', value: '9812345678' }];
    expect(verifiedPhoneFromCustomAttributes(attrs)).toBe('+919812345678');
  });
  it('returns null when the attribute is absent (never falls back)', () => {
    expect(verifiedPhoneFromNoteAttributes([{ name: 'phone', value: '9812345678' }])).toBeNull();
    expect(verifiedPhoneFromCustomAttributes([])).toBeNull();
    expect(verifiedPhoneFromNoteAttributes(undefined)).toBeNull();
  });
});
