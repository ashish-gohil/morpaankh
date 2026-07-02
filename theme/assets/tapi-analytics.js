/* tapi-analytics.js — one event stream, pluggable backends.
 * Loads ONLY when a backend is configured in theme settings (theme.liquid gates
 * the script tag), so with no GA4 ID this file never ships to the browser.
 * GA4 loads lazily (idle or first interaction) to stay off the critical path;
 * events fired before that queue in dataLayer and flush when gtag.js arrives.
 * Product context comes from the page's existing JSON-LD, so no extra Liquid
 * renders per template. Adding a second backend later = subscribe to
 * TapiAnalytics.track without touching the event wiring below.
 */
(function () {
  var cfg = window.TapiAnalytics;
  if (!cfg || !cfg.ga4Id) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag('js', new Date());
  gtag('config', cfg.ga4Id, { debug_mode: !!cfg.debug });

  var loaded = false;
  function loadGtag() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(cfg.ga4Id);
    document.head.appendChild(s);
  }
  if ('requestIdleCallback' in window) window.requestIdleCallback(loadGtag, { timeout: 4000 });
  else setTimeout(loadGtag, 3000);
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, loadGtag, { once: true, passive: true });
  });

  function track(name, params) {
    try {
      gtag('event', name, params || {});
      if (cfg.debug && window.console) console.info('[tapi-analytics]', name, params || {});
    } catch (e) { /* analytics must never break the store */ }
  }
  cfg.track = track;

  /* ---- product context from the page's JSON-LD ---- */
  function productLd() {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var d = JSON.parse(scripts[i].textContent);
        var arr = Array.isArray(d) ? d : [d];
        for (var j = 0; j < arr.length; j++) {
          if (arr[j] && arr[j]['@type'] === 'Product') return arr[j];
        }
      } catch (e) { /* skip malformed blocks */ }
    }
    return null;
  }
  function itemFromLd(ld) {
    var offers = ld.offers || {};
    var offer = Array.isArray(offers) ? (offers[0] || {}) : offers;
    return {
      item_id: String(ld.sku || ld.productID || ld.name || ''),
      item_name: String(ld.name || ''),
      item_brand: 'MorPaankh',
      price: Number(offer.price || offer.lowPrice || 0)
    };
  }

  var ld = productLd();
  if (ld) {
    var it = itemFromLd(ld);
    track('view_item', { currency: 'INR', value: it.price, items: [it] });
  }

  /* add_to_cart — Dawn's AJAX add still dispatches the form submit */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.action || f.action.indexOf('/cart/add') === -1) return;
    var qtyEl = f.querySelector('[name="quantity"]');
    var qty = qtyEl && Number(qtyEl.value) > 0 ? Number(qtyEl.value) : 1;
    var params = { currency: 'INR' };
    if (ld) {
      var item = itemFromLd(ld);
      item.quantity = qty;
      params.items = [item];
      params.value = item.price * qty;
    }
    track('add_to_cart', params);
  }, true);

  /* begin_checkout + announcement (promotion) clicks */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('button[name="checkout"], a[href^="/checkout"], .cart__checkout-button')) {
      track('begin_checkout', { currency: 'INR' });
    }
    var ann = e.target.closest('.tapi-announce__inner');
    if (ann) {
      var txt = document.querySelector('.tapi-announce__text');
      track('select_promotion', { promotion_name: txt ? txt.textContent.trim() : 'announcement' });
    }
  }, true);

  /* PDP offers box impression — fires once when half of it is on screen */
  var offers = document.querySelector('.tapi-pdp__offers');
  if (offers && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          track('view_promotion', { promotion_name: 'pdp_offers_box' });
          io.disconnect();
          break;
        }
      }
    }, { threshold: 0.5 });
    io.observe(offers);
  }

  /* wishlist adds — store calls back immediately, then on every change */
  if (window.TapiWishlist && window.TapiWishlist.subscribe) {
    var prevCount = null;
    window.TapiWishlist.subscribe(function (arr) {
      if (prevCount !== null && arr.length > prevCount) {
        var added = arr[0] || {};
        track('add_to_wishlist', {
          currency: 'INR',
          items: [{ item_name: String(added.title || added.handle || '') }]
        });
      }
      prevCount = arr.length;
    });
  }
})();
