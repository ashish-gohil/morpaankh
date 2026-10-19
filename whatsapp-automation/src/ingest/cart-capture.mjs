/*
 * cart-capture.mjs — POST /cart-capture, Flow R's PRIMARY source.
 *
 * Shopify files an AbandonedCheckout only once a shopper reaches its own
 * contact step. On this store the OTP happens earlier, in COD King's popup,
 * which writes _otpVerifiedPhoneNumber to the CART with /cart/update.js. So
 * there is a real population that is reachable and that the checkout list
 * never sees: 17 to 19 Oct, five people passed OTP and walked away and
 * abandonedCheckouts returned none of them.
 *
 * The storefront posts here when it sees that attribute on a cart with items.
 *
 * THIS ROUTE IS PUBLIC AND UNSIGNED, like /subscribe, because a browser cannot
 * hold a secret. Its defences are the same: an origin allowlist, a per-IP rate
 * limit, and validation strict enough that nothing unchecked reaches storage.
 *
 * THE ONE RULE THAT MATTERS MOST: the body is treated as hostile about money.
 * It carries variant ids and quantities and NOTHING ELSE that can move a
 * price. Every amount Flow R goes on to offer against is read back from
 * Shopify at send time, because the offer is a percentage of the bag and a
 * caller that could name its own prices could name its own discount.
 */
import { normalizeVerifiedPhone, VERIFIED_KEY } from '../lib/phone.mjs';
import { putCapture } from '../store/cartCapture.mjs';
import { table } from '../store/table.mjs';
import { log, metric, maskPhone } from '../log.mjs';

const DEFAULT_ORIGINS = ['https://www.morpaankh.in', 'https://morpaankh.in'];

function allowedOrigins() {
  const extra = String(process.env.SUBSCRIBE_ORIGINS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
}

/* Higher than /subscribe's 5, because a cart legitimately changes several
 * times in a visit and each change is a post. Still a cap: the storefront
 * only posts on an actual change, so a caller hitting this is not shopping. */
const RATE_MAX = 20;
const RATE_WINDOW_S = 600;

async function withinRate(ip) {
  if (!ip) return true;
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_S);
  const expiresAt = (bucket + 2) * RATE_WINDOW_S;
  for (let slot = 0; slot < RATE_MAX; slot++) {
    if (await table.putNew({ PK: `RATE#cartcap#${ip}#${bucket}`, SK: `SLOT#${slot}`, expiresAt })) return true;
  }
  return false;
}

/** Shopify cart tokens are hex-ish and long; anything else is not one. */
export function cleanToken(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(s) ? s : null;
}

/**
 * The bag, as variant gids and quantities only.
 *
 * Returns null rather than a partial list when any line is malformed: a cart
 * we cannot read in full is one we would price wrongly, and a wrong price is a
 * wrong discount.
 */
export function cleanItems(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) return null;
  const out = [];
  for (const line of raw) {
    const id = String(line?.id ?? '').trim();
    if (!/^\d{6,20}$/.test(id)) return null;
    const qty = Number(line?.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return null;
    out.push({ id: `gid://shopify/ProductVariant/${id}`, qty });
  }
  return out;
}

/*
 * COD King's own attributes, kept because isPartialAdvance reads
 * _codkAmountType and _codkAmountValue off them to refuse carts whose line
 * prices are only an advance.
 *
 * _otpVerifiedPhoneNumber is NOT copyable through here. The stored row's phone
 * is the one this handler validated, and capturedToCheckout rebuilds the
 * attribute from it, so a body cannot name a recipient in two places and have
 * the weaker one win.
 */
const ATTR_RE = /^_codk[A-Za-z]{1,40}$|^_partialPaymentProduct$/;

export function cleanAttrs(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 12) break;
    if (k === VERIFIED_KEY || !ATTR_RE.test(k)) continue;
    if (v == null || typeof v === 'object') continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

// ---- HTTP ------------------------------------------------------------------

function lower(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'POST';
  const headers = lower(event?.headers);
  const origin = headers.origin || '';
  const allowed = allowedOrigins().includes(origin);

  const cors = allowed
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};

  if (method === 'OPTIONS') return { statusCode: allowed ? 204 : 403, headers: cors, body: '' };
  if (method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, cors);
  if (!allowed) {
    log.warn('cart capture rejected origin', { origin });
    metric('CartCaptureRejected', 1, { reason: 'origin' });
    return json(403, { ok: false, error: 'forbidden_origin' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'bad_json' }, cors);
  }

  /* The same normalizer Flow R's recipient rule uses, not a looser local one:
   * a number this endpoint accepted but the flow would later reject is a row
   * that can never be acted on. */
  const phone = normalizeVerifiedPhone(body.phone);
  if (!phone) return json(422, { ok: false, error: 'invalid_phone' }, cors);
  const token = cleanToken(body.token);
  if (!token) return json(422, { ok: false, error: 'invalid_token' }, cors);
  const items = cleanItems(body.items);
  if (!items) return json(422, { ok: false, error: 'invalid_items' }, cors);

  const ip = event?.requestContext?.http?.sourceIp || '';
  if (!(await withinRate(ip))) {
    metric('CartCaptureRejected', 1, { reason: 'rate' });
    return json(429, { ok: false, error: 'rate_limited' }, cors);
  }

  try {
    const id = await putCapture({ token, phone, items, attrs: cleanAttrs(body.attrs) });
    log.info('cart captured', { id, lines: items.length, phone: maskPhone(phone) });
    metric('CartCaptured', 1);
    return json(200, { ok: true }, cors);
  } catch (e) {
    log.error('cart capture failed', { err: e.message, phone: maskPhone(phone) });
    metric('CartCaptureFailed', 1);
    return json(502, { ok: false, error: 'save_failed' }, cors);
  }
};
