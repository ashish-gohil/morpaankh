/*
 * actionable.mjs — is this provider event one the worker will DO anything with?
 *
 * Pure, and imported by BOTH the ingest and the worker's router, which is the
 * whole point: two copies of these predicates is how they drift into
 * disagreeing, and the failure that drift produces is an event the ingest drops
 * because it believes the worker ignores it.
 *
 * Measured over 30 days to 2026-11-06: wa-ingest-whatsapp ran 4,343 times and
 * wa-ingest-shopify 1,531, against 6,296 worker runs. A large share of those
 * decided nothing at all:
 *
 *   orders/updated fires on EVERY tag write, including the ones this service
 *     makes itself, and the worker acts on exactly one case, the COD-Cancelled
 *     tag. Every other one costs a dedupe write, an SQS message, a worker run,
 *     a WAMID read and a MSG# write to reach `return`.
 *   fulfillment_events/create fires on every courier scan; three statuses
 *     matter.
 *   checkouts/* fires on every keystroke-ish update; onCheckoutSeen skips
 *     anything without the OTP attribute as `no-verified-phone`.
 *   WhatsApp `sent` and `read` statuses are read by NOTHING. No code anywhere
 *     branches on either.
 *
 * THE RULE FOR CHANGING THIS FILE: if the worker learns to act on something
 * new, this file has to learn it in the same commit. A test asserts that the
 * worker's router and these predicates agree on every topic.
 */
import { hasTag } from './order.mjs';
import { verifiedPhoneFromNoteAttributes } from '../lib/phone.mjs';

/** Shopify topics the worker handles with no further condition. */
const ALWAYS = new Set([
  'orders/create',
  'orders/cancelled',
  'fulfillments/create',
  'fulfillments/update',
]);

/*
 * fulfillment_events statuses the worker branches on. `out_for_delivery` is
 * listed because N1 adds it; it is harmless until then, since the router
 * ignores what it does not know and the alternative is forgetting to add it.
 */
export const FULFILLMENT_EVENT_STATUSES = new Set([
  'delivered',
  'attempted_delivery',
  'failure',
  'out_for_delivery',
]);

/**
 * @param {string} topic  the x-shopify-topic header
 * @param {any} body      the REST-shaped payload
 * @returns {boolean}
 */
export function shopifyActionable(topic, body) {
  const t = String(topic || '');
  if (ALWAYS.has(t)) return true;

  if (t === 'orders/updated') {
    // The ONE case onShopify acts on. Note this reads the same CSV-or-array
    // shape the router does, through the same helper.
    const tags = Array.isArray(body?.tags)
      ? body.tags
      : String(body?.tags || '').split(',').map((x) => x.trim());
    return hasTag(tags, 'COD-Cancelled');
  }

  if (t === 'fulfillment_events/create') return FULFILLMENT_EVENT_STATUSES.has(String(body?.status || ''));

  if (t.startsWith('checkouts/')) {
    // A completed checkout is already dropped by the ingest; this is the other
    // half of the same question, and it is onCheckoutSeen's own first gate.
    if (body?.completed_at) return false;
    return Boolean(verifiedPhoneFromNoteAttributes(body?.note_attributes));
  }

  // An unknown topic is NOT dropped. Shopify can only send what we subscribed
  // to, so a topic we do not recognise means this file is behind the
  // subscription list, and losing the event is the worse of the two failures.
  return true;
}

/**
 * WhatsApp delivery statuses worth a worker run.
 *
 * `delivered` clears an undeliverable block and records the outcome; `failed`
 * drives the whole recovery path. `sent` and `read` are read by nothing.
 */
const WA_STATUSES = new Set(['delivered', 'failed']);

export const waStatusActionable = (status) => WA_STATUSES.has(String(status || ''));
