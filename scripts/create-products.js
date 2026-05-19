#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');

const STORE = 'yaaijv-6p.myshopify.com';
const ROOT = '/Users/ashishgohil/garment-seller/scripts';
const data = JSON.parse(fs.readFileSync(`${ROOT}/products-data.json`, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`, 'utf8'));

const MUTATION = `mutation BuildProduct($product: ProductSetInput!) {
  productSet(synchronous: true, input: $product) {
    product {
      id handle title
      variants(first: 20) { nodes { id title sku inventoryItem { id } } }
    }
    userErrors { field message code }
  }
}`;

function exec(query, variables) {
  const out = execFileSync('shopify', [
    'store', 'execute',
    '-s', STORE,
    '--allow-mutations',
    '-j',
    '-q', query,
    '-v', JSON.stringify(variables),
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // CLI prints "Executing GraphQL operation ..." then JSON. Strip non-JSON prefix.
  const jsonStart = out.indexOf('{');
  return JSON.parse(out.slice(jsonStart));
}

function buildProductInput(p) {
  const collectionIds = (p.collections || []).map(h => manifest.collections[h]).filter(Boolean);
  const colorOptions = JSON.stringify(p.colors);
  const demoReviews = JSON.stringify(data.reviews);
  const stockBySize = JSON.stringify(p.stockBySize);
  const piecesValue = JSON.stringify(p.pieces);

  const metafields = [
    { namespace: 'tapi', key: 'subtitle',      type: 'single_line_text_field', value: p.subtitle },
    { namespace: 'tapi', key: 'gsm',           type: 'number_integer',         value: String(p.fabric.gsm) },
    { namespace: 'tapi', key: 'blend',         type: 'single_line_text_field', value: p.fabric.blend },
    { namespace: 'tapi', key: 'weave',         type: 'single_line_text_field', value: p.fabric.weave },
    { namespace: 'tapi', key: 'weave_key',     type: 'single_line_text_field', value: p.fabric.weave_key },
    { namespace: 'tapi', key: 'fit_type',      type: 'single_line_text_field', value: p.fabric.fit_type },
    { namespace: 'tapi', key: 'opacity_note',  type: 'single_line_text_field', value: p.fabric.opacity_note },
    { namespace: 'tapi', key: 'breathability', type: 'single_line_text_field', value: p.fabric.breathability },
    { namespace: 'tapi', key: 'wash_care',     type: 'single_line_text_field', value: p.fabric.wash_care },
    { namespace: 'tapi', key: 'pieces',        type: 'list.single_line_text_field', value: piecesValue },
    { namespace: 'tapi', key: 'model_height',  type: 'single_line_text_field', value: p.model.height },
    { namespace: 'tapi', key: 'model_size',    type: 'single_line_text_field', value: p.model.size },
    { namespace: 'tapi', key: 'model_bust',    type: 'number_integer',         value: String(p.model.bust) },
    { namespace: 'tapi', key: 'model_waist',   type: 'number_integer',         value: String(p.model.waist) },
    { namespace: 'tapi', key: 'fit_note',      type: 'single_line_text_field', value: p.model.fit_note },
    { namespace: 'tapi', key: 'fit_pct_true',  type: 'number_integer',         value: String(p.fit.true) },
    { namespace: 'tapi', key: 'fit_pct_up',    type: 'number_integer',         value: String(p.fit.up) },
    { namespace: 'tapi', key: 'fit_pct_down',  type: 'number_integer',         value: String(p.fit.down) },
    { namespace: 'tapi', key: 'story',         type: 'multi_line_text_field',  value: p.story },
    { namespace: 'tapi', key: 'color_options', type: 'json',                   value: colorOptions },
    { namespace: 'tapi', key: 'demo_reviews',  type: 'json',                   value: demoReviews },
    { namespace: 'tapi', key: 'rating',        type: 'number_decimal',         value: String(p.rating) },
    { namespace: 'tapi', key: 'review_count',  type: 'number_integer',         value: String(p.reviewCount) },
    { namespace: 'tapi', key: 'stock_by_size', type: 'json',                   value: stockBySize },
  ];

  const variants = p.sizes.map(size => ({
    optionValues: [{ optionName: 'Size', name: size }],
    price: p.price,
    compareAtPrice: p.compareAt || null,
    inventoryItem: { tracked: true, sku: `${p.handle.toUpperCase().slice(0,6)}-${size}` },
  }));

  return {
    handle: p.handle,
    title: p.title,
    descriptionHtml: p.description,
    productType: p.type,
    vendor: 'Tapi & Co.',
    tags: p.tags,
    status: 'ACTIVE',
    seo: { title: p.title, description: p.description },
    productOptions: [
      { name: 'Size', position: 1, values: p.sizes.map(s => ({ name: s })) },
    ],
    variants,
    collections: collectionIds,
    metafields,
  };
}

function run() {
  for (const p of data.products) {
    process.stdout.write(`>> product: ${p.handle} ... `);
    const variables = { product: buildProductInput(p) };
    try {
      const res = exec(MUTATION, variables);
      const errors = res?.productSet?.userErrors;
      if (errors && errors.length) {
        console.log('ERR');
        console.log(JSON.stringify(errors, null, 2));
        continue;
      }
      const prod = res?.productSet?.product;
      console.log(prod.id);
      manifest.products[p.handle] = {
        id: prod.id,
        title: prod.title,
        variants: prod.variants.nodes.map(v => ({ id: v.id, title: v.title, inventoryItemId: v.inventoryItem.id })),
      };
      fs.writeFileSync(`${ROOT}/manifest.json`, JSON.stringify(manifest, null, 2));
    } catch (e) {
      console.log('FAIL');
      console.error(e.message);
    }
  }
  console.log('\n--- products created:', Object.keys(manifest.products).length);
}

run();
