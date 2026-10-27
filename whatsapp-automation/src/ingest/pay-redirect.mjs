/*
 * pay-redirect.mjs — GET /p/{token}. Looks up the opaque token in the
 * PAYTOKEN# map and 302s to the live payment-link short URL, else serves the
 * "expired" page. Full validity/eligibility recheck lands with Flow A (Phase 5);
 * the copy will move to messages/session.mjs ('pay_link_expired_page').
 */
import { table } from '../store/table.mjs';
import { getState } from '../store/orderState.mjs';
import { hasTag } from '../domain/order.mjs';
import { log } from '../log.mjs';
import { pathToken } from '../lib/ids.mjs';

const page = (message) =>
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Morpaankh</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center">' +
  `<p>${message}</p></body>`;

const EXPIRED_HTML = page('This payment link has expired. Please reply on WhatsApp and we will help you.');
const PAID_HTML = page('This order is already paid, so there is nothing more to pay. Reply on WhatsApp if anything looks wrong.');
const CLOSED_HTML = page('This order is no longer open for payment. Please reply on WhatsApp and we will help you.');

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
  if (!map || !map.url) return html(EXPIRED_HTML);

  // expiresAt is epoch SECONDS (it is what Razorpay's expire_by was set to).
  if (map.expiresAt && Number(map.expiresAt) * 1000 <= Date.now()) {
    log.info('pay redirect: token expired', { orderId: map.orderId });
    return html(EXPIRED_HTML);
  }

  const st = map.orderId ? await getState(map.orderId) : null;
  if (st?.flowA?.convertedAt) {
    log.info('pay redirect: order already converted, not sending them to pay again', { orderId: map.orderId });
    return html(PAID_HTML);
  }
  if (st?.flowA?.step === 'stopped' || hasTag(st?.tags || [], 'wa-cancelled')) {
    log.info('pay redirect: order is closed', { orderId: map.orderId });
    return html(CLOSED_HTML);
  }

  log.info('pay redirect', { orderId: map.orderId });
  return { statusCode: 302, headers: { Location: map.url }, body: '' };
};
