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
 * TWO AUTHORISED EXCEPTIONS.
 *
 * 1. Flow W (owner's decision 2026-10-24). The welcome offer messages
 *    Customer.defaultPhoneNumber. A candidate there has never ordered and
 *    never reached checkout, so `_otpVerifiedPhoneNumber` does not exist for
 *    them and the alternative was not sending the flow at all.
 *
 * 2. ORDERS, owner's decision 2026-11-02 (resolveOrderPhone below). An order
 *    only reaches COD King's popup when the shopper checks out through it.
 *    A recovery link, a Cashfree checkout straight from the cart, a draft
 *    order, an admin order and an API order all arrive with no OTP attribute,
 *    and the whole of Flows A, B and C read one field for the recipient, so
 *    those customers got NOTHING: not the confirmation, not the dispatch
 *    message, not the review ask. Measured over the last 30 days: #1213
 *    (Cashfree from the cart), #1232, #1233 (draft order) and #1239 (recovery
 *    link) each received not one message.
 *
 *    So for an ORDER the verified number is still tried first, and only when
 *    there is none do we fall back to the number the customer typed for
 *    delivery. The risk is real and worth naming: a typo in a delivery phone
 *    sends one order confirmation to a stranger. It is bounded by the same
 *    digit rules (an Indian mobile or nothing), by the order of preference
 *    below (the courier has to reach this number too, so it is the number the
 *    customer most wants right), and by `source` being logged on every send so
 *    a wrong number can be traced back to the field it came from.
 *
 * Flow R is NOT included and must not be: it messages someone who has not
 * ordered, about a cart, and the only number it may ever use is the one COD
 * King verified.
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

/*
 * The one recipient resolver for an ORDER. Exception 2 above.
 *
 * Preference order, most trustworthy first:
 *   otp      COD King's verified number. Proven to reach this person.
 *   order    Order.phone, which is what the shopper typed at checkout.
 *   shipping the delivery address phone, the one the courier will ring.
 *   billing  the billing address phone.
 *   customer the phone on the Shopify customer record.
 *
 * @param {{otp?:string|null, order?:string|null, shipping?:string|null,
 *          billing?:string|null, customer?:string|null}} src
 * @returns {{phone: string|null, source: string|null, tried: string[]}}
 */
export function resolveOrderPhone(src = {}) {
  const tried = [];
  for (const source of ['otp', 'order', 'shipping', 'billing', 'customer']) {
    const raw = src[source];
    if (raw == null || raw === '') continue;
    tried.push(source);
    /*
     * A typed delivery number is where "09876543210" and "0091 98765 43210"
     * live, and normalizeVerifiedPhone takes 10 or 12 digits and nothing else,
     * so the trunk prefix is stripped HERE rather than widening the rule that
     * also validates COD King's OTP number.
     */
    const digits = String(raw).replace(/\D/g, '').replace(/^(91)?0+/, '$1');
    const phone = normalizeVerifiedPhone(digits);
    if (phone) return { phone, source, tried };
  }
  // Every field was empty or none of them held an Indian mobile. The caller
  // records a reason code; nothing is ever sent to an unvalidated number.
  return { phone: null, source: null, tried };
}
