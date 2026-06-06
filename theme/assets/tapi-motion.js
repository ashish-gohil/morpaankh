(function () {
  if (window.__tapiMotion) return; window.__tapiMotion = true;

  // Respect reduced motion
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Reveal on scroll ----------
  // Any element with [data-tapi-reveal] fades + rises in once on first intersect.
  // Optional [data-tapi-delay="120"] (ms). Children-stagger via [data-tapi-stagger="100"] on parent.
  var revealCss = '[data-tapi-reveal]{opacity:0;transform:translate3d(0,24px,0);transition:opacity 720ms cubic-bezier(0.16,1,0.3,1),transform 720ms cubic-bezier(0.16,1,0.3,1);will-change:opacity,transform}[data-tapi-reveal].in{opacity:1;transform:translate3d(0,0,0)}';
  var st = document.createElement('style'); st.textContent = revealCss; document.head.appendChild(st);

  // Track section-scoped observers so we can disconnect on shopify:section:load
  // (avoids leaking IOs in the theme editor across reloads).
  var sectionObservers = new WeakMap();
  function registerObserver(root, io) {
    var list = sectionObservers.get(root) || [];
    list.push(io);
    sectionObservers.set(root, list);
  }
  function disconnectObservers(root) {
    var list = sectionObservers.get(root);
    if (!list) return;
    list.forEach(function (io) { try { io.disconnect(); } catch (_) {} });
    sectionObservers.delete(root);
  }

  function setupReveal(root) {
    if (reduce) {
      root.querySelectorAll('[data-tapi-reveal]').forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        var delay = parseInt(el.getAttribute('data-tapi-delay') || '0', 10);
        if (delay) el.style.transitionDelay = delay + 'ms,' + delay + 'ms';
        el.classList.add('in');
        io.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    registerObserver(root, io);

    // Apply stagger: any parent [data-tapi-stagger="100"] cascades delays to its direct children with [data-tapi-reveal]
    root.querySelectorAll('[data-tapi-stagger]').forEach(function (parent) {
      var step = parseInt(parent.getAttribute('data-tapi-stagger') || '100', 10);
      var children = parent.querySelectorAll(':scope > [data-tapi-reveal]');
      children.forEach(function (c, i) {
        if (!c.hasAttribute('data-tapi-delay')) c.setAttribute('data-tapi-delay', String(i * step));
      });
    });
    // Reveal anything already in the viewport synchronously — in the SAME task
    // as the opacity:0 injection — so above-the-fold content never flashes
    // hidden and then fades back in. It simply stays put: instant and premium,
    // and the visual paint stays stable (a big Speed Index win). Below-the-fold
    // elements are observed and animate in on scroll, which keeps it engaging.
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    root.querySelectorAll('[data-tapi-reveal]').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (vh && r.top < vh && r.bottom > 0) {
        el.classList.add('in');
      } else {
        io.observe(el);
      }
    });
  }

  // ---------- CountUp ----------
  // <span data-tapi-count-up="11"> or "120–180" or "₹2,499"
  function setupCountUp(root) {
    if (reduce) {
      root.querySelectorAll('[data-tapi-count-up]').forEach(function (el) {
        el.textContent = el.getAttribute('data-tapi-count-up');
      });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        var raw = el.getAttribute('data-tapi-count-up');
        var duration = parseInt(el.getAttribute('data-tapi-count-duration') || '1600', 10);
        var num = parseInt(String(raw).replace(/[^\d]/g, ''), 10) || 0;
        var prefix = (String(raw).match(/^[^\d]*/) || [''])[0];
        var tail = (String(raw).match(/[^\d]*$/) || [''])[0];
        var start = performance.now();
        function tick(t) {
          var elapsed = Math.min(1, (t - start) / duration);
          var eased = 1 - Math.pow(1 - elapsed, 3);
          var v = Math.round(num * eased);
          if (elapsed >= 1) {
            el.textContent = raw;
          } else {
            el.textContent = prefix + v.toLocaleString('en-IN') + tail;
            requestAnimationFrame(tick);
          }
        }
        requestAnimationFrame(tick);
        io.unobserve(el);
      });
    }, { threshold: 0.4 });
    registerObserver(root, io);
    root.querySelectorAll('[data-tapi-count-up]').forEach(function (el) {
      el.textContent = '0';
      io.observe(el);
    });
  }

  // ---------- Magnetic CTA ----------
  // rAF-throttled: mousemove fires per-pixel; we coalesce updates into one
  // transform write per frame so the GPU isn't asked to repaint 120×/sec.
  function setupMagnetic(root) {
    if (reduce) return;
    root.querySelectorAll('[data-tapi-magnetic]').forEach(function (el) {
      if (el.__tapiMagnetic) return; el.__tapiMagnetic = true;
      var strength = parseFloat(el.getAttribute('data-tapi-magnetic')) || 0.18;
      // Hard cap on travel so the button gives a subtle nudge toward the cursor
      // but can never drift past its own bounds (the "hover bleed" bug).
      var MAX_SHIFT = 6;
      var inner = el;
      inner.style.transition = 'transform 360ms cubic-bezier(0.22,1,0.36,1)';
      inner.style.willChange = 'transform';
      var pending = false;
      var lastX = 0, lastY = 0;
      function clamp(v) { return v < -MAX_SHIFT ? -MAX_SHIFT : (v > MAX_SHIFT ? MAX_SHIFT : v); }
      function apply() {
        pending = false;
        inner.style.transform = 'translate3d(' + lastX + 'px,' + lastY + 'px,0)';
      }
      // Listen on the element itself — not the parent container — so the pull
      // only engages while the pointer is over the button. Reacting to the
      // whole row is what let the cursor yank it far off-centre.
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        lastX = clamp((e.clientX - (r.left + r.width / 2)) * strength);
        lastY = clamp((e.clientY - (r.top + r.height / 2)) * strength);
        if (!pending) { pending = true; requestAnimationFrame(apply); }
      }, { passive: true });
      el.addEventListener('mouseleave', function () {
        lastX = 0; lastY = 0;
        if (!pending) { pending = true; requestAnimationFrame(apply); }
      });
    });
  }

  // ---------- PDP gallery navigation ----------
  // Wires thumbs / dots / prev-next buttons / keyboard arrows / touch swipe
  // for the Tapi PDP. Lives here (not in the section's {% javascript %})
  // because some Shopify deploys mis-cache section-bundled JS, and we'd
  // rather rely on a script tag we control from layout/theme.liquid.
  function setupPdpGallery(root) {
    var sec = (root && root.classList && root.classList.contains('tapi-pdp'))
      ? root
      : (root || document).querySelector('.tapi-pdp');
    if (!sec) return;
    if (sec.__tapiGalleryWired) return; // idempotent on editor re-render
    sec.__tapiGalleryWired = true;

    // Video playback (hosted + YouTube/Vimeo facade) is wired first, before the
    // single-media early-return below, so a product whose only media is a video
    // still gets a working play button.
    setupPdpVideo(sec);

    // Full-screen viewer (lightbox). Wired before the single-media early-return
    // so a one-image product can still be opened full screen + zoomed.
    setupPdpLightbox(sec);

    var thumbs = sec.querySelectorAll('.tapi-pdp__thumb');
    var mains  = sec.querySelectorAll('.tapi-pdp__main-img');
    var dots   = sec.querySelectorAll('[data-gallery-dots] .tapi-pdp__dot');
    var total  = mains.length || 1;
    if (total <= 1) return; // nothing to navigate

    function setActiveImage(idx) {
      var next = ((idx % total) + total) % total; // wrap both directions
      // Pause any clip that's playing before we hide its slide, and reset it
      // to the facade state (no native controls) so returning to the slide
      // shows only our branded button, never the native one stacked on top.
      sec.querySelectorAll('video[data-pdp-video]').forEach(function (v) {
        try { v.pause(); } catch (e) {}
        v.controls = false;
        var w = v.closest('[data-pdp-video-wrap]');
        if (w) w.classList.remove('is-playing');
      });
      thumbs.forEach(function (x) { x.classList.remove('is-active'); });
      mains.forEach(function (x) { x.classList.remove('is-active'); });
      dots.forEach(function (x) { x.classList.remove('is-active'); });
      var t = sec.querySelector('.tapi-pdp__thumb[data-thumb-index="' + next + '"]');
      var m = sec.querySelector('.tapi-pdp__main-img[data-main-index="' + next + '"]');
      var d = sec.querySelector('.tapi-pdp__dot[data-dot-index="' + next + '"]');
      if (t) t.classList.add('is-active');
      if (m) m.classList.add('is-active');
      if (d) d.classList.add('is-active');
    }
    function currentIndex() {
      var cur = sec.querySelector('.tapi-pdp__main-img.is-active');
      return cur ? parseInt(cur.getAttribute('data-main-index'), 10) || 0 : 0;
    }

    thumbs.forEach(function (t) {
      t.addEventListener('click', function () {
        setActiveImage(parseInt(t.getAttribute('data-thumb-index'), 10) || 0);
      });
    });
    dots.forEach(function (d) {
      d.addEventListener('click', function () {
        setActiveImage(parseInt(d.getAttribute('data-dot-index'), 10) || 0);
      });
    });

    var prevBtn = sec.querySelector('[data-gallery-prev]');
    var nextBtn = sec.querySelector('[data-gallery-next]');
    if (prevBtn) prevBtn.addEventListener('click', function () { setActiveImage(currentIndex() - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { setActiveImage(currentIndex() + 1); });

    var stage = sec.querySelector('[data-gallery-stage]');
    if (stage) {
      stage.setAttribute('tabindex', '-1');
      stage.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); setActiveImage(currentIndex() - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); setActiveImage(currentIndex() + 1); }
      });

      var touchX = null;
      stage.addEventListener('touchstart', function (e) { touchX = e.changedTouches[0].clientX; }, { passive: true });
      stage.addEventListener('touchend', function (e) {
        if (touchX == null) return;
        var dx = e.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) < 40) return;
        setActiveImage(currentIndex() + (dx < 0 ? 1 : -1));
      }, { passive: true });
    }
  }

  // ---------- PDP video playback ----------
  // Hosted video: the native <video controls> already plays on its own; this
  // just drives the branded play overlay and keeps only one clip playing.
  // External video (YouTube / Vimeo): inject the iframe on first click so we
  // don't load a third-party player until the shopper actually wants it.
  function setupPdpVideo(sec) {
    sec.querySelectorAll('[data-pdp-video-wrap]').forEach(function (wrap) {
      var video = wrap.querySelector('video[data-pdp-video]');
      if (!video) return;
      // Facade default: strip native controls so only our branded button shows
      // until tapped. Also normalises any page-cached markup that still carries
      // the old `controls` attribute, so the two buttons never stack.
      video.controls = false;
      var btn = wrap.querySelector('[data-pdp-play]');
      function startPlay() {
        // Reset every other clip to the facade state so only one plays at once.
        sec.querySelectorAll('video[data-pdp-video]').forEach(function (other) {
          if (other === video) return;
          try { other.pause(); } catch (e) {}
          other.controls = false;
          var w = other.closest('[data-pdp-video-wrap]');
          if (w) w.classList.remove('is-playing');
        });
        // Hide our branded button and hand off to the browser's native controls
        // (bottom bar + its own play/pause). They never coexist now.
        wrap.classList.add('is-playing');
        video.controls = true;
        var p = video.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
      if (btn) btn.addEventListener('click', startPlay);
      // While the clip is active our button stays hidden — a native pause must
      // NOT bring it back (that's what stacked two buttons on mobile). Only a
      // finished clip drops back to the facade: poster + branded button, no
      // native chrome.
      video.addEventListener('play', function () { wrap.classList.add('is-playing'); });
      video.addEventListener('ended', function () {
        wrap.classList.remove('is-playing');
        video.controls = false;
      });
    });

    sec.querySelectorAll('[data-pdp-external]').forEach(function (wrap) {
      var btn = wrap.querySelector('[data-pdp-external-play]');
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (wrap.__loaded) return;
        var id = wrap.getAttribute('data-video-id');
        if (!id) return;
        var host = (wrap.getAttribute('data-video-host') || '').toLowerCase();
        var src = host === 'vimeo'
          ? 'https://player.vimeo.com/video/' + id + '?autoplay=1&title=0&byline=0&portrait=0'
          : 'https://www.youtube.com/embed/' + id + '?autoplay=1&rel=0&playsinline=1';
        var iframe = document.createElement('iframe');
        iframe.className = 'tapi-pdp__iframe';
        iframe.setAttribute('src', src);
        iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
        iframe.setAttribute('allowfullscreen', '');
        iframe.setAttribute('title', 'Product video');
        wrap.appendChild(iframe);
        wrap.classList.add('is-playing', 'is-loaded');
        wrap.__loaded = true;
      });
    });
  }

  // ---------- PDP full-screen viewer (lightbox) ----------
  // A dark, focused gallery that mirrors the inline gallery's media set + index.
  // Opens from the zoom button or an image tap, supports swipe / arrow-keys /
  // thumbnails, click-to-zoom + cursor-pan (desktop) and double-tap / pinch /
  // drag-pan (touch). Additive: the inline gallery is never touched.
  function setupPdpLightbox(sec) {
    var box = sec.querySelector('[data-lightbox]');
    if (!box || box.__tapiLightbox) return;
    box.__tapiLightbox = true;

    var reduceM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    var stage   = box.querySelector('[data-lightbox-stage]');
    var slides  = Array.prototype.slice.call(box.querySelectorAll('.tapi-lightbox__slide'));
    var thumbs  = Array.prototype.slice.call(box.querySelectorAll('[data-lightbox-thumb]'));
    var curEl   = box.querySelector('[data-lightbox-current]');
    var prevBtn = box.querySelector('[data-lightbox-prev]');
    var nextBtn = box.querySelector('[data-lightbox-next]');
    var closeEls = box.querySelectorAll('[data-lightbox-close]');
    var openers = sec.querySelectorAll('[data-gallery-zoom]');
    var total = slides.length || 1;
    var idx = 0;
    var lastFocus = null;

    // zoom / pan state for the active image
    var scale = 1, panX = 0, panY = 0;

    function activeImg() {
      var s = slides[idx];
      return s ? s.querySelector('.tapi-lightbox__img[data-zoomable]') : null;
    }
    function trans() {
      return 'translate3d(' + panX.toFixed(1) + 'px,' + panY.toFixed(1) + 'px,0) scale(' + scale.toFixed(3) + ')';
    }
    function applyTransform() {
      var img = activeImg(); if (!img) return;
      img.style.transform = scale > 1.01 ? trans() : '';
      img.classList.toggle('is-zoomed', scale > 1.01);
    }
    function resetZoom() {
      scale = 1; panX = 0; panY = 0;
      var img = activeImg(); if (img) { img.style.transform = ''; img.classList.remove('is-zoomed'); }
    }
    function clampScale(s) { return Math.max(1, Math.min(3.5, s)); }
    function clampPan(w, h) {
      var mx = (scale - 1) * w / 2, my = (scale - 1) * h / 2;
      panX = Math.max(-mx, Math.min(mx, panX));
      panY = Math.max(-my, Math.min(my, panY));
    }
    function panFromClient(cx, cy) {
      var img = activeImg(); if (!img) return;
      var r = stage.getBoundingClientRect();
      var px = Math.min(1, Math.max(0, (cx - r.left) / r.width));
      var py = Math.min(1, Math.max(0, (cy - r.top) / r.height));
      panX = (0.5 - px) * (scale - 1) * img.clientWidth;
      panY = (0.5 - py) * (scale - 1) * img.clientHeight;
      clampPan(img.clientWidth, img.clientHeight);
    }

    function loadHi(slide) {
      if (!slide) return;
      var img = slide.querySelector('img[data-hi]');
      if (!img) return;
      var hi = img.getAttribute('data-hi');
      if (hi && img.getAttribute('src') !== hi && !img.__hiLoading) {
        img.__hiLoading = true;
        var pre = new Image();
        pre.onload = function () { img.setAttribute('src', hi); };
        pre.src = hi;
      }
    }

    function inlineActiveIndex() {
      var a = sec.querySelector('.tapi-pdp__main-img.is-active');
      return a ? (parseInt(a.getAttribute('data-main-index'), 10) || 0) : 0;
    }
    function syncInline(i) {
      // Move the inline gallery to match (reuses its own thumb click handler).
      var t = sec.querySelector('.tapi-pdp__thumb[data-thumb-index="' + i + '"]');
      if (t) t.click();
    }

    function show(i) {
      i = ((i % total) + total) % total;
      resetZoom();
      // Pause any clip when leaving its slide.
      box.querySelectorAll('video').forEach(function (v) { try { v.pause(); } catch (e) {} });
      idx = i;
      slides.forEach(function (s, si) { s.classList.toggle('is-active', si === i); });
      thumbs.forEach(function (t, ti) {
        t.classList.toggle('is-active', ti === i);
        t.setAttribute('aria-current', ti === i ? 'true' : 'false');
      });
      if (curEl) curEl.textContent = String(i + 1);
      loadHi(slides[i]);
      loadHi(slides[(i + 1) % total]);
      loadHi(slides[(i - 1 + total) % total]);
      var at = thumbs[i];
      if (at && at.scrollIntoView) {
        try { at.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduceM ? 'auto' : 'smooth' }); } catch (e) {}
      }
    }

    function open() {
      lastFocus = document.activeElement;
      show(inlineActiveIndex());
      box.hidden = false;
      box.setAttribute('aria-hidden', 'false');
      void box.offsetWidth; // reflow so the transition runs
      box.classList.add('is-open');
      document.documentElement.classList.add('tapi-no-scroll');
      document.body.classList.add('tapi-no-scroll');
      var c = box.querySelector('.tapi-lightbox__close');
      if (c) c.focus();
    }
    function close() {
      box.classList.remove('is-open');
      document.documentElement.classList.remove('tapi-no-scroll');
      document.body.classList.remove('tapi-no-scroll');
      box.querySelectorAll('video').forEach(function (v) { try { v.pause(); } catch (e) {} });
      syncInline(idx);
      var done = function () { box.hidden = true; box.setAttribute('aria-hidden', 'true'); };
      if (reduceM) done(); else setTimeout(done, 360);
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    }

    // ----- open / close / nav triggers -----
    openers.forEach(function (b) { b.addEventListener('click', open); });
    sec.querySelectorAll('.tapi-pdp__main-img').forEach(function (m) {
      if (m.getAttribute('data-media-type') === 'image') {
        m.style.cursor = 'zoom-in';
        m.addEventListener('click', open);
      }
    });
    closeEls.forEach(function (b) { b.addEventListener('click', close); });
    if (prevBtn) prevBtn.addEventListener('click', function () { show(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { show(idx + 1); });
    thumbs.forEach(function (t) {
      t.addEventListener('click', function () { show(parseInt(t.getAttribute('data-lightbox-thumb'), 10) || 0); });
    });

    // ----- keyboard (nav + Esc + focus trap) -----
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
      else if (e.key === 'Tab') {
        var f = Array.prototype.filter.call(
          box.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
          function (el) { return el.offsetParent !== null; }
        );
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    // ----- external video: inject iframe on first play -----
    box.querySelectorAll('[data-lb-external]').forEach(function (wrap) {
      var btn = wrap.querySelector('.tapi-lightbox__playbtn');
      if (!btn) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (wrap.__loaded) return;
        var id = wrap.getAttribute('data-video-id'); if (!id) return;
        var host = (wrap.getAttribute('data-video-host') || '').toLowerCase();
        var src = host === 'vimeo'
          ? 'https://player.vimeo.com/video/' + id + '?autoplay=1&title=0&byline=0&portrait=0'
          : 'https://www.youtube.com/embed/' + id + '?autoplay=1&rel=0&playsinline=1';
        var f = document.createElement('iframe');
        f.setAttribute('src', src);
        f.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
        f.setAttribute('allowfullscreen', '');
        f.setAttribute('title', 'Product video');
        wrap.appendChild(f);
        wrap.__loaded = true;
        var poster = wrap.querySelector('.tapi-lightbox__img'); if (poster) poster.style.display = 'none';
        btn.style.display = 'none';
      });
    });

    // ----- desktop: click-to-zoom + cursor pan + empty-area close -----
    stage.addEventListener('click', function (e) {
      if (e.target.closest('.tapi-lightbox__playbtn') || e.target.closest('video') || e.target.closest('.tapi-lightbox__nav')) return;
      var img = activeImg();
      if (img && img.contains(e.target)) {
        if (!fine) return;
        if (scale > 1.01) { resetZoom(); }
        else { scale = 2.2; panFromClient(e.clientX, e.clientY); applyTransform(); }
      } else {
        close(); // clicked the letterbox area
      }
    });
    if (fine) {
      stage.addEventListener('mousemove', function (e) {
        if (scale <= 1.01) return;
        panFromClient(e.clientX, e.clientY);
        var img = activeImg(); if (img) img.style.transform = trans();
      });
    }

    // ----- touch: pinch / double-tap zoom, drag pan, swipe nav -----
    var tStartX = 0, tStartY = 0, tMoved = false, mode = '', pinchBase = 0, pinchScaleBase = 1, baseX = 0, baseY = 0, lastTap = 0;
    function tDist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy) || 1; }
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) { mode = 'pinch'; pinchBase = tDist(e.touches); pinchScaleBase = scale; }
      else if (e.touches.length === 1) {
        mode = scale > 1.01 ? 'pan' : 'swipe';
        tStartX = e.touches[0].clientX; tStartY = e.touches[0].clientY; tMoved = false;
        baseX = panX; baseY = panY;
      }
    }, { passive: true });
    stage.addEventListener('touchmove', function (e) {
      var img = activeImg();
      if (mode === 'pinch' && e.touches.length === 2 && img) {
        scale = clampScale(pinchScaleBase * (tDist(e.touches) / pinchBase));
        clampPan(img.clientWidth, img.clientHeight);
        img.style.transform = trans(); img.classList.toggle('is-zoomed', scale > 1.01);
        tMoved = true;
      } else if (mode === 'pan' && img) {
        var dx = e.touches[0].clientX - tStartX, dy = e.touches[0].clientY - tStartY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) tMoved = true;
        panX = baseX + dx; panY = baseY + dy; clampPan(img.clientWidth, img.clientHeight);
        img.style.transform = trans();
      } else if (mode === 'swipe') {
        var sx = e.touches[0].clientX - tStartX, sy = e.touches[0].clientY - tStartY;
        if (Math.abs(sx) > 6 || Math.abs(sy) > 6) tMoved = true;
      }
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (e.touches.length > 0) return;
      var img = activeImg();
      if (mode === 'swipe' && tMoved) {
        var dx = e.changedTouches[0].clientX - tStartX;
        var dy = e.changedTouches[0].clientY - tStartY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(idx + (dx < 0 ? 1 : -1));
      } else if (mode === 'swipe' && !tMoved) {
        var now = Date.now();
        if (img) {
          if (now - lastTap < 300) { scale = 2.4; panFromClient(tStartX, tStartY); applyTransform(); lastTap = 0; }
          else { lastTap = now; }
        } else {
          var el = document.elementFromPoint(tStartX, tStartY);
          if (el && !el.closest('.tapi-lightbox__playbtn') && !el.closest('video') && !el.closest('.tapi-lightbox__nav')) close();
        }
      }
      if ((mode === 'pinch' || mode === 'pan') && scale <= 1.05) resetZoom();
      mode = '';
    }, { passive: true });
  }

  // ---------- Custom dropdown widget ----------
  // Wraps targeted <select> elements with a brand-styled trigger + popover.
  // The native <select> stays in DOM (so form submission, change events,
  // and accessibility work as before); the wrapper handles the visible UI.
  //
  // Targets: sort dropdowns + localization. Anything with [data-tapi-select]
  // also opts in. Stop at .tapi-footer__field selects (footer subscribe).
  function setupCustomSelect(root) {
    var selector = [
      '.facet-filters__field select',
      '.facets-vertical-sort select',
      '.facets__sort',
      'localization-form select',
      '.localization-form select',
      '[data-tapi-select]'
    ].join(', ');
    var selects = (root || document).querySelectorAll(selector);
    selects.forEach(wrapSelect);
  }

  function wrapSelect(sel) {
    if (sel.__tapiCustomSelect) return;
    if (sel.closest && sel.closest('.tapi-footer__field')) return;
    sel.__tapiCustomSelect = true;

    // Build wrapper structure
    var wrap = document.createElement('div');
    wrap.className = 'tapi-select-wrap';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'tapi-select__trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var valueSpan = document.createElement('span');
    valueSpan.className = 'tapi-select__value';
    valueSpan.textContent = (sel.options[sel.selectedIndex] || {}).text || '';

    var chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'tapi-select__chevron');
    chevron.setAttribute('width', '12');
    chevron.setAttribute('height', '8');
    chevron.setAttribute('viewBox', '0 0 12 8');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';

    trigger.appendChild(valueSpan);
    trigger.appendChild(chevron);

    var menu = document.createElement('div');
    menu.className = 'tapi-select__menu';
    menu.setAttribute('role', 'listbox');

    Array.prototype.forEach.call(sel.options, function (opt, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tapi-select__option';
      btn.setAttribute('role', 'option');
      btn.setAttribute('data-value', opt.value);
      btn.setAttribute('aria-selected', String(i === sel.selectedIndex));
      btn.textContent = opt.textContent;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chooseOption(opt.value);
      });
      menu.appendChild(btn);
    });

    // Insert wrap before the select; move select inside it; flag as native-hidden
    var parent = sel.parentNode;
    parent.insertBefore(wrap, sel);
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    wrap.appendChild(sel);
    sel.classList.add('tapi-select__native');

    function open() {
      // Close any other open widgets first
      document.querySelectorAll('.tapi-select-wrap.is-open').forEach(function (w) {
        if (w !== wrap) w.classList.remove('is-open');
      });
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
    }
    function close() {
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    }
    function toggle() { wrap.classList.contains('is-open') ? close() : open(); }

    function chooseOption(value) {
      if (sel.value === value) { close(); return; }
      sel.value = value;
      // Update option-selected state in the popover
      menu.querySelectorAll('.tapi-select__option').forEach(function (b) {
        b.setAttribute('aria-selected', String(b.getAttribute('data-value') === value));
      });
      // Update trigger label
      var newOpt = sel.options[sel.selectedIndex];
      if (newOpt) valueSpan.textContent = newOpt.text;
      // Fire native change so Dawn's facet-filters-form (and others) pick it up
      sel.dispatchEvent(new Event('input',  { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      close();
    }

    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });

    // Keep custom widget in sync if the underlying select is changed
    // programmatically (e.g. by Dawn after a page-section refresh)
    sel.addEventListener('change', function () {
      var newOpt = sel.options[sel.selectedIndex];
      if (newOpt) valueSpan.textContent = newOpt.text;
      menu.querySelectorAll('.tapi-select__option').forEach(function (b) {
        b.setAttribute('aria-selected', String(b.getAttribute('data-value') === sel.value));
      });
    });

    // Outside click — handled by one delegated listener (installed once below)
    // ESC closes; arrow keys move focus across options when open
    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); return; }
      if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !wrap.classList.contains('is-open')) {
        e.preventDefault();
        open();
        var first = menu.querySelector('.tapi-select__option');
        if (first) first.focus();
      }
    });
    menu.addEventListener('keydown', function (e) {
      var opts = Array.prototype.slice.call(menu.querySelectorAll('.tapi-select__option'));
      var idx = opts.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (opts[idx + 1] || opts[0]).focus(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); (opts[idx - 1] || opts[opts.length - 1]).focus(); }
      else if (e.key === 'Home')      { e.preventDefault(); opts[0] && opts[0].focus(); }
      else if (e.key === 'End')       { e.preventDefault(); opts[opts.length - 1] && opts[opts.length - 1].focus(); }
    });
  }

  // ---------- Header scroll-shadow ----------
  // Toggle .is-scrolled on .header-wrapper when the page has scrolled past 8px.
  // rAF-throttled + passive listener so it stays cheap on long pages.
  function setupHeaderScroll() {
    var header = document.querySelector('.header-wrapper');
    if (!header) return;
    var ticking = false;
    var threshold = 8;
    function update() {
      var scrolled = (window.pageYOffset || document.documentElement.scrollTop) > threshold;
      header.classList.toggle('is-scrolled', scrolled);
      ticking = false;
    }
    function onScroll() {
      if (!ticking) { window.requestAnimationFrame(update); ticking = true; }
    }
    update(); // set initial state (handles refresh-mid-page)
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------- Tapi search modal wiring ----------
  // Each header-search snippet renders inside a <details-modal>. We toggle
  // a `.is-query` class on the host whenever the input has text, which
  // CSS uses to swap the empty-state curated content for the live
  // predictive-search results region. We also mirror any "Suggested"
  // queries that Dawn's predictive response returns into the left rail.
  function setupTapiSearch(root) {
    (root || document).querySelectorAll('.tapi-search').forEach(function (host) {
      if (host.__tapiSearchWired) return;
      host.__tapiSearchWired = true;

      var input = host.querySelector('.tapi-search-bar__input');
      var resetBtn = host.querySelector('.tapi-search-bar__reset');
      var closeBtn = host.querySelector('.tapi-search-close');
      var details = host.querySelector('details');
      var live = host.querySelector('[data-predictive-search]');
      var suggestedTarget = host.querySelector('[data-query-suggested]');

      function syncQuery() {
        if (!input) return;
        var hasText = input.value.trim().length > 0;
        host.classList.toggle('is-query', hasText);
        if (resetBtn) resetBtn.classList.toggle('hidden', !hasText);
      }
      if (input) {
        input.addEventListener('input', syncQuery);
        input.addEventListener('change', syncQuery);
      }
      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          if (input) input.value = '';
          syncQuery();
          if (input) input.focus();
        });
      }
      if (closeBtn && details) {
        closeBtn.addEventListener('click', function (e) {
          e.preventDefault();
          details.removeAttribute('open');
        });
      }
      syncQuery();

      // Mirror predictive-search "Suggested" entries (queries + collections)
      // from the response into the left rail when they appear.
      if (live && suggestedTarget) {
        var mo = new MutationObserver(function () {
          var src = live.querySelector('[data-suggested-source]');
          if (!src) { suggestedTarget.innerHTML = ''; return; }
          var items = src.querySelectorAll('[data-suggested-href]');
          if (!items.length) { suggestedTarget.innerHTML = ''; return; }
          var html = '';
          items.forEach(function (a) {
            var href = a.getAttribute('data-suggested-href') || '#';
            var text = a.getAttribute('data-suggested-text') || a.textContent.trim();
            html += '<li class="tapi-search-list__item">' +
                      '<a href="' + href + '" class="tapi-search-list__link link-u">' +
                        '<span class="tapi-search-list__bullet" aria-hidden="true"></span>' +
                        '<span class="tapi-search-list__label serif">' + text + '</span>' +
                      '</a>' +
                    '</li>';
          });
          suggestedTarget.innerHTML = html;
        });
        mo.observe(live, { childList: true, subtree: true });
      }

      // ESC inside the panel closes
      host.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && details && details.hasAttribute('open')) {
          details.removeAttribute('open');
        }
      });
    });
  }

  // One delegated outside-click listener for all custom selects on the page
  // (avoids attaching a fresh document listener per wrapSelect call).
  function setupSelectOutsideClose() {
    if (window.__tapiSelectOutsideClose) return;
    window.__tapiSelectOutsideClose = true;
    document.addEventListener('click', function (e) {
      document.querySelectorAll('.tapi-select-wrap.is-open').forEach(function (w) {
        if (!w.contains(e.target)) {
          w.classList.remove('is-open');
          var t = w.querySelector('.tapi-select__trigger');
          if (t) t.setAttribute('aria-expanded', 'false');
        }
      });
      // Close any open <details.tapi-sort> when the click lands outside it
      document.querySelectorAll('details.tapi-sort[open]').forEach(function (d) {
        if (!d.contains(e.target)) d.removeAttribute('open');
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('details.tapi-sort[open]').forEach(function (d) {
        d.removeAttribute('open');
      });
    });
  }

  function boot() {
    setupReveal(document);
    setupCountUp(document);
    setupMagnetic(document);
    setupHeaderScroll();
    setupPdpGallery(document);
    setupCustomSelect(document);
    setupSelectOutsideClose();
    setupTapiSearch(document);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-init on Shopify section editor re-render
  document.addEventListener('shopify:section:load', function (e) {
    disconnectObservers(e.target);
    setupReveal(e.target);
    setupCountUp(e.target);
    setupMagnetic(e.target);
    setupPdpGallery(e.target);
    setupCustomSelect(e.target);
    setupTapiSearch(e.target);
  });

  // Tear down observers when a section is removed in the editor
  document.addEventListener('shopify:section:unload', function (e) {
    disconnectObservers(e.target);
  });
})();
