# Snippets — Tapi & Co.

Drop each block below as a separate `.liquid` file inside your theme's `snippets/` folder. Each snippet's filename matches the `{% render 'name' %}` callsite from `main-product-tapi.liquid` and elsewhere.

---

## `snippets/tapi-logo.liquid`

Inline-SVG brand logo. Replace the `<svg>` block in Dawn's `header.liquid` with `{% render 'tapi-logo' %}`.

```liquid
{%- comment -%} Tapi & Co. — horizontal logo, scales with --tapi-logo-h CSS var {%- endcomment -%}
<a href="{{ routes.root_url }}" class="tapi-logo" aria-label="{{ shop.name }}">
  <svg viewBox="0 0 220 44" width="220" height="44" role="img" aria-hidden="true">
    <circle cx="22" cy="22" r="21" stroke="currentColor" stroke-width="1" fill="none"/>
    <path d="M9 18 C 14 14, 18 22, 22 18 S 30 14, 35 18" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round"/>
    <path d="M9 23 C 14 19, 18 27, 22 23 S 30 19, 35 23" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round"/>
    <path d="M9 28 C 14 24, 18 32, 22 28 S 30 24, 35 28" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round"/>
    <text x="58" y="29" fill="currentColor" font-family="var(--font-heading-family)" font-size="28" font-weight="500" letter-spacing="-0.012em">
      Tapi <tspan font-style="italic" font-weight="400">&amp;</tspan> Co.
    </text>
  </svg>
</a>
```

---

## `snippets/trust-marquee.liquid`

Rotating marquee for the top of every page. Include from `header.liquid` (above the nav).

```liquid
{%- comment -%}
  Reads `shop.metafields.tapi.trust_items` — a list metafield. Falls back to defaults.
{%- endcomment -%}
{%- assign items = shop.metafields.tapi.trust_items.value -%}
{%- if items == blank -%}
  {%- assign items = "Size-true · cousin-verified|Made in Surat, Gujarat|Free exchange on first order|100% Indian-sourced fabric|What you see is what arrives|Pick up from Surat — save ₹50" | split: "|" -%}
{%- endif -%}
<aside class="tapi-marquee" aria-label="Brand promises">
  <div class="tapi-marquee__track" aria-hidden="true">
    {% for i in items %}<span>● {{ i }}</span>{% endfor %}
    {% for i in items %}<span>● {{ i }}</span>{% endfor %}
  </div>
</aside>
```

---

## `snippets/fabric-table.liquid`

Standalone fabric table, in case you need it outside the PDP section (e.g. on a fabric guide page).

```liquid
{%- assign m = product.metafields.tapi -%}
<table class="tapi-fabric-table">
  <tbody>
    <tr><td>GSM</td><td>{{ m.gsm }} gsm</td></tr>
    <tr><td>Blend</td><td>{{ m.blend }}</td></tr>
    <tr><td>Weave</td><td>{{ m.weave }}</td></tr>
    <tr><td>Fit type</td><td>{{ m.fit_type }}</td></tr>
    <tr><td>Opacity</td><td>{{ m.opacity_note }}</td></tr>
    <tr><td>Breathability</td><td>{{ m.breathability }}</td></tr>
    <tr><td>Wash care</td><td>{{ m.wash_care }}</td></tr>
  </tbody>
</table>
```

---

## `snippets/fit-feedback.liquid`

Just the fit-feedback bar — useful inline on collection cards or PDP variants.

```liquid
{%- assign m = product.metafields.tapi -%}
{%- if m.fit_pct_true -%}
<div class="tapi-fit-feedback">
  <strong class="tapi-fit-feedback__label">Fit feedback</strong>
  <div class="tapi-fit-feedback__bar">
    <span style="width: {{ m.fit_pct_down }}%; background: var(--tapi-terracotta-soft);"></span>
    <span style="width: {{ m.fit_pct_true }}%; background: var(--tapi-sage);"></span>
    <span style="width: {{ m.fit_pct_up   }}%; background: var(--tapi-terracotta);"></span>
  </div>
  <div class="tapi-fit-feedback__legend">
    <span>{{ m.fit_pct_down }}% size down</span>
    <span>{{ m.fit_pct_true }}% true</span>
    <span>{{ m.fit_pct_up }}% size up</span>
  </div>
</div>
{%- endif -%}
```

---

## `snippets/editorial-break.liquid`

Pull-quote band injected between rows of product cards on the collection page.

