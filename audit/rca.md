# Phase 6 — RCA (interim: Phases 1, 2, 4-static + the Phase 3 P0 gate)

Scope note: Phases 1-2 and static Phase 4 are complete from live HTML + theme source. Lab/field CWV (Lighthouse) and Phase 5 flow-walks are NOT yet run — they need a PSI API key or a Chrome measurement session (local headless Lighthouse is sandbox-blocked), and Clarity MCP is not connected. Nothing below is a measured Lighthouse score; no scores are fabricated.

## Headline
On-page SEO and the theme are genuinely well-built. There are only two tiny code defects. The one thing that matters is a P0 that lives outside the code: **the site is not in Google's index.** Per the Phase 3 rule, that gates the value of all content-SEO work.

## ADMIN-ONLY (not fixable in theme code)
| ID | Sev | Evidence | Root cause | Fix | Blast radius | Rollback | Verify |
|----|-----|----------|-----------|-----|--------------|----------|--------|
| A0 | **P0** | `site:morpaankh.in` (WebSearch) = 0 results from the real domain; only look-alike competitors. On-page fully indexable (robots index,follow; canonical; title/desc/OG; valid sitemap). | Off-site, not a theme block: GSC likely not verified / sitemap not submitted / no URL-inspect+Request-Indexing; new domain, ~no backlinks; possible manual action. Needs GSC to confirm which. | In GSC: verify domain property, submit `sitemap.xml`, URL-inspect + Request Indexing for home + top products, read Coverage + Manual Actions. Start backlink/citation building. | Entire organic channel | n/a | GSC Coverage = "Indexed"; `site:` returns pages within days |
| A1 | Low | Collection cards show bare-name alt for `Anaar`, `Nazakat` (others rich) | Those products' image `alt` field blank in admin -> theme falls back to product.title | Set descriptive image alt per product (admin or Admin API) | a11y + image SEO for those items | reset alt | Re-fetch; alt != bare product name |

## CODE (theme) — the only two real defects found
| ID | Sev | Evidence | Root cause | Fix | Blast radius | Rollback | Verify |
|----|-----|----------|-----------|-----|--------------|----------|--------|
| C1 | Low | `snippets/meta-tags.liquid:49` -> live `og:price:amount = "1,349.00"` | `money_without_currency` emits INR thousands separator; OG product spec wants plain `1349.00` | `... | money_without_currency | replace: ',', ''` | og:price on all product pages | 1-line git revert | Re-fetch PDP: `og:price:amount="1349.00"`; FB Sharing Debugger clean |
| C2 | Low | `/cart` renders 2× `<h1>` ("Your cart" + empty-state "Nothing in your cart yet") | Empty-state heading is an `<h1>` alongside the page `<h1>` | Demote empty-state to `<p>`/`<h2>` (locale key `en.default.json` "empty" is rendered as h1 in the cart section) | cart page semantics only (cart is noindex) | git revert | Re-fetch `/cart`: exactly one `<h1>` |

## PERFORMANCE — characterized, needs measurement to confirm gains
| ID | Sev | Evidence | Root cause | Candidate fix | Verify (BLOCKED) |
|----|-----|----------|-----------|---------------|------------------|
| P1 | Med? | PDP: ~179 KB inline JS across 42 `<script>` blocks; 28 `<link rel=stylesheet>` (23 unique) | Dawn per-component CSS + app injections: COD King, Shopify portable-wallets (~74 KB, not theme-removable), analytics/monorail; plus theme init | Separate app-owned vs theme-owned; defer/consolidate theme init only; wallet/analytics can't be removed | Needs before/after CWV (PSI key or Chrome) — CANNOT verify yet |

Confirmed NON-issues (do not "fix"): no `.webp` in tags = Shopify serves WebP via `?width=` negotiation; LCP image already `eager`+`fetchpriority=high`; fonts already `display=swap`+preload; duplicate `/collections/x/products/y` canonicals correctly; 404 returns 404; all 4 schema types present with NO fabricated ratings.

## Not yet done (need a decision / tool)
- Phase 1 Lighthouse scores + Phase 4 lab/field CWV: need PSI API key OR a Chrome measurement session.
- Phase 5 flows (landing->order, both payment paths, search/filters/nav/forms/404, 360/390/768/1440, tap targets, keyboard): need a Chrome session. Clarity rage/dead-click cross-check: Clarity MCP not connected.
- Phase 3 content keyword CSV: low ROI until A0 (indexing) is resolved.
