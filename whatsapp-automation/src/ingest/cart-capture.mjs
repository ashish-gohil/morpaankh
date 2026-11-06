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
import { alertOncePerDay } from '../store/cartRecovery.mjs';
import { table } from '../store/table.mjs';
import { istDayKey } from '../lib/time.mjs';
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

/*
 * Three caps, all counted the same way: claim numbered slots under one key
 * until one is free. No counter to read, no increment to race, and the TTL
 * does the forgetting. A conditional put that fails IS the count.
 */
async function claimSlot(pk, max, expiresAt) {
  for (let slot = 0; slot < max; slot++) {
    if (await table.putNew({ PK: pk, SK: `SLOT#${slot}`, expiresAt })) return true;
  }
  return false;
}

const withinRate = async (ip) => {
  if (!ip) return true;
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_S);
  return claimSlot(`RATE#cartcap#${ip}#${bucket}`, RATE_MAX, (bucket + 2) * RATE_WINDOW_S);
};

/*
 * THE IP LIMIT ABOVE IS NOT A LIMIT ON WHO CAN BE MESSAGED, and that is the
 * hole these two close. One caller rotating addresses, or one address posting
 * a different stranger's number each time, stays under 20-per-IP-per-10-min
 * forever. So the number itself is capped, and the endpoint as a whole is
 * capped, because a real storefront serving 1 to 2 orders a day never needs
 * either headroom.
 *
 * 3 per phone per IST day: a shopper who genuinely abandons, comes back and
 * abandons again is inside it, and putCapture refreshes one row rather than
 * adding rows, so the cap costs an honest shopper nothing.
 */
const PHONE_MAX_PER_DAY = 3;
const GLOBAL_MAX_PER_HOUR = 60;

async function withinPhoneCap(phone, now) {
  const day = istDayKey(now);
  // Two days, so the row outlives the IST day it counts; never a business deadline.
  const expiresAt = Math.floor(now.getTime() / 1000) + 2 * 86400;
  return claimSlot(`RATE#cartcap#ph#${phone}#${day}`, PHONE_MAX_PER_DAY, expiresAt);
}

async function withinGlobalCap(now) {
  const bucket = Math.floor(now.getTime() / 1000 / 3600);
  return claimSlot(`RATE#cartcap#all#${bucket}`, GLOBAL_MAX_PER_HOUR, (bucket + 2) * 3600);
}

/**
 * The cart's identity, with the credential Shopify now staples to it removed.
 *
 * `/cart.js` returns `token` as "<token>?key=<credential>" (61 characters, a
 * `?` and an `=` in it), so the bare pattern below refused every post the
 * storefront made. Measured live 29 Oct 2026: three `invalid_token` refusals
 * from a real shopper's browser, while the checkout webhook, which receives
 * the token WITHOUT that suffix, was accepted for the same bag.
 *
 * The suffix is DROPPED rather than allowed, for two reasons. It is a
 * credential, the same `key=` that makes a recovery URL work, and this row's
 * partition key is not the place for one. And it is not part of the cart's
 * identity: keeping it would file one bag under two different primary keys
 * depending on which source saw it first, which is exactly what the sources
 * were built to converge on.
 */
export function cleanToken(raw) {
  const s = String(raw || '').trim().split(/[?#]/)[0];
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

  /*
   * EVERY REFUSAL IS LOGGED, and that is not tidiness.
   *
   * Until 29 Oct 2026 the four validation refusals below returned their status
   * and said nothing, so a browser whose post was being turned away looked
   * exactly like a browser that never posted: both leave an empty log. The
   * day the storefront stopped capturing carts, the only evidence in CloudWatch
   * was invocations that ran for 2ms and wrote nothing, which named no cause.
   * A refusal is the one moment this endpoint knows something is wrong, so it
   * is the one moment it must speak.
   *
   * The reason is a fixed label and never the value, because the body of a
   * refused post is unvalidated input and one of its fields is a phone number.
   */
  const reject = (status, reason, fields = {}) => {
    log.warn('cart capture refused', { reason, ...fields });
    metric('CartCaptureRejected', 1, { reason });
    return json(status, { ok: false, error: reason }, reason === 'forbidden_origin' ? {} : cors);
  };

  if (method === 'OPTIONS') return { statusCode: allowed ? 204 : 403, headers: cors, body: '' };
  if (method !== 'POST') return reject(405, 'method_not_allowed', { method });
  if (!allowed) return reject(403, 'forbidden_origin', { origin });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return reject(400, 'bad_json');
  }

  /* The same normalizer Flow R's recipient rule uses, not a looser local one:
   * a number this endpoint accepted but the flow would later reject is a row
   * that can never be acted on. */
  const phone = normalizeVerifiedPhone(body.phone);
  if (!phone) return reject(422, 'invalid_phone');
  const token = cleanToken(body.token);
  if (!token) return reject(422, 'invalid_token');
  const items = cleanItems(body.items);
  if (!items) return reject(422, 'invalid_items', { lines: Array.isArray(body.items) ? body.items.length : null });

  const ip = event?.requestContext?.http?.sourceIp || '';
  if (!(await withinRate(ip))) return reject(429, 'rate_limited');

  /*
   * A cap being hit is the one signal that separates a busy day from an abuse
   * attempt, so it is raised as an ERROR once a day rather than a warning.
   * wa-cart-capture is in the error reporter's groups, so that error is the
   * owner's alert: there is no send path in an ingest function, and adding one
   * to reach a once-a-day line is not worth a WhatsApp client in here.
   */
  const now = new Date();
  const flood = async (reason) => {
    if (await alertOncePerDay(`cart-capture-flood:${reason}`, now)) {
      log.error('cart capture flood', { reason, phone: maskPhone(phone), ip });
    }
    return reject(429, reason);
  };
  if (!(await withinGlobalCap(now))) return flood('global_capped');
  if (!(await withinPhoneCap(phone, now))) return flood('phone_capped');

  try {
    /*
     * `source` is the whole point of F1: this row was typed by a browser, so
     * it is a HINT about who to message and never proof. onFirst refuses to
     * message a storefront row that Shopify cannot vouch for.
     */
    const id = await putCapture({ token, phone, items, attrs: cleanAttrs(body.attrs), source: 'storefront', now });
    log.info('cart captured', { id, lines: items.length, phone: maskPhone(phone) });
    metric('CartCaptured', 1);
    return json(200, { ok: true }, cors);
  } catch (e) {
    log.error('cart capture failed', { err: e.message, phone: maskPhone(phone) });
    metric('CartCaptureFailed', 1);
    return json(502, { ok: false, error: 'save_failed' }, cors);
  }
};
