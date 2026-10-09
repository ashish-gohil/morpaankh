/*
 * session.mjs — free-form (session) messages, sent only inside an open 24h
 * window. No Meta approval needed: edit and deploy. These may carry offers and
 * codes (templates may not). No emoji, no em/en dash (enforced by the test).
 *
 * Each entry: { type: 'text'|'buttons'|'cta_url'|'list'|'html', body, buttons?, ctaText?, listButton? }.
 * A 'list' carries no rows here: the rows are per-order (live sizes, live
 * stock) so the caller passes them to sess() in ctx.rows.
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
  // Deliberately NOT cancel_too_late: nothing has left, the order is simply
  // paid for. Saying "already left for delivery" to someone whose money we are
  // holding would be the wrong reason and would read as a brush off.
  cancel_refund_review: {
    type: 'text',
    body:
      'Order {{order_number}} is already paid, so we want a person to handle the cancellation and ' +
      'your refund rather than do it automatically. Someone from our team will call you shortly.',
  },
  // ---- variant change (size or colour swap) -------------------------------
  // Entry point. Replaces cancel_check when the order is still changeable, so
  // someone who only wants a different size is not pushed down the cancel path.
  // That is how order #1187 became #1188: cancelled, then reordered one size up
  // 36 minutes later.
  change_or_cancel: {
    type: 'buttons',
    body:
      'Before we stop the packing: would you like to change the size or colour on order {{order_number}}, ' +
      'or cancel it altogether?',
    buttons: [
      { title: 'Change size/colour', flow: 'A', action: 'vc' },
      { title: 'Cancel order', flow: 'A', action: 'cancel_yes' },
      { title: 'Keep my order', flow: 'A', action: 'cancel_no' },
    ],
  },

  // Which line, when the order has more than one changeable item.
  vc_pick_item: {
    type: 'list',
    body: 'Which item would you like to change on order {{order_number}}?',
    listButton: 'Choose item',
  },

  // Size or colour, for a product that has other colours in stock.
  vc_pick_option: {
    type: 'buttons',
    body: 'You have {{item_desc}}. What would you like to change?',
    buttons: [
      // action: null means the caller MUST supply one in ctx.actions, because it
      // carries a line item id. renderSession throws rather than emit a dead button.
      { title: 'Size', flow: 'A', action: null },
      { title: 'Colour', flow: 'A', action: null },
      { title: 'Keep as it is', flow: 'A', action: 'cancel_no' },
    ],
  },

  vc_pick_size: {
    type: 'list',
    body: 'You have {{item_desc}}. Please choose the size you would like instead.',
    listButton: 'Choose size',
  },

  vc_pick_colour: {
    type: 'list',
    body: 'You have {{item_desc}}. Please choose the colour you would like instead.',
    listButton: 'Choose colour',
  },

  // NOTHING is written to the order until the customer taps Yes here. The
  // amount is shown unchanged on purpose: the first thing a person fears when
  // changing an order is that the price will move.
  vc_confirm: {
    type: 'buttons',
    body:
      'Please confirm: order {{order_number}} changes from {{from_desc}} to {{to_desc}}.\n\n' +
      'The amount stays {{order_total}}.',
    buttons: [
      { title: 'Yes, change it', flow: 'A', action: null }, // needs ctx.actions: carries line + variant
      { title: 'Go back', flow: 'A', action: 'vc' },
    ],
  },

  vc_changed: {
    type: 'text',
    body:
      'Done. Order {{order_number}} is now {{to_desc}}, and the amount stays {{order_total}}. ' +
      'We will pack this one instead.',
  },

  vc_nothing_available: {
    type: 'text',
    body:
      'We do not have another size or colour of {{item_desc}} in stock right now, so order {{order_number}} ' +
      'stays as it is. Reply here and someone from our team will help you.',
  },

  // Any failure, any ineligible case, anything we are not certain about. The
  // order is never left half changed.
  vc_handoff: {
    type: 'text',
    body:
      'We could not make that change from here. Someone from our team will message you shortly. ' +
      'Order {{order_number}} stays exactly as it is until then.',
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
  /*
   * The code sits ALONE inside triple backticks, which WhatsApp renders as a
   * monospace block. That is deliberate: a one-tap copy button exists only as
   * a TEMPLATE component (authentication and coupon-code templates), not for
   * free-form messages, and turning this into a template would make it
   * MARKETING, which brings opt-in, a frequency cap and a per-message cost to
   * something that is free inside the window the customer just opened by
   * submitting. A monospace block on its own line is the closest free thing:
   * it reads as a code rather than as prose, and holding it selects the code
   * without dragging in the words around it.
   */
  review_code: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. We read every one of these properly.\n\n' +
      '{{amount}} towards your next piece:\n\n' +
      '```{{code}}```\n\n' +
      'Hold the code to copy it. It is yours alone, works once on an order of {{min_order}} or more, ' +
      'and is good until {{valid_until}}.\n\n' +
      'Come and see what is new at morpaankh.in',
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
      // ctx.actions overrides a button's static action by title, for the two
      // variant-change messages whose buttons must carry a line and variant id.
      buttons: m.buttons.map((b) => {
        // A button whose action is null carries per-order ids and MUST be given
        // one. Falling back to a literal would emit a payload that routes
        // nowhere: the customer taps and nothing whatsoever happens.
        const action = (ctx.actions && ctx.actions[b.title]) || b.action;
        if (!action) throw new Error(`session ${key} button "${b.title}" needs ctx.actions["${b.title}"]`);
        return { id: encodePayload({ flow: b.flow, orderId: ctx.orderId, action }), title: b.title };
      }),
    };
  }
  if (m.type === 'list') {
    // Rows are per-order, so they arrive in ctx.rows as [{id, title, description?}]
    // where id is a full action string (it carries ids, so it is built by the
    // caller rather than from a static `action` like buttons are).
    const rows = (ctx.rows || []).map((r) => ({
      id: encodePayload({ flow: 'A', orderId: ctx.orderId, action: r.action }),
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
    }));
    return { type: 'list', body, buttonText: m.listButton, rows };
  }
  throw new Error(`session ${key} has unknown type ${m.type}`);
}
