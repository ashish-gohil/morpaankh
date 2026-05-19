# Metafields — Tapi & Co.

Set these up in *Shopify admin → Settings → Custom data* **before** importing products. Without them the PDP renders empty fabric tables.

## Product metafields

Namespace: `tapi`

| Key              | Type                | Purpose                                          | Example                              |
| ---------------- | ------------------- | ------------------------------------------------ | ------------------------------------ |
| `gsm`            | `number_integer`    | Fabric weight in grams per square metre          | `120`                                |
| `blend`          | `single_line_text`  | Fabric blend description                         | `100% mulmul cotton`                 |
| `weave`          | `single_line_text`  | Weave type                                       | `Plain weave, double-layered`        |
| `weave_key`      | `single_line_text`  | Slug used to render the fabric swatch pattern    | `plain` / `satin` / `twill` / `voile` / `dobby` / `blockprint` |
| `fit_type`       | `single_line_text`  | Relaxed / Regular / Slim                          | `Relaxed`                            |
| `opacity_note`   | `single_line_text`  | How sheer the fabric is                          | `Light · semi-opaque`                |
| `breathability`  | `single_line_text`  | Plain-language breathability                     | `High breathability`                 |
| `wash_care`      | `single_line_text`  | Care instructions                                | `Hand wash cold, line dry in shade`  |
| `pieces`         | `list.single_line_text` | What's included in the set                  | `["Kurta", "Cigarette pants", "Mulmul dupatta"]` |
| `model_height`   | `single_line_text`  | Model's height                                   | `5'7"`                               |
| `model_size`     | `single_line_text`  | Size the model is wearing                        | `S`                                  |
| `model_bust`     | `number_integer`    | Model's bust in inches                           | `34`                                 |
| `model_waist`    | `number_integer`    | Model's waist in inches                          | `28`                                 |
| `fit_note`       | `single_line_text`  | Model's fit feedback                             | `True to size`                       |
| `fit_pct_true`   | `number_integer`    | % of buyers who say "runs true"                  | `78`                                 |
| `fit_pct_up`     | `number_integer`    | % who say "size up"                              | `12`                                 |
| `fit_pct_down`   | `number_integer`    | % who say "size down"                            | `10`                                 |
| `story`          | `multi_line_text`   | Studio-voice paragraph about this product        | (any prose)                          |

### Storefront access

All metafields above must be marked **"Available to storefront"** in admin, or Liquid won't be able to read them.

## Variant metafields

Namespace: `tapi`

| Key            | Type             | Purpose                                  |
| -------------- | ---------------- | ---------------------------------------- |
| `stock_low_at` | `number_integer` | Show "Low stock" badge below this count  |

## Shop metafields (global)

Namespace: `tapi`

| Key                 | Type                | Purpose                                          |
| ------------------- | ------------------- | ------------------------------------------------ |
| `free_ship_above`   | `money`             | Free shipping threshold (default ₹2,499)         |
| `pickup_address`    | `multi_line_text`   | Studio address (rendered in PDP + footer + about) |
| `pickup_discount`   | `money`             | Discount for in-Surat pickup (default ₹50)        |

## Importing — quickest path

Use the **Matrixify** or **Excelify** Shopify app to import a CSV that has columns for each metafield above. Sample first row:

```
Handle,Title,…,Metafield: tapi.gsm,Metafield: tapi.blend,Metafield: tapi.weave_key,Metafield: tapi.pieces
saanjh-kurta-set,Saanjh Kurta Set,…,120,100% mulmul cotton,plain,"Kurta,Cigarette pants,Mulmul dupatta"
```

## Reading from Liquid

```liquid
{% assign m = product.metafields.tapi %}
{{ m.gsm }}                          {# 120 #}
{{ m.blend }}                        {# 100% mulmul cotton #}
{{ m.weave_key }}                    {# plain #}
{% for p in m.pieces.value %}
  <li>{{ p }}</li>
{% endfor %}
```
