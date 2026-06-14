# MorPaankh SEO & GEO

End-to-end audit and the levers in place for search engines (SEO) and AI answer engines (GEO: ChatGPT, Perplexity, Claude, Google AI Overviews). Audited and updated 2026-06-14 against the live theme (189198631284, www.morpaankh.in).

## Verdict

The store was already well optimised. Crawler access, sitemaps, canonical URLs, social cards, and a full structured-data layer were in place from earlier work. This pass closed the remaining theme-side gaps (missing meta descriptions, rich-preview directive, product fabric facts, entity topics). The biggest remaining wins are now merchant-side data, not code.

## Crawlability (verified live)

- `templates/robots.txt.liquid` renders Shopify's default protective rules (cart/checkout/account blocked) then explicitly `Allow: /` for the AI crawlers: GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, Google-Extended, Bingbot, Amazonbot, ClaudeBot, anthropic-ai, Claude-Web, Applebot-Extended, Meta-ExternalAgent, Google-CloudVertexBot, DuckAssistBot, CCBot, cohere-ai, YouBot, Diffbot.
- `sitemap.xml` returns 200 and is referenced in robots.txt.
- Canonical URL on every page (`canonical_url`). No accidental noindex on indexable templates.

## On-page (head)

- Title: keyworded homepage title ("Women's Indian Ethnic Wear & Kurta Sets"); per-page `{{ page_title }} – MorPaankh` elsewhere.
- Meta description: admin SEO field wins, then the page's own body copy, then an honest brand+category fallback. Set in `layout/theme.liquid` so no indexable page ships without one.
- `robots` directive `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1` on indexable page types (richer Google + AI previews).
- Open Graph + Twitter summary_large_image, `og:locale=en_IN`, product `og:price`. `theme-color` set to the cream page colour.

## Structured data (schema.org JSON-LD)

- **Organization** (`header.liquid`): name, alternateName, logo, description, email, contactPoint (areaServed IN, en/hi), PostalAddress (Surat), sameAs (socials), `foundingLocation`, and `knowsAbout` topic list for entity/GEO association.
- **WebSite + SearchAction** on the homepage (sitelinks search box).
- **Product** (`main-product-tapi.liquid`): name, image, description, category, brand, per-variant Offer (price, priceCurrency, availability, itemCondition, priceValidUntil), `audience` (female), and — when the metafields exist — `material` plus an `additionalProperty` list (Fabric / GSM / Weave / Fit). AggregateRating is deliberately omitted (no verified review source yet; honest by design).
- **BreadcrumbList** on collection and product pages; **CollectionPage + ItemList** on collections; **FAQPage** on the FAQ.

## GEO notes

AI answer engines reward: open crawler access (done), clean structured data (done), factual and well-structured content (FAQ + fabric guide), and clear brand entity signals (Organization alternateName + knowsAbout + sameAs). Product fabric facts in `additionalProperty` give answer engines concrete attributes to cite. There is no honest countdown/urgency fakery to get flagged on.

## Merchant action items (data + off-theme, where the next gains are)

1. **Fill product SEO descriptions** for products missing one (as of audit: Morani, Morpaankh Mehka, Dhanak, Champa, Raunak, Savera, Rat Jugnu). The theme falls back to body copy, but a hand-written 150-char description ranks and converts better.
2. **Populate fabric metafields** `tapi.gsm` and `tapi.weave` (most products only have `blend`/`fit_type`). These flow into the PDP "Fabric & care" table AND the Product `additionalProperty` schema, which GEO engines cite.
3. **Fix weak URL handles**: `untitled-12jun_16-42-40` (Morpaankh Mehka) and `gown` (Dhanak) should become descriptive slugs (e.g. `morpaankh-mehka`). Add a URL redirect from the old handle when you change it (Online Store → Navigation → URL Redirects).
4. **Google Search Console**: verify the property, submit `https://www.morpaankh.in/sitemap.xml`, and use "URL Inspection → Request indexing" for the homepage and top products. Watch Pages (coverage) and Performance (queries) weekly. Bing Webmaster Tools mirrors this for Bing/Copilot.
5. **Content for GEO**: a few honest blog/guide posts (fabric care, how to style a kurta set, sizing) give answer engines more to cite and rank for long-tail queries.

## Notes

- I cannot log into Search Console here, so sitemap submission and "request indexing" are manual steps for you (above). Everything theme-side is shipped and live-verified.
- Re-verify structured data after content changes with Google's Rich Results Test and schema.org validator.
