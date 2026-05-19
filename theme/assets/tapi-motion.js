(function () {
  if (window.__tapiMotion) return; window.__tapiMotion = true;

  // Respect reduced motion
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Reveal on scroll ----------
  // Any element with [data-tapi-reveal] fades + rises in once on first intersect.
  // Optional [data-tapi-delay="120"] (ms). Children-stagger via [data-tapi-stagger="100"] on parent.
  var revealCss = '[data-tapi-reveal]{opacity:0;transform:translate3d(0,24px,0);transition:opacity 720ms cubic-bezier(0.16,1,0.3,1),transform 720ms cubic-bezier(0.16,1,0.3,1);will-change:opacity,transform}[data-tapi-reveal].in{opacity:1;transform:translate3d(0,0,0)}';
  var st = document.createElement('style'); st.textContent = revealCss; document.head.appendChild(st);

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
    root.querySelectorAll('[data-tapi-count-up]').forEach(function (el) {
      el.textContent = '0';
      io.observe(el);
    });
  }

  // ---------- Magnetic CTA ----------
  function setupMagnetic(root) {
    if (reduce) return;
    root.querySelectorAll('[data-tapi-magnetic]').forEach(function (el) {
      var strength = parseFloat(el.getAttribute('data-tapi-magnetic')) || 0.18;
      var inner = el;
      inner.style.transition = 'transform 360ms cubic-bezier(0.22,1,0.36,1)';
      inner.style.willChange = 'transform';
      el.parentElement.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var x = (e.clientX - (r.left + r.width / 2)) * strength;
        var y = (e.clientY - (r.top + r.height / 2)) * strength;
        inner.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      });
      el.parentElement.addEventListener('mouseleave', function () {
        inner.style.transform = 'translate3d(0,0,0)';
      });
    });
  }

  function boot() {
    setupReveal(document);
    setupCountUp(document);
    setupMagnetic(document);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-init on Shopify section editor re-render
  document.addEventListener('shopify:section:load', function (e) { setupReveal(e.target); setupCountUp(e.target); setupMagnetic(e.target); });
})();
