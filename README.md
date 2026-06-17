# MorPaankh

Storefront and supporting services for **MorPaankh** ([www.morpaankh.in](https://www.morpaankh.in)), a women's Indian ethnic wear label. The catalogue is curated kurta sets, co-ord sets, anarkali sets, lehenga sets, and festive pieces, chosen for honest fabric and a fit made for real bodies.

Operated by **Morpaankh Collection** (GSTIN 24CAOPG7375L1Z4).

The brand voice is honest and premium: what you see in the photographs is what arrives. Two rules carry into all customer-facing copy in this repo:

- The name is always written **MorPaankh** (one word). Never "Mor Paankh".
- Never claim pieces are handcrafted. Describe fabric, fit, and occasion honestly instead.

## What's in this repo

This is a small monorepo for everything behind the store.

| Path | What it is |
|------|------------|
| `theme/` | The live Shopify storefront. A Dawn-based theme with a custom design layer (the "Tapi" system). This is what shoppers see. |
| `shipping-integration/` | A standalone Node service that syncs Shopify orders to Shiprocket and relays tracking back. Not deployed inside the theme. |
| `scripts/` | One-off catalogue and asset tooling (create products/collections/pages, metafield definitions, image generation). |
| `docs/` | Working notes: design system, SEO/GEO, and a UX journey audit. |
| `clothing business/shopify/` | Background reference docs (theme architecture, metafields, snippets). |
| `package.json` (root) | Holds `sharp`, used by the image scripts. The store itself has no build step. |

## The theme

`theme/` is a [Dawn](https://github.com/Shopify/dawn)-based theme. Standard Dawn sections are kept; the brand layer is added on top as a set of custom `tapi-*` sections and snippets plus a token-driven design system, so upstream Dawn structure stays recognisable.

### Design system

- CSS custom properties prefixed `--mor-*` and `--tapi-*` for colour, spacing, radius, shadow, and type. Defined centrally in `theme/assets/theme-variables.css`.
- Palette: green primary, terracotta secondary, gold and charcoal as tertiary accents, on a crème field. Adjacent full-width sections alternate cream tone (`cream` ↔ `cream-2`) as a soft separator. The background carries a faint morpaankh feather motif (`--mor-pattern`).
- Type scale uses a `62.5%` rem base (so `1rem` = `10px`). Heading and body font families are set through theme settings.
- Spacing rhythm is driven by `--tapi-section-pad`. Consume the token rather than hard-coding section padding.

See `docs/design-system.md` for the full reference.

### Custom sections (`theme/sections/tapi-*.liquid`)

`tapi-hero`, `tapi-announcement`, `tapi-catalog-strip`, `tapi-collection-tiles`, `tapi-featured-products`, `tapi-editorial-break`, `tapi-studio-strip`, `tapi-press`, `tapi-testimonials`, `tapi-fabric-guide`, `tapi-faq`, `tapi-footer`, `tapi-recently-viewed`, `tapi-wishlist`, `tapi-track-order`, `tapi-sign-in-entry`.

### Custom snippets (`theme/snippets/tapi-*.liquid`)

`tapi-logo`, `tapi-bottom-nav`, `tapi-share`, `tapi-wishlist-button`, `tapi-sort-dropdown`.

### Notable storefront features

- **Mobile-first hero** with a `<picture>` that serves the correct crop per viewport (no desktop image flashing on phones) and optional per-viewport video.
- **Full-screen product gallery** with pinch, double-tap, and drag-to-pan zoom, keyboard and swipe navigation, and a focus trap.
- **Wishlist** stored in `localStorage` (works for guests and signed-in shoppers), with hearts on cards and the PDP, a live header count, and a dedicated `/pages/wishlist` page. The persistence layer is behind a small adapter so a future server-sync can drop in.
- **Mobile bottom navigation** (`tapi-bottom-nav`) with cart and wishlist count bubbles.
- **Recently viewed** rail on the home page and PDP, hydrated client-side.
- **Native share** with a branded fallback (WhatsApp, Telegram, email, copy link).
- **On-PDP size guide** as an accessible inline dialog.
- **COD and prepaid nudges** surfaced on the PDP, plus a Shiprocket-backed order tracking page at `/pages/track-order`.

Shared client logic lives in `theme/assets/tapi-ux.js` and `theme/assets/tapi-motion.js`; shared styles in `theme/assets/tapi-ux.css` and `theme/assets/theme-variables.css`. Everything is progressive enhancement and re-initialises on Shopify section reload.

## Local development and deploy

The theme targets the **Morpaankh** theme (`#189198631284`) on the `sawri-bawri.myshopify.com` store. Work happens inside `theme/`.

```bash
# install the Shopify CLI once
# https://shopify.dev/docs/themes/tools/cli

# pull the live theme before editing (it is the source of truth)
shopify theme pull --path theme --theme 189198631284 --store sawri-bawri.myshopify.com

# preview locally
cd theme && shopify theme dev --store sawri-bawri.myshopify.com

# push a single file (or omit --only for the whole theme)
shopify theme push --path theme --theme 189198631284 \
  --store sawri-bawri.myshopify.com --allow-live --nodelete \
  --only sections/tapi-hero.liquid
```

Conventions worth knowing:

- **Always pull before editing.** The live theme is the source of truth.
- **Always pass `--path theme`.** Edits and pushes must target the `theme/` directory.
- **Verify deploys via the Shopify Admin API**, not the page URL. Shopify's full-page CDN cache can serve a stale homepage for a few minutes after a push even though the theme file is already updated.
- The store runs on a Basic plan, so some behaviours (COD enforcement, certain filters) are app- or settings-gated rather than themeable. Those are documented in `docs/`.

## Shipping integration

`shipping-integration/` is an independent Express service. On a Shopify `orders/create` webhook it creates the order in Shiprocket, and it exposes tracking that the theme's track-order page reads. It is not part of the theme bundle.

```bash
cd shipping-integration
cp .env.example .env   # fill in Shopify and Shiprocket credentials
npm install
npm start
npm test               # smoke test
node scripts/register-webhooks.js   # register the Shopify webhooks
```

See `shipping-integration/README.md` for endpoints, environment variables, and the order-status mapping.

## Scripts

`scripts/` holds catalogue setup and asset tooling used during the store build: `create-products.js`, `create-collections.sh`, `create-pages.sh`, `create-metafield-defs.sh`, and `generate-images.js` (uses `sharp`). These are run on demand, not part of any pipeline.

## Documentation

- `docs/design-system.md` - tokens, colour, type, components, interaction states.
- `docs/seo-geo.md` - SEO and generative-engine-optimisation notes.
- `docs/ux-journey-audit-2026-06-12.md` - UX audit and findings.
- `clothing business/shopify/` - theme architecture, metafields, and snippet reference.

## License

The theme inherits Dawn's license (`theme/LICENSE.md`). Brand assets, copy, product data, and the custom `tapi-*` code are proprietary to Morpaankh Collection.
