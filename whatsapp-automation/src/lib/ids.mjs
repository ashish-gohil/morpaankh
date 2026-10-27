/*
 * ids.mjs — payloads, timer names, and tokens.
 *
 * Button payloads and Flow tokens ride round-trips through WhatsApp, so they are
 * versioned and (for Flow tokens) signed. Timer names are deterministic so a
 * schedule can be replaced or deleted without storing its name.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---- button payloads: "v1|<flow>|<orderId>|<action>" ------------------------
/** @param {{flow:string,orderId:string|number,action:string}} p */
export function encodePayload({ flow, orderId, action }) {
  return `v1|${flow}|${orderId}|${action}`;
}
/** @param {string} s @returns {{flow:string,orderId:string,action:string}|null} */
export function decodePayload(s) {
  const parts = String(s || '').split('|');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, flow, orderId, action] = parts;
  if (!flow || !orderId || !action) return null;
  return { flow, orderId, action };
}

// ---- deterministic EventBridge Scheduler names ------------------------------
/** Schedule names allow [0-9A-Za-z-_.] up to 64 chars. */
export function timerName(flow, orderId, step) {
  const raw = `${flow}-${orderId}-${step}`;
  return raw.replace(/[^0-9A-Za-z\-_.]/g, '-').slice(0, 64);
}

// ---- opaque tokens (pay links: random, mapped in DynamoDB) ------------------
export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * The longest token this service can issue, with room to spare: randomToken(16)
 * is 22 characters and a signed Flow token about 60.
 *
 * It lives here because this is the module that issues them, so this is the
 * module that knows how long one can be.
 */
export const MAX_TOKEN_LENGTH = 128;

/**
 * A path token, or '' when it cannot be one of ours.
 *
 * Every /{token} route looks the token up as a DynamoDB PARTITION KEY, and
 * DynamoDB caps those at 2048 bytes, so a longer one raises a
 * ValidationException that escaped as HTTP 500. Confirmed against production
 * on 2026-10-27: /w, /r and /p each answered "Internal Server Error" for a 3000
 * character token while a short garbage token redirected correctly.
 *
 * That breaks the rule all three handlers are built on and state at the top of
 * their modules: an unknown, guessed, expired or truncated token is a redirect
 * to the shop, never an error. It also let a stranger tell our tokens apart
 * from their own by the status code, on links we put in customer messages.
 *
 * Returning '' rather than throwing is what keeps that rule: each handler
 * already treats an empty token as unknown and answers with the shop.
 */
export function pathToken(value) {
  const s = String(value || '');
  return s.length > 0 && s.length <= MAX_TOKEN_LENGTH ? s : '';
}

// ---- signed Flow tokens: "<orderId>.<expEpochSec>.<hmac>" -------------------
/** @param {{orderId:string|number, exp:number}} claims @param {string} key */
export function signToken({ orderId, exp }, key) {
  const body = `${orderId}.${exp}`;
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}
/**
 * @param {string} token @param {string} key @param {number} [nowSec]
 * @returns {{orderId:string, exp:number}|null} null if malformed, bad sig, or expired
 */
export function verifyToken(token, key, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [orderId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!orderId || !Number.isFinite(exp)) return null;
  const expected = createHmac('sha256', key).update(`${orderId}.${expStr}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (exp < nowSec) return null;
  return { orderId, exp };
}
