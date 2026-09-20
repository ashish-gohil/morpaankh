#!/usr/bin/env node
/*
 * templates-sync — list the WABA's templates, create any missing ones from the
 * registry, print each one's status + Meta's assigned category, and fail loudly
 * if Meta assigned a different category than declared.
 *
 *   node scripts/templates-sync.mjs          # report only (dry-run)
 *   node scripts/templates-sync.mjs --live   # create missing templates
 *
 * FLOW-button templates (delivered_review, review_reminder) need the review
 * flow id: set WA_REVIEW_FLOW_ID (from flows-sync) or they are skipped.
 * TODO(Phase 4/6): confirm named-vs-positional params + FLOW button create shape.
 */
import { config } from '../src/config.mjs';
import { getSecrets } from '../src/secrets.mjs';
import { TEMPLATES, toPositionalBody, placeholderOrder } from '../messages/templates.mjs';

const live = process.argv.includes('--live');
const s = await getSecrets();
if (!s.waAccessToken || !s.waWabaId) {
  console.error('WA_ACCESS_TOKEN and WA_WABA_ID required (Secrets Manager / .env).');
  process.exit(1);
}
const G = `https://graph.facebook.com/${config.graphVersion}`;
const auth = { Authorization: `Bearer ${s.waAccessToken}` };

async function listExisting() {
  const out = {};
  let url = `${G}/${s.waWabaId}/message_templates?fields=name,status,category&limit=200`;
  while (url) {
    const r = await fetch(url, { headers: auth });
    const j = await r.json();
    if (!r.ok) throw new Error(`list failed: ${JSON.stringify(j).slice(0, 200)}`);
    for (const t of j.data || []) out[t.name] = t;
    url = j.paging?.next || '';
  }
  return out;
}

function buildComponents(key, t) {
  const order = placeholderOrder(t.body);
  const components = [
    {
      type: 'BODY',
      text: toPositionalBody(t.body),
      ...(order.length ? { example: { body_text: [order.map((n) => t.examples[n])] } } : {}),
    },
  ];
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
  const buttons = [];
  for (const b of t.buttons || []) {
    if (b.kind === 'quick_reply') buttons.push({ type: 'QUICK_REPLY', text: b.text });
    else if (b.kind === 'url')
      buttons.push({ type: 'URL', text: b.text, url: `${config.publicBaseUrl}/p/{{1}}`, example: [`${config.publicBaseUrl}/p/TESTTOKEN`] });
    else if (b.kind === 'flow') {
      const flowId = process.env.WA_REVIEW_FLOW_ID;
      if (!flowId) return null; // needs the flow id; skip until flows-sync has run
      buttons.push({ type: 'FLOW', text: b.text, flow_id: flowId, navigate_screen: 'RATE', flow_action: 'navigate' });
    }
  }
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });
  return components;
}

const existing = await listExisting();
console.log(`templates-sync (${live ? 'LIVE' : 'dry-run'}) against WABA`);
let failed = false;
for (const [key, t] of Object.entries(TEMPLATES)) {
  const found = existing[t.name];
  if (found) {
    const mismatch = found.category && found.category !== t.category;
    console.log(`  ${t.name}: ${found.status}${found.category ? ` [${found.category}]` : ''}${mismatch ? ` !! declared ${t.category}` : ''}`);
    if (mismatch) failed = true;
    continue;
  }
  const components = buildComponents(key, t);
  if (!components) {
    console.log(`  ${t.name}: SKIP (needs WA_REVIEW_FLOW_ID; run flows-sync first)`);
    continue;
  }
  if (!live) {
    console.log(`  ${t.name}: would-create [${t.category}]`);
    continue;
  }
  const r = await fetch(`${G}/${s.waWabaId}/message_templates`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: t.name, language: t.language, category: t.category, components }),
  });
  const j = await r.json();
  if (!r.ok) {
    console.log(`  ${t.name}: ERROR ${JSON.stringify(j).slice(0, 200)}`);
    failed = true;
    continue;
  }
  const assigned = j.category || t.category;
  console.log(`  ${t.name}: created [${assigned}]${assigned !== t.category ? ` !! declared ${t.category}` : ''}`);
  if (assigned !== t.category) failed = true;
}
if (failed) {
  console.error('\ntemplates-sync: category mismatch or error above.');
  process.exit(2);
}
