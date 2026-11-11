#!/usr/bin/env node
/*
 * templates-sync — list the WABA's templates, create any missing ones from the
 * registry, print each one's status + Meta's assigned category, and fail loudly
 * if anything the sender can reach is not APPROVED and usable.
 *
 *   node scripts/templates-sync.mjs                 # report + GATE (exit 2 if not ready)
 *   node scripts/templates-sync.mjs --live          # create missing templates
 *   node scripts/templates-sync.mjs --only=a,b      # just these registry keys or Meta names
 *   node scripts/templates-sync.mjs --strict        # a Hindi gap fails too
 *
 * A HINDI TEMPLATE THAT IS NOT READY IS NOT AN OUTAGE. The gate exists
 * because an English template the sender can reach and Meta has not approved
 * is a message that silently does not go out. A Hindi one is not: send.mjs
 * falls back to the English template on exactly those Meta codes, so a pending
 * Hindi template costs the language and never the message. Hindi problems are
 * WARN lines and leave the exit code alone; --strict promotes them, which is
 * what gate G3 wants when it checks the whole Hindi set really was approved.
 *
 * THE DRY RUN IS A GATE, and it did not used to be. It printed "would-create"
 * for a template that did not exist at Meta and still exited 0, so it could
 * not be used to check anything: replacement_raised_v1 was written, tested,
 * shipped and deployed without ever being submitted, and nothing in the repo
 * said so. The local suite cannot catch that either, because it has no
 * credentials and Meta is the only thing that knows a template's real status.
 * So this is the one place that can, and it now refuses rather than reports.
 *
 * PENDING is a failure here on purpose. It is the honest answer to "can the
 * sender use this today", and the answer is no until Meta approves it.
 *
 * TEMPLATES, LEGACY and NO_PRICE are ALL synced, because the sender can reach
 * any of the three: LEGACY is the version it falls back to while new copy is in
 * review, and NO_PRICE is the one it uses when there is no prepaid price to
 * quote or no product photo. A registry the sender can reach but the sync
 * ignores would be missing at Meta on a fresh WABA and every such send would
 * fail with 132001.
 *
 * FLOW-button templates (delivered_review, review_reminder) need the review
 * flow id: set WA_REVIEW_FLOW_ID (from flows-sync) or they are skipped.
 */
import { config } from '../src/config.mjs';
import { getSecrets } from '../src/secrets.mjs';
import { TEMPLATES, LEGACY, NO_PRICE, toPositionalBody, placeholderOrder } from '../messages/templates.mjs';
import { TEMPLATES_HI, PLAIN_HI, HI_NOT_SUBMITTED } from '../messages/templates.hi.mjs';

const live = process.argv.includes('--live');
const strict = process.argv.includes('--strict');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg
  ? new Set(onlyArg.slice('--only='.length).split(',').map((x) => x.trim()).filter(Boolean))
  : null;
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
 * A one-cell workbook to be the CREATE-time example for a DOCUMENT header.
 *
 * The real monthly report is generated per run and kept in a private bucket, so
 * there is no sample URL to fetch. Meta only needs something of the right type
 * to look at in review, so a throwaway is both sufficient and honest: shipping
 * a real month's figures to Meta as a template example would hand them the
 * business's accounts.
 */
