/*
 * session.mjs — free-form (session) messages, sent only inside an open 24h
 * window. No Meta approval needed: edit and deploy. These may carry offers and
 * codes (templates may not). No emoji, no em/en dash (enforced by the test).
 *
 * Each entry: { type: 'text'|'buttons'|'cta_url'|'html', body, buttons?, ctaText? }.
 * buttons carry an `action` used to build the reply id payload at render time.
 */
import { encodePayload } from '../src/lib/ids.mjs';

/**
 * The one line in the prepaid offer that changes with the saving tier.
 *
 * Always a real benefit, never blank: an empty line would leave a hole in the
 * middle of the list, and for the Meta templates an empty variable is rejected
 * outright. flowA picks by `amt.gift`.
 */
export const OFFER_GIFT_LINE = '*A gift from us*, wrapped in with your order';
export const OFFER_NO_GIFT_LINE = '*Nothing to arrange* at the door on the day';

export const SESSION = {
  confirmed_with_offer: {
    type: 'cta_url',
    body:
      'Thank you, {{customer_name}}. Order {{order_number}} is confirmed and we have started getting it ready.\n\n' +
      'You can still switch to paying online, and it is worth the thirty seconds:\n\n' +
      '*You pay {{new_total}}* instead of {{order_total}}\n' +
      '*{{saving}} stays with you*\n' +
      '{{gift_line}}\n' +
      '*Packed first and dispatched on priority*, so it reaches you sooner\n\n' +
      'The link is open until {{valid_until}}. Nothing about your order changes unless you use it.',
    ctaText: 'Pay {{new_total}}',
  },
  pay_online_offer: {
    type: 'cta_url',
    body:
      'Here it is, {{customer_name}}. Your link for order {{order_number}}.\n\n' +
      '*You pay {{new_total}}* instead of {{order_total}}\n' +
      '*{{saving}} stays with you*\n' +
      '{{gift_line}}\n' +
      '*Packed first and dispatched on priority*, so it reaches you sooner\n\n' +
      'The link is open until {{valid_until}}. Nothing about your order changes unless you use it.',
    ctaText: 'Pay {{new_total}}',
  },
  keep_cod_ack: {
    type: 'text',
    body:
      'Done, {{customer_name}}. Order {{order_number}} stays on cash on delivery. ' +
      'We will send you the tracking link the moment it leaves us.',
  },
  cancel_check: {
    type: 'buttons',
    body: 'Just to be sure before we stop the packing: should we cancel order {{order_number}}?',
    buttons: [
      { title: 'Yes, cancel', flow: 'A', action: 'cancel_yes' },
      { title: 'No, keep it', flow: 'A', action: 'cancel_no' },
    ],
  },
  cancel_done: {
    type: 'text',
    body:
      'Order {{order_number}} is cancelled. Sorry it did not work out this time. ' +
      'Thank you for telling us, and we hope to dress you for the next occasion.',
  },
  cancel_kept: { type: 'text', body: 'Good. Order {{order_number}} stays exactly as it is.' },
  cancel_too_late: {
    type: 'text',
    body:
      'Order {{order_number}} has already left for delivery, so we cannot stop it from here. ' +
      'Someone from our team will call you shortly and sort it out with you.',
  },
  payment_received: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. Your payment of {{amount_paid}} for order {{order_number}} has come through.\n\n' +
      'The order is fully prepaid now, so there is nothing to hand over at the door. Prepaid orders are packed ' +
      'and dispatched on priority, so yours is already moving up the queue.',
  },
  prepaid_refund: {
    type: 'text',
    body:
      'Order {{order_number}} had already left for delivery when your payment reached us, so we could not ' +
      'switch it to prepaid.\n\n' +
      'Your {{amount_paid}} is on its way back to the same account and usually lands within {{refund_eta}}. ' +
      'Please keep {{cod_amount}} ready at delivery as planned.\n\nSorry for the extra step.',
  },
  review_code: {
    type: 'text',
    body:
      'Thank you for writing in, {{customer_name}}. That genuinely helps us.\n\n' +
      'Here is {{percent}}% off your next order: {{code}}\n' +
      'It works once on orders of {{min_order}} or more, until {{valid_until}}.',
  },
  review_code_pending: {
    type: 'text',
    body: 'Thank you for writing in, {{customer_name}}. Your thank you code will reach you here shortly.',
  },
  ndr_reattempt_ok: {
    type: 'text',
    body: 'Done. Our courier partner will try again on the next working day.',
  },
  ndr_address_ask: {
    type: 'text',
    body:
      'Please send your full address in one message: house or flat number, street, landmark, ' +
      'and the 6 digit pincode.',
  },
  ndr_address_retry: {
    type: 'text',
    body:
      'We could not find a 6 digit pincode in that one. Please send the full address again with the pincode ' +
      'included.',
  },
  ndr_address_saved: {
    type: 'text',
    body: 'Thank you. Our courier partner has the new address and will try the delivery again.',
  },
  ndr_pincode_changed: {
    type: 'text',
    body:
      'Thank you. That address is in a different pincode, which the courier cannot switch to once a parcel ' +
      'is already on the road. Our team will call you shortly and work it out.',
  },
  ndr_cancel_ack: {
    type: 'text',
    body: 'Noted. The parcel will come back to us. Thank you for telling us rather than leaving it.',
  },
  rto_other_ask: { type: 'text', body: 'Tell us in a line or two what went wrong. We read every one of these.' },
  rto_thanks: { type: 'text', body: 'Thank you for telling us. It is noted and it will not be wasted.' },
  optout_done: {
    type: 'text',
    body: 'You will not get order updates from us here anymore. Reply START whenever you want them back.',
  },
  optin_done: { type: 'text', body: 'Thank you. Your order updates will come here again.' },
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
