# SEO + Performance Audit — progress checkpoint

Branch: `audit/seo-perf` (off `main`). Never edit live theme / checkout. Shopify MCP read-only until fix phase.
Started: 2026-09-13. Store: https://www.morpaankh.in (theme id 189198631284, store sawri-bawri.myshopify.com).

## Tooling reality (verified this session)
- **PageSpeed Insights API**: keyless shared quota EXHAUSTED (HTTP 429). No Google API key in env. Local headless Lighthouse is sandbox-blocked (prior finding). => Lighthouse category SCORES not obtainable without a PSI key or a Chrome session. Will NOT fabricate scores.
- **Clarity MCP**: NOT connected to this session (no `mcp__*clarity*` tool available). Phase 5 rage/dead-click cross-check BLOCKED until connected.
- **GSC**: no credentials. Needed to diagnose the indexing P0 (coverage, manual actions, sitemap submission).
- Available & used: curl (live HTML), WebSearch (index check), Shopify MCP (read), Chrome extension (available, not yet used), accesslint, claude-seo (no google creds).

## Plugins (named by user vs installed)
Installed & usable: code-review, feature-dev, code-simplifier, accesslint (=accessibility-review), frontend-design, humanizer, claude-seo, designer-skills, ui-ux-pro-max.
Named but NOT installed (dropped per instruction): engineering:debug, engineering:tech-debt, engineering:testing-strategy, engineering:documentation, design:ux-copy.

## Phase status
- [x] Setup: branch + audit/ dirs
- [~] Phase 1 Baseline: asset inventory DONE (audit/baseline/product-page-assets.md). Lighthouse scores BLOCKED (no PSI key / Chrome).
- [~] Phase 2 Technical SEO: on-page done from live HTML (below). Theme file:line tracing pending for a few items.
- [x] Phase 3 Content SEO: CSVs BUILT per user ("build it now"). audit/seo-import.csv (52 products) + audit/seo-import-collections.csv (12 colls). Keyword map is FACT-DERIVED (category+fabric+tags), NOT autocomplete/PAA/competitor-scraped (honest limitation; no volumes invented). No writes to store.
- [~] Phase 4 Performance: static analysis done. Chrome session run 2026-09-13 but reliable CWV NOT obtainable: extension can't emulate throttled mobile (resize doesn't change innerWidth, stayed 1462px), LCP/FCP/CLS read 0. Real signals captured: JS ~286KB of ~297KB home transfer; load event fired ~25s (something delays it — likely slow third-party/beacon/video). For trustworthy mobile CWV scores -> PSI API key needed. Will NOT fabricate scores.
- [x] Phase 5 Flows (core, desktop viewport): home + PDP(bandhan) + add-to-cart + cart all FUNCTIONAL, ZERO console errors through the funnel. ATC works; cart auto-applies WELCOME150 (1349->1199, correct, not a bug); Check out button present. Confirmed C2 (cart renders 2 H1s even with items; held). Test cart item cleared, tab closed. NOT done: full 360/390/768/1440 matrix (mobile emulation impossible via extension), search/filter/404 walk, checkout completion (avoided COD King OTP modal). Clarity cross-check: not connected (near-zero traffic pre-index anyway).
- [~] Phase 6 RCA table done (audit/rca.md) for Phases 1/2/4-static + P0. Perf-timing + flows rows pending Chrome.
- [x] Phase 7 Fixes (code): C1 og:price DEPLOYED LIVE (theme 189198631284) + verified (renders 1349.00 on bandhan/taana/morani). Committed 2bf7991, branch pushed to origin. Preview theme AUDIT-C1-preview id 193424687476 created for verify (safe to delete). C2 cart-H1 HELD per user. Watch&Buy: verified already shoppable (View-product link + ATC + size chips in tapi-story-player + tapi-story.js) — NO change needed.
- [x] Store-data fixes APPLIED 2026-09-13 (user approved), 0 failures, verified live: 46 product SEO (38 tightened descs + toran/haldi new SEO + title trims; rest no-op re-writes), ghera productType=Festival Set, 10 collection SEO (best-sellers title + anarkali/co-ord/festive/one-piece descs tightened; rest no-op), 5 featured-image alts (toran/haldi/nazakat/anaar/ghera). partial-payment EXCLUDED (COD King dependency). All reversible.

