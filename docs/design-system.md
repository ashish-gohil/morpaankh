# MorPaankh design system

Canonical specification for the "Tapi" design system powering morpaankh.in (Shopify Dawn base, live theme 189198631284). Every value below is extracted from the shipped code, primarily `theme/assets/theme-variables.css`. This document is the source of truth for anyone extending the theme; if code and spec disagree, fix whichever one drifted and say so in the commit.

## Brand foundation

- Brand name: **MorPaankh**, one word, capital M and P. Never "Mor Paankh". Lowercase `morpaankh`, caps `MORPAANKH`.
- Voice: premium and honest. Never claim "handcrafted", "made by hand", "handloom", or any production process we cannot verify. Sensory fabric storytelling is the register: how cloth falls, breathes, catches light.
- Copy style: natural, human, specific. No em dashes in customer-facing copy. No fake urgency (no countdowns, no "X people viewing", no invented customer counts).
- Logo lockup: trimmed peacock-feather mark sized by height, wordmark in Marcellus, uppercase, weight 400, letter-spacing 0.15em (`snippets/tapi-logo.liquid`).

## Color system

Brand palette (hex) with semantic aliases. Components must consume the semantic `--mor-*` tokens, never raw hex.

| Token | Value | Role |
|---|---|---|
| `--mor-cream` | #F5EFE1 | page background (surface) |
| `--mor-cream-2` | #EFE6D4 | alternate section background (surface-2) |
| `--mor-ivory` | #FAF6EC | raised surfaces, cards |
| `--mor-paper` | #FFFFFF | pure-white chips (payment icons, inputs) |
| `--mor-charcoal` | #2C2826 | primary text |
| `--mor-warm-grey` | #6B5D54 | muted text (`--mor-text-muted`) |
| `--mor-muted` | #9A8D83 | subtle text, placeholders |
| `--mor-hairline` / `-2` | #E5DDC8 / #D6CDB8 | borders, dividers |
| `--mor-primary` | #2E4B3C | forest green. Primary CTAs, meter fill, links-on-cream |
| `--mor-primary-deep` | #233A2E | primary hover |
| `--mor-accent` | #B7472A | terracotta. Secondary CTAs, sale/savings, hover accents |
| `--mor-accent-deep` | #8F3621 | accent hover |
| `--mor-gold` | #B08947 | tertiary. Stars, footer column titles, fine accents |
| `--mor-sage` | #7A8761 | quiet green for editorial tints |

Rules:
- Adjacent full-width sections on multi-section pages (home, PDP) must alternate cream / cream-2; the tone shift IS the separator. Set background via token, never an orphaned color-scheme class.
- Functional color always pairs with an icon or text (never color alone).
- Dawn scheme bridge: `--color-button` = primary green, `--color-accent-1` = terracotta, so native Dawn components inherit the brand automatically.

## Typography

Fonts: **Cormorant Garamond** (headings, weight 500), **Inter** (body), **Marcellus** (logo wordmark only). Do not add fonts. Root: Dawn's `html { font-size: 62.5% }`, so 1rem = 10px. All custom CSS is written against this base; a component whose text looks ~60 percent too small was probably written against a 16px assumption (this exact bug shipped once, in track-order).

| Token | Value | Use |
|---|---|---|
| `--mor-h1` | clamp(3.4rem, 6.5vw, 7.6rem) | hero only |
| `--mor-h2` | clamp(2.8rem, 4.5vw, 5.2rem) | every section heading |
| `--mor-h3` | clamp(2rem, 3vw, 2.8rem) | card / sub headings |
| `--mor-h4` | clamp(1.6rem, 2vw, 2rem) | minor headings |
| `--mor-text-lg` | 1.7rem | lede paragraphs |
| `--mor-text-base` | 1.5rem | body |
| `--mor-text-sm` | 1.3rem | small text, meter messages, assurance rows |
| `--mor-text-xs` | 1.1rem | eyebrows, labels, meta |

Line heights: `--mor-leading-tight` 1.04 (display), `-snug` 1.3, `-body` 1.65. Eyebrows: uppercase, letter-spacing 0.18em, usually with the `tapi-eyebrow--line` rule. Buttons: uppercase, 1.3rem, letter-spacing 0.06em, weight 500. Prices and figures use tabular numerals.

Exception register: intentional sub-1.3rem sizes exist for count bubbles (0.9rem), bottom-nav labels (1rem), and share labels (0.95rem). These are Dawn-parity micro-labels. Do not "fix" them.

## Spacing rhythm

One vertical beat for the whole site, responsive by breakpoint:

| Breakpoint | `--tapi-section-pad` | `--tapi-gutter` | `--tapi-card-gap` |
|---|---|---|---|
| base | 56px | 16px | 16px |
| ≥641px | 72px | 32px | 20px |
| ≥990px | 96px | 48px | 28px |
| ≥1440px | 112px | 64px | 32px |

