/*
 * signature.mjs — webhook authenticity, timing-safe.
 *
 * Pure functions: the secret is passed in (from secrets.mjs), never read here,
 * so these are trivially testable. Always verify against the RAW body bytes,
 * decoded first if API Gateway base64-encoded them.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Return the raw request body as a Buffer, decoding API Gateway base64. */
export function rawBody(event) {
  const body = event?.body ?? '';
  if (event?.isBase64Encoded) return Buffer.from(body, 'base64');
  return Buffer.from(body, 'utf8');
}

function hmac(raw, secret, enc) {
  return createHmac('sha256', secret).update(raw).digest(enc);
}

/** Shopify: base64 HMAC-SHA256 vs X-Shopify-Hmac-Sha256. */
export function verifyShopify(raw, headerHmac, secret) {
  if (!headerHmac || !secret) return false;
  return safeEqual(hmac(raw, secret, 'base64'), headerHmac);
}

/** WhatsApp: X-Hub-Signature-256: sha256=<hex> HMAC-SHA256(raw, appSecret). */
export function verifyWhatsApp(raw, headerSig, appSecret) {
  if (!headerSig || !appSecret) return false;
  const expected = `sha256=${hmac(raw, appSecret, 'hex')}`;
  return safeEqual(expected, headerSig);
}

/** Razorpay: hex HMAC-SHA256(raw, webhookSecret) vs X-Razorpay-Signature. */
export function verifyRazorpay(raw, headerSig, webhookSecret) {
  if (!headerSig || !webhookSecret) return false;
  return safeEqual(hmac(raw, webhookSecret, 'hex'), headerSig);
}

/** Delhivery push: a shared secret header agreed with Delhivery. */
export function verifySharedSecret(givenHeader, expectedSecret) {
  if (!givenHeader || !expectedSecret) return false;
  return safeEqual(givenHeader, expectedSecret);
}
