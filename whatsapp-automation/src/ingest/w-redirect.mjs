/*
 * w-redirect.mjs — GET /w/{token}. The "Shop best sellers" button.
 *
 * This is the only part of Flow W a stranger can reach, and THE ONLY INPUT IT
 * READS IS THE TOKEN IN THE PATH. The host is the module constant below, the
 * path comes from RULES, and the code comes from the record: there is nothing
 * here for a query parameter, a forged Host header or a cookie to steer, which
 * is what makes it impossible to turn into an open redirect.
 *
 * TWO HARD RULES, both borrowed from cart-redirect.mjs.
 *
 * 1. An unknown, guessed, expired or truncated token is a REDIRECT to the
 *    collection, never an error. The customer tapped a button we sent them;
 *    the worst they should ever see is the shop.
 * 2. Click counting is best effort and never decides the response, and it is
 *    inline rather than detached: Lambda freezes the container once a response
 *    is returned, so a fire-and-forget write is simply lost.
 */
import { RULES } from '../../messages/rules.mjs';
import { landingUrl } from '../domain/subscriberOffer.mjs';
import { getSubLinkMap, getSubRec, countSubClick } from '../store/subscriberOffer.mjs';
import { isRealTap } from './cart-redirect.mjs';
import { soft } from '../lib/resilience.mjs';
import { log, metric } from '../log.mjs';

const STORE = 'https://www.morpaankh.in';
const collection = () => `${STORE}/collections/${RULES.subscriberOffer.collectionHandle}`;
const redirect = (location) => ({ statusCode: 302, headers: { Location: location, 'Cache-Control': 'no-store' }, body: '' });

export const handler = async (event) => {
  const token = event?.pathParameters?.token || '';
  // A key lookup, not a search: a token is either a row or it is not, so a
  // path-traversal or an absolute URL in this slot is simply an unknown token.
  const map = token ? await getSubLinkMap(token) : null;
  if (!map?.customerId) {
    // Never the token itself in a log line: it is a bearer credential for a
    // Rs 200 code.
    log.info('w redirect: unknown token', {});
    return redirect(collection());
  }

  const customerId = map.customerId;
  const rec = await getSubRec(customerId);
  if (!rec?.code) {
    log.info('w redirect: no record for this link', { customerId });
    return redirect(collection());
  }

  if (isRealTap(event)) {
    await soft('subscriberClick', () => countSubClick(customerId), { customerId });
    metric('SubscriberLinkClick', 1);
  }

  /*
   * A closed code travels NOWHERE. /discount/<dead code> sets a cookie that
   * Shopify then silently ignores at checkout, so the customer would reach the
   * cart believing the offer is on it and find out at the total.
   */
  if (!rec.codeEndsAt || new Date(rec.codeEndsAt).getTime() <= Date.now()) {
    log.info('w redirect: the code has closed', { customerId });
    return redirect(collection());
  }

  const target = landingUrl({
    code: rec.code,
    // The channel the link was SENT through, off the map, so an email tap is
    // reported as an email tap however the record has since been updated.
    channel: map.channel || rec.channel || 'whatsapp',
    rules: RULES,
    host: STORE,
  });
  log.info('w redirect', { customerId, channel: map.channel || rec.channel || 'whatsapp' });
  return redirect(target);
};
