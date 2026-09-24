/*
 * templates.mjs — the Meta message-template registry. THE place template copy
 * lives. Code sends by key; the renderer supplies params by name. Bodies use
 * named {{placeholders}} for readability; templates-sync converts them to
 * positional {{1}}..{{n}} at creation and the renderer supplies params in the
 * same declared order, so runtime is positional (universally supported).
 *
 * TEMPLATES holds the copy we WANT to send. LEGACY holds the previous approved
 * version of each one. A template cannot be edited in place, so new copy means
 * a new name, and a new name is unsendable until Meta approves it (hours). The
 * sender therefore tries TEMPLATES first and falls back to LEGACY on the Meta
 * error codes that mean "this template is not usable" (see send.mjs). Nothing
 * breaks while a review is pending, and the new copy starts going out by itself
 * the moment it is approved, with no redeploy.
 *
 * To change copy: bump the version suffix in `name`, move the old definition
 * into LEGACY, run templates-sync. NEVER edit an approved template in place.
 * No emoji, no em/en dash (enforced by registry.test.mjs).
 */
import { encodePayload } from '../src/lib/ids.mjs';

/** quick-reply / url / flow button descriptors used inside the registry. */
const qr = (text, flow, action) => ({ kind: 'quick_reply', text, flow, action });
const urlBtn = (text) => ({ kind: 'url', text, urlPattern: '{{public}}/p/{{token}}' });
/** A URL button whose variable suffix is appended to a fixed external base. */
const trackBtn = (text) => ({ kind: 'url', text, base: 'https://www.delhivery.com/track/package/', example: '59152210001142' });
const flowBtn = (text) => ({ kind: 'flow', text, flowKey: 'review' });

/**
 * An IMAGE header. `sample` is only used at CREATE time: Meta wants a real
 * uploaded file as the example, and templates-sync fetches this URL and puts it
 * through the resumable upload API to get the header handle. At SEND time the
 * per-order product image is supplied through ctx.imageUrl.
 */
const imageHeader = (sample) => ({ format: 'IMAGE', sample });

const SAMPLE_PRODUCT_IMAGE =
  'https://cdn.shopify.com/s/files/1/0998/6261/0292/files/WhatsAppImage2026-06-07at2.04.11PM.jpg?v=1780823415&width=800&height=800&crop=center';

