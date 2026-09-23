#!/usr/bin/env node
/*
 * templates-sync — list the WABA's templates, create any missing ones from the
 * registry, print each one's status + Meta's assigned category, and fail loudly
 * if Meta assigned a different category than declared.
 *
 *   node scripts/templates-sync.mjs          # report only (dry-run)
 *   node scripts/templates-sync.mjs --live   # create missing templates
 *
 * Both TEMPLATES and LEGACY are synced: LEGACY holds the version the sender
 * falls back to while new copy is in review, so it has to exist at Meta too.
 *
 * FLOW-button templates (delivered_review, review_reminder) need the review
 * flow id: set WA_REVIEW_FLOW_ID (from flows-sync) or they are skipped.
 */
import { config } from '../src/config.mjs';
import { getSecrets } from '../src/secrets.mjs';
import { TEMPLATES, LEGACY, toPositionalBody, placeholderOrder } from '../messages/templates.mjs';

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

/**
 * The app id that owns the access token, needed by the resumable upload API.
 * Read from the token itself rather than stored as another secret.
 */
let appIdCache = null;
async function appId() {
  if (appIdCache) return appIdCache;
  const r = await fetch(`${G}/debug_token?input_token=${encodeURIComponent(s.waAccessToken)}`, { headers: auth });
  const j = await r.json();
  appIdCache = j.data?.app_id;
  if (!appIdCache) throw new Error(`could not read app id from token: ${JSON.stringify(j).slice(0, 200)}`);
  return appIdCache;
}

/**
 * Meta will not accept a URL as the example for a media header: it wants a
 * handle from the resumable upload API. Fetch the sample image and push it
 * through the two-step upload to get one.
 */
async function headerHandle(sampleUrl) {
  const res = await fetch(sampleUrl);
  if (!res.ok) throw new Error(`sample image fetch failed (${res.status}): ${sampleUrl}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const id = await appId();

  const start = await (
    await fetch(`${G}/${id}/uploads?file_name=sample.jpg&file_length=${bytes.length}&file_type=image/jpeg`, {
      method: 'POST',
      headers: auth,
    })
  ).json();
  if (!start.id) throw new Error(`upload session failed: ${JSON.stringify(start).slice(0, 200)}`);

  const fin = await (
    await fetch(`${G}/${start.id}`, {
      method: 'POST',
      // This step wants OAuth, not Bearer, and the offset as a header.
      headers: { Authorization: `OAuth ${s.waAccessToken}`, file_offset: '0', 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
  ).json();
  if (!fin.h) throw new Error(`upload finish failed: ${JSON.stringify(fin).slice(0, 200)}`);
  return fin.h;
}

async function buildComponents(t) {
  const order = placeholderOrder(t.body);
  const components = [];

  // Meta expects HEADER, BODY, FOOTER, BUTTONS in that order.
  if (t.header?.format === 'IMAGE') {
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [await headerHandle(t.header.sample)] } });
  }
  components.push({
    type: 'BODY',
    text: toPositionalBody(t.body),
    ...(order.length ? { example: { body_text: [order.map((n) => t.examples[n])] } } : {}),
  });
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });

  const buttons = [];
  for (const b of t.buttons || []) {
    if (b.kind === 'quick_reply') buttons.push({ type: 'QUICK_REPLY', text: b.text });
    else if (b.kind === 'url' && b.base)
      buttons.push({ type: 'URL', text: b.text, url: `${b.base}{{1}}`, example: [`${b.base}${b.example}`] });
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

// LEGACY first so a fallback always exists before its replacement goes live.
const all = [...Object.entries(LEGACY), ...Object.entries(TEMPLATES)];
for (const [key, t] of all) {
  const found = existing[t.name];
  if (found) {
    const mismatch = found.category && found.category !== t.category;
    console.log(`  ${t.name}: ${found.status}${found.category ? ` [${found.category}]` : ''}${mismatch ? ` !! declared ${t.category}` : ''}`);
    if (mismatch) failed = true;
    continue;
  }
  let components;
  try {
    components = await buildComponents(t);
  } catch (e) {
    console.log(`  ${t.name}: ERROR building components: ${e.message}`);
    failed = true;
    continue;
  }
  if (!components) {
    console.log(`  ${t.name}: SKIP (needs WA_REVIEW_FLOW_ID; run flows-sync first)`);
    continue;
  }
  if (!live) {
    console.log(`  ${t.name}: would-create [${t.category}]${t.header ? ' +image header' : ''}`);
    continue;
  }
  const r = await fetch(`${G}/${s.waWabaId}/message_templates`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: t.name, language: t.language, category: t.category, components }),
  });
  const rawText = await r.text();
  let j = {};
  try {
    j = rawText ? JSON.parse(rawText) : {};
  } catch {
    j = { raw: rawText };
  }
  if (!r.ok) {
    console.log(`  ${t.name}: ERROR ${JSON.stringify(j).slice(0, 300)}`);
    failed = true;
    continue;
  }
  const assigned = j.category || t.category;
  console.log(`  ${t.name}: created ${j.status || ''} [${assigned}]${assigned !== t.category ? ` !! declared ${t.category}` : ''}`);
  if (assigned !== t.category) failed = true;
}
if (failed) {
  console.error('\ntemplates-sync: category mismatch or error above.');
  process.exit(2);
}
