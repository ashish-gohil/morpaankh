/*
 * templates.mjs — the Meta message-template registry. THE place template copy
 * lives. Code sends by key; the renderer supplies params by name. Bodies use
 * named {{placeholders}} for readability; templates-sync converts them to
 * positional {{1}}..{{n}} at creation and the renderer supplies params in the
 * same declared order, so runtime is positional (universally supported).
 *
 * To change copy: bump the version suffix in `name`, run templates-sync, and
 * the sender keeps using the old version until the new one is APPROVED.
 * NEVER edit an approved template in place. No emoji, no em/en dash (enforced
 * by templates.test.mjs).
 */
import { encodePayload } from '../src/lib/ids.mjs';

/** quick-reply / url / flow button descriptors used inside the registry. */
const qr = (text, flow, action) => ({ kind: 'quick_reply', text, flow, action });
const urlBtn = (text) => ({ kind: 'url', text, urlPattern: '{{public}}/p/{{token}}' });
const flowBtn = (text) => ({ kind: 'flow', text, flowKey: 'review' });

export const TEMPLATES = {
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

  prepaid_offer: {
    name: 'prepaid_offer_v1',
    language: 'en',
    category: 'MARKETING',
    body:
      'Hello {{customer_name}},\n' +
      'Thank you for your order {{order_number}}.\n\n' +
      'If you pay online now, you pay {{new_total}} instead of {{order_total}} and save {{saving}}. This is valid until {{valid_until}}.\n\n' +
      'If you prefer Cash on Delivery, please tap Keep Cash on Delivery.',
    examples: {
      customer_name: 'Aarav',
      order_number: '#1234',
      new_total: 'Rs 1,399',
      order_total: 'Rs 1,499',
      saving: 'Rs 100',
      valid_until: '21 Sep, 8:00 PM',
    },
    buttons: [urlBtn('Pay online'), qr('Keep Cash on Delivery', 'A', 'keep_cod')],
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

  delivered_review: {
    name: 'delivered_review_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Thank you for shopping with us. Your order {{order_number}} was delivered on {{delivered_date}}.\n\n' +
      'We would love to know how you found it. It takes less than a minute.',
    examples: { customer_name: 'Aarav', order_number: '#1234', delivered_date: '20 Sep' },
    buttons: [flowBtn('Rate your order')],
  },

  review_reminder: {
    name: 'review_reminder_v1',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'Thank you again for your order {{order_number}}. If you have a minute, please tell us how it went.',
    examples: { customer_name: 'Aarav', order_number: '#1234' },
    buttons: [flowBtn('Rate your order')],
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
    category: 'UTILITY',
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
 * Build the Meta `components` array for a send.
 * @param {string} key
 * @param {Record<string,string>} vars  body placeholder values by name
 * @param {{orderId?:string, token?:string, flowToken?:string, flowActionData?:object}} [ctx]
 */
export function renderTemplate(key, vars = {}, ctx = {}) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`unknown template: ${key}`);
  const order = placeholderOrder(t.body);
  const missing = order.filter((n) => vars[n] === undefined);
  const extra = Object.keys(vars).filter((n) => !order.includes(n));
  if (missing.length || extra.length) {
    throw new Error(`template ${key} vars mismatch. missing=[${missing}] extra=[${extra}]`);
  }

  const components = [];
  if (order.length) {
    components.push({ type: 'body', parameters: order.map((n) => ({ type: 'text', text: sanitizeParam(vars[n]) })) });
  }
  (t.buttons || []).forEach((b, i) => {
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

  return { name: t.name, language: t.language, components };
}
