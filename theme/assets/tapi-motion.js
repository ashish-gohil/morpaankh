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
    root.querySelectorAll('[data-tapi-reveal]').forEach(function (el) { io.observe(el); });
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
      var inner = el;
      inner.style.transition = 'transform 360ms cubic-bezier(0.22,1,0.36,1)';
      inner.style.willChange = 'transform';
      var pending = false;
      var lastX = 0, lastY = 0;
      function apply() {
        pending = false;
        inner.style.transform = 'translate3d(' + lastX + 'px,' + lastY + 'px,0)';
      }
      el.parentElement.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        lastX = (e.clientX - (r.left + r.width / 2)) * strength;
        lastY = (e.clientY - (r.top + r.height / 2)) * strength;
        if (!pending) { pending = true; requestAnimationFrame(apply); }
      }, { passive: true });
      el.parentElement.addEventListener('mouseleave', function () {
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

    var thumbs = sec.querySelectorAll('.tapi-pdp__thumb');
    var mains  = sec.querySelectorAll('.tapi-pdp__main-img');
    var dots   = sec.querySelectorAll('[data-gallery-dots] .tapi-pdp__dot');
    var total  = mains.length || 1;
    if (total <= 1) return; // nothing to navigate

    function setActiveImage(idx) {
      var next = ((idx % total) + total) % total; // wrap both directions
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
  });

  // Tear down observers when a section is removed in the editor
  document.addEventListener('shopify:section:unload', function (e) {
    disconnectObservers(e.target);
  });
})();
