/*
 * pnl/sources/shopify.mjs — the month's orders, normalised to NormOrder.
 *
 * ITS OWN GRAPHQL DOCUMENT, NOT clients/shopify.mjs ORDER_FIELDS. The comment
 * at shopify.mjs:119-134 is the reason: that fragment is on the hot path of
 * every flow, every poll and every reconcile pass, so widening it to carry
 * unit costs, transactions and the customer journey would put all of that into
 * the response of every order read the service makes. This asks for it once, a
 * few dozen orders a month, in the one place that needs it.
 *
 * The field set below is copied verbatim from the probe that validated it
 * against the live 2026-07 schema on 2026-11-03 (DECISIONS V). Changing a line
 * of it means re-running that probe: Shopify answers an unknown field with a
 * GraphQL error that clients/shopify.mjs turns into a throw, so a typo here
 * fails the whole report rather than one column.
 *
 * NO PHONE, NO EMAIL, NO STREET ADDRESS leaves this file. The report is a
 * spreadsheet the owner mails to an accountant, and city/state/pin is all the
 * freight maths needs. `customer { displayName }` is asked for because
 * excludeCustomers/excludeSurnames are names, and it is the only personal
 * field in the document.
 *
 * A failure throws. The engine owns SourceStatus and records the failure there;
 * an adapter that swallowed its own outage would hand back an empty month that
 * reads exactly like a month with no sales.
 */
import { toPaise } from '../../lib/money.mjs';
import { log } from '../../log.mjs';

/*
 * Verbatim from scratchpad/pnl/fetch-orders.mjs, which is the version that
 * returned real values for all 73 October orders.
 *
 * `first: 25` is the proven page size. The document asks for 50 line items, 20
 * transactions and 10 fulfillments per order, so the query cost per node is
 * high and a bigger page is the thing Shopify throttles.
 */
export const PNL_ORDER_FIELDS = `
  id name createdAt cancelledAt cancelReason sourceName app { name } tags
  customer { displayName }
  shippingAddress { city provinceCode zip }
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames taxesIncluded
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  netPaymentSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  shippingLines(first: 5) { nodes { title originalPriceSet { shopMoney { amount } } } }
  taxLines { title rate ratePercentage priceSet { shopMoney { amount } } }
  transactions(first: 20) { kind status gateway amountSet { shopMoney { amount } } createdAt }
  fulfillments(first: 10) { status displayStatus createdAt deliveredAt trackingInfo(first: 5) { company number } }
  customerJourneySummary { lastVisit { utmParameters { source medium campaign } } }
  lineItems(first: 50) {
    nodes {
      title sku quantity currentQuantity
      originalUnitPriceSet { shopMoney { amount } }
      discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
      variant { id inventoryItem { unitCost { amount } } }
    }
  }
`;

