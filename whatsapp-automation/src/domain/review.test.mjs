import { describe, it, expect } from 'vitest';
import { validateReview, moderationStatus } from './review.mjs';

describe('validateReview', () => {
  const good = { rating: '5', review: 'Lovely fabric and the fit was spot on', display_name: 'Aarav', consent: true, fit: 'just_right' };
  it('accepts a valid submission', () => {
    const r = validateReview(good, { firstName: 'Aarav' });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ rating: 5, fit: 'just_right', consent: true });
  });
  it('rejects a bad rating', () => expect(validateReview({ ...good, rating: '7' }).ok).toBe(false));
  it('rejects too-short review text', () => expect(validateReview({ ...good, review: 'nice' }).ok).toBe(false));
  it('rejects an over-long display name', () => expect(validateReview({ ...good, display_name: 'x'.repeat(31) }).ok).toBe(false));
  it('falls back to first name when display name is empty', () => {
    const r = validateReview({ ...good, display_name: '' }, { firstName: 'Meera' });
    expect(r.value.displayName).toBe('Meera');
  });
});

describe('moderationStatus (never depends on rating)', () => {
  it('ACTIVE when consented + clean, even for a 1-star', () => {
    expect(moderationStatus('It was okay, a bit loose for me', true)).toBe('ACTIVE');
  });
  it('DRAFT without consent', () => expect(moderationStatus('Great', false)).toBe('DRAFT'));
  it('DRAFT with a url / email / phone', () => {
    expect(moderationStatus('see http://spam.com', true)).toBe('DRAFT');
    expect(moderationStatus('mail me at a@b.com', true)).toBe('DRAFT');
    expect(moderationStatus('call 9812345678', true)).toBe('DRAFT');
  });
  it('DRAFT with an abusive word', () => expect(moderationStatus('this is shit', true)).toBe('DRAFT'));
});
