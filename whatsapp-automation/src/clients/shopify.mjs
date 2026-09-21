/*
 * clients/shopify.mjs — Admin GraphQL client (same shape as meta-outcomes).
 *
 * Reads are always allowed; writes respect DRY_RUN. The heavy order-edit /
 * payment / discount / metaobject mutations land in Phase 5/6, each validated
 * against the live schema before shipping. Phase 3 provides the primitives the
 * flows share: graphql(), getOrder(), tagsAdd(), and webhook subscription sync.
 */
import { config } from '../config.mjs';
import { getSecrets } from '../secrets.mjs';
import { log } from '../log.mjs';

async function graphql(query, variables = {}) {
  const s = await getSecrets();
  const endpoint = `https://${config.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': s.shopifyAdminToken },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// Fields the flows + classifier need. Validated against the live schema at Phase 5.
const ORDER_FIELDS = `
  id
  name
  note
  tags
  test
  createdAt
  cancelledAt
  displayFinancialStatus
  paymentGatewayNames
  netPaymentSet { shopMoney { amount currencyCode } }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  customAttributes { key value }
  customer { id firstName }
  shippingAddress { zip city }
  shippingLines(first: 10) { nodes { title originalPriceSet { shopMoney { amount } } } }
  fulfillments(first: 10) { status displayStatus trackingInfo { number company } }
  lineItems(first: 50) { nodes { id title quantity product { id } originalUnitPriceSet { shopMoney { amount } } } }
`;

async function getOrder(numericOrGid) {
  const id = String(numericOrGid).startsWith('gid://') ? numericOrGid : `gid://shopify/Order/${numericOrGid}`;
  const data = await graphql(`query GetOrder($id: ID!){ order(id:$id){ ${ORDER_FIELDS} } }`, { id });
  return data.order;
}

/** Orders updated on/after sinceISO (id + tags only). Used by digest + reconcile. */
async function ordersUpdatedSince(sinceISO) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(
      `query Iter($q: String!, $after: String){
         orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT){
           edges { cursor node { id tags } } pageInfo { hasNextPage endCursor }
         } }`,
      { q: `updated_at:>='${sinceISO}'`, after: cursor },
    );
    for (const e of data.orders.edges) out.push(e.node);
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  return out;
}

async function tagsAdd(orderGid, tags) {
  if (config.dryRun) {
    log.info('shopify tagsAdd skipped (dry_run)', { orderGid, tags });
    return { skipped: 'dry_run' };
  }
  const data = await graphql(
    `mutation Add($id: ID!, $tags: [String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ field message } } }`,
    { id: orderGid, tags },
  );
  const errs = data.tagsAdd.userErrors;
  if (errs.length) throw new Error(`tagsAdd errors: ${JSON.stringify(errs)}`);
  return { ok: true };
}

// ---- webhook subscription sync (used by scripts/shopify-webhooks-sync) -------
const TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_CANCELLED',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'FULFILLMENT_EVENTS_CREATE',
];

async function ensureWebhooks({ dryRun = true } = {}) {
  const callbackUrl = `${config.publicBaseUrl}/webhooks/shopify`;
  const existing = await graphql(
    `{ webhookSubscriptions(first:100){ edges{ node{ id topic endpoint{ __typename ... on WebhookHttpEndpoint{ callbackUrl } } } } } }`,
  );
  const nodes = existing.webhookSubscriptions.edges.map((e) => e.node);
  const results = [];
  for (const topic of TOPICS) {
    const match = nodes.find((w) => w.topic === topic && w.endpoint?.callbackUrl === callbackUrl);
    if (match) {
      results.push({ topic, status: 'exists' });
      continue;
    }
    if (dryRun) {
      results.push({ topic, status: 'would-create', callbackUrl });
      continue;
    }
    const data = await graphql(
      `mutation Sub($topic: WebhookSubscriptionTopic!, $url: String!){
         webhookSubscriptionCreate(topic:$topic, webhookSubscription:{ uri:$url, format:JSON }){
           userErrors{ field message } webhookSubscription{ id }
         } }`,
      { topic, url: callbackUrl },
    );
    const errs = data.webhookSubscriptionCreate.userErrors;
    results.push(errs.length ? { topic, status: 'error', errors: errs } : { topic, status: 'created' });
  }
  return results;
}

async function orderCancel(orderGid, { reason = 'CUSTOMER', staffNote = '' } = {}) {
  if (config.dryRun) {
    log.info('shopify orderCancel skipped (dry_run)', { orderGid, reason });
    return { skipped: 'dry_run' };
  }
  // COD has nothing captured, so no refund is issued (the deprecated `refund`
  // arg is omitted). Validated against the live schema before go-live.
  const data = await graphql(
    `mutation Cancel($orderId: ID!, $reason: OrderCancelReason!, $staffNote: String) {
       orderCancel(orderId: $orderId, reason: $reason, restock: true, notifyCustomer: false, staffNote: $staffNote) {
         orderCancelUserErrors { field message }
       }
     }`,
    { orderId: orderGid, reason, staffNote },
  );
  const errs = data.orderCancel?.orderCancelUserErrors || [];
  if (errs.length) throw new Error(`orderCancel errors: ${JSON.stringify(errs)}`);
  return { ok: true };
}

