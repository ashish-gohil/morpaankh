import { describe, it, expect } from 'vitest';
import { encodePayload, decodePayload, timerName, signToken, verifyToken, randomToken, pathToken, MAX_TOKEN_LENGTH } from './ids.mjs';

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

/*
 * Every /{token} route looks its token up as a DynamoDB PARTITION KEY, and
 * DynamoDB caps those at 2048 bytes. A longer token raised a
 * ValidationException that escaped as HTTP 500: confirmed against production on
 * 2026-10-27, where /w, /r and /p all answered "Internal Server Error" for a
 * 3000 character token while a short garbage token redirected correctly.
 *
 * All three modules promise the opposite at the top of their file: an unknown,
 * guessed, expired or truncated token is a redirect to the shop, never an
 * error. These links go out in customer messages, and the status code also told
 * a stranger which tokens were real.
 */
describe('pathToken', () => {
  it('passes a real random token through unchanged', () => {
    const t = randomToken();
    expect(t.length).toBe(22);
    expect(pathToken(t)).toBe(t);
  });

  it('passes a signed Flow token through, which is the longest kind we issue', () => {
    const t = signToken({ orderId: '12712800944500', exp: 2000000000 }, 'k');
    expect(t.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    expect(pathToken(t)).toBe(t);
  });

  it('refuses one longer than DynamoDB will take as a key', () => {
    expect(pathToken('A'.repeat(3000))).toBe('');
  });

  it('accepts exactly the bound and refuses one past it', () => {
    expect(pathToken('A'.repeat(MAX_TOKEN_LENGTH))).toBe('A'.repeat(MAX_TOKEN_LENGTH));
    expect(pathToken('A'.repeat(MAX_TOKEN_LENGTH + 1))).toBe('');
  });

  it('turns nothing at all into an empty token, which every handler treats as unknown', () => {
    expect(pathToken(undefined)).toBe('');
    expect(pathToken(null)).toBe('');
    expect(pathToken('')).toBe('');
  });

  it('leaves a path traversal attempt alone, because it is only ever a key lookup', () => {
    // Not sanitised here on purpose: '../../etc/passwd' is simply a token that
    // matches no row. Rewriting it would invent a key that might match one.
    expect(pathToken('../../etc/passwd')).toBe('../../etc/passwd');
  });
});
