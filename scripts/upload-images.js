#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STORE = 'yaaijv-6p.myshopify.com';
const ROOT = '/Users/ashishgohil/garment-seller/scripts';
const manifest = JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`, 'utf8'));
const index = JSON.parse(fs.readFileSync(`${ROOT}/images/_index.json`, 'utf8'));

function exec(query, variables) {
  const out = execFileSync('shopify', [
    'store','execute','-s',STORE,'--allow-mutations','-j',
    '-q', query, '-v', JSON.stringify(variables),
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('{')));
}

const STAGE = `mutation Stage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const MEDIA = `mutation Media($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { ... on MediaImage { id alt status } }
    mediaUserErrors { field message }
  }
}`;

async function uploadFile(file, basename) {
  const stat = fs.statSync(file);
  const stageRes = exec(STAGE, {
    input: [{
      filename: basename,
      mimeType: 'image/png',
      httpMethod: 'POST',
      resource: 'IMAGE',
      fileSize: String(stat.size),
    }],
  });
  const target = stageRes?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    throw new Error('stagedUploadsCreate failed: ' + JSON.stringify(stageRes));
  }
  // POST multipart/form-data to target.url
  const FormData = (await import('node:stream/web')).FormData || globalThis.FormData;
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  const blob = new Blob([fs.readFileSync(file)], { type: 'image/png' });
  form.append('file', blob, basename);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`Upload HTTP ${res.status}: ${await res.text()}`);
  }
  return target.resourceUrl;
}

async function run() {
  // group images by product handle
  const byHandle = {};
  for (const img of index) {
    (byHandle[img.handle] ||= []).push(img);
  }

  for (const handle of Object.keys(byHandle)) {
    const productId = manifest.products[handle]?.id;
    if (!productId) {
      console.log(`!! no product id for ${handle}`);
      continue;
    }
    console.log(`>> ${handle} (${productId})`);
    const mediaInputs = [];
    for (const img of byHandle[handle]) {
      process.stdout.write(`   uploading ${img.basename} ... `);
      try {
        const resourceUrl = await uploadFile(img.file, img.basename);
        console.log('OK');
        mediaInputs.push({
          mediaContentType: 'IMAGE',
          originalSource: resourceUrl,
          alt: `${handle} — ${img.color}`,
        });
      } catch (e) {
        console.log('FAIL', e.message);
      }
    }
    if (!mediaInputs.length) continue;
    const r = exec(MEDIA, { productId, media: mediaInputs });
    const errs = r?.productCreateMedia?.mediaUserErrors || [];
    if (errs.length) console.log('   media err:', JSON.stringify(errs));
    else console.log(`   attached ${r?.productCreateMedia?.media?.length || 0} images`);
    manifest.products[handle].images = mediaInputs.map(m => m.alt);
  }
  fs.writeFileSync(`${ROOT}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log('\nDone');
}

run().catch(e => { console.error(e); process.exit(1); });
