/*
 * config.mjs — non-secret configuration from the environment.
 *
 * Same discipline as meta-outcomes: no secrets in code, a tiny hand-rolled .env
 * reader so local runs need no dotenv dependency, and DRY_RUN defaults TRUE.
 * Secrets never live here — they come from src/secrets.mjs.
 *
 * FLAGS ARE NOT HOT-SWAPPABLE. This comment used to promise a runtime overlay
 * from a DynamoDB config item via src/flags.mjs; that module was never built,
 * and `configBackend` below (fed by CONFIG_BACKEND in iac/lib/stack.js) is read
 * here and consumed by nothing. Believing the old comment would mean flipping a
 * flag and never deploying it, so: every value here comes from the environment
 * at cold start. To change one without a full deploy use
 * scripts/pause-flow.mjs, which rewrites the Lambda env vars directly.
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

  flows: { A: flow('A'), B: flow('B'), C: flow('C'), D: flow('D'), R: flow('R'), W: flow('W') },

  /*
   * Flow R shadow mode. NON-EMPTY means only these phones are really messaged;
   * every other eligible checkout is logged as "cart: would send" and nothing
   * is created, sent or locked. EMPTY means live to everyone.
   *
   * Separate from sendAllowlist on purpose: that one gates the whatsapp client
   * for the whole service, so using it to test Flow R would have silenced
   * Flow A's confirmations for every real customer at the same time.
   */
  cartRecoveryAllowlist: list(process.env.FLOW_R_ALLOWLIST),

  /*
   * Flow W shadow mode, and the same reasoning as Flow R's above: NON-EMPTY
   * means only these numbers are really messaged and every other candidate is
   * logged as "would send" with nothing created, sent or locked.
   *
   * It matters more here than it does for Flow R. Flow W is the first thing in
   * this service that messages a number which was never OTP-verified (owner's
   * decision, see src/lib/phone.mjs), so shadow mode is the mitigation for a
   * bad number reaching a stranger and it has to work before go-live.
   */
  subscriberOfferAllowlist: list(process.env.FLOW_W_ALLOWLIST),

  /*
   * Flow W's email fallback, through Amazon SES.
   *
   * EMAIL_FROM unset means email is simply unavailable, which is a recorded
   * outcome and not an error: the flow still runs for everybody reachable on
   * WhatsApp. It must be an address on a verified SES identity.
   *
   * EMAIL_REPLY_TO is where a customer's reply goes, and it is a human's
   * mailbox: nothing in this service reads it. Empty means replies go back to
   * EMAIL_FROM.
   */
  emailFrom: process.env.EMAIL_FROM || '',
  emailReplyTo: process.env.EMAIL_REPLY_TO || '',

  // How Flow B asks for a review. 'flow' is the native WhatsApp Flow, which
  // Meta will not let us publish until the business is verified; 'link' sends
  // the same message with a Google Form button and arms no reminder, because a
  // form cannot tell us it was filled in. Hot-swappable: no redeploy to switch.
  reviewVia: (process.env.REVIEW_VIA || 'flow').toLowerCase(),

  // Self-service size or colour change, offered from the Cancel button.
  // DEFAULT OFF. With it off, onCancel sends the old cancel_check and every
  // vc* tap is swallowed, so behaviour is byte for byte what it was.
  variantChangeEnabled: bool(process.env.VARIANT_CHANGE_ENABLED, false),

  /*
   * Replacement shipments (/replace).
   *
   * replaceMode is the one that matters:
   *   off    - the command answers "switched off" and does nothing.
   *   shadow - DEFAULT. Everything runs for real (parse, resolve, validate,
   *            serviceability, freight quote, preview, Confirm) except the two
   *            provider writes and the customer message, which are logged and
   *            described back to the owner instead. The point is that a shadow
   *            run proves the whole path on a real delivered order without
   *            booking a courier or messaging a customer.
   *   live   - the writes actually happen.
   * It is a mode rather than a boolean because "everything but the write" is
   * the state this feature needs to sit in until the Delhivery payload has been
   * verified against a real AWB, and a boolean cannot say that.
   */
  replaceMode: (process.env.REPLACE_MODE || 'shadow').toLowerCase(),
  // Who may run /replace. Empty means "the owner alert phones", so there is one
  // list to maintain until a second person genuinely needs the command.
  replaceAdminPhones: list(process.env.REPLACE_ADMIN_PHONES),
  // When set, live mode acts ONLY on these order numbers. The safe way to take
  // the first real booking: one test order of your own, nothing else reachable.
  replaceTestOrders: list(process.env.REPLACE_TEST_ORDERS),
  replaceRequireConfirm: bool(process.env.REPLACE_REQUIRE_CONFIRM, true),
  // `!` on the end of a command skips the preview. Off unless this is on.
  replaceAllowSkipConfirm: bool(process.env.REPLACE_ALLOW_SKIP_CONFIRM, false),
  replaceNotifyCustomer: bool(process.env.REPLACE_NOTIFY_CUSTOMER, true),
  replaceSendLabel: bool(process.env.REPLACE_SEND_LABEL, true),

  // Courier for /replace. One adapter per provider, picked here, so a new
  // courier is an adapter file plus this value and no orchestrator change.
  logisticsProvider: (process.env.LOGISTICS_PROVIDER || 'delhivery').toLowerCase(),
  // Must match the warehouse name registered with Delhivery EXACTLY, case
  // included: it is the pickup address on the forward leg and the destination
  // on the reverse leg, and Delhivery matches it as a string.
  delhiveryPickupLocation: process.env.DELHIVERY_PICKUP_LOCATION || '',
  delhiveryShippingMode: process.env.DELHIVERY_SHIPPING_MODE || 'Surface',
  sellerGstin: process.env.SELLER_GSTIN || '',
  /*
   * Where a reverse pickup is delivered back to, when that is not the pickup
   * warehouse. All five are needed together or none are used, and `name` being
   * empty is what means "send the return to the pickup warehouse".
   */
  replaceReturnTo: {
    name: process.env.REPLACE_RETURN_TO_NAME || '',
    address1: process.env.REPLACE_RETURN_TO_ADDRESS1 || '',
    city: process.env.REPLACE_RETURN_TO_CITY || '',
    state: process.env.REPLACE_RETURN_TO_STATE || '',
    pin: process.env.REPLACE_RETURN_TO_PIN || '',
    phone: process.env.REPLACE_RETURN_TO_PHONE || '',
  },
};

/** Redact a secret for safe logging: keep an 8-char prefix, mask the rest. */
export function redact(secret) {
  if (!secret) return '(empty)';
  const s = String(secret);
  const head = s.slice(0, Math.min(8, s.length));
  return `${head}${'*'.repeat(Math.max(0, s.length - head.length))}`;
}
