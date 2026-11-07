/*
 * secrets.mjs — the ONLY place secrets are read. Never logged, never in config.
 *
 *   env : read individual vars from process.env (local dev / DRY_RUN).
 *   aws : read one JSON secret from Secrets Manager, cached 5 minutes in memory.
 *
 * getSecrets() returns a flat object with the field names below. Missing values
 * are '' so callers stay in DRY_RUN rather than crash.
 */
import { config } from './config.mjs';
import { awsTimeouts } from './lib/timeout.mjs';

const CACHE_MS = 5 * 60 * 1000;
let cache = null;
let cachedAt = 0;

// Secrets Manager JSON keys  <->  local env var names.
const FIELDS = {
  waAccessToken: 'WA_ACCESS_TOKEN',
  waAppSecret: 'WA_APP_SECRET',
  waVerifyToken: 'WA_VERIFY_TOKEN',
  waPhoneNumberId: 'WA_PHONE_NUMBER_ID',
  waWabaId: 'WA_WABA_ID',
  shopifyAdminToken: 'SHOPIFY_ADMIN_TOKEN',
  shopifyWebhookSecret: 'SHOPIFY_WEBHOOK_SECRET',
  razorpayKeyId: 'RAZORPAY_KEY_ID',
  razorpayKeySecret: 'RAZORPAY_KEY_SECRET',
  razorpayWebhookSecret: 'RAZORPAY_WEBHOOK_SECRET',
  // Delhivery Express API (static token: Authorization: Token <token>) - the
  // account's classic API. delhiveryPushSecret is the shared header Delhivery
  // signs its status-push webhook with (set when they enable it).
  delhiveryToken: 'DELHIVERY_TOKEN',
  delhiveryPushSecret: 'DELHIVERY_PUSH_SECRET',
  /*
   * N7. Cloudflare Turnstile's server-side secret, for the signup popup.
   *
   * OPTIONAL, and the endpoint's behaviour turns on whether it is set.
   * /subscribe is public and unsigned, and Flow W messages whatever number was
   * typed, which is the owner's own decision: so a fake signup is a WhatsApp
   * message to a stranger, and the per-IP limit does not stop one caller
   * rotating addresses.
   *
   * Absent means the token is NOT required, because requiring one before the
   * storefront sends it would reject every real signup. Present means every
   * request must carry a valid token. That ordering is what lets the secret and
   * the theme widget be deployed in either order.
   */
  turnstileSecret: 'TURNSTILE_SECRET',
  /*
   * Meta Marketing API, read only, for the monthly P&L's ad spend. Its own key
   * rather than a shared one: the meta-outcomes System User token would do the
   * job (ads_management covers the insights read, verified 2026-11-03), but it
   * belongs to another service, and a monthly report must not be breakable by
   * rotating a credential a customer-facing flow depends on. Absent means the
   * P&L records a Meta source failure, never zero spend.
   */
  metaAdsToken: 'META_ADS_TOKEN',
  payTokenKey: 'PAY_TOKEN_KEY',
  flowTokenKey: 'FLOW_TOKEN_KEY',
};

function fromEnv() {
  const out = {};
  for (const [k, envName] of Object.entries(FIELDS)) out[k] = process.env[envName] || '';
  return out;
}

let sm = null;
async function fromAws() {
  if (!sm) {
    const c = await import('@aws-sdk/client-secrets-manager');
    sm = { client: new c.SecretsManagerClient({ region: config.region, ...awsTimeouts() }), GetSecretValueCommand: c.GetSecretValueCommand };
  }
  const r = await sm.client.send(new sm.GetSecretValueCommand({ SecretId: config.secretsId }));
  const json = JSON.parse(r.SecretString || '{}');
  const out = {};
  for (const k of Object.keys(FIELDS)) out[k] = json[k] || '';
  return out;
}

/** @returns {Promise<Record<string,string>>} cached secrets object */
export async function getSecrets() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  cache = config.secretsBackend === 'aws' ? await fromAws() : fromEnv();
  cachedAt = now;
  return cache;
}

/**
 * Merge fields into the Secrets Manager secret (aws backend only). Used by
 * onboarding to persist the exchanged WhatsApp token + WABA/phone ids.
 */
export async function writeSecrets(patch) {
  if (config.secretsBackend !== 'aws') throw new Error('writeSecrets requires SECRETS_BACKEND=aws');
  const c = await import('@aws-sdk/client-secrets-manager');
  const client = new c.SecretsManagerClient({ region: config.region, ...awsTimeouts() });
  let current = {};
  try {
    const r = await client.send(new c.GetSecretValueCommand({ SecretId: config.secretsId }));
    current = JSON.parse(r.SecretString || '{}');
  } catch (e) {
    if (e?.name !== 'ResourceNotFoundException') throw e;
  }
  const next = { ...current, ...patch };
  await client.send(new c.PutSecretValueCommand({ SecretId: config.secretsId, SecretString: JSON.stringify(next) }));
  cache = null; // force a re-read next time
  return { ok: true };
}

/** Test-only: drop the cache. */
export function _resetSecrets() {
  cache = null;
  cachedAt = 0;
}
