# MorPaankh setup checklist (everything is free)

Every item here is something only the store owner can create. Nothing needs a
paid Shopify app. Do them in this order; item 3 first because Meta's business
verification takes days. After each one, tell Claude and the wiring gets done
the same day.

## 1. Google Analytics 4 (5 minutes) — unlocks the analytics module

1. Go to analytics.google.com, sign in with the store's Google account.
2. Admin (gear, bottom left) → Create → Property. Name "MorPaankh",
   timezone India, currency INR.
3. Add a Web data stream for `https://www.morpaankh.in`. Copy the
   Measurement ID (looks like `G-XXXXXXXXXX`).
4. Shopify Admin → Online Store → Themes → Customize → Theme settings
   (bottom left) → Analytics → paste the ID → Save.

That switches on the event stream already built into the theme: product views,
add to cart, checkout clicks, offer impressions, wishlist adds. Nothing loads
for visitors until the ID is saved.

**Purchase tracking** (checkout pages are outside the theme, so the theme
CANNOT fire the order event — it must be a Customer Events pixel): Shopify
Admin → Settings → Customer events → Add custom pixel, name it `ga4-purchase`,
paste the code below (the real GA4 ID is already filled in), Save, then click
**Connect**. Connect is what actually turns the pixel on. A pixel that is
saved but left unconnected does nothing, which is the usual reason orders
never reach GA4.

```js
// GA4 checkout funnel for Morpaankh. Runs on Shopify's checkout pages, which
// the theme cannot reach. Sends ONLY to GA4 via gtag (never fbq, so the Meta
// channel pixel is untouched). Storefront events (view_item, add_to_cart,
// view_cart, select_item, apply_coupon) are fired by the theme, so they are
// deliberately NOT repeated here to avoid double counting.
const GA4_ID = 'G-T0YLNND1JT';

const s = document.createElement('script');
s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
s.async = true;
document.head.appendChild(s);

window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', GA4_ID, { send_page_view: false });

function tapiItems(lineItems) {
  return (lineItems || []).map(function (li) {
    return {
      item_id: (li.variant && li.variant.sku) || (li.variant && li.variant.id) || li.id,
      item_name: li.title,
      item_brand: 'Morpaankh',
      quantity: li.quantity,
      price: li.variant && li.variant.price && li.variant.price.amount,
    };
  });
}
function tapiCoupon(c) {
  var d = c.discountApplications && c.discountApplications[0];
  return (d && d.title) ? d.title : undefined;
}

analytics.subscribe('checkout_started', function (event) {
  var c = event.data.checkout;
  gtag('event', 'begin_checkout', {
    currency: c.currencyCode,
    value: c.totalPrice && c.totalPrice.amount,
    coupon: tapiCoupon(c),
    items: tapiItems(c.lineItems),
  });
});

analytics.subscribe('checkout_shipping_info_submitted', function (event) {
  var c = event.data.checkout;
  gtag('event', 'add_shipping_info', {
    currency: c.currencyCode,
    value: c.totalPrice && c.totalPrice.amount,
    coupon: tapiCoupon(c),
    shipping_tier: c.delivery && c.delivery.selectedDeliveryOptions && c.delivery.selectedDeliveryOptions[0] && c.delivery.selectedDeliveryOptions[0].title,
    items: tapiItems(c.lineItems),
  });
});

analytics.subscribe('payment_info_submitted', function (event) {
  var c = event.data.checkout;
  gtag('event', 'add_payment_info', {
    currency: c.currencyCode,
    value: c.totalPrice && c.totalPrice.amount,
    coupon: tapiCoupon(c),
    items: tapiItems(c.lineItems),
  });
});

analytics.subscribe('checkout_completed', function (event) {
  var c = event.data.checkout;
  gtag('event', 'purchase', {
    transaction_id: (c.order && c.order.id) || c.token,
    value: c.totalPrice && c.totalPrice.amount,
    currency: c.currencyCode,
    coupon: tapiCoupon(c),
    tax: c.totalTax && c.totalTax.amount,
    shipping: c.shippingLine && c.shippingLine.price && c.shippingLine.price.amount,
    items: tapiItems(c.lineItems),
  });
});
```

Verify: place a real or test order, then check GA4 → Admin → Realtime and
DebugView (tick Theme settings → Analytics → Debug mode first). Both show the
purchase within seconds. Standard reports (the Reports snapshot, Monetisation,
etc.) lag 24 to 48 hours, so a same-day order not appearing there is normal
even when the pixel is working. Untick Debug when done.

