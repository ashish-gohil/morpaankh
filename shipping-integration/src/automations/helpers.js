'use strict';

/**
 * Shared pure logic + the shop-metafield ledger used by automations that act
 * on objects which can't carry tags (abandoned checkouts). Orders use tags
 * instead — visible in admin and queryable, which beats hidden state.
 */
const shopify = require('../shopify');

const LEDGER_NAMESPACE = 'internal';
const LEDGER_CAP = 500;

/** Minutes elapsed since an ISO timestamp. */
function minutesSince(iso, now = new Date()) {
  return (now.getTime() - new Date(iso).getTime()) / 60000;
}

/** "2026-07-02" in IST regardless of server timezone. */
function istDateStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Keep the most recent `cap` entries (new ids are appended at the end). */
function trimLedger(ids, cap = LEDGER_CAP) {
  return ids.length > cap ? ids.slice(ids.length - cap) : ids;
}

/** Read a JSON-array ledger from a shop metafield. Missing = empty. */
async function readLedger(key) {
  const data = await shopify.graphql(
    `query AutomationLedger($namespace: String!, $key: String!) {
       shop { id metafield(namespace: $namespace, key: $key) { id value } }
     }`,
    { namespace: LEDGER_NAMESPACE, key }
  );
  const shopId = data.shop.id;
  let ids = [];
  if (data.shop.metafield && data.shop.metafield.value) {
    try {
      const parsed = JSON.parse(data.shop.metafield.value);
      if (Array.isArray(parsed)) ids = parsed;
    } catch (_e) {
      /* corrupt ledger = start over; worst case is one repeat message */
    }
  }
  return { shopId, ids };
}

/** Write the ledger back (capped). */
async function writeLedger(shopId, key, ids) {
  const data = await shopify.graphql(
    `mutation SetLedger($metafields: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $metafields) {
         metafields { id }
         userErrors { field message }
       }
     }`,
    {
      metafields: [
        {
          ownerId: shopId,
          namespace: LEDGER_NAMESPACE,
          key,
          type: 'json',
          value: JSON.stringify(trimLedger(ids)),
        },
      ],
    }
  );
  const errors = data.metafieldsSet.userErrors;
  if (errors && errors.length) {
    throw new Error(`Ledger write failed: ${errors.map((e) => e.message).join('; ')}`);
  }
}

/**
 * Search orders with the fields every automation needs.
 * `queryString` is Shopify's order search syntax.
 */
async function searchOrders(queryString, first = 50) {
  const data = await shopify.graphql(
    `query AutomationOrders($first: Int!, $query: String!) {
       orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
         nodes {
           id
           name
           createdAt
           tags
           paymentGatewayNames
           displayFinancialStatus
           displayFulfillmentStatus
           totalPriceSet { shopMoney { amount currencyCode } }
           phone
           customer { firstName defaultPhoneNumber { marketingState } }
           shippingAddress { phone }
           billingAddress { phone }
         }
       }
     }`,
    { first, query: queryString }
  );
  return data.orders.nodes;
}

/** Best available phone on an order. */
function orderPhone(order) {
  return (
    order.phone ||
    (order.shippingAddress && order.shippingAddress.phone) ||
    (order.billingAddress && order.billingAddress.phone) ||
    null
  );
}

/** "Rs 2,199" — WhatsApp template params can't contain newlines/tabs. */
function formatAmount(moneySet) {
  const amount = Number(moneySet && moneySet.shopMoney ? moneySet.shopMoney.amount : 0);
  return `Rs ${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

module.exports = {
  minutesSince,
  istDateStamp,
  trimLedger,
  readLedger,
  writeLedger,
  searchOrders,
  orderPhone,
  formatAmount,
  LEDGER_CAP,
};