## Phase 3 content findings (from live data, 52 products / 12 collections)
- SYSTEMIC: 38/49 active products have meta description >155 chars (158-207) -> SERP truncation. CSV provides tightened <=155 versions (wording preserved, facts only, no em dashes).
- toran + haldi: shipped with NO seo title/desc + NO image alts (newest products; matches periodic-upkeep pattern). CSV has full new copy.
- partial-payment: DO NOT TOUCH. Required COD King product powering the partial-payment / COD deposit flow (user confirmed 2026-09-13). Setting it Draft would break COD collection. Earlier "set to Draft" recommendation RETRACTED. Not an SEO/merchandising item.
- ghera: productType is EMPTY -> set to "Festival Set"/anarkali. 34 products have body <120w (flagged EXPAND, NOT auto-padded — expansion optional, only with true detail, low priority pre-indexing).
- 5 products need image-alt backfill (toran, haldi, nazakat, anaar, ghera: 0 alts). 8 products fully clean.
- Collections: category collections already have strong SEO. Gaps: anarkali/co-ord/festive/one-piece desc 156-160 (tighten); best-sellers title thin ("Best Sellers", 12ch); bundle-offer-eligible + frontpage = utility (keep noindex, no SEO). Collection H1 "Collection: X" prefix = visually-hidden a11y span (NOT a defect).

## P0 (Phase 3 gate) — SITE NOT INDEXED BY GOOGLE
- `site:morpaankh.in` (WebSearch) returns ZERO results from the real domain (only similarly-named competitors: morpankhi.in, morpankh.com, morpankhofficial.in...).
- On-site indexability is CLEAN: robots `index, follow`; canonical correct; title/desc/OG/Twitter present; sitemap.xml valid (products/pages/collections/blogs + agentic_discovery). => cause is OFF-SITE, not a theme block. Matches June-2026 audit note ("on-site clean, cause off-site, need GSC access").
- Likely causes: new domain, no backlinks, GSC not verified / sitemap not submitted / URL-inspect + request-indexing not done, or a manual action. REQUIRES GSC access to confirm. This is admin-only; not fixable in theme code.

## Verified findings so far (evidence)
### Technical SEO (live HTML)
- Home `<title>`: "Morpaankh | Women's Indian Ethnic Wear & Kurta Sets"; meta desc present. robots index,follow. canonical https://www.morpaankh.in/.
- PDP (bandhan): canonical, robots index,follow, full OG + Twitter card. JSON-LD: Organization + Product + BreadcrumbList + WebSite(@graph). Product schema has NO aggregateRating / NO review (correct — no fabricated ratings).
- H1: home=1, collection=1, product=1 (GOOD). cart=2 ("Your cart" + empty-state "Nothing in your cart yet") — cart is noindex so low SEO impact; a11y/semantics nit.
- PDP OG price: `og:price:amount = "1,349.00"` — has a thousands-separator comma; OG product spec wants "1349.00". Minor.
- ALT coverage: theme handles alt CORRECTLY (verified). `card-product-tapi.liquid:61` = `alt: img1.alt | default: product.title` (primary, good); `:71` = `alt: ''` on hover duplicate (correct a11y); PDP thumbnails `main-product-tapi.liquid:770` = `alt: ''` (correct); gallery mains `:148` use alt+default. The empty-alts in HTML are all intentional decorative duplicates. REFUTED earlier "theme bug" hypothesis. Only real gap: a few products (Anaar, Nazakat...) have BLANK image alt field in admin -> bare product-name fallback. Admin content task, not theme. (Matches periodic alt-backfill note.)
- 404: returns proper 404 status. Duplicate URL path /collections/x/products/y canonicals correctly to /products/y (no dup-content issue). Sitemaps well-formed. agentic_discovery -> /agents.md. Technical on-page is genuinely strong.

### Performance (static)
- PDP render path: 23 unique stylesheets (28 <link rel=stylesheet>, mostly Dawn per-component CSS + a compiled bundle) + 42 inline <script> blocks totaling ~179KB inline JS. Both are weight/parse concerns.
- LCP image: featured product image, width=1200, loading=eager + fetchpriority=high (CORRECT). Not preloaded but fetchpriority covers it.
- Images: 48/52 lazy, 40/52 srcset. No `.webp` in tags = EXPECTED (Shopify serves WebP via `?width=` CDN negotiation; do NOT flag, do NOT force pjpg).
- Fonts: Cormorant Garamond + Marcellus + Inter via Google Fonts, `display=swap` + preload-as-style (GOOD).
- Third-party JS: COD King (cod-king-payment), Shopify portable-wallets/accelerated-checkout (~74KB/page, not theme-removable per prior note), Shopify analytics.

## Local artifacts
- scratchpad html snapshots: home.html, product-bandhan.html, collection-kurta.html, cart.html
- audit/baseline/product-page-assets.md (Phase 1 inventory)
