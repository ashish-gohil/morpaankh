/*
 * pay-redirect.mjs — GET /p/{token}. Looks up the opaque token in the
 * PAYTOKEN# map and 302s to the live payment-link short URL, else serves the
 * "expired" page. Full validity/eligibility recheck lands with Flow A (Phase 5);
 * the copy will move to messages/session.mjs ('pay_link_expired_page').
 */
import { table } from '../store/table.mjs';
import { log } from '../log.mjs';

const EXPIRED_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Link expired</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center">' +
  '<p>This payment link has expired. Please reply on WhatsApp and we will help you.</p></body>';

export const handler = async (event) => {
  const token = event?.pathParameters?.token || '';
  const map = token ? await table.get(`PAYTOKEN#${token}`, 'MAP') : null;
  if (map && map.url) {
    log.info('pay redirect', { orderId: map.orderId });
    return { statusCode: 302, headers: { Location: map.url }, body: '' };
  }
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: EXPIRED_HTML };
};
