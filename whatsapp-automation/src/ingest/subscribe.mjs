/*
 * subscribe.mjs — POST /subscribe, the storefront signup popup's only backend.
 *
 * Why this exists: Shopify's Liquid {% form 'customer' %} writes an email and
 * contact[tags] to the customer record, but every other contact[...] field it
 * accepts lands in the merchant's contact notification, NOT on the customer.
 * A phone number submitted through the native form is therefore silently lost,
 * and the popup asks for a WhatsApp number as a REQUIRED field. So the save
 * goes through the Admin API instead.
 *
 * Required: name and phone. Email is OPTIONAL, because WhatsApp is the channel
 * this list exists for. Shopify accepts a customer with "a name, phone number
 * or email address", so a create always has enough to go on. Email marketing
 * consent is only meaningful when there is an address, so both consent calls
 * are skipped for a signup without one.
 *
 * This is the one public, unsigned route in the service. Every other ingest
 * verifies a provider HMAC on the raw body; a browser cannot hold a secret, so
 * this route's defences are its own: an origin allowlist, a honeypot, a per-IP
 * rate limit, and strict validation before anything reaches Shopify.
 */
import { config } from '../config.mjs';
import { shopify } from '../clients/shopify.mjs';
import { table } from '../store/table.mjs';
import { log, metric, maskPhone } from '../log.mjs';

/* The live storefront. Extra origins (a theme-dev localhost, a preview host)
 * come from SUBSCRIBE_ORIGINS so testing never needs a code change. */
const DEFAULT_ORIGINS = ['https://www.morpaankh.in', 'https://morpaankh.in'];

function allowedOrigins() {
  const extra = String(process.env.SUBSCRIBE_ORIGINS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
}

/** Tags every popup signup carries, so the segment is queryable in admin. */
export const SUBSCRIBER_TAGS = ['popup-subscriber', 'whatsapp-optin'];

/* 5 signups per IP per 10 minutes. Slot keys rather than a counter: putNew is a
 * single conditional write, so concurrent requests cannot race past the cap and
 * there is no read-modify-write to lose. Worst case is RATE_MAX writes, and only
 * for an abuser.
 * ponytail: per-IP only, so one carrier NAT shares a bucket. Key on IP+email if
 * a real subscriber ever reports being blocked. */
const RATE_MAX = 5;
const RATE_WINDOW_S = 600;

async function withinRate(ip) {
  if (!ip) return true; // no IP to key on: validation + honeypot still apply
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_S);
  const expiresAt = (bucket + 2) * RATE_WINDOW_S; // TTL reaps the slot keys
  for (let slot = 0; slot < RATE_MAX; slot++) {
    if (await table.putNew({ PK: `RATE#subscribe#${ip}#${bucket}`, SK: `SLOT#${slot}`, expiresAt })) {
      return true;
    }
  }
  return false;
}

/* Deliberately stricter than the RFC: no quotes or angle brackets, so a value
 * that reaches the Shopify search query below cannot break out of its "..." . */
const EMAIL_RE = /^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[A-Za-z]{2,}$/;

export function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

/** To E.164. The +91 rule is enforced here, not trusted from the client. */
export function normalizePhone(raw) {
  const s = String(raw || '').replace(/[\s()\-.]/g, '');
  if (!/^\+\d{8,16}$/.test(s)) return null;
  if (s.startsWith('+91')) return /^\+91[6-9]\d{9}$/.test(s) ? s : null;
  return s;
}

export function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** One typed name into Shopify's two fields. First word is the given name and
 *  the remainder the family name, which is the convention the admin shows and
 *  the order forms already use. A single word stays a first name. */
export function splitName(raw) {
  const clean = cleanName(raw);
  if (!clean) return null;
  const i = clean.indexOf(' ');
  if (i === -1) return { firstName: clean };
  return { firstName: clean.slice(0, i), lastName: clean.slice(i + 1) };
}

/* An EXACT lookup, deliberately not customers(query:). The customer search
 * index lags a create by several seconds, so a second submit moments after the
 * first found nothing, fell through to customerCreate and died on "Email has
 * already been taken" -- a 502 for someone who simply double tapped. This
 * reads through the identifier instead of the index. */
