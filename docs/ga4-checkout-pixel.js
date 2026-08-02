// ============================================================================
// MorPaankh — GA4 CHECKOUT-ONLY tracking via Shopify Custom Pixel  (v3)
// ----------------------------------------------------------------------------
// WHERE THIS LIVES: Shopify admin -> Settings -> Customer events -> "GA4 Ecommerce"
//   -> Code -> REPLACE the whole file with this -> Save.
//
// This is the SINGLE owner of the checkout funnel. Two other pixels used to
// fire the same events and must be removed so nothing double-counts:
//   - "GA4 Purchase"  (duplicate of this funnel)  -> Disconnect + Delete
//   - "GA4 Checkout"  (older, already disconnected) -> Delete
//
// v3 change (the reason for this edit):
//   purchase/checkout value now reports the REAL order total, not the COD King
//   partial-payment deposit. On a partial order the Shopify checkout only charges
//   the 5% token (e.g. 49.95 on a 999 order), so checkout.totalPrice was the
//   token, under-reporting revenue to GA4 (and to Google Ads) by ~20x. COD King
//   stamps the true pre-split total on the order as the cart attribute
//   _codkOriginalTotal, which this reads first.
//
// Division of responsibility (do not change one without the other):
//   theme assets/tapi-analytics.js -> storefront events (+ Meta bridge if a Meta
//                                     Pixel ID is ever set in theme settings)
//   this custom pixel              -> begin_checkout, add_shipping_info,
//                                     add_payment_info, purchase
// ============================================================================

const GA4_ID = 'G-T0YLNND1JT'; // MorPaankh GA4 (stream 15201927776)

const s = document.createElement('script');
s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
s.async = true;
document.head.appendChild(s);

window.dataLayer = window.dataLayer || [];
function gtag(){ dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', GA4_ID, { send_page_view: false });

function cur(m){ return m && m.currencyCode; }
function money(m){ return m ? Number(m.amount) : undefined; }

// Real order value. COD King partial-payment orders charge only a deposit at
// checkout, so checkout.totalPrice is the token, not the sale. Prefer the true
// total COD King stamps on the order (_codkOriginalTotal); if that is missing on
// a partial order, sum the line items minus COD King's deposit line; otherwise
// use the checkout total (correct for normal prepaid / full-COD orders).
function orderValue(c){
  var attrs = {};
  (c.attributes || []).forEach(function(a){ attrs[a.key] = a.value; });

  var original = parseFloat(attrs._codkOriginalTotal);
  if (original > 0) return original;

  var pv = attrs._partial_product_variant;
  if (pv){
    var sum = (c.lineItems || []).reduce(function(t, li){
      var vid = li.variant && li.variant.id ? String(li.variant.id) : '';
      if (vid.indexOf(String(pv)) !== -1) return t; // skip the deposit line item
      var p = li.variant && li.variant.price ? Number(li.variant.price.amount) : 0;
      return t + p * (li.quantity || 1);
    }, 0);
    if (sum > 0) return sum;
  }

  return money(c.totalPrice);
}

function mapLineItems(lineItems){
  return (lineItems || []).map(function(li){
    return {
      item_id:      li.variant && li.variant.product ? li.variant.product.id : undefined,
      item_name:    li.variant && li.variant.product ? li.variant.product.title : (li.title || undefined),
      item_variant: li.variant ? li.variant.title : undefined,
      price:        li.variant ? money(li.variant.price) : undefined,
      quantity:     li.quantity || 1,
    };
  });
}

// ---- checkout funnel (exclusive owner: this pixel) -------------------------
analytics.subscribe('checkout_started', function(e){
  var co = e.data.checkout;
  gtag('event', 'begin_checkout', {
    currency: cur(co.totalPrice),
    value:    orderValue(co),
    items:    mapLineItems(co.lineItems),
  });
});

analytics.subscribe('checkout_shipping_info_submitted', function(e){
  var co = e.data.checkout;
  gtag('event', 'add_shipping_info', {
    currency: cur(co.totalPrice),
    value:    orderValue(co),
    items:    mapLineItems(co.lineItems),
  });
});

analytics.subscribe('payment_info_submitted', function(e){
  var co = e.data.checkout;
  gtag('event', 'add_payment_info', {
    currency: cur(co.totalPrice),
    value:    orderValue(co),
    items:    mapLineItems(co.lineItems),
  });
});

analytics.subscribe('checkout_completed', function(e){
  var co = e.data.checkout;
  gtag('event', 'purchase', {
    transaction_id: co.order ? co.order.id : undefined,
    currency: cur(co.totalPrice),
    value:    orderValue(co),
    tax:      money(co.totalTax),
    shipping: co.shippingLine ? money(co.shippingLine.price) : undefined,
    coupon:   (co.discountApplications && co.discountApplications[0] && co.discountApplications[0].title) || undefined,
    items:    mapLineItems(co.lineItems),
  });
});