async function metafieldsSet(metafields) {
  if (config.dryRun) {
    log.info('shopify metafieldsSet skipped (dry_run)', { count: metafields.length });
    return { skipped: 'dry_run' };
  }
  const data = await graphql(
    `mutation Set($mf: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $mf) { userErrors { field message } } }`,
    { mf: metafields },
  );
  const errs = data.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet errors: ${JSON.stringify(errs)}`);
  return { ok: true };
}

/**
 * COD -> prepaid Shopify accounting (spec section 7 step 8c-8f).
 *
 * The exact mutation sequence + payment-record method (orderMarkAsPaid vs
 * orderCreateManualPayment) MUST be chosen by TESTING on a real test order
 * first (DECISIONS C3). Until that verification is done and CONVERSION_VERIFIED
 * is set, the live path refuses to run so no half-verified money mutation ever
 * touches a real order. DRY_RUN returns the plan for the fixture replay.
 */
async function convertToPrepaid({ order, amounts, paymentId, linkId }) {
  const plan = {
    orderId: order.numericId,
    removeShippingLine: 'Cash on Delivery',
    addShippingLine: 'Standard @ 0',
    discountPaise: amounts.discountPaise,
    codFeeRemovedPaise: amounts.codFeePaise,
    expectedNewTotalPaise: amounts.newTotalPaise,
    paymentId,
    linkId,
    method: 'order_edit',
  };
  if (config.dryRun) {
    log.info('convertToPrepaid plan (dry_run)', plan);
    return { ...plan, applied: false, method: 'dry_run' };
  }
  if (process.env.CONVERSION_VERIFIED !== 'true') {
    throw new Error(
      'prepaid conversion not verified on a test order yet. Run the Phase 5 test-order verification ' +
        '(pick the working order-edit + payment-record option, confirm outstanding == amount paid), ' +
        'author the sequence here, then set CONVERSION_VERIFIED=true. See DECISIONS C3.',
    );
  }
  // TODO(Phase 5 test-order): author the verified option-1 sequence here:
  //   orderEditBegin -> orderEditRemoveShippingLine(Cash on Delivery) ->
  //   orderEditAddShippingLine(Standard, 0) -> orderEditAddLineItemDiscount(₹100 on
  //   the highest line) -> orderEditCommit(notifyCustomer:false, staffNote:paymentId);
  //   then record payment (orderMarkAsPaid or orderCreateManualPayment) and assert
  //   outstanding == amount paid to the paisa before returning applied:true.
  throw new Error('convertToPrepaid live sequence not authored yet (pending test-order verification)');
}

// ---- Flow B: reviews + thank-you code --------------------------------------
/** Create a product_review metaobject (ACTIVE or DRAFT). Returns { id, status }. */
async function createReview({ productGid, orderName, rating, fit, body, authorName, consent, status, submittedAt }) {
  const fields = [
    { key: 'order_name', value: String(orderName || '') },
    { key: 'rating', value: String(rating) },
    { key: 'body', value: String(body) },
    { key: 'author_name', value: String(authorName) },
    { key: 'verified_buyer', value: 'true' },
    { key: 'consent', value: String(Boolean(consent)) },
    { key: 'source', value: 'whatsapp' },
    { key: 'submitted_at', value: submittedAt || new Date().toISOString() },
  ];
  if (productGid) fields.push({ key: 'product', value: productGid });
  if (fit) fields.push({ key: 'fit', value: fit });

  if (config.dryRun) {
    log.info('createReview skipped (dry_run)', { status, rating });
    return { id: 'dry_review', status };
  }
  const data = await graphql(
    `mutation MoCreate($m: MetaobjectCreateInput!){ metaobjectCreate(metaobject:$m){ metaobject{ id } userErrors{ field message code } } }`,
    { m: { type: 'tapi_review', capabilities: { publishable: { status } }, fields } },
  );
  const errs = data.metaobjectCreate?.userErrors || [];
  if (errs.length) throw new Error(`createReview errors: ${JSON.stringify(errs)}`);
  return { id: data.metaobjectCreate.metaobject.id, status };
}

/** Append a review metaobject gid to a product's custom.reviews list (ACTIVE only). */
async function appendProductReview(productGid, reviewGid) {
  if (config.dryRun) {
    log.info('appendProductReview skipped (dry_run)', { productGid });
    return { skipped: 'dry_run' };
  }
  const cur = await graphql(`query($id:ID!){ product(id:$id){ metafield(namespace:"custom", key:"reviews"){ value } } }`, { id: productGid });
  let list = [];
  try {
    list = JSON.parse(cur.product?.metafield?.value || '[]');
  } catch {
    list = [];
  }
  if (!list.includes(reviewGid)) list.push(reviewGid);
  return metafieldsSet([
    { ownerId: productGid, namespace: 'custom', key: 'reviews', type: 'list.metaobject_reference', value: JSON.stringify(list) },
  ]);
}

/** Create a single-use percentage code for any customer. Returns { id, code }. */
async function createDiscountCode({ code, title, startsAt, endsAt, percentage, minSubtotalInr }) {
  if (config.dryRun) {
    log.info('createDiscountCode skipped (dry_run)', { code });
    return { id: 'dry_discount', code };
  }
  const data = await graphql(
    `mutation Disc($basic: DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$basic){ codeDiscountNode{ id } userErrors{ field message code } } }`,
    {
      basic: {
        title,
        code,
        startsAt,
        endsAt,
        usageLimit: 1,
        appliesOncePerCustomer: true,
        context: { all: 'ALL' },
        customerGets: { value: { percentage }, items: { all: true } },
        minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(minSubtotalInr) } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
      },
    },
  );
  const errs = data.discountCodeBasicCreate?.userErrors || [];
  if (errs.length) throw new Error(`createDiscountCode errors: ${JSON.stringify(errs)}`);
  return { id: data.discountCodeBasicCreate.codeDiscountNode.id, code };
}

export const shopify = {
  graphql,
  getOrder,
  ordersUpdatedSince,
  tagsAdd,
  orderCancel,
  metafieldsSet,
  convertToPrepaid,
  createReview,
  appendProductReview,
  createDiscountCode,
  ensureWebhooks,
  ORDER_FIELDS,
};
