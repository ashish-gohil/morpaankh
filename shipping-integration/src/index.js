'use strict';

/**
 * Mor Paankh shipping integration service.
 * Receives Shopify + Shiprocket webhooks and bridges them:
 *   - POST /webhooks/shopify/orders-create  -> create shipment + AWB + fulfillment
 *   - POST /webhooks/shiprocket/tracking     -> sync status + handle delivery/RTO
 *
 * Webhooks are acknowledged immediately (200) and processed asynchronously so a
 * slow downstream API never causes the platform to retry/timeout.
 */
const express = require('express');
const config = require('./config');
const { verifyShopifyHmac, verifyShiprocketToken } = require('./verify');
const { handleOrderCreate } = require('./handlers/shopifyOrderCreate');
const { handleTracking } = require('./handlers/shiprocketTracking');

const app = express();

// Keep the raw body so we can verify Shopify's HMAC over the exact bytes.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'morpaankh-shipping' })
);

app.post('/webhooks/shopify/orders-create', (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (!verifyShopifyHmac(raw, hmac)) {
    return res.status(401).send('invalid hmac');
  }
  res.status(200).send('ok'); // acknowledge fast

  const order = req.body;
  handleOrderCreate(order)
    .then((result) => console.log('[orders-create]', JSON.stringify(result)))
    .catch((e) => console.error('[orders-create] error:', e.message));
});

app.post('/webhooks/shiprocket/tracking', (req, res) => {
  const token = req.get('x-api-key') || req.query.token;
  if (!verifyShiprocketToken(token)) {
    return res.status(401).send('invalid token');
  }
  res.status(200).send('ok'); // acknowledge fast

  handleTracking(req.body)
    .then((result) => console.log('[sr-tracking]', JSON.stringify(result)))
    .catch((e) => console.error('[sr-tracking] error:', e.message));
});

if (require.main === module) {
  app.listen(config.port, () =>
    console.log(`Mor Paankh shipping integration listening on :${config.port}`)
  );
}

module.exports = app;
