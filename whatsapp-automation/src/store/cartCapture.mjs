/*
 * cartCapture.mjs — carts the storefront saw the COD King OTP attribute on.
 *
 *   CAPCART#<cartToken> / CAP   the captured cart
 *
 * THE SORT KEY IS 'CAP', NOT 'REC', NOT 'STATE' AND NOT 'SUB'. cartRecovery's
 * allRecs() is a scanBySk('REC') that feeds the daily digest, reconcile's
 * scanStates() does the same for 'STATE', and Flow W's allSubRecs() does it
 * for 'SUB'. A capture filed under any of those sort keys would be read back
 * as a recovery record, as an order, or as a welcome offer.
 *
 * These rows are a QUEUE, not a history. The recovery record that Flow R
 * creates from one lives under CART#<id>/REC with its own retention; this row
 * only has to survive long enough for the sweep to see it, so it carries a
 * short TTL and nothing downstream reads it again.
 */
import { table } from './table.mjs';
// The id scheme belongs to the domain, which must not import this file back:
// see the checkJs note in src/domain/cartCapture.mjs.
import { captureIdFor, tokenFromCaptureId } from '../domain/cartCapture.mjs';

const pk = (token) => `CAPCART#${token}`;
const SK = 'CAP';

/*
 * Three days, deliberately longer than the 12 hour eligibility window.
 *
 * The row has to outlive the window it is eligible in, or a cart that aged out
 * overnight would vanish before the sweep could record WHY it was skipped, and
 * the same shopper's next capture would look like a first sighting.
 */
const TTL_DAYS = 3;
const ttl = (now = new Date()) => Math.floor(now.getTime() / 1000) + TTL_DAYS * 86400;

/**
 * Save, or refresh, one captured cart.
 *
 * `capturedAt` moves forward on every save ON PURPOSE. It is the moment they
 * were last seen holding this bag, and Flow R waits firstAfterMin from it, so
 * a shopper still adding things keeps resetting the clock and is messaged
 * twenty minutes after they actually stop rather than mid-browse.
 *
 * `verifiedBy` IS NEVER DOWNGRADED, AND NEITHER IS THE PHONE IT VOUCHES FOR.
 *
 * Two sources write this row. The checkout webhook is signed by Shopify, so
 * the number on it is proof. The public endpoint is a browser typing into an
 * unsigned POST, so the number on it is a hint. Both land on the same primary
 * key, which is the point: one bag, one row, whichever source saw it first.
 *
 * That shared key is also the attack. Without this merge, a caller who knows
 * or guesses a cart token that Shopify already vouched for could post the same
 * token with a stranger's number and inherit the verification, which is worse
 * than an unverified row because `onFirst` would then send without asking
 * Shopify anything. So a storefront write to a verified row refreshes the bag
 * and the clock and is refused the two fields that decide who gets messaged.
 *
 * @param {{token: string, phone: string, items: {id: string, qty: number}[],
 *          attrs?: Record<string,string>, source?: string,
 *          verifiedBy?: string, now?: Date}} args
 */
export async function putCapture({
  token,
  phone,
  items,
  attrs = {},
  source = 'storefront',
  verifiedBy = null,
  now = new Date(),
}) {
  const id = captureIdFor(token);
  const prior = verifiedBy ? null : await table.get(pk(token), SK);
  const keep = prior?.verifiedBy ? { verifiedBy: prior.verifiedBy, phone: prior.phone } : {};
  await table.put({
    PK: pk(token),
    SK,
    id,
    token,
    phone,
    items,
    attrs,
    source,
    ...(verifiedBy ? { verifiedBy } : {}),
    capturedAt: now.toISOString(),
    expiresAt: ttl(now),
    ...keep,
  });
  return id;
}

/** One captured cart by its `cap_<token>` id. */
export const getCapture = (id) => table.get(pk(tokenFromCaptureId(id)), SK);

/** Every captured cart still in the table. Paginated by scanBySk. */
export const listCaptures = () => table.scanBySk(SK);
