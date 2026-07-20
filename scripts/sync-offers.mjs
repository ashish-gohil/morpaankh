#!/usr/bin/env node
/*
 * sync-offers.mjs — one-command sync of the cart Offers panel to your live
 * Shopify Discounts.
 *
 * WHY THIS EXISTS
 *   A Liquid theme cannot read your admin discount list — Shopify exposes no
 *   storefront API for "here are my codes and their rules". So the cart panel
 *   (snippets/tapi-smart-offers.liquid) renders a *mirror* held in
 *   config/settings_schema.json (the "Offers" group defaults). This script
 *   pulls the real, current discounts from the Admin API and rewrites that
 *   mirror so the two stop drifting.
 *
 * WHAT IT SYNCS (auto, from the discount object)
 *   code, discount type (percent/amount), value, minimum items, minimum
 *   subtotal, and whether the slot is enabled.
 *
 * WHAT IT PRESERVES (a merchandising choice, not derivable from a discount)
 *   the "Label" text and the "First order only" flag — kept per code when the
 *   code already exists in the mirror; sensible defaults are generated for a
 *   brand-new code (review and tweak in the theme editor if needed).
 *
 * AUTH  (one-time setup — reading discounts needs the read_discounts scope)
 *   Preferred: grant the CLI session the scope, once:
 *     shopify store auth --store yaaijv-6p.myshopify.com \
 *       --scopes "read_discounts,read_products,write_products,read_themes,write_themes"
 *   Alternative: create a custom app with read_discounts and export its token:
 *     export SHOPIFY_ADMIN_TOKEN=shpat_xxx        (keep it out of git)
 *   With either in place, `node scripts/sync-offers.mjs` just works.
 *
 * USAGE
 *   node scripts/sync-offers.mjs            # sync the file AND push to live
 *   node scripts/sync-offers.mjs --dry-run  # show what would change, touch nothing
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const STORE = 'yaaijv-6p.myshopify.com';
const THEME = '189198631284';
const MAX_SLOTS = 4; // settings_schema.json has Offer 1..4 and the panel loops (1..4)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SCHEMA = join(REPO, 'theme', 'config', 'settings_schema.json');
const SETTINGS_DATA = join(REPO, 'theme', 'config', 'settings_data.json');

const DRY = process.argv.includes('--dry-run');

const money = (n) => '₹' + Number(n).toLocaleString('en-IN');

const DISCOUNTS_QUERY = `
query {
  codeDiscountNodes(first: 50) {
    nodes {
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          status
          appliesOncePerCustomer
          codes(first: 1) { nodes { code } }
          customerGets {
            value {
              __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount } }
            }
          }
          minimumRequirement {
            __typename
            ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
          }
          customerSelection { __typename }
        }
      }
    }
  }
}`;

const SCOPE_HELP = [
  '',
  'Reading discounts needs the read_discounts scope. Grant it once, then re-run:',
  '',
  '  shopify store auth --store ' + STORE + ' \\',
  '    --scopes "read_discounts,read_products,write_products,read_themes,write_themes"',
  '',
  'Or point the script at a custom-app token that has read_discounts:',
  '',
  '  export SHOPIFY_ADMIN_TOKEN=shpat_xxx',
  '',
].join('\n');

// Pull the first balanced JSON object out of a noisy string (CLI banner etc.).
function firstJsonObject(out) {
  const start = out.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return out.slice(start, i + 1); }
  }
  return null;
}

/* ---- fetch live discounts: custom-app token, else CLI session ----------- */
async function fetchDiscounts() {
  // Offline testing: SYNC_OFFERS_FIXTURE=path to a saved discounts response.
  if (process.env.SYNC_OFFERS_FIXTURE) {
    const p = JSON.parse(readFileSync(process.env.SYNC_OFFERS_FIXTURE, 'utf8'));
    return (p?.data?.codeDiscountNodes?.nodes || []).map((n) => n.codeDiscount);
  }
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const store = process.env.SHOPIFY_STORE || STORE;
  let parsed;

  if (token) {
    const version = process.env.SHOPIFY_API_VERSION || '2025-01';
    const res = await fetch(`https://${store}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: DISCOUNTS_QUERY }),
    });
    parsed = await res.json();
  } else {
    let out;
    try {
      out = execFileSync('shopify', ['store', 'execute', '-s', store, '-q', DISCOUNTS_QUERY],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch (e) {
      const blob = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
      if (/read_discounts|ACCESS_DENIED/i.test(blob)) { console.error(SCOPE_HELP); process.exit(1); }
      console.error('Could not reach the Admin API via the Shopify CLI.');
      console.error('Check you are logged in:  shopify theme list --store ' + store);
      process.exit(1);
    }
    const json = firstJsonObject(out);
    if (!json) { console.error('No JSON in CLI output.'); process.exit(1); }
    parsed = JSON.parse(json);
  }

  if (parsed?.errors) {
    const msg = JSON.stringify(parsed.errors);
    if (/read_discounts|ACCESS_DENIED/i.test(msg)) { console.error(SCOPE_HELP); process.exit(1); }
    console.error('Admin API error: ' + msg);
    process.exit(1);
  }
  return (parsed?.data?.codeDiscountNodes?.nodes || []).map((n) => n.codeDiscount);
}

/* ---- map a discount to the offer model ---------------------------------- */
function toOffer(d) {
  if (d.__typename !== 'DiscountCodeBasic') return null; // skip free-shipping / BxGy
  if (d.status !== 'ACTIVE') return null;
  const code = d.codes?.nodes?.[0]?.code;
  if (!code) return null;

  const v = d.customerGets?.value;
  let kind, value;
  if (v?.__typename === 'DiscountPercentage') { kind = 'percent'; value = Math.round(v.percentage * 100); }
  else if (v?.__typename === 'DiscountAmount') { kind = 'amount'; value = Math.round(parseFloat(v.amount.amount)); }
  else return null; // shipping/other value types don't fit the panel model

  const mr = d.minimumRequirement;
  let minQty = 0, minSubtotal = 0;
  if (mr?.__typename === 'DiscountMinimumQuantity') minQty = parseInt(mr.greaterThanOrEqualToQuantity, 10) || 0;
  else if (mr?.__typename === 'DiscountMinimumSubtotal') minSubtotal = Math.round(parseFloat(mr.greaterThanOrEqualToSubtotal.amount)) || 0;

  return {
    code: code.toUpperCase(),
    kind,
    value,
    minQty,
    minSubtotal,
    customerAll: d.customerSelection?.__typename === 'DiscountCustomerAll',
  };
}

function generateLabel(o) {
  const val = o.kind === 'percent' ? `${o.value}% off` : `${money(o.value)} off`;
  if (o.minQty > 0) return o.kind === 'percent'
    ? `Buy ${o.minQty} pieces · ${o.value}% off your order`
    : `${money(o.value)} off when you buy ${o.minQty}`;
  if (o.minSubtotal > 0) return `${val} orders over ${money(o.minSubtotal)}`;
  return `${val} your order`;
}

/* ---- read the current mirror so we can preserve label + first_order ------ */
function currentDefault(schema, key) {
  for (const g of schema) for (const s of g.settings || []) if (s.id === key) return s.default;
  return undefined;
}

/* ---- targeted, minimal-diff write of one "default" value ----------------- */
function setDefault(text, key, literal) {
  const re = new RegExp(
    '("id":\\s*"' + key + '"[\\s\\S]*?"default":\\s*)' +
    '(?:"(?:[^"\\\\]|\\\\.)*"|true|false|-?\\d+(?:\\.\\d+)?)'
  );
  if (!re.test(text)) throw new Error('Could not locate default for ' + key);
  return text.replace(re, '$1' + literal);
}

/* ------------------------------------------------------------------------- */
async function main() {
  const raw = await fetchDiscounts();
  const offers = raw.map(toOffer).filter(Boolean);

  // Deterministic order: quantity-gated first (asc qty), then subtotal-gated
  // (asc subtotal), ties broken by bigger value first.
  offers.sort((a, b) => {
    const aq = a.minQty > 0, bq = b.minQty > 0;
    if (aq !== bq) return aq ? -1 : 1;
    if (aq) return a.minQty - b.minQty || b.value - a.value;
    return a.minSubtotal - b.minSubtotal || b.value - a.value;
  });

  if (offers.length > MAX_SLOTS) {
    console.warn(`\n⚠  ${offers.length} active code discounts found, but the panel has only ${MAX_SLOTS} slots.`);
    console.warn(`   Syncing the first ${MAX_SLOTS}; the rest still work at checkout but won't be listed.\n`);
  }
  const slots = offers.slice(0, MAX_SLOTS);

  // Warn if the merchant set overrides in the theme editor — those mask the mirror.
  try {
    const sd = JSON.parse(readFileSync(SETTINGS_DATA, 'utf8').replace(/\/\*[\s\S]*?\*\//, ''));
    const cur = sd.current && typeof sd.current === 'object' ? sd.current : {};
    if (Object.keys(cur).some((k) => k.startsWith('tapi_offer'))) {
      console.warn('⚠  You have Offers overrides saved in the theme editor. Those win over this');
      console.warn('   sync — clear the "Offers" section in the editor for the sync to take effect.\n');
    }
  } catch { /* comment-wrapped or absent; ignore */ }

  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  let text = readFileSync(SCHEMA, 'utf8');

  const rows = [];
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const o = slots[i - 1];
    const base = `tapi_offer${i}`;
    if (!o) {
      const prevCode = currentDefault(schema, `${base}_code`);
      text = setDefault(text, `${base}_enable`, 'false');
      rows.push([i, '(disabled)', prevCode ? `was ${prevCode}` : '', '', '']);
      continue;
    }
    // Preserve merchandising choices keyed by code; generate for new codes.
    let label, firstOrder, isNew = true;
    const priorCode = currentDefault(schema, `${base}_code`);
    if (priorCode && priorCode.toUpperCase() === o.code) {
      label = currentDefault(schema, `${base}_label`);
      firstOrder = currentDefault(schema, `${base}_first_order`);
      isNew = false;
    } else {
      // search all slots for this code to carry its label/flag across a reorder
      for (let j = 1; j <= MAX_SLOTS; j++) {
        const c = currentDefault(schema, `tapi_offer${j}_code`);
        if (c && c.toUpperCase() === o.code) {
          label = currentDefault(schema, `tapi_offer${j}_label`);
          firstOrder = currentDefault(schema, `tapi_offer${j}_first_order`);
          isNew = false;
          break;
        }
      }
    }
    if (label == null) label = generateLabel(o);
    if (firstOrder == null) firstOrder = !o.customerAll; // targeted audience => opt-in only

    text = setDefault(text, `${base}_enable`, 'true');
    text = setDefault(text, `${base}_code`, JSON.stringify(o.code));
    text = setDefault(text, `${base}_label`, JSON.stringify(label));
    text = setDefault(text, `${base}_kind`, JSON.stringify(o.kind));
    text = setDefault(text, `${base}_value`, String(o.value));
    text = setDefault(text, `${base}_min_qty`, String(o.minQty));
    text = setDefault(text, `${base}_min_subtotal`, String(o.minSubtotal));
    text = setDefault(text, `${base}_first_order`, firstOrder ? 'true' : 'false');

    const rule = o.minQty > 0 ? `min ${o.minQty} items` : o.minSubtotal > 0 ? `min ${money(o.minSubtotal)}` : 'no minimum';
    const amt = o.kind === 'percent' ? `${o.value}%` : money(o.value);
    rows.push([i, o.code + (isNew ? '  (NEW)' : ''), amt, rule, firstOrder ? 'opt-in' : 'auto']);
  }

  // Print the result table.
  console.log('\nCart Offers  ←  live admin discounts\n');
  console.log('  #  Code                Value    Rule            Apply');
  console.log('  ─  ──────────────────  ───────  ──────────────  ──────');
  for (const [i, code, amt, rule, apply] of rows) {
    console.log(`  ${i}  ${String(code).padEnd(18)}  ${String(amt).padEnd(7)}  ${String(rule).padEnd(14)}  ${apply}`);
  }
  console.log('');

  // Sanity: result must still be valid JSON.
  JSON.parse(text);

  if (DRY) {
    // Re-read the values back out of the rewritten text to prove they landed.
    const after = JSON.parse(text);
    console.log('Would write these defaults into settings_schema.json:');
    for (let i = 1; i <= MAX_SLOTS; i++) {
      const g = (k) => currentDefault(after, `tapi_offer${i}_${k}`);
      console.log(`  offer${i}: enable=${g('enable')} code=${JSON.stringify(g('code'))} kind=${g('kind')} value=${g('value')} min_qty=${g('min_qty')} min_subtotal=${g('min_subtotal')} first_order=${g('first_order')}`);
    }
    console.log('\nDry run — nothing written or pushed. Drop --dry-run to apply + deploy.\n');
    return;
  }

  writeFileSync(SCHEMA, text);
  console.log('Wrote theme/config/settings_schema.json');
  console.log('Pushing to live theme ' + THEME + ' …\n');
  execFileSync(
    'shopify',
    ['theme', 'push', '--path', join(REPO, 'theme'), '--theme', THEME, '--store', STORE,
      '--nodelete', '--allow-live', '--only', 'config/settings_schema.json'],
    { stdio: 'inherit' }
  );
  console.log('\nDone. The cart Offers panel now matches your live Discounts.');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