export const TEMPLATES = {
  // The first message a customer gets. Deliberately NOT written as an offer:
  // it states the two amounts this order can be paid at and lets them choose.
  // Offer wording ("save", "discount", "limited time") in a UTILITY template
  // invites Meta to reclassify it as MARKETING, which would bring opt-in
  // requirements, per-user frequency caps and a higher per-message price to
  // every order confirmation we send.
  // DELIBERATELY unchanged, and deliberately WITHOUT the gift wording that the
  // prepaid offer carries. This is UTILITY and it is the message every single
  // order gets. "A gift from us" is promotional, and promotional wording here
  // invites Meta to reclassify the template as MARKETING, which would put
  // opt-in, per-user frequency caps and a higher price on EVERY order
  // confirmation. The tiered saving still reaches the customer here, because
  // the two amounts are variables: only the gift is held back to the offer
  // message and the session replies, which are free to be promotional.
  cod_confirm: {
    name: 'cod_confirm_v2',
    language: 'en',
    category: 'UTILITY',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, your order {{order_number}} is with us and ready to be packed.\n\n' +
      '{{item_line}}\n\n' +
      'Cash on delivery: {{cod_total}}\n' +
      'Pay online instead: {{prepaid_total}}\n\n' +
      'Prepaid orders are packed and dispatched on priority. Tap one below and we will take it from there.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      cod_total: 'Rs 1,499',
      prepaid_total: 'Rs 1,349',
    },
    buttons: [
      qr('Pay online now', 'A', 'pay_online'),
      qr('Confirm cash on delivery', 'A', 'confirm'),
      qr('Cancel order', 'A', 'cancel'),
    ],
  },

  // Same reasoning as cod_confirm: UTILITY, so no offer wording.
  cod_reminder: {
    name: 'cod_reminder_v2',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, we are still holding your order {{order_number}}.\n\n' +
      '{{item_line}}\n\n' +
      'Cash on delivery: {{cod_total}}\n' +
      'Pay online instead: {{prepaid_total}}\n\n' +
      'One tap is all we need to send it for packing. Prepaid orders go out on priority.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      cod_total: 'Rs 1,499',
      prepaid_total: 'Rs 1,349',
    },
    buttons: [
      qr('Pay online now', 'A', 'pay_online'),
      qr('Confirm cash on delivery', 'A', 'confirm'),
      qr('Cancel order', 'A', 'cancel'),
    ],
  },

  // This one IS an offer, so MARKETING is the honest category. It is capped by
  // RULES.marketingCapDays and carries the opt-out footer Meta expects.
  prepaid_offer: {
    name: 'prepaid_offer_v3',
    language: 'en',
    category: 'MARKETING',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, your order {{order_number}} is still set to cash on delivery.\n\n' +
      '{{item_line}}\n\n' +
      '*Pay online and you pay {{prepaid_total}}* instead of {{cod_total}}\n' +
      '*{{saving}} stays with you*\n' +
      '{{gift_line}}\n' +
      '*Packed first and dispatched on priority*, so it reaches you sooner\n\n' +
      'The link below is open until {{valid_until}}. If you would rather not, tap Keep cash on delivery and nothing changes.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      prepaid_total: 'Rs 1,349',
      cod_total: 'Rs 1,499',
      saving: 'Rs 150',
      gift_line: 'A gift from us, wrapped in with your order',
      valid_until: '21 Sep, 8:00 PM',
    },
    buttons: [urlBtn('Pay online'), qr('Keep cash on delivery', 'A', 'keep_cod')],
    footer: 'Reply STOP to stop these messages',
  },

  prepaid_confirmed: {
    name: 'prepaid_confirmed_v2',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, your payment of {{amount_paid}} for order {{order_number}} has come through.\n\n' +
      'The order is fully prepaid now, so there is nothing to hand over at the door. Prepaid orders are packed ' +
      'and dispatched on priority, so yours is already moving up the queue.',
    examples: { customer_name: 'Aarav', amount_paid: 'Rs 1,399', order_number: '#1234' },
    buttons: [],
  },

  prepaid_refund: {
    name: 'prepaid_refund_v2',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, order {{order_number}} had already left for delivery when your payment reached us, ' +
      'so we could not switch it to prepaid.\n\n' +
      'Your {{amount_paid}} is on its way back to the same account and usually lands within {{refund_eta}}. ' +
      'Please keep {{cod_amount}} ready at delivery as planned.\n\n' +
      'Sorry for the extra step.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      amount_paid: 'Rs 1,399',
      refund_eta: '5 to 7 working days',
      cod_amount: 'Rs 1,499',
    },
    buttons: [],
  },

  // PREPAID and PARTIAL orders never reached Flow A before, so a customer who
  // paid online at checkout got no WhatsApp at all. This is their confirmation.
  // It deliberately says nothing about paying: one of these customers has
  // already paid in full and the other still owes a balance at delivery, so any
  // payment wording would be wrong for one of them. No buttons either, because
  // cancelling a paid order needs a refund and Flow A's cancel path issues none.
  order_confirmed: {
    name: 'order_confirmed_v1',
    language: 'en',
    category: 'UTILITY',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, thank you for your order {{order_number}}.\n\n' +
      '{{item_line}}\n' +
      'Order total: {{order_total}}\n\n' +
      'It is with our packing team now. We will send you the tracking link the moment it leaves us.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      order_total: 'Rs 1,499',
    },
    buttons: [],
  },

  // Sent on fulfillments/create for EVERY order class. Until this existed the
  // system promised tracking details in keep_cod_ack and then never sent any.
  // payment_line carries the one sentence that differs between a prepaid and a
  // cash order, which keeps this to a single template.
  order_shipped: {
    name: 'order_shipped_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, order {{order_number}} has left us and is on its way to you.\n\n' +
      'Item: {{item_line}}\n' +
      'At delivery: {{payment_line}}\n' +
      'Courier: {{courier}}\n' +
      'Tracking number: {{awb}}\n\n' +
      'Tap below to follow it on its way.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      payment_line: 'please keep Rs 1,499 ready',
      courier: 'Delhivery',
      awb: '59152210001142',
    },
    buttons: [trackBtn('Track your order')],
  },

  // Flow B. Never created at Meta (the review Flow is still DRAFT), so these
  // stay on v1: there is no approved version to fall back to and no point
  // burning a version number on copy nobody has reviewed yet.
  delivered_review: {
    name: 'delivered_review_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, your order {{order_number}} reached you on {{delivered_date}}.\n\n' +
      'We would love to know how it fits and how it feels on. It takes a minute, and it shapes what we make next.',
    examples: { customer_name: 'Aarav', order_number: '#1234', delivered_date: '20 Sep' },
    buttons: [flowBtn('Rate your order')],
  },

  review_reminder: {
    name: 'review_reminder_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, we are still curious how order {{order_number}} turned out for you.\n\n' +
      'If you have a minute, tell us. Honest words help us more than you would think.',
    examples: { customer_name: 'Aarav', order_number: '#1234' },
    buttons: [flowBtn('Rate your order')],
  },

  ndr_action: {
    name: 'ndr_action_v2',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, our courier partner tried to reach you with order {{order_number}} on ' +
      '{{attempt_date}} and could not complete the delivery.\n\n' +
      'Nothing is lost. Tell us what suits you and we will arrange it.',
    examples: { customer_name: 'Aarav', order_number: '#1234', attempt_date: '20 Sep' },
    buttons: [
      qr('Deliver tomorrow', 'C', 'ndr_reattempt'),
      qr('Change address', 'C', 'ndr_address'),
      qr('Cancel order', 'C', 'ndr_cancel'),
    ],
  },

  rto_reason: {
    name: 'rto_reason_v2',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, order {{order_number}} could not be delivered and is on its way back to us.\n\n' +
      'If you can spare a moment, tell us what went wrong. We read every one of these.',
    examples: { customer_name: 'Aarav', order_number: '#1234' },
    buttons: [
      qr('I was not available', 'C', 'rto_not_available'),
      qr('Changed my mind', 'C', 'rto_changed_mind'),
      qr('Size or fit concern', 'C', 'rto_size_fit'),
      qr('Delivery took too long', 'C', 'rto_delivery_late'),
      qr('I did not order this', 'C', 'rto_did_not_order'),
      qr('Other reason', 'C', 'rto_other'),
    ],
  },

  ops_alert: {
    name: 'ops_alert_v2',
    language: 'en',
    category: 'UTILITY',
    body: 'Order {{order_number}} needs a look: {{alert_text}}.\n\nOpen it in Shopify when you get a moment.',
    examples: { order_number: '#1234', alert_text: 'payment received but courier edit failed' },
    buttons: [],
  },

  // Owner-only, for system faults rather than order problems. ops_alert exists
  // and is approved, but its copy is order-centric ("Please check the order in
  // Shopify"), which reads as a false alarm when the fault is an expired token
  // or a provider outage and nothing about the order is wrong. That ambiguity
  // is what made the first real alert unreadable, so infrastructure gets its
  // own wording. Until this is approved the sender falls back to ops_alert.
  ops_error: {
    name: 'ops_error_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Automation alert, {{when}} IST.\n\n' +
      'What happened: {{detail}}\n\n' +
      'Impact: {{impact}}\n\n' +
      'The full report with the stack and a log link is in the alert email.',
    examples: {
      when: '23 Sep, 9:46 pm',
      detail: 'wa-worker could not cancel the payment link on order #1150',
      impact: 'None for the customer. The order is correct and nothing was resent.',
    },
    buttons: [],
  },

  // Owner-only. Declared MARKETING because that is what Meta actually assigned
  // it: a periodic summary is tied to no single transaction, so it does not
  // meet Meta's UTILITY definition however it is worded. Declaring UTILITY here
  // only made templates-sync fail on a mismatch it could never resolve.
  ops_digest: {
    name: 'ops_digest_v2',
    language: 'en',
    category: 'MARKETING',
    body:
      'Here is the WhatsApp automation summary for {{date}}.\n\n{{summary}}\n\nPlease check any orders left on hold.',
    examples: { date: '20 Sep', summary: '12 COD, 9 confirmed, 2 converted' },
    buttons: [],
  },
};

