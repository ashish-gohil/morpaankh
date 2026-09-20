# Theme changes for Flow B (on-site reviews) + the WhatsApp notice

These are applied to the LIVE Shopify theme during the gated theme go-live, NOT
pushed automatically. Pull the latest theme first (`shopify theme pull`), apply,
`validate_theme`, then push with the usual `--path theme ... --only <files>`.
The reviews snippet here is authored off `main`; reconcile with the live theme's
current PDP section when applying.

## 1. Reviews block (snippet included in this folder)

Copy `snippets/tapi-product-reviews.liquid` into the theme's `snippets/`, then
render it in `sections/main-product-tapi.liquid` below the product info (near the
existing trust/related area):

```liquid
{% render 'tapi-product-reviews', product: product %}
```

It reads `product.metafields.custom.reviews` (product_review metaobjects the
service links when a review is ACTIVE), shows a star summary + list (5 then
"Show more"), and emits Product JSON-LD `aggregateRating` + `review` only when at
least one review exists. No action needed when there are zero reviews (it renders
nothing). Run `scripts/reviews-setup.mjs --live` once first so the metaobject
definition + storefront access exist.

## 2. WhatsApp order-updates notice (locale string)

Add to the theme's locale files (e.g. `locales/en.default.json`) under a sensible
key, then reference it near the buy buttons on the PDP and in the cart:

```json
"tapi": { "wa_order_updates": "Order updates will be sent on WhatsApp to your verified mobile number." }
```

```liquid
<p class="tapi-wa-notice">{{ 'tapi.wa_order_updates' | t }}</p>
```

Exact string (also in `messages/labels.mjs` THEME_WHATSAPP_NOTICE): keep them in
sync. No emoji, no em/en dash.
