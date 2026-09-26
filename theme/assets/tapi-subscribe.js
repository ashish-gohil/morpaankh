/* tapi-subscribe.js — subscriber signup popup.
 *
 * Framework free and self contained: one config object in, one dialog out. The
 * theme supplies the config from section settings (sections/tapi-subscribe-popup
 * .liquid); a Next.js app would call TapiSubscribe.mount(config) with the same
 * shape and ship the same CSS. Nothing here touches Liquid or Shopify globals.
 *
 * The markup is built in JS rather than rendered by Liquid on purpose: the
 * popup is not in the document until it decides to open, so it can contribute
 * no layout shift and no bytes of DOM to first paint.
 *
 * Saving goes to config.endpoint, not to Shopify's {% form 'customer' %}. That
 * form only persists the email and its tags; any other contact[...] field lands
 * in the merchant's contact notification, so the WhatsApp number would be lost.
 */
(function () {
  if (window.__tapiSubscribe) return;
  window.__tapiSubscribe = true;

  /* ---- state: localStorage, cookie fallback ------------------------------
   * Both wrapped: localStorage throws outright in some in-app webviews and in
   * Safari private mode, and the cookie keeps the popup from re-opening on
   * every page view for those visitors. */
  function cookieName(key) {
    return key.replace(/[^A-Za-z0-9_]/g, '_');
  }

  var store = {
    get: function (key) {
      try {
        var v = window.localStorage.getItem(key);
        if (v !== null && v !== undefined) return v;
      } catch (e) {}
      try {
        var m = document.cookie.match(new RegExp('(?:^|; )' + cookieName(key) + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
      } catch (e) {
        return null;
      }
    },
    set: function (key, val, days) {
      try {
        window.localStorage.setItem(key, val);
      } catch (e) {}
      try {
        var exp = new Date(Date.now() + days * 86400000).toUTCString();
        document.cookie =
          cookieName(key) + '=' + encodeURIComponent(val) + '; expires=' + exp + '; path=/; SameSite=Lax';
      } catch (e) {}
    },
  };

  var DONE = 'done';

  /* ---- gating ------------------------------------------------------------ */

  /** Page types the popup must never interrupt. Matched per path segment so a
   *  locale prefix like /en-in/cart is still excluded. */
  function onExcludedPage(segments) {
    var re = new RegExp('(^|/)(' + segments.join('|') + ')(/|$)', 'i');
    return re.test(window.location.pathname);
  }

  /** True while any other drawer, modal or menu owns the viewport. Dawn marks
   *  all of them by locking the body, which is the one signal that covers the
   *  cart drawer, the search modal, the menu drawer and the story player. */
  function otherOverlayOpen() {
    if (/(^|\s)overflow-hidden(-(desktop|mobile|tablet))?(\s|$)/.test(document.body.className)) return true;
    return Boolean(
      document.querySelector('dialog[open], details-modal details[open], #cart-notification.active'),
    );
  }

  function shouldShow(cfg) {
    if (!cfg.enabled) return false;
    if (cfg.customerSubscribed) return false;
    if (onExcludedPage(cfg.excludeSegments)) return false;
    var raw = store.get(cfg.storageKey);
    if (raw === DONE) return false;
    if (raw && Number(raw) > Date.now()) return false;
    return true;
  }

  /* ---- validation ------------------------------------------------------- */

  var EMAIL_RE = /^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[A-Za-z]{2,}$/;

  function validateEmail(v) {
    if (!v) return 'Please enter your email so we can send the code.';
    return EMAIL_RE.test(v) ? '' : 'That email does not look right. Please check it.';
  }

  function validatePhone(local, dial) {
    var digits = local.replace(/\D/g, '');
    if (!digits) return 'Please enter your WhatsApp number.';
    if (dial.code === '+91') {
      if (digits.length !== 10) return 'An Indian number has 10 digits.';
      if (!/^[6-9]/.test(digits)) return 'An Indian mobile number starts with 6, 7, 8 or 9.';
      return '';
    }
    var want = dial.digits || 0;
    if (want && digits.length !== want) return 'That number should have ' + want + ' digits.';
    if (!want && (digits.length < 6 || digits.length > 14)) return 'That number does not look right.';
    return '';
  }

  /* ---- analytics -------------------------------------------------------- */

  /* Routed through the theme's own pixel layer when it is there. It may not be:
   * tapi-analytics.js only loads when a GA4 or Meta id is configured, and it
   * bails on preview and *.myshopify.com hosts. Falls back to raw gtag / fbq
   * only if those actually exist. No email or phone is ever passed. */
  function trackLead(cfg) {
    var params = { currency: 'INR', value: Number(cfg.leadValue) || 0, method: 'popup' };
    try {
      var a = window.TapiAnalytics;
      if (a && typeof a.track === 'function') {
        a.track('generate_lead', params);
        return;
      }
      if (typeof window.gtag === 'function') window.gtag('event', 'generate_lead', params);
      if (typeof window.fbq === 'function') {
        window.fbq('track', 'Lead', { currency: params.currency, value: params.value });
      }
    } catch (e) {}
  }

  /* ---- build ------------------------------------------------------------ */

  var CLOSE_SVG =
    '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" aria-hidden="true" focusable="false">' +
    '<path d="M1 1l12 12M13 1L1 13"/></svg>';

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] != null) n.setAttribute(k, attrs[k]);
      }
    }
    if (html != null) n.innerHTML = html;
    return n;
  }

  /** Escape before any config string goes near innerHTML. The copy comes from
   *  theme settings, which a staff member types, so it is not hostile, but it
   *  will contain an ampersand sooner or later. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var FOCUSABLE =
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)';

  function mount(cfg) {
    var root = el('div', { class: 'tapi-sub', hidden: '' });
    var titleId = 'tapi-sub-title';
    var subId = 'tapi-sub-sub';

    root.appendChild(el('div', { class: 'tapi-sub__scrim', 'data-sub-scrim': '' }));

    var card = el('div', {
      class: 'tapi-sub__card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'aria-describedby': subId,
    });
    root.appendChild(card);

    var dials = cfg.dialCodes;
    var dialOptions = dials
      .map(function (d, i) {
        return '<option value="' + i + '">' + esc(d.label) + '</option>';
      })
      .join('');

    card.innerHTML =
      '<button type="button" class="tapi-sub__close" data-sub-close aria-label="Close">' + CLOSE_SVG + '</button>' +
      '<div data-sub-offer>' +
        (cfg.eyebrow ? '<p class="tapi-sub__eyebrow">' + esc(cfg.eyebrow) + '</p>' : '') +
        '<h2 class="tapi-sub__title" id="' + titleId + '">' + esc(cfg.headline) + '</h2>' +
        '<p class="tapi-sub__sub" id="' + subId + '">' + esc(cfg.subtext) + '</p>' +
        '<form class="tapi-sub__form" novalidate>' +
          '<div>' +
            '<label class="tapi-sub__label" for="tapi-sub-name">Name ' +
              '<span class="tapi-sub__optional">(optional)</span></label>' +
            '<input class="tapi-sub__input" id="tapi-sub-name" name="name" type="text" ' +
              'autocomplete="given-name" enterkeyhint="next">' +
          '</div>' +
          '<div>' +
            '<label class="tapi-sub__label" for="tapi-sub-email">Email</label>' +
            '<input class="tapi-sub__input" id="tapi-sub-email" name="email" type="email" required ' +
              'autocomplete="email" inputmode="email" enterkeyhint="next" ' +
              'aria-describedby="tapi-sub-email-err">' +
            '<span class="tapi-sub__err" id="tapi-sub-email-err" role="alert"></span>' +
          '</div>' +
          '<div>' +
            '<label class="tapi-sub__label" for="tapi-sub-phone">WhatsApp number</label>' +
            '<div class="tapi-sub__tel">' +
              '<select class="tapi-sub__dial" id="tapi-sub-dial" aria-label="Country calling code">' +
                dialOptions +
              '</select>' +
              '<input class="tapi-sub__input" id="tapi-sub-phone" name="phone" type="tel" required ' +
                'autocomplete="tel-national" inputmode="numeric" enterkeyhint="done" ' +
                'aria-describedby="tapi-sub-phone-err">' +
            '</div>' +
            '<span class="tapi-sub__err" id="tapi-sub-phone-err" role="alert"></span>' +
          '</div>' +
          /* Honeypot. Named innocuously and left out of the tab order. */
          '<input class="tapi-sub__hp" name="hp" type="text" tabindex="-1" autocomplete="off" ' +
            'aria-hidden="true" value="">' +
          '<button type="submit" class="tapi-sub__submit" data-sub-submit>' + esc(cfg.buttonText) + '</button>' +
          '<span class="tapi-sub__err" data-sub-formerr role="alert"></span>' +
          '<p class="tapi-sub__consent">' + esc(cfg.consentText) + ' ' +
            '<a href="' + esc(cfg.privacyUrl) + '" target="_blank" rel="noopener">Privacy policy</a></p>' +
          '<button type="button" class="tapi-sub__decline" data-sub-close>' + esc(cfg.declineText) + '</button>' +
        '</form>' +
      '</div>' +
      '<div data-sub-success hidden>' +
        '<h2 class="tapi-sub__title" data-sub-successtitle>' + esc(cfg.successHeadline) + '</h2>' +
        '<p class="tapi-sub__sub">' + esc(cfg.successText) + '</p>' +
        '<div class="tapi-sub__code">' +
          '<output aria-label="Your discount code">' + esc(cfg.offerCode) + '</output>' +
          '<button type="button" class="tapi-sub__copy" data-sub-copy>Copy</button>' +
        '</div>' +
        '<p class="tapi-sub__note">' + esc(cfg.offerNote) + '</p>' +
        '<a class="tapi-sub__go" data-sub-go href="/discount/' + encodeURIComponent(cfg.offerCode) +
          '?redirect=' + encodeURIComponent(cfg.successRedirect) + '">' + esc(cfg.continueText) + '</a>' +
      '</div>';

    var form = card.querySelector('form');
    var offer = card.querySelector('[data-sub-offer]');
    var success = card.querySelector('[data-sub-success]');
    var nameEl = card.querySelector('#tapi-sub-name');
    var emailEl = card.querySelector('#tapi-sub-email');
    var phoneEl = card.querySelector('#tapi-sub-phone');
    var dialEl = card.querySelector('#tapi-sub-dial');
    var hpEl = form.querySelector('[name="hp"]');
    var submitEl = card.querySelector('[data-sub-submit]');
    var formErr = card.querySelector('[data-sub-formerr]');
    var emailErr = card.querySelector('#tapi-sub-email-err');
    var phoneErr = card.querySelector('#tapi-sub-phone-err');

    var lastFocus = null;
    var prevHtmlOverflow = '';
    var prevBodyOverflow = '';

    function dial() {
      return cfg.dialCodes[Number(dialEl.value) || 0];
    }

    function setErr(input, node, msg) {
      node.textContent = msg;
      if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      return !msg;
    }

    function open() {
      if (!root.isConnected) document.body.appendChild(root);
      lastFocus = document.activeElement;
      root.hidden = false;
      /* Lock the page behind the dialog. The card scrolls internally, so an
       * overflow lock is enough and avoids the scroll-position jump that a
       * position:fixed body causes. */
      prevHtmlOverflow = document.documentElement.style.overflow;
      prevBodyOverflow = document.body.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      // Next frame, so the opening transition has a start state to animate from.
      requestAnimationFrame(function () {
        root.classList.add('is-open');
      });
      (emailEl || card).focus({ preventScroll: true });
    }

    function teardown() {
      root.classList.remove('is-open');
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
      var done = function () {
        root.hidden = true;
      };
      // Let the fade finish unless the visitor asked for no motion.
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
      else setTimeout(done, 250);
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    }

    /** Dismissed without subscribing: back after cfg.resnoozeDays. */
    function dismiss() {
      store.set(cfg.storageKey, String(Date.now() + cfg.resnoozeDays * 86400000), cfg.resnoozeDays);
      teardown();
    }

    /** Subscribed: never again on this device. 400 days is the cookie ceiling
     *  browsers will honour; localStorage has no expiry and carries the rest. */
    function retire() {
      store.set(cfg.storageKey, DONE, 400);
    }

    function trapTab(e) {
      var items = Array.prototype.filter.call(card.querySelectorAll(FOCUSABLE), function (n) {
        return n.offsetParent !== null || n === document.activeElement;
      });
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
      } else if (e.key === 'Tab') {
        trapTab(e);
      }
    });

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-sub-close]') || e.target.hasAttribute('data-sub-scrim')) dismiss();
    });

    // Re-validate on blur, not on every keystroke: an error that appears while
    // someone is still typing their address reads as broken.
    emailEl.addEventListener('blur', function () {
      setErr(emailEl, emailErr, validateEmail(emailEl.value.trim()));
    });
    phoneEl.addEventListener('blur', function () {
      setErr(phoneEl, phoneErr, validatePhone(phoneEl.value, dial()));
    });
    dialEl.addEventListener('change', function () {
      if (phoneErr.textContent) setErr(phoneEl, phoneErr, validatePhone(phoneEl.value, dial()));
    });

    card.querySelector('[data-sub-copy]').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      var restore = function () {
        setTimeout(function () {
          btn.textContent = 'Copy';
        }, 1600);
      };
      var ok = function () {
        btn.textContent = 'Copied';
        restore();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cfg.offerCode).then(ok, function () {
          btn.textContent = 'Press and hold to copy';
          restore();
        });
      } else {
        btn.textContent = 'Press and hold to copy';
        restore();
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      formErr.textContent = '';

      var email = emailEl.value.trim();
      var okEmail = setErr(emailEl, emailErr, validateEmail(email));
      var okPhone = setErr(phoneEl, phoneErr, validatePhone(phoneEl.value, dial()));
      if (!okEmail || !okPhone) {
        (okEmail ? phoneEl : emailEl).focus();
        return;
      }

      submitEl.disabled = true;
      submitEl.textContent = cfg.sendingText;

      var payload = {
        name: nameEl.value.trim(),
        email: email,
        phone: dial().code + phoneEl.value.replace(/\D/g, ''),
        hp: hpEl.value,
      };

      fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().then(
            function (b) {
              return { status: res.status, body: b };
            },
            function () {
              return { status: res.status, body: {} };
            },
          );
        })
        .then(function (r) {
          if (r.body && r.body.ok) {
            retire();
            trackLead(cfg);
            if (r.body.status === 'already') {
              card.querySelector('[data-sub-successtitle]').textContent = cfg.alreadyHeadline;
            }
            offer.hidden = true;
            success.hidden = false;
            card.querySelector('[data-sub-successtitle]').focus({ preventScroll: true });
            return;
          }
          var err = (r.body && r.body.error) || '';
          if (err === 'invalid_email') {
            setErr(emailEl, emailErr, 'That email does not look right. Please check it.');
            emailEl.focus();
          } else if (err === 'invalid_phone') {
            setErr(phoneEl, phoneErr, 'That WhatsApp number does not look right.');
            phoneEl.focus();
          } else if (err === 'rate_limited') {
            formErr.textContent = 'That is a few tries in a row. Please try again in a few minutes.';
          } else {
            formErr.textContent = 'Something went wrong at our end. Please try again.';
          }
        })
        .catch(function () {
          formErr.textContent = 'We could not reach the server. Please check your connection and try again.';
        })
        .then(function () {
          submitEl.disabled = false;
          submitEl.textContent = cfg.buttonText;
        });
    });

    // The success panel takes focus on submit, so it needs to be focusable.
    card.querySelector('[data-sub-successtitle]').setAttribute('tabindex', '-1');

    return { root: root, open: open, close: dismiss };
  }

  /* ---- boot ------------------------------------------------------------- */

  function start(cfg) {
    if (!shouldShow(cfg)) return;

    var instance = mount(cfg);
    var waited = 0;

    /* Open after the delay, but never on top of another overlay. If one is up,
     * keep checking for as long as cfg.waitLimitMs before giving up on this
     * page view, so a visitor who leaves the cart drawer open is not shown a
     * popup stacked on it. */
    function attempt() {
      if (!otherOverlayOpen()) {
        instance.open();
        return;
      }
      waited += 700;
      if (waited < cfg.waitLimitMs) setTimeout(attempt, 700);
    }

    setTimeout(attempt, cfg.delayMs);
  }

  var DEFAULTS = {
    enabled: true,
    endpoint: '',
    delayMs: 5000,
    resnoozeDays: 7,
    waitLimitMs: 30000,
    storageKey: 'tapi:subscribe',
    excludeSegments: ['cart', 'account', 'challenge', 'checkout', 'password'],
    customerSubscribed: false,
    leadValue: 150,
    offerCode: 'WELCOME150',
    successRedirect: '/collections/all',
    sendingText: 'Sending',
    declineText: 'No, thanks',
    continueText: 'Continue shopping',
    dialCodes: [
      { code: '+91', label: 'IN +91', digits: 10 },
      { code: '+971', label: 'AE +971', digits: 9 },
      { code: '+44', label: 'UK +44', digits: 10 },
      { code: '+1', label: 'US +1', digits: 10 },
      { code: '+61', label: 'AU +61', digits: 9 },
      { code: '+65', label: 'SG +65', digits: 8 },
    ],
  };

  function withDefaults(cfg) {
    var out = {};
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    for (k in cfg) {
      if (Object.prototype.hasOwnProperty.call(cfg, k) && cfg[k] !== '' && cfg[k] != null) out[k] = cfg[k];
    }
    return out;
  }

  // The portable entry point: this is what a Next.js app would call.
  window.TapiSubscribe = {
    mount: function (cfg) {
      return mount(withDefaults(cfg));
    },
    start: function (cfg) {
      return start(withDefaults(cfg));
    },
    // Underscored: exported for scripts/check-subscribe-popup.mjs, not API.
    _validateEmail: validateEmail,
    _validatePhone: validatePhone,
    _shouldShow: function (cfg) {
      return shouldShow(withDefaults(cfg));
    },
  };

  /* In the theme, the section emits its settings as JSON. Design mode is
   * excluded: a popup that reopens on every settings change makes the theme
   * editor unusable. */
  function boot() {
    var node = document.getElementById('tapi-subscribe-config');
    if (!node) return;
    if (window.Shopify && window.Shopify.designMode) return;
    var cfg;
    try {
      cfg = JSON.parse(node.textContent);
    } catch (e) {
      return;
    }
    if (!cfg.endpoint) return; // not configured yet: stay silent rather than 404 a POST
    start(withDefaults(cfg));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
