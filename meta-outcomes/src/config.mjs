/*
 * config.mjs — load and validate configuration from the environment.
 *
 * No secrets in code. Values come from process.env, seeded from a local .env
 * (gitignored). A tiny .env reader is included so `node src/server.mjs` works
 * without extra flags or a dotenv dependency.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, '..', '.env');

function loadDotEnv() {
  let raw;
  try {
    raw = readFileSync(ENV_PATH, 'utf8');
  } catch {
    return; // no .env, rely on real environment
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

const bool = (v, dflt) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

export const config = {
  dryRun: bool(process.env.DRY_RUN, true),

  shopify: {
    domain: process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.SHOPIFY_ADMIN_TOKEN || '',
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  },

  meta: {
    datasetId: process.env.META_DATASET_ID || '',
    businessId: process.env.META_BUSINESS_ID || '',
    accessToken: process.env.META_ACCESS_TOKEN || '',
    adAccountId: (process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, ''),
    testEventCode: process.env.META_TEST_EVENT_CODE || '',
    graphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
    deliveredEventName: process.env.META_DELIVERED_EVENT_NAME || 'DeliveredPurchase',
    audienceDelivered: process.env.META_AUDIENCE_DELIVERED || 'MP - Delivered Buyers',
    audienceLost: process.env.META_AUDIENCE_LOST || 'MP - Cancelled or RTO',
  },

  returnRegex: process.env.META_RETURN_REGEX
    ? new RegExp(process.env.META_RETURN_REGEX, 'i')
    : undefined,

  backfillSince: process.env.BACKFILL_SINCE || '2026-08-01',
  stateDbPath: process.env.STATE_DB_PATH || './data/state.json',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  port: Number(process.env.PORT || 8080),
};

/**
 * Fail fast when something required for the requested mode is missing.
 * @param {{requireMeta?: boolean, requirePublicUrl?: boolean}} [opts]
 */
export function assertConfig(opts = {}) {
  const missing = [];
  if (!config.shopify.domain) missing.push('SHOPIFY_STORE_DOMAIN');
  if (!config.shopify.token) missing.push('SHOPIFY_ADMIN_TOKEN');
  if (!config.shopify.webhookSecret) missing.push('SHOPIFY_WEBHOOK_SECRET');

  // Meta is only required when we are actually going to send (not dry-run),
  // or when a caller explicitly needs it.
  const needMeta = opts.requireMeta || !config.dryRun;
  if (needMeta) {
    if (!config.meta.accessToken) missing.push('META_ACCESS_TOKEN');
    if (!config.meta.datasetId) missing.push('META_DATASET_ID');
    if (!config.meta.adAccountId) missing.push('META_AD_ACCOUNT_ID');
  }

  if (opts.requirePublicUrl && !config.publicBaseUrl) missing.push('PUBLIC_BASE_URL');

  if (missing.length) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}. ` +
        `Fill them in meta-outcomes/.env (see .env.example).`,
    );
  }
}

/** Redact a secret for safe logging: keep the prefix, mask the rest. */
export function redact(secret) {
  if (!secret) return '(empty)';
  const s = String(secret);
  const head = s.slice(0, Math.min(8, s.length));
  return `${head}${'*'.repeat(Math.max(0, s.length - head.length))}`;
}