/**
 * The previously approved definition of each template, kept ONLY as the
 * send-time fallback while a new version is in review. Do not add new copy
 * here. Entries are dropped once their replacement is approved and stable.
 */
export const LEGACY = {
  // Not older copy: the image-free twin of order_confirmed, used when a product
  // has no photo or Meta cannot fetch it. Without this a missing image would
  // mean a prepaid customer gets no confirmation at all.
  order_confirmed: {
    name: 'order_confirmed_plain_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, thank you for your order {{order_number}}.\n\n' +
      '{{item_line}}\n' +
      'Order total: {{order_total}}\n\n' +
      'It is with our packing team now. We will send you the tracking link the moment it leaves us.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      order_total: 'Rs 1,499',
    },
    buttons: [],
  },

  cod_confirm: {
    name: 'cod_confirm_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Thank you for your order {{order_number}}.\n\n' +
      'Order total: {{order_total}}\n' +
      'Payment: Cash on Delivery\n\n' +
      'Please confirm your order so that we can pack and dispatch it.',
    examples: { customer_name: 'Aarav', order_number: '#1234', order_total: 'Rs 1,499' },
    buttons: [qr('Confirm order', 'A', 'confirm'), qr('Pay online', 'A', 'pay_online'), qr('Cancel order', 'A', 'cancel')],
  },

  cod_reminder: {
    name: 'cod_reminder_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Thank you for shopping with us. Your order {{order_number}} of {{order_total}} is waiting for your confirmation.\n\n' +
      'Please confirm so that we can dispatch it on time.',
    examples: { customer_name: 'Aarav', order_number: '#1234', order_total: 'Rs 1,499' },
    buttons: [qr('Confirm order', 'A', 'confirm'), qr('Pay online', 'A', 'pay_online'), qr('Cancel order', 'A', 'cancel')],
  },

  // v2, NOT v1: v2 is the version Meta has approved and that goes out today.
  // prepaid_offer_v3 above adds the tiered saving and the gift, and until Meta
  // approves it every send lands here, keeping the product photo rather than
  // dropping all the way back to the plain v1.
  prepaid_offer: {
    name: 'prepaid_offer_v2',
    language: 'en',
    category: 'MARKETING',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, your order {{order_number}} is still set to cash on delivery.\n\n' +
      '{{item_line}}\n\n' +
      'Pay online and it comes to {{prepaid_total}} instead of {{cod_total}}, so you keep {{saving}} extra. ' +
      'Prepaid orders are packed and dispatched on priority, so yours reaches you sooner.\n\n' +
      'The link below stays open until {{valid_until}}. If you would rather not, tap Keep cash on delivery and nothing changes.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      item_line: 'Khili Dhoop, size M',
      prepaid_total: 'Rs 1,399',
      cod_total: 'Rs 1,499',
      saving: 'Rs 100',
      valid_until: '21 Sep, 8:00 PM',
    },
    buttons: [urlBtn('Pay online'), qr('Keep cash on delivery', 'A', 'keep_cod')],
    footer: 'Reply STOP to stop these messages',
  },

  prepaid_confirmed: {
    name: 'prepaid_confirmed_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Thank you. We have received your payment of {{amount_paid}} for order {{order_number}}.\n\n' +
      'Your order is now fully prepaid, so there is nothing to pay at delivery.',
    examples: { customer_name: 'Aarav', amount_paid: 'Rs 1,399', order_number: '#1234' },
    buttons: [],
  },

  prepaid_refund: {
    name: 'prepaid_refund_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Sorry, your order {{order_number}} had already left for delivery, so we could not change it to prepaid.\n\n' +
      'We have started a refund of {{amount_paid}} to your original payment method. It usually takes {{refund_eta}}. Please pay {{cod_amount}} at delivery as before.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      amount_paid: 'Rs 1,399',
      refund_eta: '5 to 7 working days',
      cod_amount: 'Rs 1,499',
    },
    buttons: [],
  },

  ndr_action: {
    name: 'ndr_action_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Our courier partner tried to deliver your order {{order_number}} on {{attempt_date}} but could not complete the delivery.\n\n' +
      'Please tell us what you would like us to do.',
    examples: { customer_name: 'Aarav', order_number: '#1234', attempt_date: '20 Sep' },
    buttons: [
      qr('Deliver tomorrow', 'C', 'ndr_reattempt'),
      qr('Change address', 'C', 'ndr_address'),
      qr('Cancel order', 'C', 'ndr_cancel'),
    ],
  },

  rto_reason: {
    name: 'rto_reason_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Your order {{order_number}} could not be delivered and is on its way back to us.\n\n' +
      'Could you please tell us what happened? Your answer helps us do better next time.',
    examples: { customer_name: 'Aarav', order_number: '#1234' },
    buttons: [
      qr('I was not available', 'C', 'rto_not_available'),
      qr('Changed my mind', 'C', 'rto_changed_mind'),
      qr('Size or fit concern', 'C', 'rto_size_fit'),
      qr('Delivery took too long', 'C', 'rto_delivery_late'),
      qr('I did not order this', 'C', 'rto_did_not_order'),
      qr('Other reason', 'C', 'rto_other'),
    ],
  },

  // Not older copy: the approved template ops_error falls back to while it is
  // in review. It takes different placeholders, which is why the caller passes
  // the union of both and renderTemplateDef ignores what its version does not use.
  ops_error: {
    name: 'ops_alert_v1',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello,\nAction needed on order {{order_number}}: {{alert_text}}.\n\nPlease check the order in Shopify.',
    examples: { order_number: '#1234', alert_text: 'payment received but courier edit failed' },
    buttons: [],
  },

  ops_alert: {
    name: 'ops_alert_v1',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello,\nAction needed on order {{order_number}}: {{alert_text}}.\n\nPlease check the order in Shopify.',
    examples: { order_number: '#1234', alert_text: 'payment received but courier edit failed' },
    buttons: [],
  },

  ops_digest: {
    name: 'ops_digest_v1',
    language: 'en',
    category: 'MARKETING',
    body:
      'Hello,\nHere is the WhatsApp automation summary for {{date}}: {{summary}}.\n\nPlease review any held orders.',
    examples: { date: '20 Sep', summary: '12 COD, 9 confirmed, 2 converted' },
    buttons: [],
  },
};

