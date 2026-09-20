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
  createdAt
  cancelledAt
  displayFinancialStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  customAttributes { key value }
  customer { firstName }
  shippingLines(first: 10) { nodes { title originalPriceSet { shopMoney { amount } } } }
  fulfillments(first: 10) { status displayStatus trackingInfo { number company } }
  lineItems(first: 50) { nodes { id title quantity originalUnitPriceSet { shopMoney { amount } } } }
`;

async function getOrder(numericOrGid) {
  const id = String(numericOrGid).startsWith('gid://') ? numericOrGid : `gid://shopify/Order/${numericOrGid}`;
  const data = await graphql(`query GetOrder($id: ID!){ order(id:$id){ ${ORDER_FIELDS} } }`, { id });
  return data.order;
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
      `mutation Sub($topic: WebhookSubscriptionTopic!, $url: URL!){
         webhookSubscriptionCreate(topic:$topic, webhookSubscription:{ callbackUrl:$url, format:JSON }){
           userErrors{ field message } webhookSubscription{ id }
         } }`,
      { topic, url: callbackUrl },
    );
    const errs = data.webhookSubscriptionCreate.userErrors;
    results.push(errs.length ? { topic, status: 'error', errors: errs } : { topic, status: 'created' });
  }
  return results;
}

export const shopify = { graphql, getOrder, tagsAdd, ensureWebhooks, ORDER_FIELDS };