## 2. Native abandoned-checkout email (2 minutes)

Shopify Admin → Marketing → Automations → Abandoned checkout → Turn on.
Free, best email deliverability available, zero maintenance. The WhatsApp
recovery flow (below) complements this; it never sends a second email.

## 3. Meta WhatsApp Cloud API (start today; verification takes days)

1. business.facebook.com → create a Business Portfolio for MorPaankh if none.
2. developers.facebook.com → My Apps → Create App → type "Business" →
   add the WhatsApp product.
3. Complete business verification in Business Manager (GSTIN + address help).
4. Add a phone number for WhatsApp. It must NOT be a number already on
   personal WhatsApp. A fresh SIM or a virtual number works.
5. Note the **Phone number ID** (WhatsApp → API Setup) and create a
   **permanent access token**: Business Settings → Users → System Users →
   Add → assign the app with whatsapp_business_messaging permission →
   Generate token.
6. WhatsApp Manager → Message templates → create the five templates exactly
   as written in `shipping-integration/docs/whatsapp-templates.md` (names,
   categories, and variable order matter). Approval usually takes hours.

Free tier: ~1,000 conversations/month, then roughly Rs 0.35 per utility
message. No third-party WhatsApp service needed, ever.

## 4. AWS account (hosts the automation platform + hub, free tier)

1. aws.amazon.com → Create account (card required, stays on free tier).
2. Follow `~/node-workflow/DEPLOYMENT.md` STEP 2 to create the
   `workflow-deployer` IAM user and save its access keys.

## 5. MongoDB Atlas (database, free M0)

mongodb.com/atlas → sign up → build a free M0 cluster (AWS Mumbai region) →
Database Access: create a user → Network Access: allow 0.0.0.0/0 (Lambda has
no fixed IP) → copy the connection string.

## 6. Brevo (email API, free 300/day)

1. brevo.com → sign up → Settings → API Keys → generate one.
2. Senders & Domains → Domains → add morpaankh.in → it shows two or three
   DNS records (SPF/DKIM) → add them at the domain registrar → verify.
   Without this step emails land in spam; with it they land in inboxes.

## 7. Shopify custom app token (for the automation hub, 5 minutes)

Shopify Admin → Settings → Apps and sales channels → Develop apps →
Allow custom app development → Create app, name `morpaankh-hub` →
Configuration → Admin API scopes: `read_orders, write_orders, read_checkouts,
read_customers, read_fulfillments, write_fulfillments,
read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders`
→ Install app → reveal the Admin API access token once and save it, plus the
API secret key. These go into `shipping-integration/.env`.

## 8. Shopify Search & Discovery app (free, by Shopify)

Shopify App Store → "Search & Discovery" (by Shopify) → Add app. Then
Filters → add Fabric / Occasion / Colour / Size from the existing tags.
This is the only "app" on this list and it is Shopify's own, free.

## 9. Ten-minute odds and ends

- **Payment badges**: Settings → Payments → in the Razorpay/payments section
  enable showing card/UPI logos at checkout.
- **Bing**: bing.com/webmasters → Import from Google Search Console.
- **Google Business Profile**: business.google.com → create the profile with
  the Surat address, link www.morpaankh.in.
- **GSC API key** (optional, lets Claude monitor indexing): Google Cloud
  Console → new project → enable "Search Console API" → Service account →
  create key (JSON) → save it as `~/.config/gsc/morpaankh-sa.json` → in
  Search Console, add the service account email as a user on the property.

## What happens after each item (Claude's side, same day)

| You finish | Claude does |
|---|---|
| 1. GA4 ID saved | verifies events in DebugView flow, confirms funnel wiring |
| 3. WhatsApp creds + approved templates | fills hub `.env`, dry-run rehearsal, live smoke test to your own number |
| 4+5. AWS + Atlas | deploys node-workflow (API, poller, executor) + the hub to Lambda, seeds the three flows inactive, runs them manually, then activates |
| 6. Brevo key + DNS verified | enables Brevo in the hub, test email |
| 7. Custom app token | hub talks to the store; everything above becomes live |

The order flows that then run by themselves: abandoned checkout WhatsApp
(1h after), COD confirmation WhatsApp, shipped/delivered WhatsApp, day-3
review request. All deduped, consent-gated, with full run history in the
workflow platform's UI.
