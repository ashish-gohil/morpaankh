import { describe, it, expect } from 'vitest';
import { encodePayload, decodePayload, timerName, signToken, verifyToken, randomToken } from './ids.mjs';

describe('button payloads', () => {
  it('round-trips', () => {
    const p = { flow: 'A', orderId: '998877', action: 'confirm' };
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });
  it('rejects malformed / wrong version', () => {
    expect(decodePayload('')).toBeNull();
    expect(decodePayload('v2|A|1|x')).toBeNull();
    expect(decodePayload('v1|A|1')).toBeNull();
    expect(decodePayload('v1|A||x')).toBeNull();
  });
});

describe('timerName', () => {
  it('stays within 64 chars and the allowed charset', () => {
    const n = timerName('A', 'gid://shopify/Order/12345', 'reminder+3h');
    expect(n.length).toBeLessThanOrEqual(64);
    expect(/^[0-9A-Za-z\-_.]+$/.test(n)).toBe(true);
  });
});

describe('signed Flow tokens', () => {
  const key = 'flow-key';
  it('verifies a fresh token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const t = signToken({ orderId: '555', exp }, key);
    expect(verifyToken(t, key)).toEqual({ orderId: '555', exp });
  });
  it('rejects a tampered token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const t = signToken({ orderId: '555', exp }, key);
    expect(verifyToken(t.replace('555', '556'), key)).toBeNull();
  });
  it('rejects an expired token and a wrong key', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(verifyToken(signToken({ orderId: '1', exp: past }, key), key)).toBeNull();
    const future = Math.floor(Date.now() / 1000) + 60;
    expect(verifyToken(signToken({ orderId: '1', exp: future }, key), 'other')).toBeNull();
  });
});

describe('randomToken', () => {
  it('is url-safe and unique', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });
});
