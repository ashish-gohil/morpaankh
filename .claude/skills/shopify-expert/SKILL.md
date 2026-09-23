---
name: shopify-expert
description: Operates the user's Shopify store via Shopify CLI + Admin GraphQL + Shopify Dev MCP. Use this skill whenever the user wants to create, update, publish, or inspect products / collections / themes / sections / metafields / inventory / images on their Shopify store — even if they don't say the word "Shopify". Triggers on phrases like "push the theme", "add a product", "publish to online store", "update the PDP", "create a collection", "set inventory", "tag as new arrival", "add a metafield", "fix the cart page", "edit a Liquid section/snippet", "theme settings", or any task involving a `*.myshopify.com` domain, a `theme/` directory, a `productSet`/`publishablePublish` mutation, or a `shopify theme push`/`shopify store execute` command. Captures the validated Tapi & Co. workflow: validate every mutation with `validate_graphql_codeblocks` before sending, validate themes with `validate_theme` before push, confirm destructive ops with the user before running, use the permanent `*.myshopify.com` host (not vanity aliases), use `productSet` as a handle-keyed upsert, follow ACTIVE status with `publishablePublish` so products become visible on the storefront, and run theme pushes from inside the `theme/` dir with `--nodelete` (plus `--allow-live` only if the target is the live theme).
---

# Shopify Store Operator

This skill captures the proven workflow for managing a real Shopify store end-to-end: create/update products and collections, edit and push themes, set up metafields, upload images, and publish to the Online Store sales channel. It assumes a Liquid theme (Dawn-based or similar) and a Shopify-CLI-authenticated session.

## When to use this skill

Activate whenever the user wants to *do something to their store*:

- "push the theme" / "deploy the changes" / "publish my theme edits"
- "add 6 new products" / "create the saanjh kurta" / "update Roohi's price"
- "make them visible on the storefront" / "publish to online store"
- "set inventory to 50 for size M" / "stock the new arrivals"
- "add a metafield for GSM" / "tag these as new-arrival"
- "fix the PDP" / "the cart page is broken" / "redo the header section"
- "upload product images" / "attach photos to Mehfil"
- Anything pointing at a `theme/` directory, a `*.myshopify.com` URL, or a `shopify` CLI command

If the user asks about Hydrogen, checkout UI extensions, Shopify Functions, Polaris admin apps, or POS — those are different skills (`shopify-hydrogen`, `shopify-polaris-checkout-extensions`, etc.). Defer to them.

## Non-negotiable safety rules

1. **Validate before run.** Pass every GraphQL mutation through `mcp__shopify-dev-mcp__validate_graphql_codeblocks` before sending. Pass theme changes through `mcp__shopify-dev-mcp__validate_theme` before push. If a validator rejects the code, rewrite until it passes — don't suppress warnings.
2. **Confirm destructive or visible-state ops.** Before any mutation that deletes, unpublishes, force-pushes, drops, overwrites uncommitted work, or affects what shoppers will see: show the exact mutation name + variables + target store, then wait for the user to type "yes". A previous approval does not auth a new mutation.
3. **Never publish a theme.** Only the user publishes themes from the admin. If a theme is already live, use `--allow-live` when pushing — but treat every push as user-visible and warn before running.
4. **Never touch a production store.** All work happens on the designated dev store. If the user has more than one shop, confirm the target host before any mutation.
5. **No invented data.** Don't make up colors, sizes, GSM, fabric composition, prices, or copy that isn't in the source files or already in the store. Ask.

These rules exist because real shoppers see the consequences. A bad push can break checkout for a live store; a bad mutation can corrupt product data that has to be fixed by hand.

## First move every session: load the API context

Before any GraphQL work, call `mcp__shopify-dev-mcp__learn_shopify_api` once. It returns a `conversationId` that the validator and search tools want as input — without it, validation can fail or return stale schema results.

## Authentication

The Shopify CLI authenticates per-store. Two things consistently bite:

