/*
 * check-subscribe-popup.mjs — self check for the signup popup.
 *
 *   node scripts/check-subscribe-popup.mjs
 *
 * Two things break this component silently, so both are asserted here:
 *   1. The Liquid config block stops being valid JSON (a missing comma, a
 *      setting renamed in the schema but not in the block). The popup then
 *      never opens and nothing is logged anywhere a merchant would look.
 *   2. The phone or email rules drift from what the /subscribe endpoint
 *      enforces, so the form accepts input the server then rejects.
 *
 * No framework: a handful of asserts and a DOM stub just wide enough to let the
 * asset's IIFE run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const THEME = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme');
let checks = 0;
const ok = (label) => {
  checks++;
  console.log('  ok  ' + label);
};

// ---- 1. the Liquid config block renders valid JSON -------------------------

const section = readFileSync(join(THEME, 'sections/tapi-subscribe-popup.liquid'), 'utf8');
const schema = JSON.parse(section.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/)[1]);

const defaults = {};
for (const s of schema.settings) if (s.id) defaults[s.id] = s.default === undefined ? '' : s.default;

let block = section.match(
  /<script type="application\/json" id="tapi-subscribe-config">([\s\S]*?)<\/script>/,
)[1];

block = block
  .replace(/\{%\s*if customer and customer\.accepts_marketing\s*%\}true\{%\s*else\s*%\}false\{%\s*endif\s*%\}/g, 'false')
  .replace(/\{\{\s*delay_ms\s*\|\s*json\s*\}\}/g, JSON.stringify(defaults.delay_seconds * 1000))
  .replace(/\{\{\s*privacy\s*\|\s*json\s*\}\}/g, JSON.stringify('/policies/privacy-policy'))
  .replace(/\{\{\s*s\.([a-z_]+)\s*\|\s*json\s*\}\}/g, (_, id) => {
    assert.ok(id in defaults, `config reads s.${id} but the schema has no such setting`);
    return JSON.stringify(defaults[id]);
  });

assert.ok(!/\{\{|\{%/.test(block), 'config block still has unsubstituted Liquid');
const cfg = JSON.parse(block); // throws on a stray comma
ok('config block renders valid JSON (' + Object.keys(cfg).length + ' keys)');

for (const id of Object.keys(defaults)) {
  assert.ok(section.includes('s.' + id), `schema setting "${id}" is never used in the config block`);
}
ok('every schema setting reaches the config');

assert.equal(cfg.offerCode, 'WELCOME150');
assert.ok(String(cfg.offerNote).includes('1,199'), 'the code conditions should name the minimum');
ok('offer code and minimum match the discount in Shopify');

/* Customer copy carries no em or en dash and no emoji, same rule the WhatsApp
 * templates are held to. */
const copy = Object.values(cfg).filter((v) => typeof v === 'string').join(' ');
assert.ok(!/[–—]/.test(copy), 'customer copy contains an en or em dash');
assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(copy), 'customer copy contains an emoji');
ok('customer copy has no dashes and no emoji');

// ---- 2. the client rules match what /subscribe enforces -------------------

/* Minimal DOM. boot() finds no config node and returns, so nothing is built;
 * the exported helpers are what this section exercises. */
let cookie = '';
const localStore = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
    setItem: (k, v) => localStore.set(k, String(v)),
  },
  location: { pathname: '/' },
  matchMedia: () => ({ matches: false }),
};
globalThis.document = {
  readyState: 'complete',
  getElementById: () => null,
  querySelector: () => null,
  addEventListener: () => {},
  body: { className: '' },
  get cookie() {
    return cookie;
  },
  set cookie(v) {
    cookie = v;
  },
};

new Function(readFileSync(join(THEME, 'assets/tapi-subscribe.js'), 'utf8'))();
const S = window.TapiSubscribe;
assert.ok(S, 'tapi-subscribe.js did not export TapiSubscribe');

const IN = { code: '+91', digits: 10 };
assert.equal(S._validatePhone('9876543210', IN), '');
assert.notEqual(S._validatePhone('5876543210', IN), ''); // must start 6-9
assert.notEqual(S._validatePhone('987654321', IN), ''); // 9 digits
assert.notEqual(S._validatePhone('', IN), '');
assert.equal(S._validatePhone('98765 43210', IN), ''); // spaces are fine
ok('Indian mobile rule matches the server: 10 digits starting 6-9');

assert.equal(S._validateEmail('asha@example.com'), '');
assert.notEqual(S._validateEmail('asha@example'), '');
assert.notEqual(S._validateEmail('a"b@example.com'), ''); // server rejects quotes too
assert.notEqual(S._validateEmail(''), '');
ok('email rule matches the server');

// ---- 3. the show/hide gate ------------------------------------------------

const base = { enabled: true, endpoint: 'https://x/subscribe', storageKey: 'k' };

assert.equal(S._shouldShow(base), true);
ok('shows on an ordinary page');

for (const p of ['/cart', '/account', '/account/login', '/en-in/cart', '/checkout', '/password']) {
  window.location.pathname = p;
  assert.equal(S._shouldShow(base), false, `should not show on ${p}`);
}
window.location.pathname = '/products/bagh-bahar';
assert.equal(S._shouldShow(base), true);
ok('stays off cart, account, login and checkout, including under a locale prefix');

assert.equal(S._shouldShow({ ...base, enabled: false }), false);
assert.equal(S._shouldShow({ ...base, customerSubscribed: true }), false);
ok('respects the off switch and an already subscribed customer');

localStore.set('k', 'done');
assert.equal(S._shouldShow(base), false);
ok('never returns once someone has subscribed');

localStore.set('k', String(Date.now() + 86400000));
assert.equal(S._shouldShow(base), false);
localStore.set('k', String(Date.now() - 1000));
assert.equal(S._shouldShow(base), true);
ok('stays hidden while snoozed, returns once the snooze expires');

console.log(`\n${checks} checks passed`);
