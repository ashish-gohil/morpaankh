/*
 * check-cart-capture.mjs — self check for storefront cart capture.
 *
 *   node scripts/check-cart-capture.mjs
 *
 * ONE REGRESSION IS WORTH A WHOLE FILE HERE.
 *
 * COD King's checkout runs in a SAME ORIGIN about:blank iframe with its own
 * window.fetch, and that frame is where _otpVerifiedPhoneNumber is written to
 * the cart. A capture script that only reacts to cart writes made by THIS
 * window therefore sees nothing, which is not a theory: between going live and
 * 29 Oct 2026 the capture endpoint stored exactly one cart, a hand made test,
 * while COD King's own dashboard held ten OTP verified abandoned checkouts.
 *
 * So the test below writes the attribute the way that frame does, which is to
 * say WITHOUT the parent's fetch ever being called, and insists the cart is
 * still captured. Delete the poll and this check goes red.
 *
 * No framework: a DOM stub just wide enough to run the asset's IIFE, plus
 * hand driven timers so a 2 second poll does not cost 2 seconds.
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

/** One run of the asset against a scripted cart. */
function run({ codkOpen = () => false, cart, hiddenStyle = false }) {
  const timeouts = [];          // {id, fn, ms}
  const intervals = [];
  const posts = [];             // capture endpoint bodies
  const cartReads = [];
  let seq = 1;

  const store = new Map();
  const el = (id) => (id === 'tapi-cart-capture-config'
    ? { textContent: JSON.stringify({ enabled: true, endpoint: ENDPOINT }) }
    : null);

  const sandbox = {
    document: {
      getElementById: el,
      /*
       * The stub models the REAL modal, which matters more than it sounds.
       * COD King's modal is position:fixed, so its offsetParent is null even
       * while it fills the screen: a stub that handed back a truthy
       * offsetParent let a predicate that can never fire on the live site
       * pass this file. Measured 29 Oct 2026, offsetParent null and a client
       * rect of 492x682.
       */
      querySelectorAll: () => (codkOpen()
        ? [{ offsetParent: null, getClientRects: () => [{ width: 492, height: 682 }] }]
        : [{ offsetParent: null, getClientRects: () => [] }]),
    },
    getComputedStyle: () => ({ visibility: hiddenStyle ? 'hidden' : 'visible', display: 'block' }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    setTimeout: (fn, ms) => { const id = seq++; timeouts.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timeouts.findIndex((t) => t.id === id); if (i >= 0) timeouts.splice(i, 1); },
    setInterval: (fn, ms) => { const id = seq++; intervals.push({ id, fn, ms }); return id; },
    clearInterval: (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); },
    fetch: (url, init) => {
      const u = String(url);
      if (u.includes('/cart.js')) {
        cartReads.push(u);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(cart()) });
      }
      if (u === ENDPOINT) {
        posts.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false });
    },
  };
  sandbox.window = sandbox;

  const names = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...names, asset)(...names.map((n) => sandbox[n]));

  const drain = async () => {
    for (let i = 0; i < 12; i++) {
      const due = timeouts.splice(0, timeouts.length);
      due.forEach((t) => t.fn());
      await new Promise((r) => setImmediate(r));
    }
  };
  return { timeouts, intervals, posts, cartReads, drain };
}

// ---- 3. an unverified cart is never posted --------------------------------

{
  const h = run({ cart: () => ({ token: 'tok1234567890', items: [{ variant_id: 1, quantity: 1 }], attributes: {} }) });
  await h.drain();
  assert.equal(h.posts.length, 0, 'a cart with no verified number must never be posted');
  ok('a cart with no OTP verified number is not posted');
}

// ---- 4. THE REGRESSION: a write this window never saw is still captured ----

{
  let open = false;
  let phone = '';
  const h = run({
    codkOpen: () => open,
    cart: () => ({
      token: 'tok1234567890',
      items: [{ variant_id: 54759640039796, quantity: 2 }],
      // What COD King's frame writes. The parent's fetch is never called with
      // /cart/update.js, which is the whole point.
      attributes: phone ? { _otpVerifiedPhoneNumber: phone, _codkAmountType: 'cod' } : {},
    }),
  });
  await h.drain();
  assert.equal(h.posts.length, 0, 'nothing to capture before the shopper verifies');

  assert.ok(h.intervals.length >= 1, 'the asset must poll while a checkout modal is open');
  const poll = h.intervals[0];
  assert.ok(poll.ms <= 3000, `poll interval ${poll.ms}ms is too slow to catch the OTP write`);

  // The shopper opens COD King's checkout and passes OTP inside its frame.
  open = true;
  phone = '919876543210';
  poll.fn();
  await h.drain();

  assert.equal(h.posts.length, 1, 'the cart was NOT captured after a write made in COD King\'s frame');
  const body = h.posts[0];
  assert.equal(body.phone, '919876543210');
  assert.equal(body.token, 'tok1234567890');
  assert.deepEqual(body.items, [{ id: '54759640039796', qty: 2 }]);
  assert.equal(body.attrs._codkAmountType, 'cod', 'COD King amount attrs must travel');
  assert.ok(!('_otpVerifiedPhoneNumber' in body.attrs), 'the number must not be copyable through attrs');
  ok('a cart verified inside COD King\'s frame is captured');

  // Same bag again: one post, not a stream of them.
  poll.fn();
  await h.drain();
  assert.equal(h.posts.length, 1, 'an unchanged bag must not be posted twice');
  ok('an unchanged bag is posted once');

  // Closing the modal stops the asking.
  open = false;
  const before = h.cartReads.length;
  poll.fn();
  await h.drain();
  assert.equal(h.cartReads.length, before, 'the cart must not be read once the modal is closed');
  ok('the poll stops when the checkout modal closes');
}

// ---- 5. a frame kept in the layout but hidden is not an open checkout -----

{
  // COD King leaves the frame in the page and flips visibility between steps,
  // so "has a box" alone would poll on every page for twenty minutes.
  const h = run({
    codkOpen: () => true,
    hiddenStyle: true,
    cart: () => ({ token: 't12345678', items: [], attributes: {} }),
  });
  await h.drain();
  const before = h.cartReads.length;
  h.intervals[0].fn();
  await h.drain();
  assert.equal(h.cartReads.length, before, 'a hidden frame must not count as an open checkout');
  ok('a frame hidden between steps is not treated as an open checkout');
}

// ---- 6. the poll is bounded ------------------------------------------------

{
  let open = true;
  const h = run({ codkOpen: () => open, cart: () => ({ token: 't', items: [], attributes: {} }) });
  await h.drain();
  const poll = h.intervals[0];
  for (let i = 0; i < 1200; i++) poll.fn();
  await h.drain();
  assert.ok(h.cartReads.length < 1000, `an open modal polled ${h.cartReads.length} times, it must be capped`);
  ok('a modal left open stops polling instead of running forever');
}

console.log(`\n${checks} checks passed`);
