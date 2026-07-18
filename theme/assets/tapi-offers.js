/* ------------------------------------------------------------------
   Smart offers behaviour.
   Cart: applies a discount code to the CART itself via
   POST /cart/update.js { discount } — the same mechanism the checkout
   reads — so the cart total, the footer discount line and checkout
   all reflect the code instantly, no refresh. The request bundles
   Shopify section rendering, so the panel and totals re-render from
   one round trip. The biggest general (non-first-order) code is
   auto-applied once; the shopper can switch or remove freely.
   PDP: copy-to-clipboard for the offer code chips.
   Progressive enhancement: without JS the panel still lists codes and
   they can be typed at checkout. Only a "shopper removed the code"
   flag is stored, per tab session — no personal data.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var DISMISS_KEY = 'tapi:offer-dismissed';
  var busy = false;
  var autoTried = false;

  function panel() {
    return document.querySelector('[data-tapi-offers]');
  }

  function dismissed() {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }

  function setDismissed(on) {
    try {
      if (on) sessionStorage.setItem(DISMISS_KEY, '1');
      else sessionStorage.removeItem(DISMISS_KEY);
    } catch (e) { /* private mode */ }
  }

  function sectionIds() {
    var ids = [];
    var items = document.getElementById('main-cart-items');
    var footer = document.getElementById('main-cart-footer');
    if (items && items.dataset.id) ids.push(items.dataset.id);
    if (footer && footer.dataset.id) ids.push(footer.dataset.id);
    return ids;
  }

  function swapSections(sections) {
    if (!sections) return;
    Object.keys(sections).forEach(function (id) {
      var html = sections[id];
      var host = document.getElementById('shopify-section-' + id);
      if (!html || !host) return;
      var fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('.js-contents');
      var live = host.querySelector('.js-contents');
      if (fresh && live) live.innerHTML = fresh.innerHTML;
    });
  }

  function setStatus(msg, isError) {
    var p = panel();
    if (!p) return;
    var s = p.querySelector('[data-tapi-offers-status]');
    if (!s) return;
    s.textContent = msg || '';
    s.classList.toggle('is-error', !!isError);
  }

  function rupees(paise) {
    return 'Rs. ' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function postDiscount(code, opts) {
    if (busy) return;
    busy = true;
    opts = opts || {};
    var prev = null;
    var p = panel();
    if (p) prev = p.getAttribute('data-applied-code') || '';
    var body = { discount: code };
    var ids = sectionIds();
    if (ids.length) body.sections = ids.join(',');
    fetch('/cart/update.js', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        var entry = (cart.discount_codes || [])[0];
        var applicable = code === '' || (entry && entry.applicable === true);
        swapSections(cart.sections);
        if (applicable) {
          if (!opts.silent) {
            if (code === '') setStatus('Code removed.');
            else setStatus('Code ' + code + ' applied. You save ' + rupees(cart.total_discount) + ' on this order.');
          }
          busy = false;
          if (opts.after) opts.after();
        } else {
          // Structural miss (cart changed under us): put things back, then
          // say why — after the restore's own section swap, or the message
          // would be wiped along with the panel HTML.
          busy = false;
          postDiscount(prev || '', {
            silent: true,
            after: function () {
              setStatus('Code ' + code + ' does not fit this cart yet.', true);
            }
          });
        }
      })
      .catch(function () {
        busy = false;
        setStatus('Could not update the code. Please try again.', true);
      });
  }

  function initCart() {
    var p = panel();
    if (!p || autoTried) return;
    var applied = p.getAttribute('data-applied-code') || '';
    var best = p.getAttribute('data-best-general') || '';
    if (applied === '' && best !== '' && !dismissed()) {
      autoTried = true;
      postDiscount(best, { silent: true });
    }
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
      setDismissed(false);
      postDiscount(apply.getAttribute('data-code'));
      return;
    }
    var remove = e.target.closest('[data-tapi-offer-remove]');
    if (remove) {
      setDismissed(true);
      postDiscount('');
      return;
    }
    var chip = e.target.closest('[data-tapi-copy]');
    if (chip) copyChip(chip);
  });

  function boot() {
    initCart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  document.addEventListener('shopify:section:load', boot);
})();