```liquid
<section class="tapi-editorial-band" aria-label="Editorial note">
  <div>
    <span class="tapi-eyebrow" style="color: var(--tapi-terracotta);">— A note from the studio</span>
    <h3 class="tapi-editorial-band__quote">"{{ section.settings.quote | default: "If it isn't in the fabric, it isn't worth the price." }}"</h3>
    <p style="color: var(--tapi-warm-grey); margin: 0; line-height: 1.7;">
      {{ section.settings.body | default: "Every kurta set in this drop lists its GSM — the weight of the fabric per square metre. Higher isn't always better; it depends on the season and the silhouette." }}
    </p>
  </div>
  <a href="{{ section.settings.link | default: '/pages/fabric-guide' }}" class="button button--outline" style="justify-self: end; align-self: start;">
    Read our fabric guide →
  </a>
</section>

{% schema %}
{
  "name": "Editorial break",
  "settings": [
    { "type": "text", "id": "quote", "label": "Quote", "default": "If it isn't in the fabric, it isn't worth the price." },
    { "type": "textarea", "id": "body", "label": "Body" },
    { "type": "url", "id": "link", "label": "CTA link" }
  ],
  "presets": [ { "name": "Editorial break" } ]
}
{% endschema %}
```

---

## `snippets/card-product-tapi.liquid`

Replace Dawn's product card with this — adds GSM + low-stock indicator + colour dots.

```liquid
{%- assign m = product.metafields.tapi -%}
<article class="tapi-card">
  <a href="{{ product.url }}" class="tapi-card__media" aria-label="{{ product.title }}">
    {%- if product.featured_image -%}
      {{ product.featured_image | image_url: width: 800 | image_tag: loading: 'lazy', widths: '300, 600, 900', sizes: '(min-width: 750px) 25vw, 50vw', alt: product.featured_image.alt | escape }}
    {%- endif -%}
    {%- if product.tags contains 'new' -%}
      <span class="tapi-tag tapi-tag--charcoal">New</span>
    {%- elsif product.tags contains 'bestseller' -%}
      <span class="tapi-tag tapi-tag--sage">Bestseller</span>
    {%- endif -%}
  </a>
  <div class="tapi-card__info">
    <h3 class="card__heading">
      <a href="{{ product.url }}">{{ product.title }}</a>
    </h3>
    <div class="tapi-card__row">
      <span class="card__subtitle">{{ m.blend | truncate: 32 }}</span>
      <span class="price">{{ product.price | money }}</span>
    </div>
    <div class="tapi-meta">
      {%- if product.metafields.reviews.rating.value %}<span>★ {{ product.metafields.reviews.rating.value.rating }}</span>{% endif -%}
      {%- if m.gsm %}<span>{{ m.gsm }} GSM</span>{% endif -%}
      {%- if product.available == false %}<span style="color: var(--tapi-terracotta);">Sold out</span>{% endif -%}
    </div>
  </div>
</article>
```

---

## `snippets/studio-strip.liquid`

The "11 weavers · 5 cousins · 120–180 GSM · 48 hrs" stat band.

```liquid
<section class="tapi-studio-strip" style="background: var(--tapi-charcoal); color: var(--tapi-cream); padding: 8rem 0;">
  <div class="page-width" style="display:grid; grid-template-columns: repeat(4, 1fr); gap: 3.2rem;">
    {% assign stats = section.blocks %}
    {% for s in stats %}
      <div>
        <div style="font-family: var(--font-heading-family); font-size: 4.4rem; line-height: 1; color: var(--tapi-terracotta-soft); font-variant-numeric: tabular-nums;">{{ s.settings.value }}</div>
        <div style="margin-top: 0.8rem; font-size: 1.2rem; opacity: 0.7;">{{ s.settings.label }}</div>
      </div>
    {% endfor %}
  </div>
</section>

{% schema %}
{
  "name": "Studio strip",
  "blocks": [
    { "type": "stat", "name": "Stat",
      "settings": [
        { "type": "text", "id": "value", "label": "Value", "default": "11" },
        { "type": "text", "id": "label", "label": "Label", "default": "Weavers within walking distance" }
      ]
    }
  ],
  "max_blocks": 8,
  "presets": [
    { "name": "Studio strip",
      "blocks": [
        { "type": "stat", "settings": { "value": "11", "label": "Weavers within walking distance" } },
        { "type": "stat", "settings": { "value": "5", "label": "Family + cousin operations" } },
        { "type": "stat", "settings": { "value": "120–180", "label": "GSM range — listed per piece" } },
        { "type": "stat", "settings": { "value": "48 hrs", "label": "Pickup-ready in Surat" } }
      ]
    }
  ]
}
{% endschema %}
```

---

## Quick checklist

- [ ] All snippets above pasted into `snippets/` with matching filenames
- [ ] `main-product-tapi.liquid` in `sections/`
- [ ] `theme-variables.css` in `assets/`, linked from `layout/theme.liquid`
- [ ] `templates/product.json` replaced
- [ ] Metafields from `metafields.md` defined + marked storefront-accessible
- [ ] Cormorant Garamond + Inter added in Theme Settings → Typography (or via the `@import` in `theme-variables.css`)
- [ ] Pincode lookup table in `pincode-delivery.liquid` reviewed (replace with real API when ready)
