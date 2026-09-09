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

  /* Non-customer contexts must never emit: the theme editor (design mode),
   * shared theme previews (*.shopifypreview.com) and the raw *.myshopify.com
   * domain would pollute GA4/Meta with non-shopper traffic. Real shoppers are
   * on the primary domain (www.morpaankh.in), so bail before any backend inits
   * or events fire. */
  var host = location.hostname || '';
  function hostEndsWith(s) { return host.length >= s.length && host.slice(-s.length) === s; }
  if ((window.Shopify && Shopify.designMode) || hostEndsWith('shopifypreview.com') || hostEndsWith('.myshopify.com')) return;

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

  /* ---- surviving a page unload ------------------------------------------
   * The PDP "Add to bag" is a native form POST that navigates straight to
   * /cart, and the vendor scripts load lazily (idle, or first interaction).
   * A shopper who taps add within a few seconds of landing fires the event
   * while gtag.js is still downloading, so it dies in the dataLayer queue
   * when the page unloads and GA4 never sees it. That is why add_to_cart was
   * running roughly a third of view_cart.
   *
   * Fix: if gtag is already live, send immediately as before. If it is not,
   * park the event in sessionStorage and replay it on the next page, keeping
   * the original page_location so GA4 still credits the product page. The two
   * paths are mutually exclusive, so nothing is ever counted twice.
   * --------------------------------------------------------------------- */
  var PENDING_KEY = 'tapi_pending_event';
  var PENDING_MAX_AGE = 5 * 60 * 1000;

  function ga4Ready() {
    return !!(cfg.ga4Id && window.google_tag_manager && window.google_tag_manager[cfg.ga4Id]);
  }

  function parkEvent(name, params) {
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        name: name,
        params: params,
        page_location: location.href,
        page_title: document.title,
        ts: Date.now()
      }));
    } catch (e) { /* private mode or quota — nothing else we can do */ }
  }

  function flushParkedEvent() {
    var raw = null;
    try {
      raw = sessionStorage.getItem(PENDING_KEY);
      if (raw) sessionStorage.removeItem(PENDING_KEY);
    } catch (e) { return; }
    if (!raw) return;
    try {
      var p = JSON.parse(raw);
      if (!p || !p.name || (Date.now() - p.ts) > PENDING_MAX_AGE) return;
      var params = p.params || {};
      params.page_location = p.page_location;
      params.page_title = p.page_title;
      loadVendors(); // shopper is mid-funnel, do not wait for idle
      track(p.name, params);
    } catch (e) { /* analytics must never break the store */ }
  }
  flushParkedEvent();

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
  /* Shopify's product JSON-LD on this store carries neither sku nor productID,
     so item_id was falling back to the product NAME ("Tulsi"). view_cart and
     the checkout pixel both key on the variant, so the same product arrived in
     GA4 under two different ids and the item funnel never joined up. Read the
     real ids off the page instead: the cart form's [name="id"] holds the
     currently selected variant and updates when size or colour changes. */
  function pdpIds() {
    var ids = { sku: '', variantId: '', productId: '' };
    try {
      var f = document.querySelector('form[action*="/cart/add"]');
      var idInput = f && f.querySelector('[name="id"]');
      if (idInput && idInput.value) ids.variantId = String(idInput.value);
      var prod = ((window.ShopifyAnalytics && window.ShopifyAnalytics.meta) || {}).product || {};
      if (prod.id) ids.productId = String(prod.id);
      var vars = prod.variants || [];
      for (var i = 0; i < vars.length; i++) {
        if (String(vars[i].id) === ids.variantId && vars[i].sku) { ids.sku = String(vars[i].sku); break; }
      }
      if (ids.sku === 'null' || ids.sku === 'undefined') ids.sku = '';
    } catch (e) { /* fall through to whatever the JSON-LD offers */ }
    return ids;
  }

  function itemFromLd(ld) {
    var offers = ld.offers || {};
    var offer = Array.isArray(offers) ? (offers[0] || {}) : offers;
    var ids = pdpIds();
    return {
      // same precedence view_cart already uses: sku, then variant, then product
      item_id: String(ids.sku || ids.variantId || ids.productId || ld.sku || ld.productID || ld.name || ''),
      item_name: String(ld.name || ''),
      item_brand: 'Morpaankh',
      price: Number(offer.price || offer.lowPrice || 0)
    };
  }

  var ld = productLd();
  if (ld) {
    var it = itemFromLd(ld);
    track('view_item', { currency: 'INR', value: it.price, items: [it] });
  }

  /* add_to_cart — catches both an AJAX add and the native form POST that
     navigates to /cart. In the navigating case the event has to outlive the
     page, so it goes through the park-and-replay path above. */
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
    if (ga4Ready()) {
      track('add_to_cart', params);
    } else {
      loadVendors();
      parkEvent('add_to_cart', params);
    }
  }, true);

  /* view_cart — the cart page is in theme scope (checkout pages are not), so
     it fires here, not in the Customer Events pixel. Live line items come from
     /cart.js so the event carries real products and value. */
  if (/\/cart\/?$/.test(location.pathname)) {
    fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        var items = (cart.items || []).map(function (li) {
          return {
            item_id: String(li.sku || li.variant_id || li.product_id || ''),
            item_name: String(li.product_title || li.title || ''),
            item_brand: 'Morpaankh',
            quantity: li.quantity,
            price: (li.final_price || li.price || 0) / 100
          };
        });
        track('view_cart', { currency: cart.currency || 'INR', value: (cart.total_price || 0) / 100, items: items });
      })
      .catch(function () { /* analytics must never break the store */ });
  }

  /* apply_coupon — shopper tapped Apply on a cart offer card. The checkout
     pixel also reports the coupon on begin_checkout and purchase; this is the
     in-cart, storefront-side signal that a code was chosen. */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var applyBtn = e.target.closest('[data-tapi-offer-apply]');
    if (applyBtn) track('apply_coupon', { coupon: applyBtn.getAttribute('data-code') || '' });
  }, true);

  /* Announcement (promotion) clicks.
     NOTE: begin_checkout intentionally NOT tracked here — the Customer Events
     custom pixel ("GA4 Checkout") owns all checkout-funnel events
     (begin_checkout, add_shipping_info, add_payment_info, purchase) because it
     fires on actual checkout pages, which theme JS cannot see. Keeping it in
     one place prevents double counting. */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
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

  /* --------------------------------------------------------------------
   * Engagement — which products get explored, which buttons get pressed.
   * GA4 + GTM only (Meta owns the standard funnel events above). Everything
   * is delegated on document, so cards/buttons injected after load (related
   * products, wishlist page, theme-editor re-renders) are covered with no
   * re-wiring. Product data on cards is read from the wishlist button they
   * already carry, so this needs zero extra Liquid per card.
   * ------------------------------------------------------------------ */
  function toNumber(money) { return Number(String(money || '').replace(/[^0-9.]/g, '')) || 0; }
  function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }

  // Name a product list by its section's <h2> (card titles are <h3>, so they
  // are never mistaken for the list name); fall back to the section id.
  function listNameFor(el) {
    var sec = el.closest('.shopify-section, [data-recently-viewed], product-recommendations') || el;
    var h = sec.querySelector('h2, h1, .tapi-rv__heading');
    return txt(h).slice(0, 80) || sec.id || 'product_list';
  }
  function listContainerOf(card) {
    return card.closest('ul, ol, .tapi-grid, [data-recently-grid], [data-wishlist-grid], product-recommendations, .tapi-collection') || card.parentElement;
  }
  // The product a card represents — from its wishlist button when present,
  // else from the visible title/price (client-rendered mini cards have no heart).
  function itemFromCard(card, index, listName) {
    var w = card.querySelector('[data-wishlist-toggle]');
    var item = {
      item_id: w ? (w.getAttribute('data-product-id') || w.getAttribute('data-handle') || '') : '',
      item_name: (w && w.getAttribute('data-title')) || txt(card.querySelector('.tapi-card__title')),
      item_brand: 'Morpaankh',
      price: w ? toNumber(w.getAttribute('data-price')) : toNumber(txt(card.querySelector('.tapi-card__price-now')))
    };
    if (listName) item.item_list_name = listName;
    if (index != null && index >= 0) item.index = index + 1;
    return item;
  }

  // select_item — a shopper clicked into a product from a grid or rail.
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var card = e.target.closest('.tapi-card');
    if (!card) return;
    if (!e.target.closest('a[href]')) return; // heart / non-navigational control
    var listName = listNameFor(card);
    var container = listContainerOf(card);
    var cards = container ? container.querySelectorAll('.tapi-card') : [card];
    var index = Array.prototype.indexOf.call(cards, card);
    track('select_item', { item_list_name: listName, items: [itemFromCard(card, index, listName)] });
  }, true);

  // view_item_list — one impression per grid the first time it is on screen,
  // so select_item clicks read as a click-through rate per list and position.
  var listIO;
  function observeLists() {
    if (!('IntersectionObserver' in window)) return;
    if (!listIO) {
      listIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          listIO.unobserve(en.target);
          var cards = en.target.querySelectorAll('.tapi-card');
          if (!cards.length) return;
          var name = listNameFor(en.target);
          var items = [];
          for (var i = 0; i < cards.length && i < 20; i++) items.push(itemFromCard(cards[i], i, name));
          track('view_item_list', { item_list_name: name, items: items });
        });
      }, { threshold: 0.2 });
    }
    var seen = [];
    document.querySelectorAll('.tapi-card').forEach(function (card) {
      var c = listContainerOf(card);
      if (!c || c.__tapiListObserved || seen.indexOf(c) !== -1) return;
      seen.push(c);
      c.__tapiListObserved = true;
      listIO.observe(c);
    });
  }
  observeLists();
  document.addEventListener('shopify:section:load', function () { observeLists(); });
  setTimeout(observeLists, 2500); // catch async product-recommendations

  // Button engagement — size/colour chosen, gallery zoom, share, size guide,
  // plus a generic data-tapi-track opt-in for any future control.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest) return;
    var pname = (ld && ld.name) || document.title || '';

    var generic = t.closest('[data-tapi-track]');
    if (generic) {
      var params = {};
      for (var i = 0; i < generic.attributes.length; i++) {
        var a = generic.attributes[i];
        if (a.name.indexOf('data-tapi-p-') === 0) params[a.name.slice(12).replace(/-/g, '_')] = a.value;
      }
      track(generic.getAttribute('data-tapi-track'), params);
    }

    var size = t.closest('.tapi-pdp__size');
    if (size && !size.classList.contains('is-out')) {
      track('select_size', { item_name: pname, size: (size.getAttribute('data-size') || txt(size)) });
    }
    var color = t.closest('.tapi-pdp__color');
    if (color) track('select_color', { item_name: pname, color: color.getAttribute('data-color') || '' });
    if (t.closest('[data-gallery-zoom]')) track('view_gallery_fullscreen', { item_name: pname });
    if (t.closest('[data-share-trigger]')) track('share', { method: navigator.share ? 'native' : 'popover', content_type: 'product', item_name: pname });
    if (t.closest('[data-size-guide-open]')) track('open_size_guide', { item_name: pname });
  }, true);
})();