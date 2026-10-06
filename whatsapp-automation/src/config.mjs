/*
 * config.mjs — non-secret configuration from the environment.
 *
 * Same discipline as meta-outcomes: no secrets in code, a tiny hand-rolled .env
 * reader so local runs need no dotenv dependency, and DRY_RUN defaults TRUE.
 * Secrets never live here — they come from src/secrets.mjs.
 *
 * Hot-swappable flags (per-flow enabled/startAt, DRY_RUN, allowlists) can be
 * overlaid at runtime from a DynamoDB config item without a redeploy; see
 * src/flags.mjs. This module holds the env-derived defaults.
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
    return; // no .env: rely on the real environment (Lambda)
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
/** Split a comma/space list into trimmed non-empty items. */
const list = (v) => String(v || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

function flow(letter) {
  return {
    enabled: bool(process.env[`FLOW_${letter}_ENABLED`], false),
    startAt: process.env[`FLOW_${letter}_START_AT`] || '', // ISO8601; '' means "no orders yet"
  };
}

export const config = {
  dryRun: bool(process.env.DRY_RUN, true),
  region: process.env.AWS_REGION || 'ap-south-1',

  dynamoBackend: (process.env.DYNAMO_BACKEND || 'memory').toLowerCase(),
  queueBackend: (process.env.QUEUE_BACKEND || 'memory').toLowerCase(),
  secretsBackend: (process.env.SECRETS_BACKEND || 'env').toLowerCase(),
  configBackend: (process.env.CONFIG_BACKEND || 'env').toLowerCase(),

  tableName: process.env.TABLE_NAME || 'wa-automation',
  queueUrl: process.env.QUEUE_URL || '',
  dlqUrl: process.env.DLQ_URL || '',
  secretsId: process.env.SECRETS_ID || 'wa-automation/secrets',

  shopDomain: process.env.SHOP_DOMAIN || '',
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  graphVersion: process.env.GRAPH_VERSION || 'v25.0',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),

  sendAllowlist: list(process.env.SEND_ALLOWLIST),
  orderAllowlist: list(process.env.ORDER_ALLOWLIST),
  ownerAlertPhones: list(process.env.OWNER_ALERT_PHONES),

  flows: { A: flow('A'), B: flow('B'), C: flow('C'), D: flow('D') },

  // How Flow B asks for a review. 'flow' is the native WhatsApp Flow, which
  // Meta will not let us publish until the business is verified; 'link' sends
  // the same message with a Google Form button and arms no reminder, because a
  // form cannot tell us it was filled in. Hot-swappable: no redeploy to switch.
  reviewVia: (process.env.REVIEW_VIA || 'flow').toLowerCase(),
};

/** Redact a secret for safe logging: keep an 8-char prefix, mask the rest. */
export function redact(secret) {
  if (!secret) return '(empty)';
  const s = String(secret);
  const head = s.slice(0, Math.min(8, s.length));
  return `${head}${'*'.repeat(Math.max(0, s.length - head.length))}`;
}
