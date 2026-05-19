# Theme architecture — Tapi & Co.

## Principle

**Build on Dawn. Override visually with CSS variables, structurally with section/template overrides.** Don't fork — the theme stays auto-updateable for as long as possible.

## Templates we override

| Shopify template            | Our file                            | Why                                                                                  |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `templates/index.json`      | edit Dawn's, add our custom sections | Add "fabric guide" section, "studio film" video band                                 |
| `templates/product.json`    | `templates/product.json`             | Use our `main-product-tapi` section instead of `main-product`                        |
| `templates/collection.json` | edit Dawn's, set filter rail config  | Reorder filter facets (Fabric → Color → Size → Fit → Occasion), add Editorial Break  |
| `templates/page.about.json` | new                                  | The "Our Story" narrative — built from custom sections (timeline, principles, etc.)  |

## Sections we add (new files in `sections/`)

| File                          | Purpose                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `main-product-tapi.liquid`    | Full PDP — gallery, fabric table, fit feedback bar, size quiz hook, pincode widget    |
| `fabric-guide.liquid`         | Reusable section explaining GSM ranges. Used on home + "fabric guide" page             |
| `editorial-break.liquid`      | Pull-quote band between product grid rows on collection                                |
| `trust-marquee.liquid`        | Top-of-page rotating marquee (cousin-verified, made in Surat, etc.)                    |
| `studio-strip.liquid`         | "11 weavers · 5 cousins · 120–180 GSM" stat band                                       |

## Sections we modify (Dawn defaults)

| Dawn section             | Change                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `header.liquid`          | Replace logo block with our `tapi-logo` snippet, add marquee above       |
| `footer.liquid`          | Replace with our 5-column layout (Shop · Help · Brand · Visit)           |
| `card-product.liquid`    | Read GSM, fabric blend, weave from metafields. Show fit-feedback dot.   |
| `main-collection-product-grid.liquid` | Inject `editorial-break` after every 9 products            |

## CSS approach

- Single source of truth: `assets/theme-variables.css`. Linked from `layout/theme.liquid`.
- We override Dawn's `--color-base-*` and `--color-foreground` to point at our cream / charcoal / terracotta scale (see file).
- All custom sections use our CSS variables — never hard-code colors.
- **Type:** add Cormorant Garamond + Inter via `Settings → Theme settings → Typography`. Dawn loads them via `font_face`. Fall back to our `--font-serif` / `--font-sans` variables.

## Settings → Theme settings

These should be configured **after** installing the theme, before launching:

- **Colors:** define Tapi palette presets. Background = cream, accent-1 = terracotta, accent-2 = sage, foreground = charcoal.
- **Typography:** Heading = Cormorant Garamond Medium 500, Body = Inter 400.
- **Layout:** Page width = 1440px, section spacing = 80px.
- **Buttons:** small radius (2px), uppercase labels, 0.06em letter-spacing.

## Apps we recommend (later)

- **Judge.me** or **Loox** for verified-buyer reviews (replace the demo review block).
- **Shopify Search & Discovery** for the filter rail (we configure facet order in admin).
- **Easy Pincode** or your own custom app for live shipping dates — replace the mock JS in `pincode-delivery.liquid`.
- **Klaviyo** for the "Letters from the loom" newsletter.

## Folder structure inside your theme

```
your-dawn-theme/
├── assets/
│   ├── theme-variables.css      ← from shopify/theme-variables.css
│   └── …
├── sections/
│   ├── main-product-tapi.liquid ← from shopify/main-product-tapi.liquid
│   ├── fabric-guide.liquid
│   ├── editorial-break.liquid
│   ├── trust-marquee.liquid
│   └── …
├── snippets/
│   ├── tapi-logo.liquid
│   ├── pincode-delivery.liquid
│   ├── fabric-table.liquid
│   ├── fit-feedback.liquid
│   └── …
├── templates/
│   ├── product.json             ← from shopify/product.json
│   └── …
└── layout/
    └── theme.liquid             ← add <link rel="stylesheet" href="{{ 'theme-variables.css' | asset_url }}">
```
