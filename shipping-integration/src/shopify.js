'use strict';

/**
 * Shopify Admin API client (REST for fulfillments/events, GraphQL for lookups
 * and order tagging/notes). Uses native fetch (Node >= 18).
 */
const config = require('./config');

const { shop, adminToken, apiVersion } = config.shopify;
const REST = `https://${shop}/admin/api/${apiVersion}`;
const GQL = `${REST}/graphql.json`;

async function rest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${REST}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_e) {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Shopify ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function graphql(query, variables) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/** Fulfillment orders for an order (numeric id). */
async function getFulfillmentOrders(orderId) {
  const data = await rest(`/orders/${orderId}/fulfillment_orders.json`);
  return data.fulfillment_orders || [];
}

/**
 * Create a fulfillment for all open fulfillment orders, attaching tracking.
 * This is what surfaces tracking on the storefront order page + emails.
 */
async function createFulfillment({
  orderId,
  trackingNumber,
  trackingUrl,
  trackingCompany,
  notifyCustomer,
}) {
  const fulfillmentOrders = await getFulfillmentOrders(orderId);
  const open = fulfillmentOrders.filter(
    (fo) => fo.status === 'open' || fo.status === 'in_progress'
  );
  if (!open.length) {
    throw new Error(`No open fulfillment orders for order ${orderId}`);
  }
  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: open.map((fo) => ({
        fulfillment_order_id: fo.id,
      })),
      tracking_info: {
        number: trackingNumber,
        url: trackingUrl,
        company: trackingCompany,
      },
      notify_customer: Boolean(notifyCustomer),
    },
  };
  const data = await rest('/fulfillments.json', { method: 'POST', body });
  return data.fulfillment;
}

/**
 * Create a fulfillment event (status update). Valid statuses:
 * confirmed, in_transit, out_for_delivery, delivered, attempted_delivery, failure.
 */
function createFulfillmentEvent(orderId, fulfillmentId, status, message) {
  return rest(`/orders/${orderId}/fulfillments/${fulfillmentId}/events.json`, {
    method: 'POST',
    body: { event: { status, message } },
  });
}

/** Find an order by its name/number (e.g. "1001" or "#1001"). DB-free mapping. */
async function findOrderByName(name) {
  const clean = String(name).replace(/^#/, '');
  const data = await graphql(
    `query($q: String!) {
       orders(first: 1, query: $q) {
         nodes {
           id
           legacyResourceId
           name
           tags
           phone
           customer { firstName }
           shippingAddress { phone }
           billingAddress { phone }
           fulfillments(first: 10) { id legacyResourceId status }
         }
       }
     }`,
    { q: `name:#${clean}` }
  );
  return data.orders.nodes[0] || null;
}

function addTags(orderGid, tags) {
  return graphql(
    `mutation($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) { userErrors { message } }
     }`,
    { id: orderGid, tags }
  );
}

function addOrderNote(orderGid, note) {
  return graphql(
    `mutation($input: OrderInput!) {
       orderUpdate(input: $input) { userErrors { message } }
     }`,
    { input: { id: orderGid, note } }
  );
}

module.exports = {
  rest,
  graphql,
  getFulfillmentOrders,
  createFulfillment,
  createFulfillmentEvent,
  findOrderByName,
  addTags,
  addOrderNote,
};
