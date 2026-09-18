/* ============================================================
   Morpaankh — story-style shoppable video player.
   Drives snippets/tapi-story-player.liquid. Opened by any
   [data-story-tile] inside a [data-story-scope] (the Watch & Buy
   rail, the PDP video bubble). Self-contained: builds the playlist
   from the scope's tiles, runs the story UI, and adds to cart
   through Dawn's native <cart-notification>.
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function parseJSON(s, fallback) { try { return JSON.parse(s); } catch (e) { return fallback; } }

  // Bandwidth tier from the Network Information API (where supported).
  //   'save' = Data Saver / 2g, 'lite' = 3g, 'full' = 4g / unknown.
  function netTier() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return 'full';
    if (c.saveData) return 'save';
    var t = c.effectiveType || '';
    if (t === 'slow-2g' || t === '2g') return 'save';
    if (t === '3g') return 'lite';
    return 'full';
  }

  function nativeHls(video) {
    return !!(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL'));
  }

  // Decide the playback source for THIS device + connection from the tile's
  // rendition list. HLS (m3u8) is adaptive bitrate — the stream auto-matches the
  // viewer's bandwidth — so prefer it whenever it can play (natively on
  // Safari/iOS, or via lazy-loaded hls.js elsewhere). On Save-Data force the
  // lightest concrete mp4 and skip adaptive probing. Returns { url, hls } where
  // hls:true means "needs hls.js attached". Falls back to the inline mp4.
  function choosePlayback(video, item) {
    var srcs = (item.sources || []).filter(function (s) { return s && s.u; });
    var tier = netTier();
    var m3u8 = srcs.filter(function (s) { return s.f === 'm3u8'; })[0];
    var mp4 = srcs.filter(function (s) { return s.f === 'mp4'; }).sort(function (a, b) { return (a.h || 0) - (b.h || 0); });
    if (tier === 'save') { return { url: (mp4[0] || {}).u || item.video, hls: false }; }
    if (m3u8) {
      if (nativeHls(video)) return { url: m3u8.u, hls: false };
      // No native HLS: use hls.js if this browser can (assume yes until the lib
      // loads and tells us otherwise; the loader falls back to mp4 if not).
      if (!window.Hls || window.Hls.isSupported()) return { url: m3u8.u, hls: true };
    }
    if (!mp4.length) return { url: item.video, hls: false };
    if (tier === 'lite') {
      var lite = mp4.filter(function (s) { return (s.h || 0) <= 720; });
      return { url: (lite[lite.length - 1] || mp4[0]).u, hls: false };
    }
    return { url: mp4[mp4.length - 1].u, hls: false };
  }

  // Best mp4 for the tier — the graceful fallback when hls.js can't run.
  function fallbackMp4(item) {
    var mp4 = (item.sources || []).filter(function (s) { return s && s.u && s.f === 'mp4'; })
      .sort(function (a, b) { return (a.h || 0) - (b.h || 0); });
    if (!mp4.length) return item.video;
    var tier = netTier();
    if (tier === 'full') return mp4[mp4.length - 1].u;
    var lite = mp4.filter(function (s) { return (s.h || 0) <= 720; });
    return (lite[lite.length - 1] || mp4[0]).u;
  }

  // Lazy-load the vendored hls.js (only when a browser without native HLS opens
  // the player). Loaded once, cached; resolves with window.Hls or null on failure.
  var hlsLibPromise = null;
  function loadHlsLib(src) {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!src) return Promise.resolve(null);
    if (hlsLibPromise) return hlsLibPromise;
    hlsLibPromise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(window.Hls || null); };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return hlsLibPromise;
  }

  function itemFromTile(tile) {
    return {
      video: tile.getAttribute('data-video') || '',
      sources: parseJSON(tile.getAttribute('data-sources'), []) || [],
      url: tile.getAttribute('data-url') || '',
      title: tile.getAttribute('data-title') || '',
      price: tile.getAttribute('data-price') || '',
      image: tile.getAttribute('data-image') || '',
      hasSize: tile.getAttribute('data-has-size') === 'true',
      variantCount: parseInt(tile.getAttribute('data-variant-count') || '0', 10) || 0,
      variants: parseJSON(tile.getAttribute('data-variants'), []) || []
    };
  }

  // Add to cart via Dawn's native cart-notification / cart-drawer (updates the
  // count bubble and shows the standard confirmation).
  function addToCart(variantId, btn) {
    if (!variantId) return;
    var notif = document.querySelector('cart-notification') || document.querySelector('cart-drawer');
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
        if (res && res.status) { return; }
        if (notif && notif.renderContents) { try { notif.renderContents(res); } catch (e) {} }
        // Keep the cart page + counts in sync when added from this overlay.
        if (window.location.pathname.indexOf('/cart') !== -1) { window.location.reload(); return; }
        fetch('/cart.js', { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (c) {
            var n = c.item_count || 0;
            document.querySelectorAll('[data-cart-count]').forEach(function (el) { el.textContent = n; el.toggleAttribute('hidden', n === 0); });
          }).catch(function () {});
        if (btn) {
          btn.classList.add('is-added');
          var prev = btn.getAttribute('data-label') || 'Add to cart';
          btn.textContent = 'Added';
          setTimeout(function () { btn.classList.remove('is-added'); btn.textContent = prev; }, 1600);
        }
      })
      .catch(function () { if (btn) { btn.classList.remove('is-loading'); btn.disabled = false; } });
  }

  var FOCUSABLE = 'button, a[href], [tabindex]:not([tabindex="-1"])';

  function Player(el) {
    this.el = el;
    this.video = el.querySelector('[data-story-video]');
    this.bars = el.querySelector('[data-story-bars]');
    this.titleEl = el.querySelector('[data-story-title]');
    this.priceEl = el.querySelector('[data-story-price]');
    this.imgEl = el.querySelector('[data-story-img]');
    this.sizesEl = el.querySelector('[data-story-sizes]');
    this.atc = el.querySelector('[data-story-atc]');
    this.closeBtn = el.querySelector('[data-story-close]');
    this.muteBtn = el.querySelector('[data-story-mute]');
    this.icMuted = el.querySelector('.tapi-story__ic-muted');
    this.icSound = el.querySelector('.tapi-story__ic-sound');
    this.links = el.querySelectorAll('[data-story-link]');
    this.items = [];
    this.index = 0;
    this.pending = null;
    this.muted = false;
    this.lastFocus = null;
    this.hlsSrc = el.getAttribute('data-hls-src') || '';
    this.hls = null;      // active hls.js instance, when used
    this._loadToken = 0;  // guards against a slow async attach landing on a stale clip
    this._bind();
  }

  Player.prototype._bind = function () {
    var self = this;
    this.el.querySelectorAll('[data-story-close]').forEach(function (b) {
      b.addEventListener('click', function () { self.close(); });
    });
    this.el.querySelector('[data-story-prev]').addEventListener('click', function () { self.prev(); });
    this.el.querySelector('[data-story-next]').addEventListener('click', function () { self.next(); });
    this.muteBtn.addEventListener('click', function () { self.setMuted(!self.muted); });
    this.atc.addEventListener('click', function () { if (self.pending) addToCart(self.pending, self.atc); });

    // Tap the video (center) to pause/resume.
    this.video.addEventListener('click', function () {
      if (self.video.paused) { self.video.play(); } else { self.video.pause(); }
    });
    // Auto-advance when a clip ends; track progress on the active bar.
    this.video.addEventListener('ended', function () { self.next(); });
    this.video.addEventListener('timeupdate', function () {
      var bar = self.bars.children[self.index];
      if (!bar) return;
      var fill = bar.querySelector('.tapi-story__bar-fill');
      var d = self.video.duration;
      if (fill && d && isFinite(d)) fill.style.width = Math.min(100, (self.video.currentTime / d) * 100) + '%';
    });

    // Keyboard: Esc close, arrows navigate, Tab trap.
    this.el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); self.close(); }
      else if (e.key === 'ArrowRight') { self.next(); }
      else if (e.key === 'ArrowLeft') { self.prev(); }
      else if (e.key === 'Tab') { self._trap(e); }
    });

    // Swipe: left/right = prev/next, down = close.
    var sx = 0, sy = 0;
    this.el.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
    }, { passive: true });
    this.el.addEventListener('touchend', function (e) {
      if (!e.changedTouches || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) && dy > 0) { self.close(); return; }
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) self.next(); else self.prev(); }
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && self.isOpen()) { try { self.video.pause(); } catch (x) {} }
      else if (self.isOpen()) { self.video.play().catch(function () {}); }
    });
  };

  Player.prototype.isOpen = function () { return this.el.classList.contains('is-open'); };

  Player.prototype._trap = function (e) {
    var f = Array.prototype.filter.call(this.el.querySelectorAll(FOCUSABLE), function (n) {
      return n.offsetParent !== null && !n.disabled;
    });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  Player.prototype.open = function (items, start) {
    this.items = items;
    this.index = Math.max(0, Math.min(start || 0, items.length - 1));
    this.lastFocus = document.activeElement;
    this.el.hidden = false;
    this.el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('tapi-story-lock');
    this._buildBars();
    var self = this;
    requestAnimationFrame(function () {
      self.el.classList.add('is-open');
      self.load(self.index);
      if (self.closeBtn) self.closeBtn.focus();
    });
  };

  Player.prototype.close = function () {
    this.el.classList.remove('is-open');
    this.el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('tapi-story-lock');
    this._loadToken++;      // invalidate any in-flight hls.js attach
    this._detachHls();
    try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch (e) {}
    var el = this.el, focus = this.lastFocus;
    setTimeout(function () { el.hidden = true; if (focus && focus.focus) focus.focus(); }, 260);
  };

  Player.prototype._buildBars = function () {
    this.bars.innerHTML = '';
    for (var i = 0; i < this.items.length; i++) {
      var bar = document.createElement('div');
      bar.className = 'tapi-story__bar';
      bar.innerHTML = '<span class="tapi-story__bar-fill"></span>';
      this.bars.appendChild(bar);
    }
  };

  // Toggle the SVG icons via the content attribute (NOT the .hidden
  // property — SVGElement doesn't reflect .hidden to the attribute, so the
  // `svg[hidden]` CSS never fires and the icon looks stuck).
  Player.prototype._syncMute = function () {
    if (this.icMuted) this.icMuted.toggleAttribute('hidden', !this.muted);
    if (this.icSound) this.icSound.toggleAttribute('hidden', this.muted);
    if (this.muteBtn) this.muteBtn.setAttribute('aria-label', this.muted ? 'Unmute' : 'Mute');
  };

  Player.prototype.setMuted = function (m) {
    this.muted = m;
    this.video.muted = m;
    this._syncMute();
    if (!m) { this.video.play().catch(function () {}); }
  };

  Player.prototype._detachHls = function () {
    if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
  };

  Player.prototype._playVideo = function () {
    var self = this;
    var pp = this.video.play();
    if (pp && pp.catch) { pp.catch(function () { if (!self.muted) self.setMuted(true); }); }
  };

  // Attach the chosen source, wiring up hls.js when adaptive HLS is needed and
  // this browser has no native HLS. A monotonic token ensures a slow async attach
  // that finishes after the viewer has already swiped to another clip is dropped.
  Player.prototype._setSource = function (item) {
    var self = this;
    var token = ++this._loadToken;
    this._detachHls();
    this.video.removeAttribute('src');
    try { this.video.currentTime = 0; } catch (e) {}
    var choice = choosePlayback(this.video, item);
    if (!choice.hls) {
      this.video.src = choice.url;
      this.video.load();
      this._playVideo();
      return;
    }
    loadHlsLib(this.hlsSrc).then(function (Hls) {
      if (token !== self._loadToken) return;                 // viewer already moved on
      if (Hls && Hls.isSupported()) {
        self.hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 20 });
        self.hls.loadSource(choice.url);
        self.hls.attachMedia(self.video);
        self.hls.on(Hls.Events.MANIFEST_PARSED, function () { if (token === self._loadToken) self._playVideo(); });
        self.hls.on(Hls.Events.ERROR, function (evt, data) {
          if (data && data.fatal && token === self._loadToken) {
            self._detachHls();
            self.video.src = fallbackMp4(item);
            self.video.load();
            self._playVideo();
          }
        });
      } else {
        self.video.src = fallbackMp4(item);
        self.video.load();
        self._playVideo();
      }
    });
  };

  Player.prototype.load = function (i) {
    if (i < 0) { return; }
    if (i >= this.items.length) { this.close(); return; }
    this.index = i;
    var item = this.items[i];

    // Bars: past = done, current resets, future = empty.
    for (var b = 0; b < this.bars.children.length; b++) {
      var bar = this.bars.children[b];
      var fill = bar.querySelector('.tapi-story__bar-fill');
      bar.classList.toggle('tapi-story__bar--done', b < i);
      if (b !== i) { if (fill) fill.style.width = b < i ? '100%' : '0'; }
      else if (fill) fill.style.width = '0';
    }

    // Video. Default is unmuted; if the browser blocks sound-autoplay,
    // fall back to muted so the clip still plays (and flip the icon).
    this.video.muted = this.muted;
    this._syncMute();
    // Show the product image while the clip buffers so the stage never flashes
    // black; the first video frame paints over it.
    if (item.image) { this.video.poster = item.image; } else { this.video.removeAttribute('poster'); }
    this._setSource(item);

    // Card.
    this.titleEl.textContent = item.title;
    this.priceEl.textContent = item.price;
    if (this.imgEl) { if (item.image) { this.imgEl.src = item.image; this.imgEl.alt = item.title; } else { this.imgEl.removeAttribute('src'); } }
    Array.prototype.forEach.call(this.links, function (a) { if (item.url) a.setAttribute('href', item.url); });

    this._buildSizes(item);
  };

  Player.prototype._buildSizes = function (item) {
    var self = this;
    this.sizesEl.innerHTML = '';
    this.pending = null;
    this.atc.disabled = true;
    this.atc.textContent = this.atc.getAttribute('data-label') || 'Add to cart';

    var variants = item.variants || [];
    if (!variants.length) { this.atc.disabled = true; return; }

    // No size dimension (single variant, or colour-only): add the first
    // available variant directly, no chips.
    if (!item.hasSize) {
      var firstAvail = variants.filter(function (v) { return v.a; })[0] || variants[0];
      if (firstAvail) { this.pending = firstAvail.id; this.atc.disabled = false; }
      return;
    }

    // Size chips: one per unique size, in variant order. A size is buyable if
    // any variant of that size is available; picking it resolves to the first
    // available variant of that size.
    var order = [], bySize = {};
    variants.forEach(function (v) {
      var s = v.size == null ? '' : String(v.size);
      if (!(s in bySize)) { bySize[s] = []; order.push(s); }
      bySize[s].push(v);
    });

    order.forEach(function (s) {
      var group = bySize[s];
      var avail = group.filter(function (v) { return v.a; })[0];
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tapi-story__size';
      chip.textContent = s;
      if (!avail) { chip.disabled = true; chip.setAttribute('aria-label', s + ' sold out'); }
      else {
        chip.addEventListener('click', function () {
          self.sizesEl.querySelectorAll('.tapi-story__size').forEach(function (c) { c.classList.remove('is-active'); });
          chip.classList.add('is-active');
          self.pending = avail.id;
          self.atc.disabled = false;
        });
      }
      self.sizesEl.appendChild(chip);
    });

    // Preselect the first in-stock size so Add to cart is usable right away.
    var firstChip = self.sizesEl.querySelector('.tapi-story__size:not([disabled])');
    if (firstChip) firstChip.click();
  };

  Player.prototype.next = function () { this.load(this.index + 1); };
  Player.prototype.prev = function () { this.load(Math.max(0, this.index - 1)); };

  function playerFor(el) {
    if (!el.__tapiPlayer) el.__tapiPlayer = new Player(el);
    return el.__tapiPlayer;
  }

  // Delegated open: any [data-story-tile] click opens its scope's player at the
  // tile's index within that scope.
  function onTileClick(e) {
    var tile = e.target.closest('[data-story-tile]');
    if (!tile) return;
    var scope = tile.closest('[data-story-scope]');
    if (!scope) return;
    var playerEl = scope.querySelector('[data-story]');
    if (!playerEl) return;
    e.preventDefault();
    var tiles = Array.prototype.slice.call(scope.querySelectorAll('[data-story-tile]'));
    var items = tiles.map(itemFromTile).filter(function (it) { return it.video; });
    var start = tiles.indexOf(tile);
    // Map the clicked tile to its position within the playable (video) subset.
    var playableStart = tiles.slice(0, start + 1).filter(function (t) { return t.getAttribute('data-video'); }).length - 1;
    if (!items.length) return;
    playerFor(playerEl).open(items, Math.max(0, playableStart));
  }

  function boot() {
    if (!document.__tapiStoryWired) {
      document.__tapiStoryWired = true;
      document.addEventListener('click', onTileClick);
    }
    // Wire PDP bubble previews (muted loop) if present.
    document.querySelectorAll('[data-vbubble-video]').forEach(function (v) {
      if (v.__wired) return; v.__wired = true;
      if (reduceMotion || netTier() === 'save') return;
      var src = v.getAttribute('data-src');
      if (src && !v.src) { v.src = src; v.muted = true; v.loop = true; v.playsInline = true; v.play().catch(function () {}); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  document.addEventListener('shopify:section:load', boot);
})();
