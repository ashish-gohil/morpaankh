/*
 * review.mjs — validate a submitted review and decide its moderation status.
 * Pure. The status NEVER depends on the rating (a genuine 1-star still gets the
 * code and is publishable); moderation only guards contact info / abuse.
 */
import { RULES } from '../../messages/rules.mjs';
import { MODERATION } from '../../messages/labels.mjs';

const FITS = ['too_tight', 'just_right', 'too_loose', 'not_sure'];

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

  const displayName = String(sub.display_name || firstName || '').trim();
  if (displayName.length < 1 || displayName.length > 30) errors.push('display_name');

  const fit = sub.fit && FITS.includes(sub.fit) ? sub.fit : null;
  const consent = sub.consent === true || sub.consent === 'true';

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { rating, review, displayName, fit, consent, product: sub.product || null },
  };
}

/** 'ACTIVE' if consent AND clean; else 'DRAFT'. Rating is irrelevant. */
export function moderationStatus(text, consent) {
  if (!consent) return 'DRAFT';
  const s = String(text || '');
  if (MODERATION.patterns.some((re) => re.test(s))) return 'DRAFT';
  const lower = s.toLowerCase();
  if (MODERATION.words.some((w) => lower.includes(w))) return 'DRAFT';
  return 'ACTIVE';
}
