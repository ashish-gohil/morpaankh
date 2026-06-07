/*
 * tapi-ux.js — commerce-UX engine for the MorPaankh storefront.
 * One deferred, idempotent module that powers:
 *   - Wishlist (localStorage store + heart buttons + live counts + wishlist page)
 *   - Recently viewed (track on PDP, render rails on PDP + home)
 *   - Share (Web Share API native sheet + branded fallback popover)
 * Add-to-cart reuses Dawn's native <cart-notification> + /cart/add (no rebuild).
 * Persistence is behind a small store adapter so a future server/metafield sync
 * can drop in without touching the UI layer.
 */
(function () {
  if (window.__tapiUX) return;
  window.__tapiUX = true;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----------------------------------------------------------------------
   * Store adapter — localStorage with pub/sub + cross-tab sync.
   * -------------------------------------------------------------------- */
  function makeStore(key, cap) {
    var subs = [];
    function read() {
      try { return JSON.parse(localStorage.getItem(key) || '[]') || []; }
      catch (e) { return []; }
    }
    function write(arr) {
      try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
      emit(arr);
    }
    function emit(arr) { subs.forEach(function (fn) { try { fn(arr); } catch (e) {} }); }
    window.addEventListener('storage', function (e) { if (e.key === key) emit(read()); });
    return {
      key: key,
      all: read,
      has: function (handle) { return read().some(function (i) { return i.handle === handle; }); },
      add: function (item) {
        var a = read().filter(function (i) { return i.handle !== item.handle; });
        a.unshift(item);
        if (cap) a = a.slice(0, cap);
        write(a);
        return a;
      },
      remove: function (handle) { write(read().filter(function (i) { return i.handle !== handle; })); },
      toggle: function (item) {
        if (this.has(item.handle)) { this.remove(item.handle); return false; }
        this.add(item); return true;
      },
      subscribe: function (fn) { subs.push(fn); fn(read()); return function () { subs = subs.filter(function (s) { return s !== fn; }); }; }
    };
  }

  var Wishlist = makeStore('tapi:wishlist', 0);    // no cap
  var Recently = makeStore('tapi:recently', 12);   // most-recent 12
  window.TapiWishlist = Wishlist;
  window.TapiRecently = Recently;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function attrItem(el) {
    return {
      handle: el.getAttribute('data-handle'),
      id: el.getAttribute('data-product-id') || '',
      variantId: el.getAttribute('data-variant-id') || '',
      variantCount: parseInt(el.getAttribute('data-variant-count') || '1', 10) || 1,
      title: el.getAttribute('data-title') || '',
      url: el.getAttribute('data-url') || '',
      image: el.getAttribute('data-image') || '',
      price: el.getAttribute('data-price') || '',
      compareAt: el.getAttribute('data-compare') || '',
      addedAt: Date.now()
    };
  }

  /* ----------------------------------------------------------------------
   * Wishlist hearts.
   * -------------------------------------------------------------------- */
  // Write only when a value actually changes. Redundant writes (esp. textContent)
  // are real DOM mutations — if a heart sits inside a watched MutationObserver
  // subtree, a no-op repaint would still re-trigger the observer and can spin into
  // an infinite loop. Guarding every write makes repaint idempotent and cheap.
  function paintHeart(btn, saved) {
    if (btn.classList.contains('is-saved') !== saved) btn.classList.toggle('is-saved', saved);
    if ((btn.getAttribute('aria-pressed') === 'true') !== saved) btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    var on = btn.getAttribute('data-label-on') || 'Saved';
    var off = btn.getAttribute('data-label-off') || 'Save';
    var txt = btn.querySelector('[data-wishlist-text]');
    if (txt) { var nt = saved ? on : off; if (txt.textContent !== nt) txt.textContent = nt; }
    var sr = btn.querySelector('[data-wishlist-sr]');
    if (sr) { var ns = saved ? (on + ', remove from wishlist') : (off + ' to wishlist'); if (sr.textContent !== ns) sr.textContent = ns; }
  }
  // Paint initial saved-state onto any hearts in `root`. Used at boot and after
  // async card injection (related products) — clicks are handled by delegation,
  // so newly added hearts work without per-element wiring.
  function paintHearts(root) {
    (root || document).querySelectorAll('[data-wishlist-toggle]').forEach(function (btn) {
      paintHeart(btn, Wishlist.has(btn.getAttribute('data-handle')));
    });
  }
  // One delegated click handler covers every heart on the page — including cards
  // injected later by Dawn's <product-recommendations> ("You may also like"),
  // which fetches its HTML after load and does NOT fire shopify:section:load.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-wishlist-toggle]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var saved = Wishlist.toggle(attrItem(btn));
    paintHeart(btn, saved);
    if (saved && !reduceMotion) { btn.classList.remove('tapi-pop'); void btn.offsetWidth; btn.classList.add('tapi-pop'); }
  });
  // Repaint hearts as soon as product-recommendations swaps in its cards.
  // IMPORTANT: observe ONLY direct children (no subtree). Dawn injects the cards
  // via `this.innerHTML = ...` (a direct-child mutation), so childList alone
  // catches it. Watching the subtree would also catch paintHeart's own deep
  // textContent writes and re-fire endlessly — a self-retriggering loop that
  // freezes the page. paintHeart is also guarded above, so this is belt + braces.
  function observeRecommendations() {
    document.querySelectorAll('product-recommendations').forEach(function (pr) {
      if (pr.__tapiObserved) return;
      pr.__tapiObserved = true;
      new MutationObserver(function () { paintHearts(pr); }).observe(pr, { childList: true });
    });
  }
  // Keep every heart + every count in sync whenever the store changes.
  Wishlist.subscribe(function (arr) {
    var set = {};
    arr.forEach(function (i) { set[i.handle] = 1; });
    document.querySelectorAll('[data-wishlist-toggle]').forEach(function (btn) {
      paintHeart(btn, !!set[btn.getAttribute('data-handle')]);
    });
    var n = arr.length;
    document.querySelectorAll('[data-wishlist-count]').forEach(function (el) {
      el.textContent = n;
      el.toggleAttribute('hidden', n === 0);
    });
    renderWishlistPage();
  });

  /* ----------------------------------------------------------------------
   * Cart counts (bottom nav) — refreshed natively from /cart.js.
   * -------------------------------------------------------------------- */
  function refreshCartCounts() {
    fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (c) {
        var n = c.item_count || 0;
        document.querySelectorAll('[data-cart-count]').forEach(function (el) {
          el.textContent = n;
          el.toggleAttribute('hidden', n === 0);
        });
      })
      .catch(function () {});
  }

  /* ----------------------------------------------------------------------
   * Add to cart — reuses Dawn's <cart-notification> (native flow + UI).
   * -------------------------------------------------------------------- */
  function addToCart(variantId, btn) {
    if (!variantId) return;
    var notif = document.querySelector('cart-notification');
    var body = { items: [{ id: Number(variantId), quantity: 1 }] };
    if (notif && notif.getSectionsToRender) {
      body.sections = notif.getSectionsToRender().map(function (s) { return s.id; });
      body.sections_url = window.location.pathname;
    }
    if (btn) { btn.classList.add('is-loading'); btn.disabled = true; }
    fetch((window.routes && window.routes.cart_add_url) || '/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/javascript' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (btn) { btn.classList.remove('is-loading'); btn.disabled = false; }
        if (res && res.status) { return; } // error payload
        if (notif && notif.renderContents) { try { notif.renderContents(res); } catch (e) {} }
        refreshCartCounts();
        if (btn) {
          btn.classList.add('is-added');
          var prev = btn.getAttribute('data-label') || btn.textContent;
          btn.textContent = 'Added';
          setTimeout(function () { btn.classList.remove('is-added'); btn.textContent = prev; }, 1600);
        }
      })
      .catch(function () { if (btn) { btn.classList.remove('is-loading'); btn.disabled = false; } });
  }

  /* ----------------------------------------------------------------------
   * Card markup (shared by recently-viewed + wishlist page).
   * -------------------------------------------------------------------- */
  function cardHTML(item, opts) {
    opts = opts || {};
    var was = item.compareAt && item.compareAt !== item.price
      ? '<span class="tapi-card__price-was">' + esc(item.compareAt) + '</span>' : '';
    var img = item.image
      ? '<img src="' + esc(item.image) + '" alt="' + esc(item.title) + '" loading="lazy">'
      : '';
    var remove = opts.remove
      ? '<button type="button" class="tapi-wl__remove" data-wl-remove="' + esc(item.handle) + '" aria-label="Remove ' + esc(item.title) + ' from wishlist">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' : '';
    var action = '';
    if (opts.actions) {
      action = item.variantCount > 1
        ? '<a class="button button--outline tapi-wl__action" href="' + esc(item.url) + '">Select options</a>'
        : '<button type="button" class="button button--primary tapi-wl__action" data-wl-add="' + esc(item.variantId) + '" data-label="Add to bag">Add to bag</button>';
    }
    return '' +
      '<article class="tapi-card tapi-card--mini">' +
        remove +
        '<a class="tapi-card__media" href="' + esc(item.url) + '" aria-label="' + esc(item.title) + '">' +
          '<div class="tapi-card__img tapi-card__img--front">' + img + '</div>' +
        '</a>' +
        '<div class="tapi-card__info">' +
          '<div class="tapi-card__row">' +
            '<h3 class="tapi-card__title"><a href="' + esc(item.url) + '">' + esc(item.title) + '</a></h3>' +
            '<div class="tapi-card__price"><span class="tapi-card__price-now">' + esc(item.price) + '</span>' + was + '</div>' +
          '</div>' +
          (action ? '<div class="tapi-card__actions">' + action + '</div>' : '') +
        '</div>' +
      '</article>';
  }

  /* ----------------------------------------------------------------------
   * Recently viewed — track (PDP) + render rails (PDP + home).
   * -------------------------------------------------------------------- */
  function trackRecentlyViewed() {
    var node = document.querySelector('[data-tapi-track-product]');
    if (!node) return;
    var data;
    try { data = JSON.parse(node.textContent); } catch (e) { return; }
    if (!data || !data.handle) return;
    Recently.add({
      handle: data.handle, id: data.id || '', variantId: data.variantId || '', variantCount: data.variantCount || 1,
      title: data.title || '', url: data.url || '', image: data.image || '',
      price: data.price || '', compareAt: data.compareAt || '', addedAt: Date.now()
    });
  }
  function renderRecentlyViewed(root) {
    (root || document).querySelectorAll('[data-recently-viewed]').forEach(function (sec) {
      var grid = sec.querySelector('[data-recently-grid]');
      if (!grid) return;
      var exclude = sec.getAttribute('data-exclude') || '';
      var limit = parseInt(sec.getAttribute('data-limit') || '8', 10) || 8;
      var items = Recently.all().filter(function (i) { return i.handle && i.handle !== exclude; }).slice(0, limit);
      if (!items.length) { sec.hidden = true; return; }
      grid.innerHTML = items.map(function (i) { return '<li class="tapi-rv__item">' + cardHTML(i, {}) + '</li>'; }).join('');
      sec.hidden = false;
    });
  }

  /* ----------------------------------------------------------------------
   * Wishlist page render.
   * -------------------------------------------------------------------- */
  function renderWishlistPage() {
    var page = document.querySelector('[data-wishlist-page]');
    if (!page) return;
    var grid = page.querySelector('[data-wishlist-grid]');
    var empty = page.querySelector('[data-wishlist-empty]');
    var countEl = page.querySelector('[data-wishlist-page-count]');
    var items = Wishlist.all();
    if (countEl) countEl.textContent = items.length ? ('(' + items.length + ')') : '';
    if (!items.length) {
      if (grid) { grid.innerHTML = ''; grid.hidden = true; }
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    if (grid) {
      grid.hidden = false;
      grid.innerHTML = items.map(function (i) { return '<li class="tapi-wl__item">' + cardHTML(i, { remove: true, actions: true }) + '</li>'; }).join('');
    }
  }
  function wireWishlistPage() {
    var page = document.querySelector('[data-wishlist-page]');
    if (!page || page.__wired) return;
    page.__wired = true;
    page.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-wl-remove]');
      if (rm) { e.preventDefault(); Wishlist.remove(rm.getAttribute('data-wl-remove')); return; }
      var add = e.target.closest('[data-wl-add]');
      if (add) { e.preventDefault(); addToCart(add.getAttribute('data-wl-add'), add); }
    });
  }

  /* ----------------------------------------------------------------------
   * Share — native Web Share API + branded fallback popover.
   * -------------------------------------------------------------------- */
  function wireShare(root) {
    (root || document).querySelectorAll('[data-tapi-share]').forEach(function (host) {
      if (host.__wired) return;
      host.__wired = true;
      var trigger = host.querySelector('[data-share-trigger]');
      var popover = host.querySelector('[data-share-popover]');
      var url = host.getAttribute('data-url') || window.location.href;
      var title = host.getAttribute('data-title') || document.title;
      var text = host.getAttribute('data-text') || title;
      if (!trigger) return;

      function openPopover() { if (popover) { popover.hidden = false; host.classList.add('is-open'); trigger.setAttribute('aria-expanded', 'true'); } }
      function closePopover() { if (popover) { popover.hidden = true; host.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false'); } }

      trigger.addEventListener('click', function (e) {
        e.preventDefault();
        if (navigator.share) {
          navigator.share({ title: title, text: text, url: url }).catch(function () {});
        } else {
          host.classList.contains('is-open') ? closePopover() : openPopover();
        }
      });

      if (popover) {
        var copyBtn = popover.querySelector('[data-share-copy]');
        if (copyBtn) {
          copyBtn.addEventListener('click', function () {
            var done = function () {
              copyBtn.classList.add('is-copied');
              var t = copyBtn.querySelector('[data-copy-label]');
              if (t) { var prev = t.textContent; t.textContent = 'Copied'; setTimeout(function () { t.textContent = prev; copyBtn.classList.remove('is-copied'); }, 1600); }
            };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(done);
            else { var i = popover.querySelector('input'); if (i) { i.select(); try { document.execCommand('copy'); } catch (e) {} } done(); }
          });
        }
        document.addEventListener('click', function (e) { if (host.classList.contains('is-open') && !host.contains(e.target)) closePopover(); });
        host.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePopover(); });
      }
    });
  }

  /* ----------------------------------------------------------------------
   * Bottom-nav search — reuse Dawn's header search modal (fallback: /search).
   * -------------------------------------------------------------------- */
  function wireBottomNavSearch() {
    var s = document.querySelector('[data-botnav-search]');
    if (!s || s.__wired) return;
    s.__wired = true;
    s.addEventListener('click', function (e) {
      var summary = document.querySelector('details-modal.header__search summary, .header__search summary');
      if (!summary) return; // no header search on this page — let the link go to /search
      e.preventDefault();
      // Defer opening to the next tick: clicking the summary opens Dawn's modal,
      // which attaches an outside-click listener on <body>. If we open synchronously,
      // THIS in-flight click then bubbles to body and is treated as an outside click,
      // closing the modal instantly ("does nothing"). Letting the current click
      // finish first avoids that race.
      setTimeout(function () { summary.click(); }, 0);
    });
  }

  /* ----------------------------------------------------------------------
   * Boot.
   * -------------------------------------------------------------------- */
  function boot(root) {
    paintHearts(root);
    observeRecommendations();
    renderRecentlyViewed(root);
    wireWishlistPage();
    renderWishlistPage();
    wireShare(root);
    wireBottomNavSearch();
  }

  function start() {
    trackRecentlyViewed();   // record this PDP view once
    refreshCartCounts();     // sync bottom-nav cart bubble
    boot(document);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  document.addEventListener('shopify:section:load', function (e) { boot(e.target); });
})();
