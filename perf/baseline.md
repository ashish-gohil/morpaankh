# Morpaankh storefront — performance baseline (CHECKPOINT 1)

Date: 2026-08-12 · Live theme `189198631284` · Store `www.morpaankh.in` (edge: Cloudflare → Shopify, POP: Bombay/BOM, India)
Measurement device profile: mobile (390–430 CSS-px Android, the dominant visitor).

## 0. Method + what is and isn't measured here

The work order asks for Lighthouse mobile, 3-run medians. Two blockers hit today:

- **Keyless PageSpeed Insights quota is exhausted** for the day (`Queries per day` limit on the shared anonymous key) — no cloud Lighthouse until it resets (~00:00 PT) or an API key is supplied.
- **Local headless Lighthouse cannot run in this shell.** Chrome-for-Testing installs and renders pages fine standalone, but the sandbox denies Lighthouse permission to control the Chrome it spawns (`kill EPERM` → `Connection closed`) on every run, sandboxed or not. The same `npx lighthouse` command run in your own terminal would work.

So the numbers below are **directly measured over the network against the live pages** (HTTP headers, real asset transfer sizes, real image weights, DOM counts from the served HTML) — these are hard facts. The Lighthouse composite score and lab LCP/CLS/INP/TBT are the one **pending** row; fastest way to fill it is at the bottom (§8).

## 1. Baseline metrics (real, measured)

| Signal | Home `/` | PDP `/products/bandhan` | Collection `/collections/all` | Cart `/cart` |
|---|---|---|---|---|
| Server render (server-timing) | ~230 ms (`processing 165` + `render 66`) | not isolated | not isolated | light (native) |
| TTFB / edge | Cloudflare BOM, `cf-cache-status: DYNAMIC` (HTML not edge-cached) | same | same | same |
| HTML document — transfer (gzip) | **51 KB** | **59 KB** | **64 KB** | light |
| HTML document — decompressed | 281 KB | 301 KB | **420 KB** (heaviest) | — |
| `<img>` nodes in initial HTML | 47 | 44 | 75 | — |
| `<div>` nodes | 257 | 130 | **405** | — |
| `<script>` tags | 52 | 61 | 55 | — |
| `/cdn` image URL references | 47 | **146** (14 distinct photos → ~10×/photo) | 75+ | — |
| LCP / CLS / INP / TBT / LH score | **pending (see §0/§8)** | pending | pending | pending |

Render-blocking CSS and deferred JS weights are page-agnostic (same shell) and measured in §2.

## 2. Render path (real transfer sizes, gzip)

### Render-blocking `<link rel=stylesheet>` (synchronous, in `<head>`)
All three are emitted by `theme/layout/theme.liquid`:

| File | Line | Transfer | Note |
|---|---|---|---|
| `base.css` | `layout/theme.liquid:345` | 10 KB | Dawn core (already trimmed) |
| `theme-variables.css` | `layout/theme.liquid:346` | **12 KB** | design-tokens SSOT + all `:root` vars — biggest blocker |
| `tapi-ux.css` | `layout/theme.liquid:347` | 2 KB | brand UX layer |
| **Total render-blocking CSS** | | **~24 KB** | modest — CSS is *not* the primary villain |

Everything else CSS is already off the critical path: fonts load `print`→`onload` swap (`theme.liquid:62`), `component-cart-items.css` async (`:389`), predictive-search CSS async (`:420`). Total CSS across the page ≈ 40 KB.

### Scripts
- **Theme JS is lean and fully deferred** (not render-blocking): `constants/pubsub/global/details-*/search-form` (`theme.liquid:118–123`), `tapi-motion.js` + `tapi-ux.js` (`:348–349`), `tapi-analytics.js` (`:380`), predictive-search (`:526`). Sum ≈ 20 KB. Good.
- **The heavy JS is Shopify-injected via `{{ content_for_header }}` (`theme.liquid:129`), not the theme:**
  - `portable-wallets.en.js` — **74 KB** (Shop Pay / Apple Pay / Google Pay dynamic-checkout buttons). Single biggest script on the page.
  - `shopify-perf-kit-3.8.2.min.js` — 22 KB.
  - `standard-actions.js`, `loader.init-shop-cart-sync`, `load_feature`, `scripts.js`, plus Shopify `styles.css` 12 KB.
  - Total page JS ≈ **125 KB gzip**, ~95 KB of it Shopify/checkout, ~20 KB theme.

**Takeaway:** the classic Dawn render-blocking problem is largely already solved here (JS deferred, fonts async, blocking CSS only 24 KB). The weight sits in (a) Shopify's wallet/checkout JS on every page, and (b) **images + DOM size**, below.

## 3. Images (real delivered weights)

- **Shopify CDN already serves WebP** to modern browsers (verified `content-type: image/webp` with an `Accept: image/webp` request). No format is force-pinned in markup (`format=` absent) — so **do NOT "convert to WebP / force pjpg"; that would break auto-WebP.** This corrects a common assumption.
- Real delivered weights are moderate **because the sources are low-resolution**: PDP main photo = **92 KB** at width 1200 **and identical 92 KB at width 2048** — i.e. the source tops out around ~1200 px. Mobile hero (WhatsApp jpg) = 85 KB at 1200.
- **Sources are phone/WhatsApp exports**, confirmed by filenames throughout: `WhatsAppImage2026-06-25at7.03.01PM_1.jpg`, `rn-image_picker_lib_temp_*.jpg` (React-Native picker temp names), `photo_6219828727785394378_x.jpg`. Double-compressed and soft on retina.
- **Homepage heroes are PNG** for photographic content (`Gemini_Generated_Image_*.png`, desktop slides in `templates/index.json:128/138/148`). PNG for photos is the §3 target (desktop LCP). Mobile uses `image_mobile` WhatsApp jpgs.
- **The real image cost is render multiplicity, not per-file bytes:** the PDP references **146 image URLs for 14 distinct photos** — each photo rendered ~10× (main gallery, thumb strip, second carousel, second thumb strip, fullscreen lightbox full-res @2048, lightbox thumbs). That is DOM weight + decode + speculative fetch overhead, and it is the single biggest structural problem found.

