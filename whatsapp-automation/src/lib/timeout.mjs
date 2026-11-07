/*
 * timeout.mjs — a deadline on every outbound call.
 *
 * No client passed a `signal` to fetch, and Node's fetch has no default
 * timeout of its own. So a provider that accepted the connection and then
 * stopped answering held the worker until the Lambda's own timeout: 60 seconds
 * for the worker, 30 for an ingest, which is already six times past Shopify's
 * 5 second webhook deadline.
 *
 * The cost is not the wasted time. It is that the SQS message comes back 6
 * minutes later (visibility 360 s) and BLOCKS ITS GROUP the whole while, so one
 * hung call stalls every event for that order. And withRetry never sees a hang,
 * so its never-sent and maybe-sent rules, the ones that decide whether
 * retrying could double a message or a refund, are never applied.
 *
 * A TimeoutError is a MAYBE-SENT failure, deliberately: the request left this
 * process and we do not know whether the other end acted on it. See codeOf in
 * lib/resilience.mjs, which retries those only when the caller said the
 * operation is idempotent.
 *
 * THE BUDGET. withRetry does up to 3 attempts with a few hundred milliseconds
 * of backoff, so a timeout has to stay under about a third of the Lambda's
 * limit: attempts x timeout + backoff must finish inside 40 s in the worker.
 * 20 s is therefore the ceiling for anything retried, and the three 20 s
 * entries below are all non-idempotent calls that are NOT retried.
 */
export const TIMEOUT_MS = {
  shopify: 10_000,
  whatsapp: 10_000,
  razorpay: 10_000,
  // Tracking is read-only and idempotent, so it IS retried: 15 s x 3 fits.
  delhiveryTrack: 15_000,
  // Booking, editing and NDR actions change state at Delhivery and are not
  // retried, so they can afford to wait longer for a slow answer.
  delhiveryWrite: 20_000,
  // The P&L runs on a 15 minute Lambda and reads whole months, so its reads are
  // the one place a longer wait is cheaper than a failed report.
  metaGraph: 20_000,
};

/**
 * `{ signal }` for fetch, or `{}` where AbortSignal.timeout is unavailable.
 *
 * Spread into the fetch options rather than returned as a signal, so a caller
 * cannot accidentally pass `undefined` as a signal, which Node rejects.
 *
 * @param {number} ms
 */
export function deadline(ms) {
  return typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(ms) } : {};
}

/*
 * The same deadline, for an AWS SDK v3 client.
 *
 * The SDK's default is no request timeout at all and a connection timeout of
 * several seconds, so a hung AWS endpoint costs the same stalled FIFO group as
 * a hung provider. These are in-region calls answering in single-digit
 * milliseconds, so the numbers are deliberately tight.
 *
 * An INGEST is tighter still, because Shopify abandons a webhook after 5
 * seconds and a slow DynamoDB write there means a webhook Shopify will retry
 * anyway. Spend the retry rather than the deadline.
 *
 * @param {{ingest?: boolean}} [opts]
 */
export const awsTimeouts = ({ ingest = false } = {}) => ({
  requestHandler: {
    connectionTimeout: 1_000,
    requestTimeout: ingest ? 3_000 : 5_000,
  },
});