Sections consume `padding-block: var(--tapi-section-pad)`. Do not change the values; standardize consumption. The footer's `.page-width` carries the uniform pre-footer gap for every page. Mobile product grid overrides Dawn's gutters to 14px column / 28px row on `.product-grid`.

## Surfaces, radii, shadows

- Radii: `--mor-radius-sm` 2px (buttons, chips), `-md` 4px (inputs, meter panel), `-lg` 8px (cards, panels), `-pill` 9999px (bubbles, bars). Plus 50% for circular dots. No other radius values.
- Shadows, all charcoal-tinted rgba(44,40,38): `--mor-shadow-sm` (0 1px 2px / 0.05), `-md` (0 12px 24px -16px / 0.22), `-lg` (0 24px 48px -28px / 0.26). Hover-lift uses shadow-lg. Colored button hover shadows (green/terracotta tints) are the sanctioned exception.
- Hairline dividers use `--mor-hairline`; "premium separation" = whitespace plus tone shift first, hairline second, shadow last.
- No gradients beyond the hero scrim band; the premium read comes from tone-on-tone cream layering, not gradient decoration.

## Buttons, inputs, badges

- Buttons: 4.8rem height, padding 0 2.2rem, radius-sm, uppercase tracked label. Variants: `--primary` (green), `--terracotta` (accent), `--outline`. Hover deepens the fill; desktop press = translateY(1px); touch press = scale(0.96) via the global coarse-pointer block.
- Inputs: 1.6rem text minimum (clears iOS auto-zoom), radius-md when boxed, 44px minimum height. Focus ring: 2px solid, brand color, offset 2px.
- Badges/tags: `.tapi-tag` chip stack top-left on cards; savings badge rides the tag stack. Count bubbles are terracotta pills with tabular numerals.
- Touch targets: 44px minimum everywhere (a global min-width/min-height rule enforces it; note it silently clamps any smaller explicit width, so override `min-*` too when resizing icons).

## Motion

Tokens: `--mor-dur-fast` 150ms, `-base` 250ms, `-slow` 400ms, `-slower` 700ms (image zoom/settle). Easing: `--mor-ease` cubic-bezier(0.22,1,0.36,1), `--mor-ease-out` (0.16,1,0.3,1).

Inventory and rules:
- Scroll reveals via `data-tapi-reveal` (`assets/tapi-motion.js`); above-fold elements get `.in` synchronously so first paint never flashes.
- Card hover: lift translateY(-3px) + image zoom 1.05 on the slow curve + dual-image crossfade. Hero CTA: magnetic, clamped to ±6px.
- Cart bubble: `tapi-bubble-pop` mount keyframe replays on Dawn's section re-render = free add-to-cart feedback.
- Hero: video slides hold the carousel until `ended`; image slides use the interval timer; progress bar tracks real playback.
- Every animation is transform/opacity only, interruptible, and disabled under `prefers-reduced-motion`. Budget: no animation library. three.js and GSAP are explicitly rejected (payload vs slow-network mobile traffic).

## Component library (theme inventory)

One card to rule product display: `snippets/card-product-tapi.liquid` (collection, search, featured, related, recently-viewed, wishlist). Key sections/snippets: tapi-hero (per-viewport media + video), tapi-collection-tiles (mobile snap rail), tapi-featured-products, tapi-studio-strip, tapi-testimonials (renders only with real quotes), tapi-faq (visible accordion + FAQPage JSON-LD from one source), tapi-footer, tapi-bottom-nav, tapi-wishlist-button, trust-marquee, main-product-tapi (gallery, buy box, perks, accordions), main-cart-items (free-shipping meter), main-cart-footer (assurance row), tapi-track-order. Shared client logic: `assets/tapi-motion.js`, `assets/tapi-ux.js` (wishlist store, recently viewed, share), `assets/tapi-ux.css`.

Conventions: never overlay custom UI on a Dawn-native equivalent (no double icons); sibling elements match on color, weight, border, gap, and technique; one `{% stylesheet %}` block per liquid file (a second one fails the push); idempotent JS that re-inits on `shopify:section:load`.

## Accessibility floor

WCAG AA contrast (4.5:1 text), visible focus everywhere, 44px touch targets, `aria-pressed`/`aria-current`/`aria-expanded` state semantics, single landmark per role, reduced-motion support. Home page audits clean (axe 27 to 0); payment-brand logo SVG contrast flags are known false positives (logo exemption).

## Governance

- Extend by adding semantic tokens, not raw values; if a one-off value seems needed, it is almost always one of the existing steps.
- Every customer-facing claim must be true (shipping thresholds, return terms, craft language).
- New features ship merchant-gated (a section setting or checkbox) so rollback is a toggle, and get committed individually to `main`.
- Deploys: full `shopify theme push --path theme` (multi `--only` drops files), verified via Admin API file checksums, never via the page-cached bare URL.