## 4. Pre-rendered heavy blocks in initial PDP HTML (confirmed)

Grep of the served PDP HTML:
- **Fullscreen lightbox: 18 zoomable `<img>` pre-rendered** in the initial document (`data-zoomable` / `tapi-lightbox__img`), including `width:2048` variants. Lazy-loaded, but present as nodes/URLs on first paint.
- **Size-guide table pre-rendered** (8 matches) — full table ships in HTML instead of on-demand.
- **Offers/accordion block pre-rendered** (15 matches).
- **Predictive-search results: NOT pre-populated** (0) — this one is already on-demand. (Corrects the work-order assumption that search results are pre-rendered.)

## 5. Third-party inventory (where each loads)

| Domain | Purpose | Loads on | Source |
|---|---|---|---|
| `fonts.googleapis.com` + `fonts.gstatic.com` | Google Fonts (Cormorant, Marcellus, Inter) | every page (async swap) | `theme.liquid:50–72` |
| `www.googletagmanager.com` | GA4 gtag (`G-T0YLNND1JT`) | every page | `tapi-analytics.js`, gated on GA4 id |
| `connect.facebook.net` | Meta Pixel base | via Shopify Facebook/Instagram channel (theme `meta_pixel_id` is **blank**) | `content_for_header` |
| COD King app embed | COD availability / OTP / partial-payment | every page | `settings_data.json:159` (`disabled:false`) |
| `shiprocket.co` | order tracking | `/pages/track-order` only | theme snippet |
| `youtube.com` / `player.vimeo.com` | video embeds | only if a video block is used | section markup |

`gtm_container_id` is blank → the GTM noscript iframe (`theme.liquid:442`) does **not** render. Only app embed present is **COD King** (single, enabled).

## 6. Redirect chain + attribution (measured)

```
http://morpaankh.in/        → 301 → https://morpaankh.in/            (http→https)
https://morpaankh.in/       → 301 → https://www.morpaankh.in/        (canonical_host_redirection)
https://www.morpaankh.in/   → 200                                    (final)
```

- An ad pointing at **`http://morpaankh.in`** eats **two** 301 hops; at **`https://morpaankh.in`** (apex) eats **one**; at **`https://www.morpaankh.in`** eats **zero**. Each hop = DNS/TLS/TTFB of dead time before first paint on mobile.
- **`fbclid` IS preserved through the redirect** — verified: `https://morpaankh.in/?fbclid=TEST` → `location: https://www.morpaankh.in/?fbclid=TEST`, and the deep-link `…/products/bandhan?fbclid=TEST` is preserved too. So the redirect is **not** stripping Meta attribution; it only adds latency. The theme also captures `fbclid`→`_fbc` cookie on landing (`theme.liquid:357–372`). Good.

## 7. Ranked cause — the 36% ad-click → landing-page-view loss (63.7%)

Meta counts a *link click* but only logs a *Landing Page View* once the page loads far enough for the pixel to fire. 63.7% is well below the ~85–90% healthy band, and the gap is mostly recoverable. Ranked:

1. **Mobile load latency before the pixel fires (highest impact).** On Indian mobile networks, users tap-and-leave before the page paints and the pixel/LPV fires. Contributors measured above: ~125 KB JS per page (74 KB of it the Shop Pay wallet bundle on pages that don't need it), heavy DOM (collection 405 divs; PDP 146 image URLs), WhatsApp-sourced hero as the mobile LCP, and the DYNAMIC (non-edge-cached) HTML. Fix = cut mobile TTI + make first paint + pixel fire sooner.

2. **Ad destination redirect hop (cheapest fix, needs your Ads Manager to confirm).** If the live ad URLs point at the apex or `http://` (very common), every click pays 1–2 redirects before anything renders. Sending all ad traffic to the canonical **`https://www.morpaankh.in/…`** removes that dead time outright. *Requires confirming the actual destination URLs in Meta Ads Manager — I can't see them from the storefront.*

3. **Pixel undercount from late fire / ITP / blockers (real but lower).** Some "lost" LPVs are measurement artifacts, not lost humans — client-only pixel timing on slow loads, iOS ITP, ad-blockers. The §6 EMQ work (CAPI dedup, `_fbc`) mitigates this; attribution itself is intact (redirect preserves `fbclid`).

Net: **1 and 2 are intertwined and account for most of the gap** — both say "make the first paint and the pixel happen faster, and point ads at the canonical www/https URL." 2 is a one-line change once the ad URLs are confirmed.

## 8. To fill the one pending row (Lighthouse lab scores)

Any one of these unblocks it — no code needed:
- **You run it locally** (works in your own terminal, unlike this sandbox): `npx lighthouse https://www.morpaankh.in/ --form-factor=mobile --view` for each of the 4 URLs. Paste the JSON/scores back.
- **Provide a free PageSpeed Insights API key** (raises the daily quota) and I'll run all 4 × 3 and compute medians myself.
- **Wait for the keyless PSI quota reset** (~24h) and I re-run automatically.

## 9. Scope notes
- COD gateway config is out of scope (already fixed) — not touched.
- Dummy ratings / `aggregateRating` verification (§4/§7 of the work order) intentionally skipped — you're handling that manually.
- No code changed at CHECKPOINT 1 (measurement only), per the work order.
