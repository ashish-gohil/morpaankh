/*
 * pay-redirect.mjs — GET /p/{token}. Looks up the opaque token in the
 * PAYTOKEN# map and 302s to the live payment-link short URL, else serves the
 * "expired" page.
 *
 * The three sentences live in messages/lang.mjs now, which is what makes them
 * translatable and what puts them under the no-dash, no-emoji test with the
 * rest of the copy. SESSION.pay_link_expired_page is still there and still
 * unused: sess() returns null for type 'html', so it never could have been
 * sent, and removing it is a separate decision from this one.
 */
import { table } from '../store/table.mjs';
import { getState } from '../store/orderState.mjs';
import { hasTag } from '../domain/order.mjs';
import { log } from '../log.mjs';
import { pathToken } from '../lib/ids.mjs';
import { langFor } from '../worker/send.mjs';
import { str, DEFAULT_LANG } from '../../messages/lang.mjs';
import { soft } from '../lib/resilience.mjs';

const page = (message, lang = DEFAULT_LANG) =>
  `<!doctype html><html lang="${lang === 'hi' ? 'hi' : 'en'}"><meta charset="utf-8">` +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Morpaankh</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center">' +
  `<p>${message}</p></body>`;

/*
 * The page is the dead end of a message we sent, so it is read in that
 * message's language. `lang` also sets the document's lang attribute, which is
 * what a screen reader pronounces it with.
 */
const payPage = (lang, key) => page(str(lang, key), lang);

const html = (body) => ({ statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body });

/**
 * GET /p/{token} -> the live Razorpay short URL.
 *
 * This used to redirect on nothing more than "the row exists and has a url".
 * Two things were stored and never read:
 *
 *  - `expiresAt` was written by setPayTokenMap on every link and checked
 *    nowhere, so a dead token still bounced the customer to Razorpay to meet
 *    Razorpay's own error page instead of ours.
 *  - the order's state. Cancelling the link after a conversion is a `soft`
 *    step, so when it fails the link stays LIVE. A customer reopening an old
 *    WhatsApp message could then pay a second time for an order that was
 *    already converted, and getting that money back is a manual refund.
 *
 * Both are one read each, on a route that runs once per customer tap.
 */
export const handler = async (event) => {
  const token = pathToken(event?.pathParameters?.token);
  const map = token ? await table.get(`PAYTOKEN#${token}`, 'MAP') : null;
  /*
   * A token that resolves to nothing has no order and so no customer, which
   * means no language either. English, which is also what every one of these
   * pages said before today.
   */
  if (!map || !map.url) return html(payPage(DEFAULT_LANG, 'payExpired'));

  const st = map.orderId ? await getState(map.orderId) : null;
  /*
   * From the ORDER's own stored phone, not from anything in the URL. soft and
   * English on any doubt: a page in the wrong language is a bad page, and a
   * page that throws is a broken shop at the end of a payment link.
   */
  const lang = (await soft('payPageLang', () => langFor(st?.verifiedPhone), { orderId: map.orderId }))
    || DEFAULT_LANG;

  // expiresAt is epoch SECONDS (it is what Razorpay's expire_by was set to).
  if (map.expiresAt && Number(map.expiresAt) * 1000 <= Date.now()) {
    log.info('pay redirect: token expired', { orderId: map.orderId });
    return html(payPage(lang, 'payExpired'));
  }

  if (st?.flowA?.convertedAt) {
    log.info('pay redirect: order already converted, not sending them to pay again', { orderId: map.orderId });
    return html(payPage(lang, 'payAlreadyPaid'));
  }
  if (st?.flowA?.step === 'stopped' || hasTag(st?.tags || [], 'wa-cancelled')) {
    log.info('pay redirect: order is closed', { orderId: map.orderId });
    return html(payPage(lang, 'payClosed'));
  }

  log.info('pay redirect', { orderId: map.orderId });
  return { statusCode: 302, headers: { Location: map.url }, body: '' };
};
