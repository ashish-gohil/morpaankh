import { describe, it, expect } from 'vitest';
import { toPaise, rupeesToPaise, formatINR } from './money.mjs';

describe('money', () => {
  it('toPaise from string and number', () => {
    expect(toPaise('1499.00')).toBe(149900);
    expect(toPaise(1499)).toBe(149900);
    expect(toPaise('1149.50')).toBe(114950);
    expect(toPaise('')).toBe(0);
  });
  it('rupeesToPaise', () => expect(rupeesToPaise(100)).toBe(10000));
  it('formatINR: no decimals when whole, en-IN grouping', () => {
    expect(formatINR(149900)).toBe('₹1,499');
    expect(formatINR(114950)).toBe('₹1,149.50');
    expect(formatINR(10000)).toBe('₹100');
  });
});