const PNL_ORDERS_QUERY = `query PnlOrders($q: String!, $cursor: String) {
  orders(first: 25, query: $q, after: $cursor, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${PNL_ORDER_FIELDS} }
  }
}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A money string Shopify may not have sent -> paise, or null. Never 0 for absent. */
function paiseOrNull(amount) {
  if (amount == null || amount === '') return null;
  return toPaise(amount);
}

const money = (set) => toPaise(set?.shopMoney?.amount ?? 0);

/**
 * THE `created_at:` SEARCH FILTER IGNORES THE TIME OF DAY.
 *
 * Proven on 2026-11-03: `created_at:>=2026-09-30T18:30:00Z` still returns
 * #1168 (08:04Z) and #1169 (17:37Z), both of which are September in IST. So
 * the search asks for a window a day wider on each side and the real cut is
 * made in code against `createdAt`. Doing that yields exactly #1170-#1240.
 *
 * Widening rather than narrowing because the failure modes are not symmetric:
 * an extra order is dropped by the filter below, a missing one is simply
 * absent from the month's profit with nothing to notice it by.
 */
export function searchWindow(monthStartUtc, monthEndUtc) {
  const from = new Date(new Date(monthStartUtc).getTime() - DAY_MS).toISOString();
  const to = new Date(new Date(monthEndUtc).getTime() + DAY_MS).toISOString();
  return `created_at:>=${from} created_at:<${to}`;
}

/**
 * Which bucket an order's money went through.
 *
 * COD first, then partial, then prepaid, and the order is what DECISIONS V
 * describes. It is not actually contested on real data: every PARTIALLY_PAID
 * order in Sep-Nov 2026 carries the Cashfree gateway and a 'Standard' shipping
 * line, so the COD test cannot fire on one.
 *
 * `partial` is COD King's deposit: it leaves a SECOND line item for the same
 * garment at ~5% of the price with currentQuantity 0, which is what separates
 * it from an edited or refunded line (those sit on a VOIDED or REFUNDED order).
 */
function paymentTypeOf(o, gateways, shippingLines) {
  const cod =
    gateways.some((g) => /cash on delivery/i.test(g)) ||
    shippingLines.some((l) => /cash on delivery/i.test(String(l?.title || '')));
  if (cod) return 'cod';
  const lines = o.lineItems?.nodes || [];
  if (
    String(o.displayFinancialStatus || '') === 'PARTIALLY_PAID' &&
    lines.some((l) => Number(l.currentQuantity) === 0)
  ) {
    return 'partial';
  }
  return 'prepaid';
}

/**
 * One raw order -> NormOrder. Exported because it is the whole risk in this
 * file and a test should be able to hand it one order.
 *
 * @param {any} o
 * @returns {import('../../domain/pnl/types.mjs').NormOrder}
 */
export function normaliseOrder(o) {
  const gateways = o.paymentGatewayNames || [];
  const shippingLines = o.shippingLines?.nodes || [];
  const fulfillments = o.fulfillments || [];
  const codLine = shippingLines.find((l) => /cash on delivery/i.test(String(l?.title || '')));

  /** @type {string[]} */
  const awbs = [];
  /** @type {import('../../domain/pnl/types.mjs').NormFulfillment[]} */
  const norm = [];
  for (const f of fulfillments) {
    const tracking = f.trackingInfo || [];
    for (const t of tracking) {
      const n = t?.number ? String(t.number) : null;
      if (n && !awbs.includes(n)) awbs.push(n);
    }
    norm.push({
      status: String(f.status || ''),
      displayStatus: String(f.displayStatus || ''),
      createdAt: String(f.createdAt || ''),
      deliveredAt: f.deliveredAt || null,
      awb: tracking[0]?.number ? String(tracking[0].number) : null,
      company: tracking[0]?.company || null,
    });
  }

  const utm = o.customerJourneySummary?.lastVisit?.utmParameters || null;
  const app = o.app?.name || null;

  return {
    name: String(o.name || ''),
    gid: String(o.id || ''),
    numericId: String(o.id || '').split('/').pop() || '',
    createdAt: String(o.createdAt || ''),
    cancelledAt: o.cancelledAt || null,
    cancelReason: o.cancelReason || null,
    sourceName: String(o.sourceName || ''),
    appName: app,
    tags: o.tags || [],
    customerName: o.customer?.displayName || null,
    city: o.shippingAddress?.city || null,
    state: o.shippingAddress?.provinceCode || null,
    pin: o.shippingAddress?.zip ? String(o.shippingAddress.zip) : null,
    // Null on 7 real orders (the ones this service created itself). '' rather
    // than a guess; the engine branches on the string it knows.
    financialStatus: String(o.displayFinancialStatus || ''),
    fulfillmentStatus: String(o.displayFulfillmentStatus || ''),
    gateways,
    taxesIncluded: Boolean(o.taxesIncluded),
    paymentType: paymentTypeOf(o, gateways, shippingLines),
    /*
     * The app name is the channel wherever Shopify has one ('Online Store',
     * 'whatsapp-automation', 'Shopify Claude Connector App'). A draft order has
     * sourceName 'shopify_draft_order' and is the owner typing an order in by
     * hand, which is what 'Manual' means on the report.
     */
    channel: app || (/draft|manual/i.test(String(o.sourceName || '')) ? 'Manual' : String(o.sourceName || '')),
    currentTotalPaise: money(o.currentTotalPriceSet),
    totalPaise: money(o.totalPriceSet),
    discountsPaise: money(o.totalDiscountsSet),
    refundedPaise: money(o.totalRefundedSet),
    netPaymentPaise: money(o.netPaymentSet),
    outstandingPaise: money(o.totalOutstandingSet),
    codFeePaise: codLine ? money(codLine.originalPriceSet) : 0,
    /*
     * Cash actually in. SALE and CAPTURE only, and SUCCESS only: a COD order
     * carries a SALE/PENDING for its full value from the minute it is placed,
     * and counting that would book every unshipped COD order as money received.
     */
    prepaidReceivedPaise: (o.transactions || [])
      .filter((t) => /^(SALE|CAPTURE)$/i.test(String(t.kind || '')) && /^SUCCESS$/i.test(String(t.status || '')))
      .reduce((n, t) => n + money(t.amountSet), 0),
    // Recorded for the mismatch list only. RULES.pnl says why they cannot be
    // used to compute GST: they are wrong on Gujarat orders and on #1227.
    shopifyTaxLines: (o.taxLines || []).map((t) => ({
      title: String(t.title || ''),
      ratePct: Number(t.ratePercentage ?? (Number(t.rate) || 0) * 100),
      pricePaise: money(t.priceSet),
    })),
    transactions: (o.transactions || []).map((t) => ({
      kind: String(t.kind || ''),
      status: String(t.status || ''),
      gateway: String(t.gateway || ''),
      amountPaise: money(t.amountSet),
      createdAt: String(t.createdAt || ''),
    })),
    fulfillments: norm,
    awbs,
    utm: utm
      ? { source: utm.source || null, medium: utm.medium || null, campaign: utm.campaign || null }
      : null,
    lines: (o.lineItems?.nodes || []).map((l) => ({
      title: String(l.title || ''),
      sku: l.sku || null,
      quantity: Number(l.quantity) || 0,
      currentQuantity: Number(l.currentQuantity) || 0,
      originalUnitPaise: money(l.originalUnitPriceSet),
      discountedUnitPaise: money(l.discountedUnitPriceAfterAllDiscountsSet),
      variantGid: l.variant?.id || null,
      /*
       * NULL, NOT ZERO. A line with no cost (#1174 "Toran") and a line with no
       * variant at all (#1233 "Dupatta") both land here, and both mean the
       * order's COGS is incomplete, never that the garment was free.
       */
      unitCostPaise: paiseOrNull(l.variant?.inventoryItem?.unitCost?.amount),
    })),
  };
}

/**
 * Every order created inside the IST month, normalised.
 *
 * @param {{monthStartUtc: string, monthEndUtc: string, clients: any, maxPages?: number}} args
 * @returns {Promise<import('../../domain/pnl/types.mjs').NormOrder[]>}
 */
export async function fetchOrders({ monthStartUtc, monthEndUtc, clients, maxPages = 40 }) {
  const q = searchWindow(monthStartUtc, monthEndUtc);
  const raw = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await clients.shopify.graphql(PNL_ORDERS_QUERY, { q, cursor }, { idempotent: true });
    const conn = data?.orders;
    if (!conn) throw new Error('pnl shopify: orders connection missing from the response');
    raw.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (page === maxPages - 1) {
      throw new Error(`pnl shopify: more than ${maxPages} pages of orders, the month is not complete`);
    }
  }

  const from = new Date(monthStartUtc).getTime();
  const to = new Date(monthEndUtc).getTime();
  const inMonth = raw.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return Number.isFinite(t) && t >= from && t < to;
  });
  log.info('pnl shopify: orders read', {
    fetched: raw.length,
    inMonth: inMonth.length,
    dropped: raw.length - inMonth.length,
  });
  return inMonth.map(normaliseOrder);
}
