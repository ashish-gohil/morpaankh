/*
 * Mobile sticky checkout bar behaviour.
 * The bar (#tapi-cart-stickybar) is fixed to the bottom on mobile so checkout is
 * always one tap away. It retracts once the real footer checkout button (#checkout)
 * scrolls into view, so there is never a duplicate CTA at rest, and returns when the
 * button leaves the viewport. Desktop uses the sticky aside, where the bar is
 * display:none, so toggling the class there is a no-op.
 *
 * The footer #checkout node is stable across quantity changes (it lives in
 * .cart__ctas, outside the .js-contents that cart.js swaps), but the bar's own inner
 * HTML is re-rendered on quantity change; the .is-hidden class lives on the stable
 * outer element, so the observer keeps working without re-attaching. We still re-init
 * on cartUpdate as a cheap safety net.
 */
(function () {
  function init() {
    var bar = document.getElementById('tapi-cart-stickybar');
    var target = document.getElementById('checkout'); // footer's inline checkout button
    if (!bar || !target || !('IntersectionObserver' in window)) return;

    if (bar.__tapiStickyIO) bar.__tapiStickyIO.disconnect();

    var io = new IntersectionObserver(
      function (entries) {
        var visible = entries[0].isIntersecting;
        bar.classList.toggle('is-hidden', visible);
        bar.setAttribute('aria-hidden', visible ? 'true' : 'false');
      },
      { threshold: 0 }
    );
    io.observe(target);
    bar.__tapiStickyIO = io;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-init after a cart re-render (safety net; the observed node is normally stable).
  if (window.PUB_SUB_EVENTS && typeof subscribe === 'function') {
    subscribe(PUB_SUB_EVENTS.cartUpdate, function () {
      setTimeout(init, 0);
    });
  }
})();