async function sampleWorkbook(filename) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sample');
  ws.getCell('A1').value = 'Morpaankh profit and loss';
  ws.getCell('A2').value = 'This is a sample file for template review.';
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  return { bytes, filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Meta will not accept a URL as the example for a media header: it wants a
 * handle from the resumable upload API.
 *
 * `sample` is either a URL to fetch (an image header, the original case) or an
 * already-built `{bytes, filename, mime}` (a document header, where there is
 * nothing to fetch). The two-step upload is identical either way.
 */
async function headerHandle(sample) {
  let bytes;
  let filename;
  let mime;
  if (typeof sample === 'string') {
    const res = await fetch(sample);
    if (!res.ok) throw new Error(`sample image fetch failed (${res.status}): ${sample}`);
    bytes = Buffer.from(await res.arrayBuffer());
    filename = 'sample.jpg';
    mime = 'image/jpeg';
  } else {
    ({ bytes, filename, mime } = sample);
  }
  const id = await appId();

  const start = await (
    await fetch(
      `${G}/${id}/uploads?file_name=${encodeURIComponent(filename)}&file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}`,
      { method: 'POST', headers: auth },
    )
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
  /*
   * A DOCUMENT header needs an uploaded example too, and there is no sample
   * workbook to fetch from a URL: the real one is generated per month and lives
   * in a private bucket. So we build a throwaway one-cell workbook here and
   * upload that. It is never sent to anyone; Meta only looks at it in review.
   */
  if (t.header?.format === 'DOCUMENT') {
    components.push({
      type: 'HEADER',
      format: 'DOCUMENT',
      example: { header_handle: [await headerHandle(await sampleWorkbook(t.header.sampleName))] },
    });
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
    else if (b.kind === 'url') {
      /*
       * A URL button is FIXED once Meta approves the template: the only thing
       * it can carry at send time is the token. Creating one against an empty
       * publicBaseUrl would register "/r/{{1}}" as the url, which Meta either
       * rejects or approves as a broken link that cannot be edited afterwards,
       * only replaced with a new template and another review.
       */
      if (!config.publicBaseUrl) {
        throw new Error(`${t.name}: PUBLIC_BASE_URL is empty, refusing to create a URL button that cannot work`);
      }
      const seg = b.path || 'p';
      buttons.push({
        type: 'URL',
        text: b.text,
        url: `${config.publicBaseUrl}/${seg}/{{1}}`,
        example: [`${config.publicBaseUrl}/${seg}/TESTTOKEN`],
      });
    }
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
console.log(`templates-sync (${live ? 'LIVE' : 'dry-run'}${strict ? ', strict' : ''}) against WABA`);
let failed = false;
/** Names that are not usable today, with why. Printed as the last word. */
const notReady = [];
/** Hindi names that are not usable today. English is sent meanwhile. */
const hindiNotReady = [];

// Fallbacks FIRST, so one always exists at Meta before its replacement goes
// live. NO_PRICE before LEGACY before TEMPLATES, oldest to newest. The Hindi
// registries come LAST, after every English template they fall back to.
const all = [
  ...Object.entries(NO_PRICE),
  ...Object.entries(LEGACY),
  ...Object.entries(TEMPLATES),
  ...Object.entries(PLAIN_HI),
  ...Object.entries(TEMPLATES_HI),
];
const HI_NAMES = new Set([...Object.values(TEMPLATES_HI), ...Object.values(PLAIN_HI)].map((t) => t.name));
for (const [key, t] of all) {
  if (only && !only.has(key) && !only.has(t.name)) continue;
  const isHi = HI_NAMES.has(t.name);
  /*
   * The two Hindi review asks, held back for the same reason their English
   * twins are: Meta needs the business verified before a Flow can be
   * published, so a FLOW button has no flow id to carry. Named explicitly
   * rather than left to the WA_REVIEW_FLOW_ID check, so setting that variable
   * later does not quietly submit two templates nothing can send yet.
   */
  if (HI_NOT_SUBMITTED.has(t.name)) {
    console.log(`  ${t.name}: HELD BACK (needs the review Flow published, like its English twin)`);
    continue;
  }
  const found = existing[t.name];
  if (found) {
    const mismatch = found.category && found.category !== t.category;
    console.log(`  ${t.name}: ${found.status}${found.category ? ` [${found.category}]` : ''}${mismatch ? ` !! declared ${t.category}` : ''}`);
    if (mismatch) failed = true;
    if (String(found.status || '').toUpperCase() !== 'APPROVED') {
      (isHi ? hindiNotReady : notReady).push(`${t.name}: ${found.status} at Meta`);
    }
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
    (isHi ? hindiNotReady : notReady).push(`${t.name}: skipped, needs WA_REVIEW_FLOW_ID from flows-sync`);
    continue;
  }
  if (!live) {
    console.log(`  ${t.name}: would-create [${t.category}]${t.header ? ` +${t.header.format.toLowerCase()} header` : ''}`);
    // The whole point of the gate: a template the sender can reach that does
    // not exist at Meta is a send that will fail with 132001.
    (isHi ? hindiNotReady : notReady).push(`${t.name}: does not exist at Meta, run --live to submit it`);
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
if (notReady.length) {
  console.error(`\ntemplates-sync: ${notReady.length} template(s) the sender can reach are NOT usable today:`);
  for (const n of notReady) console.error(`  - ${n}`);
  console.error('\nA closed 24 hour window has no other way to reach the customer, so each of');
  console.error('these is a message that silently does not go out. Fix before relying on them.');
}
if (hindiNotReady.length) {
  console.warn(`\ntemplates-sync: ${hindiNotReady.length} HINDI template(s) are not usable yet:`);
  for (const n of hindiNotReady) console.warn(`  - ${n}`);
  console.warn('\nENGLISH IS BEING SENT MEANWHILE. These customers get the message, in the');
  console.warn('other language, so this is a quality gap and not an outage. Each one starts');
  console.warn('going out by itself the moment Meta approves it, with no redeploy.');
  if (strict) console.error('\n--strict: treating the Hindi gaps above as failures.');
}
if (failed || notReady.length || (strict && hindiNotReady.length)) {
  if (failed) console.error('\ntemplates-sync: category mismatch or error above.');
  process.exit(2);
}
