'use strict';

/**
 * MorPaankh shipping integration service.
 * Receives Shopify + Shiprocket webhooks and bridges them:
 *   - POST /webhooks/shopify/orders-create  -> create shipment + AWB + fulfillment
 *   - POST /webhooks/shiprocket/tracking     -> sync status + handle delivery/RTO
 *
 * Webhooks are acknowledged immediately (200) and processed asynchronously so a
 * slow downstream API never causes the platform to retry/timeout.
 */
const express = require('express');
const config = require('./config');
const {
  verifyShopifyHmac,
  verifyShiprocketToken,
  verifyAutomationSecret,
} = require('./verify');
const { handleOrderCreate } = require('./handlers/shopifyOrderCreate');
const { handleTracking } = require('./handlers/shiprocketTracking');

// Scheduled automation tasks, invoked by the node-workflow platform.
// Each is an idempotent run() returning a summary the workflow asserts on.
const automations = {
  'abandoned-checkouts': require('./automations/abandonedCheckouts'),
  'cod-confirmation': require('./automations/codConfirmation'),
  'review-requests': require('./automations/reviewRequests'),
};

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

/**
 * Scheduled automation runner. Unlike the webhooks above this responds only
 * after the task finishes — the calling workflow needs the summary to assert
 * success and to show honest run history. Callers must set a request timeout
 * of 30s+ (work is a few seconds at current volume).
 */
app.post('/automations/:task/run', async (req, res) => {
  if (!config.automation.sharedSecret) {
    return res
      .status(503)
      .json({ ok: false, error: 'automations not configured (AUTOMATION_SHARED_SECRET unset)' });
  }
  if (!verifyAutomationSecret(req.get('x-automation-secret'))) {
    return res.status(401).json({ ok: false, error: 'invalid automation secret' });
  }
  const mod = automations[req.params.task];
  if (!mod) {
    return res.status(404).json({
      ok: false,
      error: `unknown task "${req.params.task}"`,
      tasks: Object.keys(automations),
    });
  }
  const dryRun = Boolean((req.body || {}).dryRun) || config.automation.dryRun;
  try {
    const summary = await mod.run({ dryRun });
    console.log(`[automation:${req.params.task}]`, JSON.stringify({ dryRun, ...summary }));
    res.json({ ok: true, task: req.params.task, dryRun, ...summary });
  } catch (e) {
    console.error(`[automation:${req.params.task}] error:`, e.message);
    res.status(500).json({ ok: false, task: req.params.task, error: e.message });
  }
});

if (require.main === module) {
  app.listen(config.port, () =>
    console.log(`MorPaankh shipping integration listening on :${config.port}`)
  );
}

module.exports = app;
