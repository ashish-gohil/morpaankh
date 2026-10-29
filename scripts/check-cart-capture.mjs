/*
 * check-cart-capture.mjs — self check for storefront cart capture.
 *
 *   node scripts/check-cart-capture.mjs
 *
 * ONE REGRESSION IS WORTH A WHOLE FILE HERE.
 *
 * COD King's checkout runs in a SAME ORIGIN iframe with its own window.fetch,
 * and that frame is where _otpVerifiedPhoneNumber is written to the cart. A
 * capture script that only watches THIS window therefore sees nothing, which
 * is not a theory: between going live and 29 Oct 2026 the capture endpoint
 * stored exactly one cart, a hand made test, while COD King's own dashboard
 * held ten OTP verified abandoned checkouts.
 *
 * So the test below writes the attribute the way that frame does, from a child
 * frame's own fetch that this window never sees, and insists the cart is still
 * captured.
 *
 * It also insists the script does NOT poll. Watching for COD King's modal by
 * element id and polling the cart was the first fix attempted and it was wrong
 * twice over: it breaks the day COD King renames a div, and it put a request
 * every two seconds on the shopper's connection during checkout.
 *
 * No framework: a DOM stub just wide enough to run the asset's IIFE.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME = join(ROOT, 'theme');
const ENDPOINT = 'https://example.invalid/cart-capture';

let checks = 0;
const ok = (label) => { checks++; console.log('  ok  ' + label); };

// ---- 1. the Liquid section still renders the config the asset reads --------

const section = readFileSync(join(THEME, 'sections/tapi-cart-capture.liquid'), 'utf8');
assert.match(section, /id="tapi-cart-capture-config"/, 'config block id changed');
assert.match(section, /"enabled":\s*true/, 'config block lost "enabled"');
assert.match(section, /"endpoint":\s*\{\{\s*s\.endpoint\s*\|\s*json\s*\}\}/, 'config block lost "endpoint"');
assert.match(section, /tapi-cart-capture\.js/, 'section no longer loads the asset');
ok('section renders the enabled + endpoint config the asset parses');

// ---- 2. a harness wide enough to run the asset ----------------------------

const asset = readFileSync(join(THEME, 'assets/tapi-cart-capture.js'), 'utf8');

function run({ cart }) {
  const timeouts = [];
  const intervals = [];
  const posts = [];
  const cartReads = [];
  const observers = [];
  let seq = 1;
  const store = new Map();

  /** The shared fetch, used by this window and by any frame we hand one to. */
  const doFetch = (url, init) => {
    const u = String(url);
    if (u.includes('/cart.js')) {
      cartReads.push(u);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(cart()) });
    }
    if (u === ENDPOINT) {
      posts.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: true });
  };

  /*
   * COD King's frame: SAME ORIGIN, with its OWN fetch. Nothing it does passes
   * through this window's fetch, which is the entire point of the test.
   */
  const frameWin = { fetch: (u, i) => doFetch(u, i) };
  const frame = {
    contentWindow: frameWin,
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ||= new Set()).add(fn); },
  };
  const iframes = [frame];

  const sandbox = {
    document: {
      getElementById: (id) => (id === 'tapi-cart-capture-config'
        ? { textContent: JSON.stringify({ enabled: true, endpoint: ENDPOINT }) }
        : null),
      getElementsByTagName: (tag) => (tag === 'iframe' ? iframes : []),
      documentElement: {},
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    setTimeout: (fn, ms) => { const id = seq++; timeouts.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timeouts.findIndex((t) => t.id === id); if (i >= 0) timeouts.splice(i, 1); },
    setInterval: (fn, ms) => { const id = seq++; intervals.push({ id, fn, ms }); return id; },
    clearInterval: () => {},
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    fetch: (u, i) => doFetch(u, i),
  };
  sandbox.window = sandbox;

  const names = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...names, asset)(...names.map((n) => sandbox[n]));

  const drain = async () => {
    for (let i = 0; i < 12; i++) {
      timeouts.splice(0, timeouts.length).forEach((t) => t.fn());
      await new Promise((r) => setImmediate(r));
    }
  };
  return { timeouts, intervals, posts, cartReads, drain, sandbox, frameWin, frame, observers };
}

