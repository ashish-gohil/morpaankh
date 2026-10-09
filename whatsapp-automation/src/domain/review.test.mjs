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
  // 'nice' is 4 characters and is now ACCEPTED on purpose: the minimum dropped
  // from 10 to 4 because 10 was a desktop-form number on a WhatsApp surface.
  // 'ok' is the boundary that still carries no review in it.
  it('rejects review text with no words in it', () => expect(validateReview({ ...good, review: 'ok' }).ok).toBe(false));
  it('accepts a short but real review', () => expect(validateReview({ ...good, review: 'nice' }).ok).toBe(true));
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

/*
 * Publishing choice is three-way now, and the NAME is published exactly like
 * the text is, so it has to clear the same moderation bar.
 */
describe('publish choice', () => {
  const base = { rating: '5', review: 'Lovely fabric and the fit was perfect', display_name: 'Aarav' };

  it('shows it with the name they typed', () => {
    const v = validateReview({ ...base, publish: 'name' }, { firstName: 'Aarav' });
    expect(v.value).toMatchObject({ consent: true, displayName: 'Aarav' });
  });

  it('anonymous does NOT quietly fall back to their real first name', () => {
    const v = validateReview({ ...base, display_name: 'Aarav', publish: 'anon' }, { firstName: 'Aarav' });
    expect(v.value.displayName).not.toBe('Aarav');
    expect(v.value.consent).toBe(true);
  });

  it('do not publish keeps consent off', () => {
    const v = validateReview({ ...base, publish: 'no' }, { firstName: 'Aarav' });
    expect(v.value.consent).toBe(false);
    expect(moderationStatus(v.value.review, v.value.consent, v.value.displayName)).toBe('DRAFT');
  });

  it('still understands the old yes/no consent while the new Flow is in review', () => {
    expect(validateReview({ ...base, consent: true }, {}).value.consent).toBe(true);
    expect(validateReview({ ...base, consent: false }, {}).value.consent).toBe(false);
  });
});

describe('moderation covers the display name, not just the review', () => {
  const clean = 'Lovely fabric and the fit was perfect';

  it('holds a review whose NAME carries a phone number', () => {
    expect(moderationStatus(clean, true, 'call me 9876543210')).toBe('DRAFT');
  });

  it('holds a review whose NAME carries a url', () => {
    expect(moderationStatus(clean, true, 'www.notmorpaankh.in')).toBe('DRAFT');
  });

  it('holds a review whose NAME is abusive', () => {
    expect(moderationStatus(clean, true, 'chutiya')).toBe('DRAFT');
  });

  it('still publishes a clean review with a clean name', () => {
    expect(moderationStatus(clean, true, 'Aarav')).toBe('ACTIVE');
  });

  it('still holds a clean name with a dirty review', () => {
    expect(moderationStatus('visit www.elsewhere.com', true, 'Aarav')).toBe('DRAFT');
  });
});

/*
 * How short a real review is allowed to be. 10 characters was a desktop-form
 * number on a WhatsApp surface: "Loved it" is 8 and "Nice" is 4, and both are
 * genuine. Rejecting one is not a silent no-op either, it sends the customer a
 * "your code is coming" message and lands manual follow-up on the owner.
 */
describe('a short review is still a review', () => {
  const sub = (review) => ({ rating: '5', review, publish: 'name', display_name: 'Aarav' });

  it('accepts the short ones people actually write on a phone', () => {
    for (const text of ['Nice', 'Loved it', 'Very good', 'Good fit']) {
      const v = validateReview(sub(text), { firstName: 'Aarav' });
      expect(v.ok, `${text} (${text.length} chars) should be accepted`).toBe(true);
    }
  });

  it('still refuses something that carries no words at all', () => {
    for (const text of ['', ' ', 'ok']) {
      expect(validateReview(sub(text), { firstName: 'Aarav' }).errors).toContain('review');
    }
  });

  it('still refuses an essay beyond the max', () => {
    expect(validateReview(sub('x'.repeat(601)), { firstName: 'Aarav' }).errors).toContain('review');
  });
});
