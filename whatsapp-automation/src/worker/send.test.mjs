/*
 * How a Meta send failure is classified, which is the branch that decides
 * whether a customer's one offer survives.
 *
 * On 2026-10-26 both of Flow W's WhatsApp candidates failed with 130472,
 * "User's number is part of an experiment". Meta runs a marketing-message
 * holdout on a small share of numbers: MARKETING templates to those numbers are
 * refused, the send is not billed, retrying the template returns the same error,
 * and there is no opt-out and no published end date. What still reaches them is
 * a free-form message inside an open 24 hour service window.
 *
 * That is 131049's shape exactly, so it needs 131049's handling: park the offer
 * against the phone and deliver it the moment the customer writes in. 130472 was
 * in neither of the two code sets, so it fell through to the generic branch: no
 * park, no window delivery. The one candidate who had an email got the offer by
 * email; the one who did not received nothing at all, and nothing would ever
 * come back for them, because the sweep only ever looks at yesterday.
 *
 * The code list lives in one place because four call sites read it: both flows'
 * thrown-error path and both flows' status-webhook path.
 */
import { describe, it, expect } from 'vitest';
import { isWindowDeliverable, isTemplateUnusable } from './send.mjs';

describe('isWindowDeliverable', () => {
  it('is true for the per-user marketing cap, 131049', () => {
    expect(isWindowDeliverable(131049)).toBe(true);
  });

  it("is true for Meta's marketing experiment holdout, 130472", () => {
    expect(isWindowDeliverable(130472)).toBe(true);
  });

  it('is false for an undeliverable number, where no window can help', () => {
    // 131026 means that handset cannot take a WhatsApp message at all, so
    // parking it against a service window that can never open would strand the
    // offer instead of falling straight through to email.
    expect(isWindowDeliverable(131026)).toBe(false);
  });

  it('is false for a template fault, which is ours to fix and not recipient-specific', () => {
    expect(isWindowDeliverable(132001)).toBe(false);
    expect(isWindowDeliverable(132015)).toBe(false);
  });

  it('is false for nothing at all, so a thrown non-Meta error never looks parkable', () => {
    expect(isWindowDeliverable(undefined)).toBe(false);
    expect(isWindowDeliverable(null)).toBe(false);
    expect(isWindowDeliverable(NaN)).toBe(false);
  });

  it('takes the numeric code, and a string code from a webhook still classifies', () => {
    // onSubStatus/onCartStatus read the code off a webhook payload, where it
    // arrives as a number but is stored and re-read through DynamoDB.
    expect(isWindowDeliverable(Number('130472'))).toBe(true);
  });

  it('does not overlap the template-unusable set', () => {
    for (const code of [131049, 130472]) {
      expect(isTemplateUnusable({ waCode: code })).toBe(false);
    }
  });
});
