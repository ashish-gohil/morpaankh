import { describe, it, expect } from 'vitest';
import { extractPincode, classifyAddressReply } from './ndr.mjs';

describe('extractPincode', () => {
  it('finds a 6-digit pincode', () => expect(extractPincode('Flat 2, MG Road, Jaipur 302001')).toBe('302001'));
  it('returns null when absent', () => expect(extractPincode('no pin here 123')).toBeNull());
});

describe('classifyAddressReply', () => {
  it('same pincode', () => expect(classifyAddressReply('addr 302001', '302001').status).toBe('same'));
  it('different pincode', () => expect(classifyAddressReply('addr 560001', '302001').status).toBe('different'));
  it('no pincode', () => expect(classifyAddressReply('just a street', '302001').status).toBe('no_pincode'));
});
