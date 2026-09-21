/*
 * ndr.mjs — parse a customer's address reply. Pure.
 * The reply must contain a 6-digit pincode; the courier can only re-route within
 * the same pincode for a parcel already in motion.
 */

/** First standalone 6-digit number in the text, or null. */
export function extractPincode(text) {
  const m = String(text || '').match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

/**
 * @param {string} text  the customer's address message
 * @param {string|null} shipmentZip  the pincode on the shipment
 * @returns {{status:'same'|'different'|'no_pincode', pincode?:string}}
 */
export function classifyAddressReply(text, shipmentZip) {
  const pin = extractPincode(text);
  if (!pin) return { status: 'no_pincode' };
  if (shipmentZip && pin !== String(shipmentZip)) return { status: 'different', pincode: pin };
  return { status: 'same', pincode: pin };
}
