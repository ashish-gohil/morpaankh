/*
  tapi-cart-capture.js — tell the recovery service about a cart that has been
  OTP verified, so it can be won back if the shopper leaves.

  WHY THIS EXISTS. Shopify only files an abandoned checkout once a shopper
  reaches its OWN contact step. On this store the OTP happens earlier, in COD
  King's popup, which writes _otpVerifiedPhoneNumber onto the cart. So there is
  a real group of people who are reachable and who Shopify's abandoned list
  never sees: measured 17 to 19 Oct 2026, five of them in three days, against
  zero abandoned checkouts recorded. This closes that gap.

  WHAT IS SENT: the cart token, the OTP verified number, and variant ids with
  quantities. No prices, no titles, no personal detail beyond the number COD
  King already verified. The server re-reads every price from Shopify, so
  nothing here can move what a shopper is later offered.

  WHEN: once on load, and after any cart mutation, which is how COD King's own
  write is noticed the moment it lands. Each payload is posted once; an
  unchanged cart is never posted twice.

  This file must never be able to break the cart. Every entry point is wrapped,
  the fetch hook always returns the original promise untouched, and any failure
  here is silent.
*/
(function () {
  var el = document.getElementById('tapi-cart-capture-config');
  if (!el) return;

  var cfg;
  try { cfg = JSON.parse(el.textContent); } catch (e) { return; }
  if (!cfg || !cfg.enabled || !cfg.endpoint) return;

  var PHONE_ATTR = '_otpVerifiedPhoneNumber';
  var SENT_KEY = 'tapi:cartcap';
  // Mirrors the server's allowlist. COD King's own attributes travel because
  // the flow reads _codkAmountType and _codkAmountValue to refuse carts whose
  // line prices are only a partial advance.
  var ATTR_RE = /^_codk[A-Za-z]{1,40}$|^_partialPaymentProduct$/;
  var CART_WRITE_RE = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;

  function readSent() {
    try { return localStorage.getItem(SENT_KEY) || ''; } catch (e) { return ''; }
  }
  function writeSent(v) {
    try { localStorage.setItem(SENT_KEY, v); } catch (e) { /* private mode */ }
  }

  function codkAttrs(attrs) {
    var out = {};
    var n = 0;
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      if (n >= 12 || !ATTR_RE.test(k)) continue;
      var v = attrs[k];
      if (v == null || typeof v === 'object') continue;
      out[k] = String(v).slice(0, 200);
      n += 1;
    }
    return out;
  }

  function post(cart) {
    var attrs = (cart && cart.attributes) || {};
    var phone = attrs[PHONE_ATTR];
    // No verified number means there is nobody we are allowed to message, and
    // an empty cart means there is nothing to win back.
    if (!phone || !cart.token || !cart.items || !cart.items.length) return;

    var items = [];
    for (var i = 0; i < cart.items.length; i++) {
      var line = cart.items[i];
      var id = String(line.variant_id || line.id || '');
      if (!/^\d+$/.test(id)) return;     // a bag we cannot read in full
      items.push({ id: id, qty: line.quantity });
    }

    var body = JSON.stringify({
      token: cart.token,
      phone: String(phone),
      items: items,
      attrs: codkAttrs(attrs)
    });
    // The same bag, already reported. Posting it again would only reset the
    // service's "last seen holding this" clock and delay the message.
    if (readSent() === body) return;

    fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true          // survives the navigation into checkout
    }).then(function (r) {
      if (r && r.ok) writeSent(body);
    }).catch(function () { /* recovery is best effort, never the shopper's problem */ });
  }

  var pending = null;
  function check() {
    // Coalesced: a single "add to cart" can fire several section re-renders,
    // and each one would otherwise be its own /cart.js read.
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () {
      pending = null;
      fetch(window.Shopify && window.Shopify.routes && window.Shopify.routes.root ?
        window.Shopify.routes.root + 'cart.js' : '/cart.js', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (c) { if (c) post(c); })
        .catch(function () {});
    }, 600);
  }

  /*
    The cart changes without a page load, and the write we most need to notice
    is COD King's own: it sets the verified number with /cart/update.js the
    moment the OTP passes, and then sends the shopper to checkout, where none
    of our scripts run. Watching for that write is the only way to see the cart
    while we still can.

    The original promise is returned untouched and the observation is attached
    with .then, so nothing here can delay, alter or reject a cart request.
  */
  if (window.fetch && !window.__tapiCartCaptureHooked) {
    window.__tapiCartCaptureHooked = true;
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var p = nativeFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (CART_WRITE_RE.test(url)) p.then(function () { check(); }).catch(function () {});
      } catch (e) { /* observation must never break the request */ }
      return p;
    };
  }

  /*
    THE HOOK ABOVE IS NOT ENOUGH, and that gap is why recovery had nothing to
    work with.

    COD King's checkout, OTP step included, runs inside
    #codk-full-modal-svelte: a SAME ORIGIN about:blank iframe that carries its
    OWN window.fetch. The write that puts _otpVerifiedPhoneNumber on the cart
    is made from in there, so the hook above, which is installed on this
    window, never fires and the number lands without anyone on this page
    noticing.

    Proven live 29 Oct 2026: that frame's bundle builds
    {_otpVerifiedPhoneNumber, _codkSessionId} and posts it to /cart/update.js,
    the frame's fetch is a different function object from ours, our script is
    not loaded in there, and in the capture endpoint's whole life it had
    stored exactly one cart, a test posted by hand from the parent page. Over
    the same days COD King's own dashboard held ten OTP verified abandoned
    checkouts.

    So while that modal is open we stop waiting to be told and ask the cart.
    A poll and not a hook on the frame, because the frame is rewritten as the
    shopper moves between steps and its bundle is already running before we
    could patch it, and because this keeps working if COD King ever moves the
    write to its own server.
  */
  var CODK_SEL = '#codk-full-modal-svelte, #codk-otp-widget-box';
  // 2s is well inside the address step that follows OTP, so the number is
  // seen while the shopper is still here. 600 asks caps one opening at 20
  // minutes, so a tab left open overnight cannot poll forever.
  var POLL_MS = 2000;
  var POLL_MAX = 600;
  var asks = 0;

  /*
    NOT offsetParent. The modal is position:fixed, and a fixed element's
    offsetParent is null in every browser even while it fills the screen, so
    that test reads an open checkout as closed and the poll below never runs.
    Measured on the live modal 29 Oct 2026: offsetParent null, client rect
    492x682. getClientRects is the test that survives fixed positioning, and
    visibility is checked separately because COD King keeps the frame in the
    layout and hides it between steps.
  */
  function shown(el) {
    if (!el.getClientRects().length) return false;
    var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return !cs || cs.visibility !== 'hidden';
  }

  function codkOpen() {
    var els = document.querySelectorAll(CODK_SEL);
    for (var i = 0; i < els.length; i++) if (shown(els[i])) return true;
    return false;
  }

  setInterval(function () {
    // Closed again: give the next opening a fresh budget.
    if (!codkOpen()) { asks = 0; return; }
    if (asks++ >= POLL_MAX) return;
    check();
  }, POLL_MS);

  check();
}());