const BY_IDENTIFIER = `query FindSubscriber($id: CustomerIdentifierInput!) {
  customerByIdentifier(identifier: $id) {
    id
    tags
    defaultEmailAddress { emailAddress marketingState }
    defaultPhoneNumber { phoneNumber }
  }
}`;

/** Email first when there is one, because it is the identifier most of the
 *  store's other records are keyed on; the phone catches a signup under a new
 *  address, and is the only lookup when no email was given. */
async function findExisting({ email, phone }) {
  if (email) {
    const byEmail = await shopify.graphql(BY_IDENTIFIER, { id: { emailAddress: email } }, { idempotent: true });
    if (byEmail && byEmail.customerByIdentifier) return byEmail.customerByIdentifier;
  }
  const byPhone = await shopify.graphql(BY_IDENTIFIER, { id: { phoneNumber: phone } }, { idempotent: true });
  return (byPhone && byPhone.customerByIdentifier) || null;
}

const CREATE = `mutation CreateSubscriber($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer { id tags defaultPhoneNumber { phoneNumber } }
    userErrors { field message }
  }
}`;

const UPDATE = `mutation UpdateSubscriber($input: CustomerInput!) {
  customerUpdate(input: $input) {
    customer { id tags defaultPhoneNumber { phoneNumber } }
    userErrors { field message }
  }
}`;

/* emailMarketingConsent is a valid field on CustomerInput and passes schema
 * validation on customerUpdate, but the API refuses it at runtime: "To update
 * emailMarketingConsent, please use the customerEmailMarketingConsentUpdate
 * Mutation instead". It IS accepted on customerCreate, so only the update path
 * needs this second call. */
const CONSENT = `mutation SubscriberConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
  customerEmailMarketingConsentUpdate(input: $input) {
    customer { id defaultEmailAddress { marketingState } }
    userErrors { field message }
  }
}`;

const consent = () => ({
  marketingState: 'SUBSCRIBED',
  marketingOptInLevel: 'SINGLE_OPT_IN',
  consentUpdatedAt: new Date().toISOString(),
});

/**
 * Save one signup. Returns { status: 'created' | 'already' }.
 * Exported so the test can drive it without an HTTP event.
 */
export async function saveSubscriber({ email, phone, name }) {
  const existing = await findExisting({ email, phone });

  if (config.dryRun) {
    log.info('subscribe dry run', { existing: Boolean(existing), phone: maskPhone(phone) });
    return { status: existing ? 'already' : 'created' };
  }

  if (!existing) {
    const input = { phone, tags: SUBSCRIBER_TAGS, ...(splitName(name) || {}) };
    /* Consent rides along on the create. It is rejected on customerUpdate but
     * accepted here, which is why only the update path needs CONSENT. */
    if (email) {
      input.email = email;
      input.emailMarketingConsent = consent();
    }
    const d = await shopify.graphql(CREATE, { input });
    const errs = d?.customerCreate?.userErrors || [];
    if (errs.length) {
      /* Either field can collide: the email when two submits race past the
       * lookup above, the phone when it already belongs to someone else.
       * Shopify rejects the whole mutation in both cases, and retrying without
       * the offending field would drop it silently, so re-read and update. */
      if (errs.some((e) => /taken|in use|already/i.test(e.message))) {
        const owner = await findExisting({ email, phone });
        if (owner) return updateSubscriber(owner, { email, phone, name });
      }
      throw new Error(`customerCreate: ${JSON.stringify(errs)}`);
    }
    if (!d?.customerCreate?.customer?.defaultPhoneNumber?.phoneNumber) {
      // Loud on purpose: the whole reason this endpoint exists is the phone.
      log.error('subscribe created a customer with no phone on record', { phone: maskPhone(phone) });
      metric('SubscribePhoneMissing', 1);
    }
    return { status: 'created' };
  }

  await updateSubscriber(existing, { email, phone, name });
  return { status: 'already' };
}

