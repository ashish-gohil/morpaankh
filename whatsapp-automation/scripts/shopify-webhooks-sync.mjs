#!/usr/bin/env node
/*
 * shopify-webhooks-sync — register the 6 order/fulfillment webhook topics at
 * ${PUBLIC_BASE_URL}/webhooks/shopify. Idempotent. Dry-run by default; pass
 * --live to actually create missing subscriptions.
 *
 *   node scripts/shopify-webhooks-sync.mjs          # report only
 *   node scripts/shopify-webhooks-sync.mjs --live   # create missing
 */
import { config } from '../src/config.mjs';
import { shopify } from '../src/clients/shopify.mjs';

const live = process.argv.includes('--live');

if (!config.publicBaseUrl) {
  console.error('PUBLIC_BASE_URL is not set; cannot compute the callback URL.');
  process.exit(1);
}

const results = await shopify.ensureWebhooks({ dryRun: !live });
console.log(`webhooks-sync (${live ? 'LIVE' : 'dry-run'}) -> ${config.publicBaseUrl}/webhooks/shopify`);
for (const r of results) console.log(`  ${r.topic}: ${r.status}${r.errors ? ' ' + JSON.stringify(r.errors) : ''}`);
