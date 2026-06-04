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
      var closeBtn = host.querySelector('.tapi-search-bar__close');
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