**Use the permanent `*.myshopify.com` domain, not a vanity alias.** OAuth callbacks check the literal hostname. If the store has both `cool-brand.myshopify.com` (vanity) and `yaaijv-6p.myshopify.com` (permanent), use the permanent one.

**Quote the scope string.** Shell line wrapping has silently truncated scopes (e.g. `write_publications` → `wri`) when the command spans multiple lines unquoted.

```bash
shopify store auth -s yaaijv-6p.myshopify.com \
  -S "read_products,write_products,read_themes,write_themes,read_files,write_files,read_publications,write_publications,read_content,write_content,read_locales"
```

Why each scope:

| Scope | Needed for |
|---|---|
| `read_products,write_products` | products, variants, collections, metafields, options |
| `read_themes,write_themes` | `shopify theme push/pull` |
| `read_files,write_files` | `stagedUploadsCreate` + product image upload |
| `read_publications,write_publications` | `publishablePublish` to Online Store sales channel |
| `read_content,write_content` | pages, blogs, articles |
| `read_locales` | translations (safe to include, low risk) |

There is **no** `write_collections` scope — it's covered by `write_products`. Including it returns `invalid_scope`.

## Tooling map

### Shopify Dev MCP — validation + docs
- `learn_shopify_api` — call first, returns conversationId
- `search_docs_chunks` — query the official docs by keyword (don't guess GraphQL types)
- `validate_graphql_codeblocks` — run before every mutation
- `validate_theme` — run before every theme push

### Shopify Admin MCP — direct store ops (prefer when a dedicated tool exists)
- Products: `get-product`, `search_products`, `create-product`, `update-product`, `bulk-update-product-status`
- Collections: `get-collection`, `search_collections`, `create-collection`, `update-collection`, `add-to-collection`
- Inventory: `set-inventory`, `get-inventory-levels`
- Orders & customers: `list-orders`, `get-order`, `list-customers`
- Misc: `create-discount`, `get-shop-info`, `run-analytics-query`
- Escape hatch: `graphql_query` / `graphql_mutation` for anything without a dedicated tool — metafields, metaobjects, pages, publications, files, markets.

### Shopify CLI — theme workflow and arbitrary GraphQL
- `shopify theme push` / `pull` / `dev` / `check`
- `shopify store execute -s <host> --allow-mutations -j -q '<graphql>' -v '<vars-json>'`

## Workflow: Products (create + update)

Use `productSet` as a handle-keyed upsert. It accepts variants, options, and metafields inline, and returns the full product. It's idempotent against the handle, so re-running with the same input is safe.

```graphql
mutation ProductUpsert($product: ProductSetInput!) {
  productSet(input: $product, synchronous: true) {
    product { id handle title status }
    userErrors { field message }
  }
}
```

Variables — minimal shape that survived production:

```json
{
  "product": {
    "handle": "saanjh-kurta-set",
    "title": "Saanjh kurta set",
    "descriptionHtml": "<p>A muted dusk-rose chanderi kurta paired with...</p>",
    "status": "ACTIVE",
    "vendor": "Tapi & Co.",
    "productType": "Kurta set",
    "tags": ["new-arrival", "festive"],
    "productOptions": [
      { "name": "Size", "values": [{"name":"XS"},{"name":"S"},{"name":"M"},{"name":"L"}] }
    ],
    "variants": [
      { "optionValues": [{"optionName":"Size","name":"M"}],
        "price": "4200", "sku": "SAANJH-M",
        "inventoryItem": { "tracked": true } }
    ],
    "metafields": [
      { "namespace": "tapi", "key": "gsm", "type": "number_integer", "value": "180" }
    ]
  }
}
```

ACTIVE alone does **not** make the product visible. See the next section.

### Metafield types — use the `_field` suffix

Bit us once: passing `single_line_text` silently fails because the real type id is `single_line_text_field`. Common types:

- Text: `single_line_text_field`, `multi_line_text_field`
- Numbers: `number_integer`, `number_decimal`
- Structured: `json`, `boolean`, `date`, `url`, `color`, `weight`, `dimension`
- References: `file_reference`, `product_reference`, `metaobject_reference`

If you want the metafield to show up in Admin editors and storefront filters, also define it once via `metafieldDefinitionCreate` (see "Metafields" section below).

## Workflow: Publishing to Online Store

The single biggest "it should be working but isn't" gotcha: a product created with status ACTIVE is **not** visible on the storefront until it's published to the Online Store sales channel. `onlineStoreUrl` comes back `null` until you do this.

Step 1 — find the Online Store publication ID (once, then cache):

```graphql
{ publications(first: 10) { nodes { id name } } }
```

Step 2 — publish each product / collection:

```graphql
mutation Publish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}
```

Variables: `{ "id": "gid://shopify/Product/123", "input": [{"publicationId": "gid://shopify/Publication/456"}] }`

Verify with `{ products(first:6) { nodes { handle onlineStoreUrl } } }` — `onlineStoreUrl` should now be non-null.

## Workflow: Product images

Three steps. Don't try to embed images in `productSet` — go through staged uploads.

```graphql
mutation Stage($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
```

Then POST the file to `url` with the returned form parameters (multipart form), then attach:

```graphql
mutation Attach($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    mediaUserErrors { field message }
  }
}
```

For batch image generation (e.g., placeholder PNGs from SVGs), `sharp` works well in Node — it can rasterize SVG with a fixed density and write PNG in one call.

## Workflow: Inventory

For one-off changes, use the `set-inventory` MCP tool. For bulk:

```graphql
mutation BulkInv($input: InventorySetOnHandQuantitiesInput!) {
  inventorySetOnHandQuantities(input: $input) {
    inventoryAdjustmentGroup { id }
    userErrors { field message }
  }
}
```

Variables need the inventory item ID + location ID. Get the location once:

```graphql
{ locations(first: 5) { nodes { id name } } }
```

Tracked variants (`inventoryItem.tracked: true`) start at 0 — they won't be purchasable until you set quantities.

## Workflow: Metafields (definitions)

Two-phase pattern:

1. **Define once** via `metafieldDefinitionCreate` — sets type, key, namespace, owner type, visibility, validation rules. Without a definition, values still save but Admin won't render a nice editor and storefront filters won't pick them up.
2. **Write values** inline on `productSet` (or via `metafieldsSet` for bulk back-fill).

```graphql
mutation Def($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id }
    userErrors { field message code }
  }
}
```

```json
{
  "definition": {
    "namespace": "tapi",
    "key": "gsm",
    "name": "Fabric GSM",
    "ownerType": "PRODUCT",
    "type": "number_integer",
    "description": "Grams per square metre"
  }
}
```

## Workflow: Themes

### Push from inside the theme directory

```bash
cd theme && shopify theme push \
  --theme <theme-id> \
  --store <store>.myshopify.com \
  --nodelete \
  --json --no-color
```

Why each flag:

- `--nodelete` — Shopify will otherwise delete any remote file that doesn't have a local counterpart. Without `--nodelete`, running from the project root (instead of `theme/`) will try to wipe the entire remote theme.
- `--allow-live` — required when the target theme is the published (live) one. Use sparingly — any push immediately changes what real shoppers see.
- `--only <path>` — fast partial pushes (e.g. `--only sections/header.liquid`).
- `--json --no-color` — clean output for piping.

### Theme architecture (Dawn-based)

- `layout/theme.liquid` — global HTML shell. CSS/JS/font links go here.
- `sections/*.liquid` — schema-enabled blocks. Theme editor exposes their settings.
- `snippets/*.liquid` — pure Liquid partials. **No schema block allowed.** Render via `{% render 'name', arg: x %}`.
- `templates/*.json` — section ordering + per-instance settings for home/product/collection/cart pages.
- `assets/*` — CSS / JS / images / fonts. Reference via `{{ 'file.css' | asset_url }}`.
- `config/settings_schema.json` — theme-wide settings (color schemes, fonts).
- `sections/header-group.json` + `sections/footer-group.json` — the group definitions for headers/footers.

### Common push failures → fixes

| Symptom | Cause | Fix |
|---|---|---|
| "Trying to delete remote files" | ran from project root, not `theme/` | `cd theme && ...` + `--nodelete` |
| "Snippet X has invalid schema block" | snippet contains `{% schema %}` | move schema-bearing markup to a section |
| "Section Y references missing type" | template JSON points to a deleted/renamed section | update or remove the entry in `templates/*.json` |
| "Cannot push to live theme" | target is published | add `--allow-live` (and warn the user first) |
| Header logo wraps on non-home pages | Dawn wraps the logo in `<h1>` only on the homepage | lock `.header` grid + `flex-wrap: nowrap` with `!important` for the wrapping element |

### Local CSS strategy

For brand customizations on top of Dawn, append to a single `assets/<brand>-variables.css` and link it from `layout/theme.liquid`. Drive section-to-section consistency with CSS custom properties:

```css
:root { --tapi-section-y: clamp(6.4rem, 9vw, 11rem); }
.tapi-hero, .tapi-collection-tiles, .tapi-featured, .tapi-studio-strip,
.tapi-editorial-band {
  padding-top: var(--tapi-section-y) !important;
  padding-bottom: var(--tapi-section-y) !important;
  margin: 0 !important;
}
```

One variable beats ten hardcoded padding values — when the user says "the spacing's off", you change one number.

## Confirming before destructive ops — the script

Before any mutation that changes the store, post a single message that contains:

1. The store you're targeting (`*.myshopify.com`)
2. The mutation name
3. The variables (IDs and prices are fine to show; obvious secrets like access tokens are not)
4. The state change in plain words ("creates 6 products as ACTIVE but unpublished; they won't be visible until `publishablePublish` runs")
5. The literal sentence: "Type 'yes' to proceed."

Wait. Then run.

## Common errors → fixes (the cheat sheet)

| Error | Cause | Fix |
|---|---|---|
| `invalid_scope: write_collections` | scope doesn't exist | remove — `write_products` covers it |
| OAuth callback "store does not match" | used vanity alias | use permanent `*.myshopify.com` |
| `Type 'single_line_text' is not valid` | dropped `_field` suffix | use `single_line_text_field` |
| Product created, `onlineStoreUrl` null | not published to sales channel | run `publishablePublish` with Online Store publication ID |
| Theme push deletes files | ran from wrong CWD | `cd theme` + `--nodelete` |
| Cannot push, theme is live | published theme | add `--allow-live` after warning the user |
| Snippet has `{% schema %}` | snippets can't carry schema | move that markup to a section file |
| Logo invisible on dark background | hardcoded charcoal color in SVG | switch to `color: inherit` and let parent set the color |

## What to NOT do

- Don't include `write_collections` in scopes.
- Don't run mutations without validate → confirm → "yes".
- Don't publish a theme. The user does that.
- Don't invent product data. If a fabric/color/GSM/price isn't in the source files, ask.
- **Never delete or blank a supplier/wholesaler name.** The public `vendor` field must always read "Morpaankh" (a real name there is a public leak), but before resetting it you MUST copy the existing value into the private `internal.supplier` metafield (`access.storefront: NONE`). Copy first, reset second — never reset without copying. The user has repeatedly and angrily flagged supplier names going missing.
- Don't use REST Admin endpoints. GraphQL only.
- Don't commit store domains, access tokens, or API keys.
- Don't push the theme without `validate_theme` for non-trivial Liquid changes.

## Looking things up

Don't guess GraphQL types or fields — call `search_docs_chunks` with a keyword first. The Admin schema is large and versioned; what's true on `2024-10` may differ on `2024-07`. When in doubt, validate.
