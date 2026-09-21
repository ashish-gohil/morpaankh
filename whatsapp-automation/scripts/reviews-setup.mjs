#!/usr/bin/env node
/*
 * reviews-setup — create the tapi_review metaobject definition (idempotent).
 * Storefront PUBLIC_READ + publishable capability, so ACTIVE reviews render on
 * the PDP. Dry-run by default; --live to create.
 *
 *   node scripts/reviews-setup.mjs          # report
 *   node scripts/reviews-setup.mjs --live   # create the definition
 *
 * The star summary + JSON-LD are computed in the theme from the product's
 * custom.reviews list (ACTIVE reviews only are linked), so Shopify's standard
 * reviews.rating/rating_count metafields are optional and not required here.
 */
import { shopify } from '../src/clients/shopify.mjs';

const live = process.argv.includes('--live');

const DEF = {
  name: 'Product review',
  type: 'tapi_review',
  access: { storefront: 'PUBLIC_READ' },
  capabilities: { publishable: { enabled: true } },
  fieldDefinitions: [
    { key: 'product', name: 'Product', type: 'product_reference' },
    { key: 'order_name', name: 'Order name', type: 'single_line_text_field' },
    { key: 'rating', name: 'Rating', type: 'number_integer' },
    { key: 'fit', name: 'Fit', type: 'single_line_text_field' },
    { key: 'body', name: 'Body', type: 'multi_line_text_field' },
    { key: 'author_name', name: 'Author name', type: 'single_line_text_field' },
    { key: 'verified_buyer', name: 'Verified buyer', type: 'boolean' },
    { key: 'consent', name: 'Consent', type: 'boolean' },
    { key: 'source', name: 'Source', type: 'single_line_text_field' },
    { key: 'submitted_at', name: 'Submitted at', type: 'date_time' },
  ],
};

async function exists() {
  const d = await shopify.graphql(`{ metaobjectDefinitionByType(type:"tapi_review"){ id } }`).catch(() => null);
  return Boolean(d?.metaobjectDefinitionByType?.id);
}

if (!live) {
  console.log('reviews-setup (dry-run): would create metaobject definition tapi_review with', DEF.fieldDefinitions.length, 'fields.');
  process.exit(0);
}

if (await exists()) {
  console.log('tapi_review definition already exists; nothing to do.');
  process.exit(0);
}
const data = await shopify.graphql(
  `mutation DefCreate($definition: MetaobjectDefinitionCreateInput!){
     metaobjectDefinitionCreate(definition:$definition){ metaobjectDefinition{ id type } userErrors{ field message code } }
   }`,
  { definition: DEF },
);
const errs = data.metaobjectDefinitionCreate?.userErrors || [];
if (errs.length) {
  console.error('errors:', JSON.stringify(errs));
  process.exit(2);
}
console.log('created:', data.metaobjectDefinitionCreate.metaobjectDefinition.id);
