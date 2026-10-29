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
  /*
    THE HOOK ABOVE ONLY WATCHES THIS WINDOW, and that is not where the write
    happens.

    COD King's checkout, OTP step included, runs inside a SAME ORIGIN iframe
    that carries its OWN window.fetch. The write that puts
    _otpVerifiedPhoneNumber on the cart is made from in there, so a hook
    installed on this window never fires. Proven live 29 Oct 2026: that
    frame's bundle builds {_otpVerifiedPhoneNumber, _codkSessionId} and posts
    it to /cart/update.js, its fetch is a different function object from ours,
    and in the capture endpoint's whole life it had stored one cart, a test
    posted by hand from this page.

    So the same observation is installed in every same origin child frame,
    whichever one it is. Deliberately NOT by looking for COD King's modal:
    an element id or a style is theirs to change without telling anyone, and a
    recovery flow that breaks on a redesign is a flow that breaks silently. A
    cart write from a same origin frame is a Shopify level fact and survives
    any redesign.

    It costs nothing to run. No polling, no timers, no extra requests, and
    nothing is added to the page the shopper waits for.

    This is the SECOND source. The first is the checkouts/create and
    checkouts/update webhooks, where Shopify hands the service the same
    attributes signed and server to server, which no change to anyone's
    frontend can affect. See cartRecovery.onCheckoutSeen.
  */
  function hookWindow(win) {
    try {
      if (!win || win.__tapiCartCaptureHooked || !win.fetch) return;
      win.__tapiCartCaptureHooked = true;
      var native = win.fetch;
      win.fetch = function (input, init) {
        var p = native.apply(this, arguments);
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (CART_WRITE_RE.test(url)) p.then(function () { check(); }).catch(function () {});
        } catch (e) { /* observation must never break the request */ }
        return p;
      };
    } catch (e) {
      // A cross origin frame throws on property access. Not ours to watch.
    }
  }

  function hookFrames() {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        hookWindow(frames[i].contentWindow);
        // A frame that navigates gets a fresh document; re-hook on load. The
        // listener is added once per element, because addEventListener with
        // the same function reference does not stack.
        frames[i].addEventListener('load', onFrameLoad);
      } catch (e) { /* cross origin */ }
    }
  }

  function onFrameLoad(e) {
    try { hookWindow(e.target.contentWindow); } catch (err) { /* cross origin */ }
  }

  hookWindow(window);
  hookFrames();

  /*
    Frames are created when the shopper opens the checkout, long after this
    runs, so new ones have to be caught as they appear. An observer and not an
    interval: it fires only when the page actually changes.
  */
  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) { hookFrames(); return; }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  check();
}());
