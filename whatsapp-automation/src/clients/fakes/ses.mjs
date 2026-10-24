/*
 * Fake SES client: records every email, returns a deterministic messageId.
 *
 * Same shape and same discipline as fakes/whatsapp.mjs, including
 * `sendSkipReason`, because Flow W asks the channel whether it is gated BEFORE
 * it creates a single-use Shopify code (S13). The two knobs that matter are
 * about NOT sending:
 *
 *   unavailable - EMAIL_FROM is unset, or @aws-sdk/client-sesv2 is not in the
 *                 Lambda bundle (iac excludes node_modules, so it genuinely
 *                 may not be). The real client must DEGRADE to a skip, never
 *                 throw, which is what the `email-unavailable` outcome is for.
 *   failWith    - SES itself refused. The worker must still not throw: a
 *                 rejected email must not redeliver a record whose WhatsApp
 *                 message has already gone out.
 */
export function makeFakeSes({ unavailable = false, skipWith = null, failWith = null } = {}) {
  const sent = [];
  let n = 0;
  return {
    sent,
    /** The service-wide gate (DRY_RUN / no EMAIL_FROM), asked before anything is spent. */
    sendSkipReason: () => skipWith,
    async send(args) {
      if (unavailable) return { skipped: 'email-unavailable' };
      if (failWith) {
        const e = new Error(`fake SES failure ${failWith}`);
        /** @type {any} */ (e).sesCode = failWith;
        throw e;
      }
      n += 1;
      sent.push({ ...args });
      return { messageId: `fake-ses-${n}` };
    },
  };
}
