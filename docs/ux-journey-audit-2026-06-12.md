# MorPaankh UX journey and friction audit

Date: 2026-06-12. Scope: full purchase funnel on the live theme (189198631284), mobile-first, benchmarked against Libas, Bunaai, and Aachho (live-site analysis same day). Method: simulated first-click and scroll-depth reasoning per screen, thumb-zone review at 360 to 430px widths, render verification with real cart sessions, and a live accessibility engine pass. No analytics are installed yet, so behavioral claims below are heuristic predictions to validate against real data after launch.

## Funnel walkthrough

### 1. Arrival (home, mobile)
- **Attention path**: announcement offer, then hero image, then CTA. The announcement carries a real value claim ("Pay online and save 5% / Free shipping over Rs 2,000"), matching the offer-led pattern all three competitors lead with, without fake urgency.
- **First click prediction**: hero CTA or bottom-nav Search. Both reachable. Bottom nav (Home/Search/Cart/Account/Wishlist) matches Aachho's discovery pattern.
- **Friction found earlier in project, already fixed**: above-fold reveal flash (content painted, hid, faded back) was killed by synchronous in-viewport reveal; hero autoplay now waits for window load.
- **Open item (merchant)**: test slide `slide_cwredk` has an empty caption; share image (1200x630) not uploaded, so WhatsApp shares of the homepage have no image. Both are editor-side.

### 2. Discovery (PLP / collection)
- Cards: 2-up mobile grid, struck MRP + savings, color dots, low-stock and sold-out states, wishlist heart, title clamped to 2 lines with reserved height so rows stay even. Material/rating/GSM deferred to PDP on mobile to keep scan speed high. This matches or beats the competitor card anatomy.
- Filtering and sorting render in tokenized panels; facets verified.
- **No action needed this pass.**

### 3. Consideration (PDP)
- Visible breadcrumb (Home / Collection / Product) plus BreadcrumbList JSON-LD; gallery with one eager LCP image and the rest lazy; sticky mobile buy bar; size guide link; honest perks line under buy button (merchant-gated); Shipping & returns accordion with true terms; fullscreen viewer, share, recently-viewed rail.
- **Friction found and fixed earlier in project**: phantom empty blocks for unset metafields (tags, fabric accordion, subtitle) ate vertical space on every PDP; all are now conditionally rendered.
- **Deliberately absent**: fake review counts and aggregateRating (no real reviews yet), countdown timers, "X people viewing". These violate the honest-premium positioning, which is where this store outperforms the benchmark on trust.

### 4. Cart (the gap this audit closed)
- **Found**: a shopper at Rs 1,800 had no signal they were Rs 200 from free shipping, and the checkout button stood alone at the moment of highest payment anxiety. Every benchmark competitor closes both.
- **Shipped (commit 36319bc)**: free-shipping progress meter inside the cart's re-rendered region (live-updates on quantity change, zero new JS, fill capped 4 to 96 percent below threshold so it never reads as done early) and a three-line assurance row under checkout (free shipping over Rs 2,000, 7-day defect resolution, secure checkout). Verified with a real cart session at Rs 1,999 (meter showed "Add Rs. 1.00 more") and above threshold ("Your order ships free." at 100 percent). Both merchant-gated: one checkbox each to roll back.

### 5. Checkout
- Shopify-hosted; theme work cannot and should not alter it. Trust is front-loaded in the cart instead (assurance row), which is the correct lever available on this plan.

### 6. Post-purchase (order + tracking)
- **Found**: the Track Order page and the order page tracking block were rendering at roughly 60 percent of intended size (styles written against a 16px rem base while Dawn sets 62.5 percent, so labels hit 8px and inputs 10px, below the iOS zoom threshold).
- **Shipped (commit e7b6791)**: rescaled to the theme type scale (inputs 16px), radii and shadows folded into the `--mor-*` tokens. Verified live: compiled CSS, Admin API checksums, accessibility pass clean (only flags were payment-brand logo SVGs, exempt under WCAG logo provisions).

