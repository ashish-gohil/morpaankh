/*
 * dedupe.mjs — one conditional put per provider event.
 *
 * Providers retry webhooks; SQS can redeliver. markSeen() returns true only the
 * first time an event id is seen. The record self-expires after 7 days via the
 * table's `expiresAt` TTL, so the ledger never grows unbounded.
 */
import { table } from './table.mjs';

const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * @param {string} source  e.g. "shopify" | "whatsapp" | "razorpay" | "delhivery"
 * @param {string} id      the provider's unique event id
 * @returns {Promise<boolean>} true if this is the first time we've seen it
 */
export async function markSeen(source, id) {
  if (!id) return true; // no id to dedupe on: let it through (caller logs)
  const now = Math.floor(Date.now() / 1000);
  return table.putNew({
    PK: `EVENT#${source}#${id}`,
    SK: 'DEDUP',
    seenAt: new Date().toISOString(),
    expiresAt: now + TTL_SECONDS,
  });
}

/**
 * Undo a markSeen. Used only when enqueue fails right after marking, so the
 * provider's retry is not mistaken for a duplicate and dropped.
 */
export async function unmarkSeen(source, id) {
  if (!id) return;
  await table.del(`EVENT#${source}#${id}`, 'DEDUP');
}
