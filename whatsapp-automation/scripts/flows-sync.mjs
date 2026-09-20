#!/usr/bin/env node
/*
 * flows-sync — create/update the review Flow (category SURVEY), upload the
 * flow.json asset, and publish. Prints the flow id to set as WA_REVIEW_FLOW_ID
 * for templates-sync.
 *
 *   node scripts/flows-sync.mjs          # report only (dry-run)
 *   node scripts/flows-sync.mjs --live   # create/update + publish
 *
 * TODO(Phase 6): confirm exact endpoints, the required Flow JSON version, and
 * the asset upload field name against the live Graph API.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../src/config.mjs';
import { getSecrets } from '../src/secrets.mjs';

const live = process.argv.includes('--live');
const s = await getSecrets();
if (!s.waAccessToken || !s.waWabaId) {
  console.error('WA_ACCESS_TOKEN and WA_WABA_ID required.');
  process.exit(1);
}
const G = `https://graph.facebook.com/${config.graphVersion}`;
const auth = { Authorization: `Bearer ${s.waAccessToken}` };
const HERE = dirname(fileURLToPath(import.meta.url));
const flowJson = readFileSync(join(HERE, '..', 'messages', 'flows', 'review.flow.json'), 'utf8');

const NAME = 'morpaankh_review_v1';

if (!live) {
  console.log('flows-sync (dry-run): would create/update flow', NAME, 'category SURVEY, then upload asset + publish.');
  console.log('flow.json bytes:', flowJson.length);
  process.exit(0);
}

// find or create the flow
async function findFlow() {
  const r = await fetch(`${G}/${s.waWabaId}/flows?limit=200`, { headers: auth });
  const j = await r.json();
  if (!r.ok) throw new Error(`list flows failed: ${JSON.stringify(j).slice(0, 200)}`);
  return (j.data || []).find((f) => f.name === NAME);
}

let flow = await findFlow();
if (!flow) {
  const r = await fetch(`${G}/${s.waWabaId}/flows`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, categories: ['SURVEY'] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`create flow failed: ${JSON.stringify(j).slice(0, 200)}`);
  flow = { id: j.id, name: NAME };
  console.log('created flow', flow.id);
}

// upload the flow.json asset (multipart)
const form = new FormData();
form.append('name', 'flow.json');
form.append('asset_type', 'FLOW_JSON');
form.append('file', new Blob([flowJson], { type: 'application/json' }), 'flow.json');
const up = await fetch(`${G}/${flow.id}/assets`, { method: 'POST', headers: auth, body: form });
const upJson = await up.json();
if (!up.ok) throw new Error(`asset upload failed: ${JSON.stringify(upJson).slice(0, 300)}`);
console.log('asset uploaded; validation:', JSON.stringify(upJson.validation_errors || 'none'));

// publish
const pub = await fetch(`${G}/${flow.id}/publish`, { method: 'POST', headers: auth });
const pubJson = await pub.json();
if (!pub.ok) throw new Error(`publish failed: ${JSON.stringify(pubJson).slice(0, 200)}`);
console.log(`published. Set WA_REVIEW_FLOW_ID=${flow.id} for templates-sync.`);
