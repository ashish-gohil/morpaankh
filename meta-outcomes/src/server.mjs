/*
 * server.mjs — receive Shopify webhooks, verify HMAC, process the order.
 *
 * The webhook body is only a trigger. We verify the signature, pull the order
 * id, ack 200 immediately (Shopify's delivery budget is tight), then process in
 * the background. Retries are safe because processOrder is idempotent.
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, assertConfig, redact } from './config.mjs';
import { processOrder } from './process.mjs';
import { ensureWebhooks } from './shopify.mjs';
import { initStore } from './store.mjs';

function verifyHmac(rawBody, headerHmac) {
  if (!headerHmac) return false;
  const digest = createHmac('sha256', config.shopify.webhookSecret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(headerHmac);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Which field holds the order id for each topic family.
function orderIdFromPayload(topic, body) {
  if (topic.startsWith('orders/')) return body.id;
  if (topic.startsWith('fulfillments/')) return body.order_id;
  return body.order_id || body.id || null;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dryRun: config.dryRun }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/webhooks/shopify') {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const raw = await readRawBody(req);
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyHmac(raw, hmac)) {
    console.warn('[webhook] HMAC verification failed, rejecting');
    res.writeHead(401);
    res.end('unauthorized');
    return;
  }

  const topic = String(req.headers['x-shopify-topic'] || '');
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400);
    res.end('bad json');
    return;
  }

  // Ack immediately, then process in the background (idempotent on retry).
  res.writeHead(200);
  res.end('ok');

  const orderId = orderIdFromPayload(topic, body);
  if (!orderId) return;
  processOrder(orderId)
    .then((r) => console.log(`[webhook] ${topic} order ${r.orderId} -> ${r.state} [${r.actions.join(', ')}]`))
    .catch((e) => console.error(`[webhook] ${topic} order ${orderId} failed:`, e.message));
});

async function main() {
  assertConfig(); // Meta required only when not dry-run
  await initStore();
  console.log(
    `meta-outcomes server starting: dryRun=${config.dryRun} store=${config.shopify.domain} ` +
      `token=${redact(config.shopify.token)} dataset=${config.meta.datasetId}`,
  );

  if (config.publicBaseUrl) {
    const results = await ensureWebhooks(config.publicBaseUrl, { dryRun: config.dryRun });
    for (const r of results) console.log(`[webhooks] ${r.topic}: ${r.status}`);
  } else {
    console.log('[webhooks] PUBLIC_BASE_URL not set; skipping subscription registration.');
    console.log('           Set it (a tunnel or deployment URL) so Shopify can deliver webhooks.');
  }

  server.listen(config.port, () => console.log(`listening on :${config.port}/webhooks/shopify`));
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
