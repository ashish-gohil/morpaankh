#!/usr/bin/env node
/*
 * dryrun-render — render every template and session message with sample data
 * and print the result. A fast self-check that all copy renders without error
 * (spec section 11 admin tool). No network, no secrets.
 *
 *   node scripts/dryrun-render.mjs
 */
import { TEMPLATES, LEGACY, renderTemplateDef, placeholderOrder } from '../messages/templates.mjs';
import { SESSION, renderSession } from '../messages/session.mjs';

function sampleValue(name) {
  const map = {
    customer_name: 'Aarav',
    order_number: '#1234',
    order_total: 'Rs 1,499',
    new_total: 'Rs 1,399',
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
    // Flow R
    item_line: 'Khili Dhoop, size M',
    expires_at: 'tomorrow at 9:20 PM',
    time_left: '2 hours',
  };
  return map[name] || `[${name}]`;
}

const ctx = {
  orderId: '1234567890',
  token: 'TESTTOKEN16CHARS',
  flowToken: 'ft.exp.sig',
  flowActionData: { first_name: 'Aarav' },
  url: 'https://dry.run/pay',
  imageUrl: 'https://cdn.shopify.com/sample.jpg?width=800&height=800&crop=center',
};

console.log('=== TEMPLATES ===');
for (const [key, t] of [...Object.entries(TEMPLATES), ...Object.entries(LEGACY)]) {
  const r = renderTemplateDef(t, t.examples, ctx);
  console.log(`\n[${key}] ${r.name} (${t.category})${t.header ? ' [image header]' : ''}`);
  console.log(t.body.replace(/\{\{(\w+)\}\}/g, (_, n) => t.examples[n]));
  if (t.footer) console.log(`(footer) ${t.footer}`);
  for (const b of t.buttons || []) console.log(`  [${b.kind}] ${b.text}`);
}

console.log('\n\n=== SESSION ===');
for (const [key, m] of Object.entries(SESSION)) {
  const names = new Set();
  for (const s of [m.body, m.ctaText || '']) {
    let x;
    const re = /\{\{(\w+)\}\}/g;
    while ((x = re.exec(s))) names.add(x[1]);
  }
  const vars = {};
  for (const n of names) vars[n] = sampleValue(n);
  // A list's rows are per-order, and a button whose action is null carries
  // per-order ids, so both have to be supplied here or renderSession throws.
  // Sample values only; this script renders copy, it never sends.
  const rows =
    m.type === 'list'
      ? [
          { action: 'vcs:1:101', title: 'M' },
          { action: 'vcs:1:102', title: 'L', description: 'in stock' },
        ]
      : undefined;
  const actions = Object.fromEntries(
    (m.buttons || []).filter((b) => !b.action).map((b) => [b.title, 'vcok:1:101']),
  );
  const r = renderSession(key, vars, { ...ctx, rows, actions });
  console.log(`\n[${key}] (${m.type})`);
  console.log(r.body);
  if (r.type === 'list') console.log(`  [open] ${r.buttonText}`);
  else if (r.buttonText) console.log(`  [cta] ${r.buttonText} -> ${r.url}`);
  for (const row of r.rows || []) console.log(`  [row] ${row.title} (${row.id})${row.description ? ` - ${row.description}` : ''}`);
  for (const b of r.buttons || []) console.log(`  [reply] ${b.title} (${b.id})`);
}
console.log('\nOK: all copy rendered.');
