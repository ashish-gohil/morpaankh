'use strict';

/**
 * Webhook authenticity checks.
 * - Shopify: HMAC-SHA256 of the raw request body, base64, compared in
 *   constant time against the X-Shopify-Hmac-Sha256 header.
 * - Shiprocket: a shared secret sent as the x-api-key header (configured on
 *   the webhook in the Shiprocket dashboard).
 */
const crypto = require('crypto');
const config = require('./config');

function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader || !rawBody) return false;
  const digest = crypto
    .createHmac('sha256', config.shopify.apiSecret)
    .update(rawBody, 'utf8')
    .digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyShiprocketToken(headerToken) {
  return Boolean(headerToken) && headerToken === config.shiprocket.webhookToken;
}

module.exports = { verifyShopifyHmac, verifyShiprocketToken };
