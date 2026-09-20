/*
 * labels.mjs — non-message constants: button actions, RTO reasons, NDR options,
 * moderation word list, courier status -> friendly text, and a few fixed strings.
 * Button payload format is v1|<flow>|<orderId>|<action> (see src/lib/ids.mjs).
 */

// Button actions used to build payloads. Flow A/C quick replies reference these.
export const ACTIONS = {
  confirm: 'confirm',
  pay_online: 'pay_online',
  cancel: 'cancel',
  cancel_yes: 'cancel_yes',
  cancel_no: 'cancel_no',
  keep_cod: 'keep_cod',
  ndr_reattempt: 'ndr_reattempt',
  ndr_address: 'ndr_address',
  ndr_cancel: 'ndr_cancel',
};

// RTO reasons: id, label (customer-facing), slug (order tag rto-reason-<slug>).
export const RTO_REASONS = [
  { id: 'not_available', label: 'I was not available', slug: 'not-available' },
  { id: 'changed_mind', label: 'Changed my mind', slug: 'changed-mind' },
  { id: 'size_fit', label: 'Size or fit concern', slug: 'size-fit' },
  { id: 'delivery_late', label: 'Delivery took too long', slug: 'delivery-late' },
  { id: 'did_not_order', label: 'I did not order this', slug: 'did-not-order' },
  { id: 'other', label: 'Other reason', slug: 'other' },
];

// NDR quick-reply options (Flow C).
export const NDR_OPTIONS = [
  { id: ACTIONS.ndr_reattempt, label: 'Deliver tomorrow' },
  { id: ACTIONS.ndr_address, label: 'Change address' },
  { id: ACTIONS.ndr_cancel, label: 'Cancel order' },
];

// Reasons that force cod-block regardless of RTO count.
export const COD_BLOCK_REASONS = ['changed_mind', 'did_not_order'];

// Review moderation: reject text with contact info or any of these words. A hit
// sends the review to DRAFT for manual review; it NEVER affects the code (given
// for any genuine review) and NEVER depends on the star rating.
export const MODERATION = {
  patterns: [
    /https?:\/\//i, // urls
    /\bwww\./i,
    /[\w.+-]+@[\w-]+\.[\w.-]+/, // emails
    /\b\d{10}\b/, // bare 10-digit phone
  ],
  words: ['fuck', 'shit', 'bitch', 'bastard', 'chutiya', 'madarchod', 'bhenchod', 'randi'],
};

// Delhivery internal state -> friendly customer text (used in session copy).
export const COURIER_STATUS_TEXT = {
  MANIFESTED: 'is being prepared',
  PICKED_UP: 'has been picked up',
  IN_TRANSIT: 'is on the way',
  PENDING: 'is being processed',
  OUT_FOR_DELIVERY: 'is out for delivery',
  NDR: 'could not be delivered on the last attempt',
  DELIVERED: 'has been delivered',
  RTO_INITIATED: 'is on its way back to us',
  RTO_DELIVERED: 'has returned to us',
  LOST: 'needs attention',
  CANCELLED: 'has been cancelled',
};

// Fixed strings.
export const ORDER_EDIT_DISCOUNT_DESCRIPTION = 'Prepaid payment discount';
export const THEME_WHATSAPP_NOTICE = 'Order updates will be sent on WhatsApp to your verified mobile number.';
