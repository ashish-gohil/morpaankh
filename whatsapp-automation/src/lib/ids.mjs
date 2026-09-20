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
