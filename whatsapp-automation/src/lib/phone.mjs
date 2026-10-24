/*
 * phone.mjs — the ONLY source of a recipient number (hard rule 1).
 *
 * The recipient is the COD King OTP-verified number from the order attribute
 * `_otpVerifiedPhoneNumber` (value like "91XXXXXXXXXX"). We NEVER fall back to
 * phone / customer.phone / shipping_address.phone / any typed field.
 *
 * Normalize to E.164 "+91XXXXXXXXXX": strip non-digits, then accept only
 *   - 12 digits starting "91" whose 3rd digit is 6-9, or
 *   - 10 digits starting 6-9 (prefix "91").
 * Anything else is invalid -> null (caller sends nothing, tags wa-no-verified-phone).
 *
 * ONE AUTHORISED EXCEPTION, owner's decision 2026-10-24: Flow W (the welcome
 * offer) messages Customer.defaultPhoneNumber. A candidate there has never
 * ordered and never reached checkout, so `_otpVerifiedPhoneNumber` does not
 * exist for them and the alternative was not sending the flow at all. It
 * reuses normalizeVerifiedPhone below for the validation, because these digit
 * rules ARE the check that number needs, and FLOW_W_ALLOWLIST shadow mode is
 * the mitigation for a bad number reaching a stranger. The rule stands
 * unchanged for Flows A, B, C and R: the exception is not a precedent.
 */

const VERIFIED_KEY = '_otpVerifiedPhoneNumber';

/** @param {string|null|undefined} raw @returns {string|null} E.164 or null */
export function normalizeVerifiedPhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return `+${digits}`;
  }
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91${digits}`;
  }
  return null;
}

/**
 * Pull the verified phone from a webhook payload's note_attributes
 * (`[{name, value}]`). Returns the normalized E.164 or null.
 */
export function verifiedPhoneFromNoteAttributes(noteAttributes) {
  if (!Array.isArray(noteAttributes)) return null;
  const hit = noteAttributes.find((a) => a && a.name === VERIFIED_KEY);
  return hit ? normalizeVerifiedPhone(hit.value) : null;
}

/**
 * Pull the verified phone from GraphQL customAttributes (`[{key, value}]`).
 * Returns the normalized E.164 or null.
 */
export function verifiedPhoneFromCustomAttributes(customAttributes) {
  if (!Array.isArray(customAttributes)) return null;
  const hit = customAttributes.find((a) => a && a.key === VERIFIED_KEY);
  return hit ? normalizeVerifiedPhone(hit.value) : null;
}

export { VERIFIED_KEY };