async function updateSubscriber(existing, { email, phone, name }) {
  const tags = Array.from(new Set([...(existing.tags || []), ...SUBSCRIBER_TAGS]));
  const input = { id: existing.id, tags };

  const onFile = existing.defaultPhoneNumber?.phoneNumber || '';
  if (!onFile) {
    input.phone = phone;
  } else if (onFile !== phone) {
    /* Never clobber a number that may be the one their orders ship against,
     * but never lose the new one in silence either: the tag makes the conflict
     * visible in admin instead of only in a log nobody reads. */
    input.tags = Array.from(new Set([...tags, 'phone-mismatch']));
    log.warn('subscribe phone differs from the number on file', {
      customerId: existing.id,
      onFile: maskPhone(onFile),
      submitted: maskPhone(phone),
    });
    metric('SubscribePhoneMismatch', 1);
  }
  /* Same rule as the phone: fill a blank, never overwrite what is on file.
   * A mismatch here is only a log, not a tag, because the email is the
   * optional field and a second address is not the conflict a phone one is. */
  const emailOnFile = existing.defaultEmailAddress?.emailAddress || '';
  if (email && !emailOnFile) {
    input.email = email;
  } else if (email && emailOnFile !== email) {
    log.warn('subscribe email differs from the address on file', { customerId: existing.id });
    metric('SubscribeEmailMismatch', 1);
  }

  Object.assign(input, splitName(name) || {});

  const d = await shopify.graphql(UPDATE, { input });
  const errs = d?.customerUpdate?.userErrors || [];
  if (errs.length) throw new Error(`customerUpdate: ${JSON.stringify(errs)}`);

  /* Skipped when there is no address to consent with, and when they are already
   * subscribed: nothing to change, and it avoids re-stamping consentUpdatedAt
   * over the date they actually opted in. */
  const hasEmail = Boolean(emailOnFile || input.email);
  if (hasEmail && existing.defaultEmailAddress?.marketingState !== 'SUBSCRIBED') {
    const c = await shopify.graphql(CONSENT, {
      input: { customerId: existing.id, emailMarketingConsent: consent() },
    });
    const cErrs = c?.customerEmailMarketingConsentUpdate?.userErrors || [];
    if (cErrs.length) throw new Error(`consentUpdate: ${JSON.stringify(cErrs)}`);
  }
  return { status: 'already' };
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

  /* CORS lives here, not in the HttpApi config: one allowlist, changeable
   * without a CDK deploy, and no risk of API Gateway and the handler both
   * setting Access-Control-Allow-Origin (two of that header fails the check). */
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
    log.warn('subscribe rejected origin', { origin });
    metric('SubscribeRejected', 1, { reason: 'origin' });
    return json(403, { ok: false, error: 'forbidden_origin' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'bad_json' }, cors);
  }

  /* Honeypot: a bot fills every field it can see. Answer exactly as a success
   * looks so it has no signal to tune against, and write nothing. */
  if (String(body.hp || '').trim()) {
    log.info('subscribe honeypot tripped');
    metric('SubscribeRejected', 1, { reason: 'honeypot' });
    return json(200, { ok: true, status: 'created' }, cors);
  }

  const name = cleanName(body.name);
  if (name.length < 2) return json(422, { ok: false, error: 'invalid_name' }, cors);
  const phone = normalizePhone(body.phone);
  if (!phone) return json(422, { ok: false, error: 'invalid_phone' }, cors);
  /* Optional, but not forgiving: a typo is rejected rather than saved as an
   * address that will never deliver. Blank is the only way to skip it. */
  const typedEmail = String(body.email || '').trim();
  const email = typedEmail ? normalizeEmail(typedEmail) : null;
  if (typedEmail && !email) return json(422, { ok: false, error: 'invalid_email' }, cors);

  const ip = event?.requestContext?.http?.sourceIp || '';
  if (!(await withinRate(ip))) {
    metric('SubscribeRejected', 1, { reason: 'rate' });
    return json(429, { ok: false, error: 'rate_limited' }, cors);
  }

  try {
    const { status } = await saveSubscriber({ email, phone, name });
    log.info('subscribe saved', { status, email: Boolean(email), phone: maskPhone(phone) });
    metric('SubscribeSaved', 1, { status });
    return json(200, { ok: true, status }, cors);
  } catch (e) {
    log.error('subscribe failed', { err: e.message, phone: maskPhone(phone) });
    metric('SubscribeFailed', 1);
    return json(502, { ok: false, error: 'save_failed' }, cors);
  }
};