// ---- helpers ----------------------------------------------------------------
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Unique placeholder names in order of first appearance. */
export function placeholderOrder(body) {
  const seen = [];
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(body))) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** Convert named body to positional {{1}}..{{n}} for template creation. */
export function toPositionalBody(body) {
  const order = placeholderOrder(body);
  return body.replace(PLACEHOLDER, (_, name) => `{{${order.indexOf(name) + 1}}}`);
}

/** Runtime param values: no newline/tab, no run of >4 spaces. */
export function sanitizeParam(v) {
  return String(v).replace(/[\n\t]/g, ' ').replace(/ {5,}/g, '    ').trim();
}

/**
 * Build the Meta `components` array for a send from a template DEFINITION.
 *
 * Strict about MISSING vars (a blank where a price should be is worse than a
 * crash) and lenient about extra ones, because the caller builds one set of
 * vars that has to satisfy both the current template and its LEGACY fallback,
 * and the two versions rarely take the same placeholders.
 *
 * @param {any} def one entry from TEMPLATES or LEGACY
 * @param {Record<string,string>} vars body placeholder values by name
 * @param {{orderId?:string, token?:string, flowToken?:string, flowActionData?:object, imageUrl?:string}} [ctx]
 */
export function renderTemplateDef(def, vars = {}, ctx = {}) {
  const order = placeholderOrder(def.body);
  const missing = order.filter((n) => vars[n] === undefined);
  if (missing.length) throw new Error(`template ${def.name} missing vars: [${missing}]`);

  const components = [];
  if (def.header?.format === 'IMAGE') {
    if (!ctx.imageUrl) throw new Error(`template ${def.name} needs ctx.imageUrl for its image header`);
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: ctx.imageUrl } }] });
  }
  if (order.length) {
    components.push({ type: 'body', parameters: order.map((n) => ({ type: 'text', text: sanitizeParam(vars[n]) })) });
  }
  (def.buttons || []).forEach((b, i) => {
    const index = String(i);
    if (b.kind === 'quick_reply') {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index,
        parameters: [{ type: 'payload', payload: encodePayload({ flow: b.flow, orderId: ctx.orderId, action: b.action }) }],
      });
    } else if (b.kind === 'url') {
      components.push({ type: 'button', sub_type: 'url', index, parameters: [{ type: 'text', text: ctx.token }] });
    } else if (b.kind === 'flow') {
      components.push({
        type: 'button',
        sub_type: 'flow',
        index,
        parameters: [{ type: 'action', action: { flow_token: ctx.flowToken, flow_action_data: ctx.flowActionData } }],
      });
    }
  });

  return { name: def.name, language: def.language, components };
}

/** renderTemplateDef by registry key, using the current version. */
export function renderTemplate(key, vars = {}, ctx = {}) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`unknown template: ${key}`);
  return renderTemplateDef(t, vars, ctx);
}
