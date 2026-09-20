#!/usr/bin/env node
/*
 * dryrun-render — render every template and session message with sample data
 * and print the result. A fast self-check that all copy renders without error
 * (spec section 11 admin tool). No network, no secrets.
 *
 *   node scripts/dryrun-render.mjs
 */
import { TEMPLATES, renderTemplate, placeholderOrder } from '../messages/templates.mjs';
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
    code: 'THANKS-AB4K7P',
    percent: '5',
    min_order: 'Rs 1,500',
    date: '20 Sep',
    summary: '12 COD, 9 confirmed, 2 converted, 1 held',
    alert_text: 'payment received but courier edit failed',
  };
  return map[name] || `[${name}]`;
}

const ctx = { orderId: '1234567890', token: 'TESTTOKEN16CHARS', flowToken: 'ft.exp.sig', flowActionData: { first_name: 'Aarav' }, url: 'https://dry.run/pay' };

console.log('=== TEMPLATES ===');
for (const [key, t] of Object.entries(TEMPLATES)) {
  const r = renderTemplate(key, t.examples, ctx);
  console.log(`\n[${key}] ${r.name} (${t.category})`);
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
  const r = renderSession(key, vars, ctx);
  console.log(`\n[${key}] (${m.type})`);
  console.log(r.body);
  if (r.buttonText) console.log(`  [cta] ${r.buttonText} -> ${r.url}`);
  for (const b of r.buttons || []) console.log(`  [reply] ${b.title} (${b.id})`);
}
console.log('\nOK: all copy rendered.');