// ---- 3. nothing is posted for a cart with no verified number --------------

{
  const h = run({ cart: () => ({ token: 'tok1234567890', items: [{ variant_id: 1, quantity: 1 }], attributes: {} }) });
  await h.drain();
  assert.equal(h.posts.length, 0, 'a cart with no verified number must never be posted');
  ok('a cart with no OTP verified number is not posted');
}

// ---- 4. THE REGRESSION: a write made in a child frame is still captured ----

{
  let phone = '';
  const h = run({
    cart: () => ({
      token: 'tok1234567890',
      items: [{ variant_id: 54759640039796, quantity: 2 }],
      attributes: phone ? { _otpVerifiedPhoneNumber: phone, _codkAmountType: 'cod' } : {},
    }),
  });
  await h.drain();
  assert.equal(h.posts.length, 0, 'nothing to capture before the shopper verifies');

  // The shopper passes OTP. COD King writes the number from ITS OWN frame, so
  // this window's fetch is never called.
  phone = '919876543210';
  await h.frameWin.fetch('/cart/update.js', { method: 'POST' });
  await h.drain();

  assert.equal(h.posts.length, 1, 'a cart write made inside a child frame was NOT captured');
  const body = h.posts[0];
  assert.equal(body.phone, '919876543210');
  assert.equal(body.token, 'tok1234567890');
  assert.deepEqual(body.items, [{ id: '54759640039796', qty: 2 }]);
  assert.equal(body.attrs._codkAmountType, 'cod', 'COD King amount attrs must travel');
  assert.ok(!('_otpVerifiedPhoneNumber' in body.attrs), 'the number must not be copyable through attrs');
  ok('a cart verified inside COD King\'s own frame is captured');

  // Same bag again: one post, not a stream of them.
  await h.frameWin.fetch('/cart/update.js', { method: 'POST' });
  await h.drain();
  assert.equal(h.posts.length, 1, 'an unchanged bag must not be posted twice');
  ok('an unchanged bag is posted once');
}

// ---- 5. a frame that appears later is hooked too ---------------------------

{
  let phone = '';
  const h = run({
    cart: () => ({
      token: 'tok1234567890',
      items: [{ variant_id: 1, quantity: 1 }],
      attributes: phone ? { _otpVerifiedPhoneNumber: phone } : {},
    }),
  });
  await h.drain();
  assert.equal(h.posts.length, 0, 'nothing to capture before the shopper verifies');

  // A frame created when the shopper opens checkout, long after load.
  const late = { fetch: (u, i) => h.sandbox.fetch(u, i) };
  h.frame.contentWindow = late;
  assert.ok(h.observers.length, 'new frames must be noticed without polling');
  h.observers[0]([{ addedNodes: [{}] }]);

  phone = '919876543210';
  await late.fetch('/cart/update.js', { method: 'POST' });
  await h.drain();
  assert.equal(h.posts.length, 1, 'a frame added after load was never hooked');
  ok('a frame that appears at checkout time is hooked too');
}

// ---- 6. it must not poll ---------------------------------------------------

{
  const h = run({ cart: () => ({ token: 't12345678', items: [], attributes: {} }) });
  await h.drain();
  assert.equal(
    h.intervals.length, 0,
    `the asset set ${h.intervals.length} interval(s): capture must be event driven, not a poll on the shopper's connection`,
  );
  ok('nothing is polled, so checkout costs the shopper no extra requests');
}

// ---- 7. a cross origin frame is left alone ---------------------------------

{
  const h = run({ cart: () => ({ token: 't12345678', items: [], attributes: {} }) });
  // Touching contentWindow on a cross origin frame throws; it must not take
  // the script down with it.
  Object.defineProperty(h.frame, 'contentWindow', {
    get() { throw new Error('SecurityError: cross origin'); },
  });
  assert.doesNotThrow(() => h.observers[0]([{ addedNodes: [{}] }]), 'a cross origin frame must be skipped, not thrown on');
  ok('a cross origin frame is skipped without breaking the page');
}

console.log(`\n${checks} checks passed`);