## Micro-interaction inventory (Animation & Interaction dimension)
Already present: scroll reveals with in-viewport synchronous first paint, magnetic hero CTA (clamped travel), card hover lift + image zoom + dual-image crossfade, touch press feedback block (scale 0.96 with hover-stuck prevention), tokenized durations/easings, prefers-reduced-motion respected throughout.
Added this pass: cart bubble pop on add-to-cart (mount animation replays on Dawn's section re-render, zero JS, reduced-motion guarded).
Rejected: three.js (150KB+ and GPU cost against slow-network mobile traffic, no conversion value for garments) and GSAP (30 to 60KB to recreate an existing zero-cost motion system). Premium speed is a brand feature; Speed Index is already the weakest Lighthouse metric.

## Copy and trust (Content dimension)
Storefront copy was through the premium-honesty rewrite in prior stages. This pass closed the last gap: four product bodies still claimed hand-work ("set by hand", "hand block-printed", "hand embroidery", "handloom") that cannot be verified; all four rewritten via Admin API with the sensory voice intact. Every claim on the store is now defensible.

## SEO (end-to-end status)
Done: Product+Offer+Breadcrumb, CollectionPage+ItemList, Organization, FAQPage JSON-LD; SEO titles and metas on all 13 products and 4 collections; robots.txt admitting AI crawlers plus /llms.txt; OG/Twitter dedup; productType on all products; featured-image alt text written for all 13 products (this pass). Remaining: homepage share image upload (merchant), real reviews to unlock aggregateRating later.

## Validation plan once traffic exists
Install analytics (Shopify native + optionally Microsoft Clarity for real heatmaps/scroll maps, free). Watch: announcement-bar click rate, PLP-to-PDP rate, PDP add-to-cart rate, cart-to-checkout rate before vs after the meter, and AOV distribution around the Rs 2,000 threshold. Every feature shipped is a one-checkbox rollback if a metric regresses.

## Navigation addendum (same day, later pass)
- **Found**: desktop header showed Catalog as a flat link to /collections/all; reaching a specific category cost two clicks plus a scroll. All three competitors expose categories on hover. The mobile drawer had a custom accordion (added earlier because the menu had no children).
- **Shipped (menu data, zero theme code)**: gave the main menu's Catalog item five real children via the Menu API (New Arrivals, Kurta Sets, Co-ord Sets, Festive Edit, View all). Dawn's native mega menu now renders the desktop dropdown with active-state highlighting, and the drawer automatically switched from the custom accordion to native children because the native branch precedes it. One source of truth (the menu), native rendering everywhere, one click saved on every desktop category visit. Rollback: remove the child items in Admin Navigation.
- **Also fixed**: footer rendered dead href-less social anchors when a link was unset; now hidden until set. Testimonials section shipped pre-wired but invisible until real quotes are added (no fabricated social proof, no review JSON-LD by design).
- **Deliberately skipped**: deleting the legacy `.product-grid .card__*` CSS block. It is mostly dead (product grids use the tapi card) but search results can render Dawn article cards inside a product grid, so removal risks a regression for a few hundred bytes. Documented instead of deleted.

## Measured behavioral audit (instrumented, same day)
Method: Playwright-core driving Edge with true device emulation (iPhone-class 390x844 DPR3 with viewport meta honored, and 1440x900 desktop), all 10 templates, measuring document height, scroll depth to the primary CTA, CTA hit-box size, tap-target geometry across header and bottom nav, and horizontal overflow. This is the closest available proxy for scroll-depth and click-pattern analysis before analytics exist.

Results (mobile / desktop):
- Horizontal overflow: 0px on every page at both viewports. No layout breakage anywhere.
- PLP and search: first product card reachable at 0.43 and 0.46 screens (mobile). Product discovery is effectively immediate.
- Filled cart: checkout button 360x48 at 0.83 screens (mobile), with the shipping meter rendering above it ("Your order ships free." state verified in-browser). Desktop PDP add-to-cart at 0.89 screens, visible without scrolling.
- Contact form submit at 0.82 screens, track-order CTA at 0.64 (mobile). Page lengths 2.0 to 5.6 screens except the fabric guide (9 screens, intentional reference content).
- Home hero CTA sits at 1.22 screens on mobile (announcement bar + header + catalog strip push the hero down). Observation, not a defect: the catalog strip above the hero IS the primary discovery path and sits fully above the fold.
- Tap targets: one real violation found and fixed, the header search clear button at 24x24 (16px icon + 4px padding). Now a 44px minimum touch box with the icon visually unchanged. The 31px nav-link geometry flagged on mobile was confirmed an artifact (computed style display:none; screenshot shows a clean mobile header). Logo link is 153x36, wide enough in area to be a non-issue.
- Mobile header screenshot verified: announcement, burger/logo/search header, catalog chip strip, hero, in that order, no desktop nav leak after the menu change.
