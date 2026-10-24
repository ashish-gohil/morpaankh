/*
 * clients/email.mjs — Amazon SES v2, for the one flow that has to reach
 * somebody WhatsApp cannot.
 *
 * IT NEVER THROWS FOR A REASON THAT IS NOT WORTH A RETRY. Every refusal comes
 * back as `{ skipped: <reason> }`, because the caller has already spent a
 * Shopify discount code by the time some of these are discovered, and an
 * exception there would redeliver a record whose WhatsApp message may already
 * have gone out.
 *
 * THE SDK MAY GENUINELY NOT BE THERE. iac/lib/stack.js builds the Lambda asset
 * with `exclude: ['node_modules', ...]`, so a function gets only what the
 * NODEJS_24_X runtime itself ships. @aws-sdk/client-sesv2 is a devDependency
 * for the tests and the type checker and is NOT bundled, so the import below
 * is dynamic, inside try/catch, and degrades to `email-unavailable` rather
 * than killing the worker on cold start. That outcome is a real one the owner
 * will see in `subscriber-offer.mjs preview`, and it means "the deploy cannot
 * send email", not "that address is bad".
 */
import { config } from '../config.mjs';
import { log, metric } from '../log.mjs';
import { headerSafe } from '../../messages/email.mjs';

let ses = null;
let sesBroken = false;

/**
 * The SES client, or null if this deploy has no SES SDK to talk to.
 *
 * Remembered either way: a missing module is a property of the bundle, not of
 * the moment, so retrying the import per message would only cost latency.
 */
async function client() {
  if (ses || sesBroken) return ses;
  try {
    const mod = await import('@aws-sdk/client-sesv2');
    ses = {
      send: (cmd) => new mod.SESv2Client({ region: config.region }).send(cmd),
      SendEmailCommand: mod.SendEmailCommand,
    };
  } catch (e) {
    sesBroken = true;
    log.error('email: no SES SDK in this bundle, email is unavailable', { err: /** @type {any} */ (e).message });
  }
  return ses;
}

/** True when SES says the problem is the address being on the suppression list. */
const suppressed = (e) =>
  e?.name === 'AccountSuppressionListException' || /suppress/i.test(String(e?.message || ''));

export const email = {
  /**
   * The service-wide gate, asked BEFORE the caller spends anything.
   *
   * Flow W creates a single-use Shopify discount code for the message it is
   * about to send, so a run with DRY_RUN on would otherwise leave one orphan
   * code per candidate in the admin.
   */
  sendSkipReason() {
    if (config.dryRun) return 'dry_run';
    if (!config.emailFrom) return 'email-unavailable';
    return null;
  },

  /**
   * Send one email.
   *
   * @param {{to: string, subject: string, html: string, text: string,
   *          headers?: Record<string,string>, validFormat?: boolean}} args
   * @returns {Promise<{messageId?: string, skipped?: string}>}
   */
  async send({ to, subject, html, text, headers = {}, validFormat }) {
    /*
     * Shopify has already told us this address cannot receive. Skipping it
     * costs nothing; sending to it costs a bounce, and SES judges a sender on
     * its bounce RATE, not its bounce count. At one or two emails a day a
     * single dud address is a double-digit percentage of the day's volume,
     * which is how a new sending identity gets put under review.
     */
    if (validFormat === false) return { skipped: 'email-invalid' };
    if (!config.emailFrom) return { skipped: 'email-unavailable' };
    const c = await client();
    if (!c) return { skipped: 'email-unavailable' };

    /*
     * Every header value is stripped of CR and LF. Two of these come from
     * outside this service: the address is the customer's and the unsubscribe
     * URL is Shopify's, and a bare CRLF in either appends headers of somebody
     * else's choosing to our message.
     *
     * Reply-To is EMAIL_REPLY_TO, falling back to the From identity, so a
     * customer who answers the welcome offer reaches a human rather than a
     * bounce. Nothing in this service reads that mailbox: it is a person's.
     */
    const list = Object.entries(headers)
      .filter(([, v]) => v != null && String(v) !== '')
      .map(([Name, Value]) => ({ Name: headerSafe(Name), Value: headerSafe(Value) }));

    try {
      const res = await c.send(
        new c.SendEmailCommand({
          FromEmailAddress: headerSafe(config.emailFrom),
          Destination: { ToAddresses: [headerSafe(to)] },
          ReplyToAddresses: [headerSafe(config.emailReplyTo || config.emailFrom)],
          Content: {
            Simple: {
              Subject: { Data: headerSafe(subject), Charset: 'UTF-8' },
              Body: {
                Html: { Data: html, Charset: 'UTF-8' },
                Text: { Data: text, Charset: 'UTF-8' },
              },
              /*
               * List-Unsubscribe travels here. An SDK older than the Headers
               * field would drop it rather than fail the send, which is why
               * the unsubscribe link is ALSO in the body: that one cannot be
               * dropped by anything.
               */
              Headers: list.length ? list : undefined,
            },
          },
        }),
      );
      metric('EmailSent', 1);
      return { messageId: res?.MessageId };
    } catch (e) {
      /*
       * A suppressed address is NOT retried, and it is its own outcome. The
       * address bounced or complained once already, SES is refusing on our
       * behalf, and sending again is the exact behaviour that suppression
       * exists to stop. Everything else is reported as a send failure and the
       * caller records it; nothing here throws.
       */
      if (suppressed(e)) {
        log.warn('email: address is on the SES suppression list, not retrying', {});
        metric('EmailSuppressed', 1);
        return { skipped: 'email-suppressed' };
      }
      throw e;
    }
  },
};
