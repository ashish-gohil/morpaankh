/* Tapi PDP — size selector + buy-now wiring.
 * Loaded directly from theme.liquid as a separate asset so it doesn't
 * depend on Shopify's {% javascript %} bundle or the section page-cache.
 *
 * Contract:
 *   - .tapi-pdp                       — the section root
 *   - .tapi-pdp__sizes                — the size buttons container
 *   - .tapi-pdp__size                 — each size button (one per variant)
 *       data-variant-id               — Shopify variant id
 *       data-variant-price            — formatted price (for CTA label)
 *       data-variant-available        — "true" or "false"
 *       .is-active                    — current selection
 *       .is-out                       — sold out (style only)
 *   - input[name="id"]#variant-id-X   — hidden cart form variant id (source of truth)
 *   - .tapi-pdp__add  / .tapi-pdp__buynow / .tapi-pdp__mobile-add — CTAs
 *   - [data-add-label] / [data-mobile-add] / [data-mobile-price] — CTA labels
 *   - [data-stock-note]               — stock message under sizes
 */
(function () {
  'use strict';

  function init(sec) {
    if (!sec || sec.__tapiPdpWired) return;
    sec.__tapiPdpWired = true;

    var sizesEl = sec.querySelector('.tapi-pdp__sizes');
    var variantInput = sec.querySelector('input[name="id"]');
    var addBtn = sec.querySelector('.tapi-pdp__add');
    var buyBtn = sec.querySelector('.tapi-pdp__buynow');
    var addLabel = sec.querySelector('[data-add-label]');
    var mobileAdd = sec.querySelector('[data-mobile-add]');
    var mobilePrice = sec.querySelector('[data-mobile-price]');
    var stockNote = sec.querySelector('[data-stock-note]');

    if (!sizesEl || !variantInput) return;

    function setCtaState(available, variantText, priceText) {
      var qtyInput = sec.querySelector('[data-qty-input]');
      var qty = Math.max(1, parseInt((qtyInput && qtyInput.value) || '1', 10) || 1);
      if (available) {
        if (addLabel) {
          addLabel.textContent = qty > 1
            ? 'Add to bag (' + qty + ') — ' + priceText
            : 'Add to bag — ' + priceText;
        }
        if (mobileAdd) mobileAdd.textContent = variantText ? 'Add — ' + variantText : 'Add to bag';
        if (addBtn) { addBtn.disabled = false; addBtn.removeAttribute('aria-disabled'); }
        if (buyBtn) { buyBtn.disabled = false; buyBtn.removeAttribute('aria-disabled'); }
        if (stockNote) stockNote.textContent = 'In stock — ships in 1–2 days';
      } else {
        if (addLabel) addLabel.textContent = 'Sold out';
        if (mobileAdd) mobileAdd.textContent = 'Sold out';
        if (addBtn) { addBtn.disabled = true; addBtn.setAttribute('aria-disabled', 'true'); }
        if (buyBtn) { buyBtn.disabled = true; buyBtn.setAttribute('aria-disabled', 'true'); }
        if (stockNote) stockNote.textContent = variantText
          ? 'Sold out in size ' + variantText + ' — restocking soon'
          : 'Sold out — restocking soon';
      }
      if (mobilePrice && priceText) mobilePrice.textContent = priceText;
    }

    // Single click handler scoped to the size container.
    sizesEl.addEventListener('click', function (e) {
      var b = e.target.closest('.tapi-pdp__size');
      if (!b || !sizesEl.contains(b)) return;
      e.preventDefault();
      e.stopPropagation();

      var available = b.getAttribute('data-variant-available') === 'true';
      // Sold-out sizes are intentionally not selectable.
      if (!available) return;

      var allBtns = sizesEl.querySelectorAll('.tapi-pdp__size');
      for (var i = 0; i < allBtns.length; i++) {
        allBtns[i].classList.remove('is-active');
        allBtns[i].setAttribute('aria-pressed', 'false');
      }
      b.classList.add('is-active');
      b.setAttribute('aria-pressed', 'true');

      var vid = b.getAttribute('data-variant-id');
      var price = b.getAttribute('data-variant-price') || '';
      var label = (b.textContent || '').trim();

      // Source of truth — Shopify reads this on /cart/add
      if (vid) variantInput.value = vid;

      // Keep URL in sync so reload / share preserves the size
      try {
        var url = new URL(window.location.href);
        url.searchParams.set('variant', vid);
        window.history.replaceState({}, '', url.toString());
      } catch (_) { /* ignore */ }

      setCtaState(true, label, price);
    }, false);

    // Hydrate initial CTA state from the active button (or first available)
    var initial = sec.querySelector('.tapi-pdp__size.is-active')
               || sec.querySelector('.tapi-pdp__size[data-variant-available="true"]');
    if (initial) {
      var initAvailable = initial.getAttribute('data-variant-available') === 'true';
      var initPrice = initial.getAttribute('data-variant-price') || '';
      var initLabel = (initial.textContent || '').trim();
      // Don't overwrite if already active
      if (!initial.classList.contains('is-active')) {
        initial.classList.add('is-active');
        if (variantInput) variantInput.value = initial.getAttribute('data-variant-id') || variantInput.value;
      }
      setCtaState(initAvailable, initLabel, initPrice);
    }

    // ----- Checkout / COD app compatibility (e.g. COD King OTP) -----
    // The mobile sticky-bar buttons live OUTSIDE the product <form> (they target
    // it via the form= attribute), so scripts that bind to the in-form desktop
    // Add / Buy-now buttons never see a mobile tap. That is why the OTP gate
    // fired on desktop but not on phones. Relay each mobile tap to its real
    // in-form twin so mobile behaves identically to desktop, OTP and all. If
    // this script never loads, the listeners are absent and the buttons fall
    // back to their native form submit, so nothing regresses.
    var mobileBuy = sec.querySelector('[data-mobile-buy]');
    function relayTo(twin) {
      return function (e) {
        e.preventDefault();
        if (twin && !twin.disabled) twin.click();
      };
    }
    if (mobileAdd && addBtn) mobileAdd.addEventListener('click', relayTo(addBtn));
    if (mobileBuy && buyBtn) mobileBuy.addEventListener('click', relayTo(buyBtn));
  }

  function boot() {
    document.querySelectorAll('.tapi-pdp').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-init on Shopify section reload (theme editor)
  document.addEventListener('shopify:section:load', function (e) {
    var sec = e.target.querySelector('.tapi-pdp') || (e.target.classList && e.target.classList.contains('tapi-pdp') ? e.target : null);
    if (sec) { sec.__tapiPdpWired = false; init(sec); }
  });
})();
