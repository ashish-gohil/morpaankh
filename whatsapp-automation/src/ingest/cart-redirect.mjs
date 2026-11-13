/*
 * cart-redirect.mjs — GET /r/{token}. The "Complete my order" button.
 *
 * Looks the opaque token up in the CARTLINK# map and sends the customer to
 * their own saved checkout with their private code already applied. Serves a
 * page instead when there is nothing useful left to send them to.
 *
 * TWO HARD RULES.
 *
 * 1. The recovery URL contains `key=<credential>`. It is never logged and
 *    never put in a message. It travels in exactly two places, both of them
 *    straight to the customer who was sent the token: the Location header, and
 *    the button on the closed page, which is the only way left to hand them
 *    back their own bag. Both responses are `no-store` so nothing in between
 *    keeps a copy.
 * 2. Click counting is best effort and never decides the response. A customer
 *    who tapped our button must reach their bag even if DynamoDB is having a
 *    bad minute.
 */
import { RULES } from '../../messages/rules.mjs';
import { getCartLinkMap, getRec, patchRec } from '../store/cartRecovery.mjs';
import { cartPagesIn, cartPage } from '../../messages/pages.mjs';
import { langFor } from '../store/phoneProfile.mjs';
import { DEFAULT_LANG } from '../../messages/lang.mjs';
import { soft } from '../lib/resilience.mjs';
import { log, metric } from '../log.mjs';
import { pathToken } from '../lib/ids.mjs';

const STORE = 'https://www.morpaankh.in';
const html = (body) => ({
  statusCode: 200,
  // no-store because the closed page's button carries the recovery key.
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body,
});
const redirect = (location) => ({ statusCode: 302, headers: { Location: location, 'Cache-Control': 'no-store' }, body: '' });

/*
 * WhatsApp fetches a link to build its preview card, and so does Facebook's
 * scraper, and both look exactly like a tap. Counting them would have reported
 * a click on every message we sent. HEAD is never a person either.
 */
const BOT = /bot|crawl|spider|whatsapp|facebookexternalhit|preview|slackbot|telegram/i;

/*
 * EXPORTED, and reused by w-redirect.mjs rather than copied into it. Two
 * copies of this regex would drift, and the one that drifts is the one that
 * starts counting WhatsApp's own preview fetch as a customer tap, which turns
 * a click-through number into an invented one.
 */
export function isRealTap(event) {
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  if (method !== 'GET') return false;
  const headers = event?.headers || {};
  const ua = headers['user-agent'] || headers['User-Agent'] || '';
  return !BOT.test(String(ua));
}

/**
 * Where to send them. A RULES switch, never a template change: the button's
 * URL is fixed at Meta approval time and the only thing it carries is the
 * token, so every one of these can be changed by a deploy without touching
 * a single approved template.
 */
export function buildTarget(rec, rules = RULES) {
  const r = rules.cartRecovery;
  const code = encodeURIComponent(rec.code || '');
  const recovery = rec.recoveryUrl || '';
  const items = (rec.cartItems || []).map((i) => `${i.v}:${i.q}`).join(',');

  /*
   * A CAPTURED cart has no recover URL, because it never became a Shopify
   * checkout: that is the whole reason it was captured. Rebuild the bag as a
   * /cart permalink instead of dropping them on the home page having just been
   * promised their own bag back.
   *
   * The /discount/<CODE>?redirect= form, not ?discount=, and not by taste:
   * measured on this store 13 Oct, `/discount/BUY2?redirect=/cart` answered
   * 302 and set the discount_code cookie, while `/cart?discount=BUY2` answered
   * 200 and set nothing. The cookie is what survives into checkout, so it is
   * the only form that actually carries the offer. An unknown code still
   * redirects rather than erroring, so a deleted code cannot cost them the bag.
   */
  if (!recovery) {
    if (!items) return STORE;
    return `${STORE}/discount/${code}?redirect=${encodeURIComponent(`/cart/${items}`)}`;
  }

  if (r.linkTarget === 'cart') {
    /*
     * Last resort only, and only together with the theme change: a /cart/
     * landing goes through COD King's OTP popup again, and the theme's own
     * offers script auto-replaces a link-supplied code with the biggest public
     * one unless it has been taught not to.
     */
    const host = new URL(recovery).host;
    if (!items) return STORE;
    return `https://${host}/cart/${items}?discount=${code}&storefront=true`;
  }

  if (r.checkoutLinkStyle === 'path') {
    // /discount/<CODE>?redirect=<path> applies the code and then forwards.
    const u = new URL(recovery);
    const rest = `${u.pathname}${u.search}`;
    return `https://${u.host}/discount/${code}?redirect=${encodeURIComponent(rest)}`;
  }

  // Default: hand the code to the saved checkout itself.
  const sep = recovery.includes('?') ? '&' : '?';
  return `${recovery}${sep}discount=${code}`;
}

export const handler = async (event) => {
  const token = pathToken(event?.pathParameters?.token);
  const map = token ? await getCartLinkMap(token) : null;
  if (!map?.checkoutId) {
    // An old, guessed or truncated link. Send them to the shop, not an error.
    log.info('cart redirect: unknown token', {});
    return redirect(STORE);
  }
  const checkoutId = map.checkoutId;
  const rec = await getRec(checkoutId);
  if (!rec) {
    log.info('cart redirect: no record for this link', { checkoutId });
    return redirect(STORE);
  }

  if (isRealTap(event)) {
    // Inline rather than fire-and-forget: Lambda freezes the container once a
    // response is returned, so a detached write would simply be lost.
    await soft('cartClick', () =>
      patchRec(checkoutId, {
        clicks: (rec.clicks || 0) + 1,
        firstClickAt: rec.firstClickAt || new Date().toISOString(),
      }), { checkoutId });
    metric('CartLinkClick', 1);
  }

  /*
   * The page is the end of a message, so it is read in the language the
   * message was in. The phone comes off the checkout's own REC row, which is
   * the same phone the message went to.
   *
   * soft, and English on ANY doubt: a page in the wrong language is a bad
   * page, and a page that does not render is a broken shop.
   */
  const lang = (await soft('cartPageLang', () => langFor(rec.phone), { checkoutId })) || DEFAULT_LANG;
  const pages = cartPagesIn(lang);

  if (rec.orderId) {
    log.info('cart redirect: already ordered', { checkoutId });
    return html(cartPage(pages.ordered, STORE, lang));
  }

  if (rec.codeEndsAt && new Date(rec.codeEndsAt).getTime() <= Date.now()) {
    log.info('cart redirect: code has closed', { checkoutId });
    // Their bag, without the code, which has genuinely gone.
    return html(cartPage(pages.closed, rec.recoveryUrl || STORE, lang));
  }

  const target = buildTarget(rec);
  // linkTarget and the style, never the URL: it carries the recovery key.
  log.info('cart redirect', { checkoutId, linkTarget: RULES.cartRecovery.linkTarget, style: RULES.cartRecovery.checkoutLinkStyle });
  return redirect(target);
};
