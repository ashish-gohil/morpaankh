/*
 * shopify.mjs — thin Admin GraphQL client for this store.
 *
 * The webhook is only a trigger; every decision is made from a fresh GraphQL
 * read so displayStatus and netPaymentSet are canonical. Uses global fetch
 * (Node 18+). The access token and store domain come from config.
 */
import { config } from './config.mjs';

const endpoint = () =>
  `https://${config.shopify.domain}/admin/api/${config.shopify.apiVersion}/graphql.json`;

export async function adminGraphql(query, variables = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// Fields the classifier and Meta matching need. Kept in one place.
const ORDER_FIELDS = `
  id
  name
  note
  tags
  cancelledAt
  createdAt
  updatedAt
  currencyCode
  displayFinancialStatus
  netPaymentSet { shopMoney { amount currencyCode } }
  email
  phone
  shippingAddress { city province zip countryCodeV2 phone }
  fulfillments(first: 20) { displayStatus }
`;

export async function getOrderByNumericId(numericId) {
  const data = await adminGraphql(
    `query GetOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: `gid://shopify/Order/${numericId}` },
  );
  return data.order;
}

/**
 * Async-iterate every order created on/after `sinceISO`, oldest first.
 * Used by the one-time backfill. Yields raw GraphQL order nodes.
 */
export async function* iterateOrdersSince(sinceISO) {
  yield* iterateOrders(`created_at:>='${sinceISO}'`, 'CREATED_AT');
}

/**
 * Async-iterate every order *updated* on/after `sinceISO`, oldest-updated first.
 * This is what the scheduled poll uses: an order created days ago whose outcome
 * changes today (delivered / RTO tag added) reappears because its updatedAt moved.
 */
export async function* iterateOrdersUpdatedSince(sinceISO) {
  yield* iterateOrders(`updated_at:>='${sinceISO}'`, 'UPDATED_AT');
}

async function* iterateOrders(queryStr, sortKey) {
  let cursor = null;
  for (;;) {
    const data = await adminGraphql(
      `query Iter($q: String!, $after: String) {
         orders(first: 50, after: $after, query: $q, sortKey: ${sortKey}) {
           edges { cursor node { ${ORDER_FIELDS} } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { q: queryStr, after: cursor },
    );
    for (const edge of data.orders.edges) yield edge.node;
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
}

const TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_CANCELLED',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
];

async function listWebhooks() {
  const data = await adminGraphql(
    `{ webhookSubscriptions(first: 100) {
         edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
       } }`,
  );
  return data.webhookSubscriptions.edges.map((e) => e.node);
}

/**
 * Ensure the five topics point at `${publicBaseUrl}/webhooks/shopify`.
 * Idempotent: skips topics already pointing at the same URL. In dry-run it only
 * reports what it would create.
 */
export async function ensureWebhooks(publicBaseUrl, { dryRun = true } = {}) {
  const callbackUrl = `${publicBaseUrl}/webhooks/shopify`;
  const existing = await listWebhooks();
  const results = [];
  for (const topic of TOPICS) {
    const match = existing.find(
      (w) => w.topic === topic && w.endpoint?.callbackUrl === callbackUrl,
    );
    if (match) {
      results.push({ topic, status: 'exists' });
      continue;
    }
    if (dryRun) {
      results.push({ topic, status: 'would-create', callbackUrl });
      continue;
    }
    const data = await adminGraphql(
      `mutation Sub($topic: WebhookSubscriptionTopic!, $url: URL!) {
         webhookSubscriptionCreate(
           topic: $topic,
           webhookSubscription: { callbackUrl: $url, format: JSON }
         ) { userErrors { field message } webhookSubscription { id } }
       }`,
      { topic, url: callbackUrl },
    );
    const errs = data.webhookSubscriptionCreate.userErrors;
    results.push(
      errs.length
        ? { topic, status: 'error', errors: errs }
        : { topic, status: 'created' },
    );
  }
  return results;
}
