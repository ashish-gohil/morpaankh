import { describe, it, expect, beforeEach } from 'vitest';
import { markSeen, unmarkSeen } from './dedupe.mjs';
import { _resetMemory } from './table.mjs';

beforeEach(() => _resetMemory());

describe('dedupe (memory backend)', () => {
  it('returns true the first time, false afterwards', async () => {
    expect(await markSeen('shopify', 'wh-1')).toBe(true);
    expect(await markSeen('shopify', 'wh-1')).toBe(false);
  });
  it('scopes by source so the same id from two providers is independent', async () => {
    expect(await markSeen('shopify', 'x')).toBe(true);
    expect(await markSeen('razorpay', 'x')).toBe(true);
  });
  it('lets an event through again after unmarkSeen (enqueue-failure recovery)', async () => {
    expect(await markSeen('whatsapp', 'm-1')).toBe(true);
    await unmarkSeen('whatsapp', 'm-1');
    expect(await markSeen('whatsapp', 'm-1')).toBe(true);
  });
  it('does not dedupe when there is no id', async () => {
    expect(await markSeen('delhivery', '')).toBe(true);
    expect(await markSeen('delhivery', '')).toBe(true);
  });
});
