# Tapi & Co. — Shopify Liquid deliverables

This folder contains everything you need to take the prototype to a working Shopify store. It assumes you're starting from **Dawn** (the official free theme) and customising it. Drop the files into the matching folders in your theme.

## Order of operations

1. **Set up the brand in Shopify**
   - `theme-architecture.md` — read first. Sections / templates / metafield namespaces.
   - `metafields.md` — create these metafields in *Settings → Custom data* before importing products. The PDP and product cards read from them.
   - `theme-variables.css` — drop into `assets/`, link from `theme.liquid`. Holds the cream / terracotta / serif tokens.

2. **Customise the product page**
   - `product.json` — replaces the default Dawn product template.
   - `main-product-tapi.liquid` — section file. Renders the fabric table, fit feedback bar, GSM / weave display, model measurements.
   - `pincode-delivery.liquid` + JS in the same file — pincode lookup widget. Mocks delivery date; swap the lookup table for a real shipping-rates API later.

3. **Snippets used across the theme**
   - `snippets.md` — full list of small `{% include %}` snippets we depend on. Copy each into `snippets/<name>.liquid`.

## File map

```
shopify/
├── README.md                  ← you are here
├── theme-architecture.md      ← sections, templates, principles
├── metafields.md              ← exact metafield setup
├── theme-variables.css        ← drop into assets/
├── product.json               ← templates/product.json (new template)
├── main-product-tapi.liquid   ← sections/main-product-tapi.liquid
├── pincode-delivery.liquid    ← snippets/pincode-delivery.liquid
└── snippets.md                ← snippets list with bodies
```

## Notes

- All Liquid here is Dawn-flavoured (Online Store 2.0). It will *not* work on legacy themes.
- The CSS variables in `theme-variables.css` mirror what the prototype uses. Once the visual direction is signed off, every component reads from these — change them and the storefront re-skins.
- Pricing in INR. Currency formatting uses Shopify's `money` filter, so the shop's currency setting is the source of truth.
- The pincode widget is a **front-end mock** of delivery date — real implementations should call your shipping app or Shopify's shipping-rates API. Marked clearly in the file.
- I did NOT include couple-set bundle Liquid since couple sets were de-scoped. If you reintroduce them, ask and I'll add a `bundle-couple.liquid` snippet that wires Shopify Bundles app.
