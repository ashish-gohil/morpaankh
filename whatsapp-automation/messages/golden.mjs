/*
 * golden.mjs — render EVERY piece of customer copy with fixed sample data.
 *
 * This exists for one reason: the English output must not move when Hindi is
 * added. messages/golden.snapshot.json was generated from the registries as
 * they stood before the language work began (commit 27d8fab), and
 * golden.test.mjs asserts renderAll() still equals it byte for byte.
 *
 * DO NOT REGENERATE THE SNAPSHOT TO MAKE A TEST PASS. The snapshot failing is
 * the test working: it means an English payload changed, which is a decision
 * and not a refactor. Regenerate only when the change to English copy is the
 * deliberate point of the commit, and say so in the message.
 *
 * Deliberately exercises the OLD call shapes: ctx.actions keyed by button
 * title, no `lang` in ctx. Both must keep working for messages already on a
 * customer's phone.
 */
import { TEMPLATES, LEGACY, NO_PRICE, renderTemplateDef } from './templates.mjs';
import { SESSION, renderSession } from './session.mjs';

/** Fixed, boring sample values. Never a date computed from the clock. */
const SAMPLES = {
  customer_name: 'Aarav',
  order_number: '#1234',
  order_total: 'Rs 1,499',
  new_total: 'Rs 1,399',
  cod_total: 'Rs 1,499',
  prepaid_total: 'Rs 1,349',
  saving: 'Rs 150',
  valid_until: '21 Sep, 8:00 PM',
  amount_paid: 'Rs 1,399',
  cod_amount: 'Rs 1,499',
  refund_eta: '5 to 7 working days',
  delivered_date: '20 Sep',
  attempt_date: '20 Sep',
  code: 'MORPAANKHAARAV47',
  percent: '5',
  min_order: 'Rs 1,500',
  date: '20 Sep',
  summary: '12 COD, 9 confirmed, 2 converted, 1 held',
  alert_text: 'payment received but courier edit failed',
  item_line: 'Khili Dhoop, size M',
  expires_at: 'tomorrow at 9:20 PM',
  time_left: '2 hours',
  top_picks: 'Khili Dhoop, Bandhan and Morani',
  gift_line: 'a gift from us',
  text: 'a line of owner copy',
  status_text: 'is on the way',
  awb: '59152210001142',
  tracking_url: 'https://www.delhivery.com/track/package/59152210001142',
};

const sampleValue = (name) => SAMPLES[name] ?? `[${name}]`;

const CTX = {
  orderId: '1234567890',
  token: 'TESTTOKEN16CHARS',
  flowToken: 'ft.exp.sig',
  flowActionData: { first_name: 'Aarav' },
  url: 'https://dry.run/pay',
  imageUrl: 'https://cdn.shopify.com/sample.jpg?width=800&height=800&crop=center',
  mediaId: 'MEDIA123',
};

const names = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

/** The sample rows a list message is given, so renderSession has something to render. */
const ROWS = [
  { action: 'vcs:1:101', title: 'M' },
  { action: 'vcs:1:102', title: 'L', description: 'in stock' },
];

/**
 * Every rendered payload, as one plain object, keyed `templates.<key>` and
 * `session.<key>`. Everything in it is JSON-serialisable and order-stable.
 */
export function renderAll() {
  const out = {};
  for (const [registry, defs] of [['TEMPLATES', TEMPLATES], ['LEGACY', LEGACY], ['NO_PRICE', NO_PRICE]]) {
    for (const key of Object.keys(defs).sort()) {
      const t = defs[key];
      out[`${registry}.${key}`] = {
        name: t.name,
        language: t.language,
        category: t.category,
        body: t.body,
        footer: t.footer || null,
        buttons: (t.buttons || []).map((b) => ({ kind: b.kind, text: b.text })),
        rendered: renderTemplateDef(t, t.examples, CTX),
      };
    }
  }
  for (const key of Object.keys(SESSION).sort()) {
    const m = SESSION[key];
    const vars = {};
    for (const n of [...names(m.body), ...names(m.ctaText || '')]) vars[n] = sampleValue(n);
    // A button with no static action carries per-order ids. Keyed by TITLE,
    // which is how every call site keyed it before the language work.
    const actions = Object.fromEntries((m.buttons || []).filter((b) => !b.action).map((b) => [b.title, 'vcok:1:101']));
    out[`SESSION.${key}`] = renderSession(key, vars, { ...CTX, rows: m.type === 'list' ? ROWS : undefined, actions });
  }
  return out;
}
