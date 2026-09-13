# Phase 1 — Product page asset inventory

Page: https://www.morpaankh.in/products/bandhan (live), captured 2026-09-13. HTML = 322 KB.

## Scripts
- **External `<script src>`: 22 total**
  - 18 from `www.morpaankh.in` (theme/app assets on Shopify CDN + app-block injected)
  - 4 from `cdn.shopify.com` (Shopify platform: analytics, consent, web-pixels, etc.)
- **Inline `<script>` blocks: 42, ~179 KB total.** Includes: 4 JSON-LD blocks, Shopify analytics/monorail bootstrap, COD King config, theme init. This is the single largest parse/execute cost on the page and is uncacheable across pages.

## Link tags (40 total)
| rel | count | notes |
|-----|-------|-------|
| stylesheet | 28 (23 unique) | Dawn per-component CSS + compiled bundle + theme CSS + Google Fonts + COD King + portable-wallets |
| preconnect | 4 | |
| dns-prefetch | 3 | |
| preload | 1 | Google Fonts CSS (as style) |
| canonical | 1 | https://www.morpaankh.in/products/bandhan (correct) |
| alternate | 1 | |
| icon | 1 | |
| apple-touch-icon | 1 | |

### Stylesheets (source-attributed)
Theme (Shopify CDN `/cdn/shop/t/2/assets/`): base, component-card, component-cart-items, component-cart-notification, component-list-menu, component-mega-menu, component-menu-drawer, component-predictive-search, component-price, component-search, header-fix, pdp-cta, pdp-offers, pdp-trust, pdp-video, section-related-products, tapi-offers, tapi-ux, theme-variables, + compiled_assets/styles.css
Third-party: `fonts.googleapis.com` (Cormorant Garamond + Marcellus + Inter, display=swap), COD King app (`cdn.shopify.com/extensions/.../cod-king-payment-js-438`), Shopify portable-wallets accelerated-checkout.

## LCP / fonts
- LCP candidate: featured product image (`width=1200`), `loading=eager` + `fetchpriority=high` — correct.
- Fonts preloaded (as style) with `display=swap`.

## Structured data (JSON-LD, 4 blocks)
Organization, Product (no aggregateRating/review — correct), WebSite (in @graph), BreadcrumbList.

## NOT captured (blocked)
- Lighthouse mobile category scores (Performance/A11y/Best-practices/SEO) and lab CWV — PSI keyless quota exhausted (429), no API key, local headless Lighthouse sandbox-blocked. Needs a PSI key or a Chrome measurement session.
