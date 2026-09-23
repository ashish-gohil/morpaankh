/*
 * session.mjs — free-form (session) messages, sent only inside an open 24h
 * window. No Meta approval needed: edit and deploy. These may carry offers and
 * codes (templates may not). No emoji, no em/en dash (enforced by the test).
 *
 * Each entry: { type: 'text'|'buttons'|'cta_url'|'html', body, buttons?, ctaText? }.
 * buttons carry an `action` used to build the reply id payload at render time.
 */
import { encodePayload } from '../src/lib/ids.mjs';

export const SESSION = {
  confirmed_with_offer: {
    type: 'cta_url',
    body:
      'Thank you, {{customer_name}}. Your order {{order_number}} is confirmed. If you would like to pay online instead, you pay {{new_total}} rather than {{order_total}} and save {{saving}} extra. Prepaid orders are packed and dispatched on priority, so yours reaches you sooner. This is valid until {{valid_until}}.',
    ctaText: 'Pay {{new_total}}',
  },
  pay_online_offer: {
    type: 'cta_url',
    body:
      'Thank you, {{customer_name}}. You can pay {{new_total}} online instead of {{order_total}} and save {{saving}} extra. Prepaid orders are packed and dispatched on priority, so yours reaches you sooner. The link is valid until {{valid_until}}.',
    ctaText: 'Pay {{new_total}}',
  },
  keep_cod_ack: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. Your order {{order_number}} stays on Cash on Delivery. We will share the tracking details once it is dispatched.',
  },
  cancel_check: {
    type: 'buttons',
    body: 'Are you sure you want to cancel order {{order_number}}?',
    buttons: [
      { title: 'Yes, cancel', flow: 'A', action: 'cancel_yes' },
      { title: 'No, keep it', flow: 'A', action: 'cancel_no' },
    ],
  },
  cancel_done: {
    type: 'text',
    body:
      'Your order {{order_number}} has been cancelled. Sorry it did not work out this time, and thank you for letting us know.',
  },
  cancel_kept: { type: 'text', body: 'Thank you. Your order {{order_number}} stays as it is.' },
  cancel_too_late: {
    type: 'text',
    body:
      'Your order {{order_number}} has already been dispatched, so it cannot be cancelled from here. Our team will contact you shortly.',
  },
  payment_received: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. We have received your payment of {{amount_paid}} for order {{order_number}}. Your order is now fully prepaid, so there is nothing to pay at delivery. Prepaid orders are packed and dispatched on priority, so yours will reach you sooner.',
  },
  prepaid_refund: {
    type: 'text',
    body:
      'Sorry, your order {{order_number}} had already left for delivery, so we could not change it to prepaid. We have started a refund of {{amount_paid}} to your original payment method. It usually takes {{refund_eta}}. Please pay {{cod_amount}} at delivery as before.',
  },
  review_code: {
    type: 'text',
    body:
      'Thank you for your review, {{customer_name}}.\n\nYour code: {{code}}\nIt gives {{percent}}% off your next order of {{min_order}} or more. You can use it once, until {{valid_until}}.',
  },
  review_code_pending: {
    type: 'text',
    body: 'Thank you for your review, {{customer_name}}. Your code will reach you here shortly.',
  },
  ndr_reattempt_ok: {
    type: 'text',
    body: 'Thank you. We have asked our courier partner to try the delivery again on the next working day.',
  },
  ndr_address_ask: {
    type: 'text',
    body:
      'Please reply with your complete address, including house or flat number, street, landmark and the 6-digit pincode.',
  },
  ndr_address_retry: {
    type: 'text',
    body:
      'Sorry, we could not find a 6-digit pincode in that message. Please send the complete address again, including the pincode.',
  },
  ndr_address_saved: {
    type: 'text',
    body: 'Thank you. We have shared the updated address with our courier partner, and they will try the delivery again.',
  },
  ndr_pincode_changed: {
    type: 'text',
    body:
      'Thank you. The new address is in a different pincode, which the courier cannot change for a parcel that is already on its way. Our team will call you shortly to sort this out.',
  },
  ndr_cancel_ack: {
    type: 'text',
    body: 'Noted. The parcel will come back to us. Thank you for letting us know.',
  },
  rto_other_ask: { type: 'text', body: 'Please tell us in a short message what went wrong.' },
  rto_thanks: { type: 'text', body: 'Thank you for telling us. We have noted it.' },
  optout_done: {
    type: 'text',
    body: 'You will not get order updates from us on WhatsApp anymore. Reply START if you would like them again.',
  },
  optin_done: { type: 'text', body: 'Thank you. You will get order updates from us here again.' },
  pay_link_expired_page: {
    type: 'html',
    body: 'This payment link has expired. Please reply on WhatsApp and we will help you.',
  },
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function fill(str, vars, key) {
  const names = [];
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(str))) if (!names.includes(m[1])) names.push(m[1]);
  const missing = names.filter((n) => vars[n] === undefined);
  if (missing.length) throw new Error(`session ${key} missing vars: [${missing}]`);
  return str.replace(PLACEHOLDER, (_, n) => String(vars[n]));
}

/**
 * @param {string} key
 * @param {Record<string,string>} vars
 * @param {{orderId?:string, url?:string}} [ctx]  url for cta_url; orderId for button ids
 * @returns a shape the whatsapp client can send (or {type:'html',body} for the page)
 */
export function renderSession(key, vars = {}, ctx = {}) {
  const m = SESSION[key];
  if (!m) throw new Error(`unknown session message: ${key}`);
  const body = fill(m.body, vars, key);
  if (m.type === 'text' || m.type === 'html') return { type: m.type, body };
  if (m.type === 'cta_url') return { type: 'cta_url', body, buttonText: fill(m.ctaText, vars, key), url: ctx.url };
  if (m.type === 'buttons') {
    return {
      type: 'buttons',
      body,
      buttons: m.buttons.map((b) => ({ id: encodePayload({ flow: b.flow, orderId: ctx.orderId, action: b.action }), title: b.title })),
    };
  }
  throw new Error(`session ${key} has unknown type ${m.type}`);
}
