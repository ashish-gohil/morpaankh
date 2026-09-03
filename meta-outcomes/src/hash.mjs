/*
 * hash.mjs — Meta Advanced Matching normalisation + SHA-256 hashing.
 *
 * Per Meta's spec: normalise (trim, lowercase, strip formatting), then
 * SHA-256, then lowercase hex. Raw PII is never returned by the public helpers
 * and must never be logged.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/** Lowercase + trim, then hash. Returns null for empty. */
export function hashEmail(email) {
  if (!email) return null;
  const norm = String(email).trim().toLowerCase();
  if (!norm) return null;
  return sha256Hex(norm);
}

/**
 * Digits only, country code included, no plus/spaces/leading zeros, then hash.
 * Indian 10-digit numbers with no country code get 91 prepended.
 * @param {string} phone
 * @param {string} [defaultCc] default country code digits, e.g. "91"
 */
export function hashPhone(phone, defaultCc = '91') {
  if (!phone) return null;
  let digits = String(phone).replace(/\D+/g, '');
  if (!digits) return null;
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10) digits = defaultCc + digits; // bare local number
  return sha256Hex(digits);
}

/** Generic normalised text field (name, city, state): lowercase, strip spaces. */
export function hashText(value) {
  if (!value) return null;
  const norm = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if (!norm) return null;
  return sha256Hex(norm);
}

/** external_id is hashed but not normalised beyond stringify. */
export function hashExternalId(id) {
  if (id == null || id === '') return null;
  return sha256Hex(String(id));
}

/**
 * Build Meta `user_data` from a normalised order's contact fields. Values are
 * arrays of hashes, as Meta accepts. Empty keys are omitted. RAW PII IN, HASHES
 * OUT: the caller passes the raw contact, this returns only hashes.
 *
 * @param {{email?:string, phone?:string, externalId?:string|number,
 *          firstName?:string, lastName?:string, city?:string, state?:string,
 *          zip?:string, country?:string, fbc?:string, fbp?:string}} contact
 */
export function buildUserData(contact = {}) {
  const ud = {};
  const push = (key, val) => {
    if (val) ud[key] = Array.isArray(ud[key]) ? [...ud[key], val] : [val];
  };
  push('em', hashEmail(contact.email));
  push('ph', hashPhone(contact.phone));
  push('external_id', hashExternalId(contact.externalId));
  push('fn', hashText(contact.firstName));
  push('ln', hashText(contact.lastName));
  push('ct', hashText(contact.city));
  push('st', hashText(contact.state));
  push('zp', hashText(contact.zip));
  push('country', hashText(contact.country));
  // These are already opaque identifiers, sent unhashed per Meta's spec.
  if (contact.fbc) ud.fbc = contact.fbc;
  if (contact.fbp) ud.fbp = contact.fbp;
  return ud;
}
