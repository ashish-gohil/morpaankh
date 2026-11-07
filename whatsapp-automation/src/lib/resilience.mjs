/*
 * resilience.mjs — the two primitives every side effect goes through.
 *
 *   withRetry : survive a transient provider failure without burning an SQS
 *               attempt, WITHOUT ever repeating a call that may already have
 *               taken effect.
 *   soft      : run a step that must never fail the message it belongs to.
 *
 * The distinction that matters for money is whether a failed request actually
 * reached the provider:
 *
 *   NEVER SENT  DNS failure, connection refused, connect timeout, HTTP 429 and
 *               503. The provider explicitly refused or was never reached, so
 *               the call definitely did not happen. Always safe to retry, even
 *               for a refund.
 *   UNKNOWN     connection reset, socket timeout, HTTP 500/502/504. The request
 *               may have been processed before the connection died. Retrying a
 *               refund or a message here would repeat it, so these are retried
 *               ONLY when the caller declares the operation idempotent.
 *
 * Defaulting `idempotent` to false means a caller that has not thought about it
 * gets the safe behaviour.
 */
import { log, metric } from '../log.mjs';

const NEVER_SENT_STATUS = new Set([429, 503]);
const UNKNOWN_STATUS = new Set([500, 502, 504, 408, 425]);
const NEVER_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);
const UNKNOWN_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);

/*
 * AbortSignal.timeout rejects with a DOMException named 'TimeoutError' that
 * carries no `code` at all, so it fell through every classification here and
 * was treated as a permanent fault. It belongs in the MAYBE-SENT class: the
 * request left this process and we do not know whether the other end acted on
 * it, which is exactly the uncertainty `idempotent` exists to resolve.
 */
const codeOf = (err) => {
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') return 'ETIMEDOUT';
  return err?.cause?.code || err?.code || '';
};

/** True when the request provably never reached the provider. */
export function neverSent(err) {
  if (err?.status && NEVER_SENT_STATUS.has(err.status)) return true;
  return NEVER_SENT_CODES.has(codeOf(err));
}

/** True when the request may or may not have been processed. */
export function maybeSent(err) {
  if (err?.status && UNKNOWN_STATUS.has(err.status)) return true;
  return UNKNOWN_CODES.has(codeOf(err));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a provider call with exponential backoff and jitter.
 *
 * @param {string} label            what is being called, for logs and metrics
 * @param {() => Promise<any>} fn
 * @param {{attempts?:number, baseMs?:number, idempotent?:boolean}} [opts]
 *        idempotent: true only when repeating the call cannot cause a second
 *        message, charge, refund or order edit.
 */
export async function withRetry(label, fn, { attempts = 3, baseMs = 300, idempotent = false } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      const err = /** @type {any} */ (e);
      const worthRetrying = neverSent(err) || (idempotent && maybeSent(err));
      if (attempt >= attempts || !worthRetrying) throw err;
      // Jittered backoff: two workers failing on the same provider outage must
      // not come back in lockstep.
      const wait = Math.round(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
      log.warn('transient failure, retrying', { label, attempt, waitMs: wait, err: err.message });
      metric('TransientRetry', 1, { label });
      await sleep(wait);
    }
  }
}

/**
 * Run a step that must never fail the message it belongs to.
 *
 * For work that is genuinely secondary to the customer: an internal tag, an
 * audit metafield, an owner alert. The customer has already been served by the
 * time these run, so throwing would only cause SQS to redeliver and repeat
 * whatever already succeeded.
 *
 * It logs at ERROR level on purpose, tagged `soft`, so the failure still
 * reaches the owner's inbox through the error reporter. Swallowed is not the
 * same as hidden.
 */
export async function soft(label, fn, fields = {}) {
  try {
    return await fn();
  } catch (e) {
    const err = /** @type {any} */ (e);
    log.error('non-fatal step failed, continuing', {
      label,
      soft: true,
      err: err.message,
      stack: String(err.stack || '').split('\n').slice(0, 4).join(' | '),
      ...fields,
    });
    metric('SoftFailure', 1, { label });
    return null;
  }
}
