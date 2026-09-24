/*
 * review.mjs — validate a submitted review and decide its moderation status.
 * Pure. The status NEVER depends on the rating (a genuine 1-star still gets the
 * code and is publishable); moderation only guards contact info / abuse.
 */
import { RULES } from '../../messages/rules.mjs';
import { MODERATION } from '../../messages/labels.mjs';

const FITS = ['too_tight', 'just_right', 'too_loose', 'not_sure'];
const PUBLISH = ['name', 'anon', 'no'];
/** What a review published without a name is credited to. */
export const ANON_NAME = 'A verified buyer';

/**
 * @param {object} sub  parsed nfm_reply: { product?, rating, fit?, review, display_name, consent }
 * @param {{firstName?:string}} ctx
 * @returns {{ok:boolean, errors:string[], value?:object}}
 */
export function validateReview(sub, { firstName = 'there' } = {}) {
  const errors = [];
  const rating = parseInt(sub.rating, 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.push('rating');

  const review = String(sub.review || '').trim();
  if (review.length < RULES.reviewTextMin || review.length > RULES.reviewTextMax) errors.push('review');

  // Three-way now, not a yes/no: show it with my name, show it without my
  // name, or do not show it. `consent` is still accepted so a submission from
  // the older published Flow keeps working while the new one is in review.
  let publish = String(sub.publish || '').trim();
  if (!PUBLISH.includes(publish)) publish = sub.consent === true || sub.consent === 'true' ? 'name' : 'no';

  // Anonymous means anonymous: we do NOT quietly fall back to their real first
  // name, which is what reusing the old displayName default would have done.
  let displayName = String(sub.display_name || '').trim();
  if (publish === 'anon') displayName = ANON_NAME;
  else if (!displayName) displayName = String(firstName || '').trim();
  if (displayName.length < 1 || displayName.length > 30) errors.push('display_name');

  const fit = sub.fit && FITS.includes(sub.fit) ? sub.fit : null;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { rating, review, displayName, fit, consent: publish !== 'no', publish, product: sub.product || null },
  };
}

/**
 * 'ACTIVE' if consent AND clean; else 'DRAFT'. Rating is irrelevant.
 *
 * `displayName` is checked as well as the review body. It used to be published
 * unchecked, so a name of "call me 9876543210" went live on the product page
 * with consent: the name is displayed exactly like the text is, so it has to
 * clear exactly the same bar.
 */
export function moderationStatus(text, consent, displayName = '') {
  if (!consent) return 'DRAFT';
  if (!isClean(text) || !isClean(displayName)) return 'DRAFT';
  return 'ACTIVE';
}

function isClean(value) {
  const s = String(value || '');
  if (MODERATION.patterns.some((re) => re.test(s))) return false;
  const lower = s.toLowerCase();
  return !MODERATION.words.some((w) => lower.includes(w));
}
