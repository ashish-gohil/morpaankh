/* ------------------------------------------------------------------
   Smart offers behaviour.
   Cart: auto-applies the biggest general (non-first-order) code via
   Shopify's /discount/CODE cookie endpoint so checkout arrives with
   the code pre-filled, and lets the shopper switch to any eligible
   code (one code per order — Shopify enforces the rest).
   PDP: copy-to-clipboard for the offer code chips.
   Progressive enhancement: without JS the panel still lists codes and
   they can be typed at checkout. No personal data is stored — only
   the chosen code, per tab session.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var KEY = 'tapi:offer-code';
  var busy = false;

  function panel() {
    return document.querySelector('[data-tapi-offers]');
  }

  function readSaved() {
    try { return sessionStorage.getItem(KEY); } catch (e) { return null; }
  }

  function writeSaved(code) {
    try { sessionStorage.setItem(KEY, code); } catch (e) { /* private mode */ }
  }

  function setStatus(p, msg) {
    var s = p.querySelector('[data-tapi-offers-status]');
    if (s) s.textContent = msg;
  }

  function markApplied(p, code) {
    var rows = p.querySelectorAll('.tapi-offers__row[data-code]');
    Array.prototype.forEach.call(rows, function (row) {
      var on = row.getAttribute('data-code') === code;
      row.classList.toggle('is-applied', on);
      var btn = row.querySelector('[data-tapi-offer-apply]');
      if (btn) {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        var lbl = btn.querySelector('[data-apply-label]');
        if (lbl) lbl.textContent = on ? 'Applied' : 'Apply';
      }
    });
    setStatus(p, code ? 'Code ' + code + ' is set. It comes off your total at checkout.' : '');
  }

  function applyCode(code, p) {
    if (!code || busy) return;
    busy = true;
    fetch('/discount/' + encodeURIComponent(code), { credentials: 'same-origin' })
      .then(function () {
        writeSaved(code);
        if (p) markApplied(p, code);
      })
      .catch(function () { /* offline: shopper can still type the code at checkout */ })
      .then(function () { busy = false; });
  }

  function initCart() {
    var p = panel();
    if (!p) return;
    var saved = readSaved();
    if (saved && p.querySelector('.tapi-offers__row[data-code="' + saved + '"][data-eligible="true"]')) {
      markApplied(p, saved);
      return;
    }
    // No valid choice yet for this cart: quietly set the biggest general
    // saving. First-order-only codes are never auto-applied — the shopper
    // opts in, since eligibility is theirs to know.
    var best = p.getAttribute('data-best-general');
    if (best) applyCode(best, p);
  }

  function copyChip(btn) {
    var code = btn.getAttribute('data-tapi-copy');
    if (!code) return;
    var done = function () {
      btn.classList.add('is-copied');
      var lbl = btn.querySelector('[data-copy-label]');
      var prev = lbl ? lbl.textContent : '';
      if (lbl) lbl.textContent = 'Copied';
      window.setTimeout(function () {
        btn.classList.remove('is-copied');
        if (lbl) lbl.textContent = prev;
      }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, function () { /* denied */ });
    } else {
      var ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* no-op */ }
      document.body.removeChild(ta);
    }
  }

  document.addEventListener('click', function (e) {
    var apply = e.target.closest('[data-tapi-offer-apply]');
    if (apply) {
      applyCode(apply.getAttribute('data-code'), apply.closest('[data-tapi-offers]'));
      return;
    }
    var chip = e.target.closest('[data-tapi-copy]');
    if (chip) copyChip(chip);
  });

  // The cart section swaps .js-contents on every quantity change, which
  // re-renders the panel server-side with fresh math. Re-run init so the
  // applied state (and a better auto-pick) follows the new cart.
  var observer = null;
  function watchCart() {
    var host = document.getElementById('main-cart-items');
    if (!host || observer) return;
    var t = null;
    observer = new MutationObserver(function () {
      window.clearTimeout(t);
      t = window.setTimeout(initCart, 150);
    });
    observer.observe(host, { childList: true, subtree: true });
  }

  function boot() {
    initCart();
    watchCart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  document.addEventListener('shopify:section:load', initCart);
})();
