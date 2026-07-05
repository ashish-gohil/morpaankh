/* tapi-analytics.js — one event stream, pluggable backends (GA4, GTM, Meta Pixel).
 * Loads ONLY when a backend is configured in theme settings (theme.liquid gates
 * the script tag), so with no IDs this file never ships to the browser.
 * Vendor scripts load lazily (idle or first interaction) to stay off the critical
 * path; events fired before that queue (dataLayer / fbq stub) and flush on load.
 * Product context comes from the page's existing JSON-LD, so no extra Liquid
 * renders per template. Theme JS cannot see Shopify checkout pages: purchase and
 * checkout-step events belong in a Customer Events custom pixel, not here.
 */
(function () {
  var cfg = window.TapiAnalytics;
  if (!cfg || (!cfg.ga4Id && !cfg.gtmId && !cfg.metaPixelId)) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  if (cfg.ga4Id) {
    window.gtag = window.gtag || gtag;
    gtag('js', new Date());
    gtag('config', cfg.ga4Id, { debug_mode: !!cfg.debug });
  }
  if (cfg.gtmId) {
    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  }
  if (cfg.metaPixelId && !window.fbq) {
    var fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
    fbq.push = fbq; fbq.loaded = true; fbq.version = '2.0'; fbq.queue = [];
    window.fbq = window._fbq = fbq;
    window.fbq('init', cfg.metaPixelId);
    window.fbq('track', 'PageView');
  }

  var loaded = false;
  function loadVendors() {
    if (loaded) return;
    loaded = true;
    function add(src) {
      var s = document.createElement('script');
      s.async = true;
      s.src = src;
      document.head.appendChild(s);
    }
    if (cfg.gtmId) add('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(cfg.gtmId));
    if (cfg.ga4Id) add('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(cfg.ga4Id));
    if (cfg.metaPixelId) add('https://connect.facebook.net/en_US/fbevents.js');
  }
  if ('requestIdleCallback' in window) window.requestIdleCallback(loadVendors, { timeout: 4000 });
  else setTimeout(loadVendors, 3000);
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, loadVendors, { once: true, passive: true });
  });

  /* GA4 event names -> Meta Pixel standard events */
  var META_EVENTS = {
    view_item: 'ViewContent',
    add_to_cart: 'AddToCart',
    begin_checkout: 'InitiateCheckout',
    add_to_wishlist: 'AddToWishlist'
  };

  function track(name, params) {
    try {
      params = params || {};
      if (cfg.ga4Id) gtag('event', name, params);
      if (cfg.gtmId) {
        var dl = { event: name };
        for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) dl[k] = params[k];
        window.dataLayer.push(dl);
      }
      if (cfg.metaPixelId && window.fbq && META_EVENTS[name]) {
        var first = (params.items && params.items[0]) || {};
        window.fbq('track', META_EVENTS[name], {
          content_type: 'product',
          content_name: String(first.item_name || ''),
          content_ids: first.item_id ? [String(first.item_id)] : [],
          currency: params.currency || 'INR',
          value: Number(params.value || 0)
        });
      }
      if (cfg.debug && window.console) console.info('[tapi-analytics]', name, params);
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
