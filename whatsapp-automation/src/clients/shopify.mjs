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
import { withRetry } from '../lib/resilience.mjs';
import { toPaise } from '../lib/money.mjs';

/**
 * @param {string} query
 * @param {object} [variables]
 * @param {{idempotent?:boolean}} [opts] idempotent only for reads and for
 *        mutations that can be repeated without a second effect. Order edits
 *        and payment marking are NOT idempotent, so they default to false.
 */
async function graphql(query, variables = {}, { idempotent = false } = {}) {
  const s = await getSecrets();
  const endpoint = `https://${config.shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
  return withRetry(
    'shopify.graphql',
    async () => {
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
        const e = new Error(`Shopify non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
        e.status = res.status;
        throw e;
      }
      if (json.errors) {
        const e = new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
        // Shopify answers a rate limit with HTTP 200 and a THROTTLED error, so
        // it has to be mapped by hand or it would never be retried.
        if (JSON.stringify(json.errors).includes('THROTTLED')) e.status = 429;
        e.status = e.status || res.status;
        throw e;
      }
      // A non-2xx whose body still parses as JSON used to fall straight through
      // here and return `undefined`, so a 503 from Shopify looked exactly like
      // "this order does not exist" to every caller. Check the status.
      if (!res.ok) {
        const e = new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      return json.data;
    },
    { idempotent },
  );
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
  fulfillments(first: 10) { status displayStatus createdAt trackingInfo { number company } }
  lineItems(first: 50) { nodes {
    id title quantity currentQuantity variantTitle
    product { id handle }
    variant { id selectedOptions { name value } }
    image { url width height }
    originalUnitPriceSet { shopMoney { amount } }
    discountAllocations { allocatedAmountSet { shopMoney { amount } } }
  } }
`;

async function getOrder(numericOrGid) {
  const id = String(numericOrGid).startsWith('gid://') ? numericOrGid : `gid://shopify/Order/${numericOrGid}`;
  const data = await graphql(`query GetOrder($id: ID!){ order(id:$id){ ${ORDER_FIELDS} } }`, { id }, { idempotent: true });
  return data.order;
}

/**
 * Find an order by the number a human reads off the admin ("#1214" or "1214").
 *
 * The owner knows an order by that number and by nothing else, so the owner
 * command has to start there. `name:#1214` is a search, not a lookup: it can
 * return a near miss, so the exact name is re-checked against what comes back
 * rather than trusting the first row.
 */
async function getOrderByName(name) {
  const num = String(name || '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(num)) return null;
  const data = await graphql(
    `query OrderByName($q: String!){ orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true){ nodes { ${ORDER_FIELDS} } } }`,
    { q: `name:#${num}` },
    { idempotent: true },
  );
  return (data.orders?.nodes || []).find((o) => String(o.name).replace(/^#/, '') === num) || null;
}

/*
 * The consignee details a courier booking needs, read on their own.
 *
 * These fields are NOT in ORDER_FIELDS and must not be added to it. That
 * fragment is on the hot path of every flow, every poll and every reconcile
 * pass, and all of this is protected customer data: widening the shared query
 * would put a customer's name, street address and phone into the response of
 * every order read the service makes, including the ones that only wanted a
 * status. This asks for it once, at the only moment it is needed.
 *
 * Shopify returns `null` for these fields (rather than failing) when the app
 * has no approved protected-customer-data access, which is indistinguishable
 * from a genuinely empty address unless you look at `userErrors`. The caller
 * has to treat "no address1" as "stop and say what is missing", and
 * `scopeProblem` is set when the response carries the access error so the
 * owner is told that instead of hunting for a typo in the address.
 */
async function getShippingDetails(numericOrGid) {
  const id = String(numericOrGid).startsWith('gid://') ? numericOrGid : `gid://shopify/Order/${numericOrGid}`;
  const query = `query ShippingDetails($id: ID!){
    order(id:$id){
      id
      name
      phone
      shippingAddress {
        name firstName lastName
        address1 address2
        city province provinceCode
        zip country countryCodeV2
        phone
      }
      customer { id defaultPhoneNumber { phoneNumber } }
      lineItems(first: 50) { nodes {
        id
        sku
        quantity
        currentQuantity
        variant { id sku }
      } }
    }
  }`;
  let data;
  try {
    data = await graphql(query, { id }, { idempotent: true });
  } catch (e) {
    /*
     * An app without protected-customer-data approval gets an ACCESS_DENIED
     * style error for the whole query, not a null field, so the throw has to be
     * caught here or the owner sees a raw GraphQL error.
     */
    if (/access denied|not approved|protected customer data|unauthorized/i.test(e.message || '')) {
      return { scopeProblem: true, error: e.message, address: null, lines: [] };
    }
    throw e;
  }
  const o = data.order;
  if (!o) return null;
  const a = o.shippingAddress || null;
  return {
    scopeProblem: false,
    orderName: o.name,
    address: a
      ? {
          name: a.name || [a.firstName, a.lastName].filter(Boolean).join(' '),
          address1: a.address1 || '',
          address2: a.address2 || '',
          city: a.city || '',
          state: a.province || a.provinceCode || '',
          pin: a.zip || '',
          country: a.country || a.countryCodeV2 || 'India',
          phone: a.phone || o.phone || o.customer?.defaultPhoneNumber?.phoneNumber || '',
        }
      : null,
    lines: (o.lineItems?.nodes || []).map((l) => ({
      id: l.id,
      sku: l.sku || l.variant?.sku || '',
      quantity: l.quantity,
      currentQuantity: l.currentQuantity,
      variantId: l.variant?.id || null,
    })),
  };
}

/** Orders updated on/after sinceISO (id + createdAt + tags). Used by digest + reconcile. */
async function ordersUpdatedSince(sinceISO) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(
      `query Iter($q: String!, $after: String){
         orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT){
           edges { cursor node { id createdAt tags } } pageInfo { hasNextPage endCursor }
         } }`,
      { q: `updated_at:>='${sinceISO}'`, after: cursor },
      { idempotent: true },
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
  // Sequence verified by hand on real order #1150 (2026-09-23): outstanding went
  // 1199 -> 1149 (COD fee line removed) -> 1049 (Rs 100 line discount), matching
  // the Razorpay capture to the paisa.
  const begun = await graphql(
    `mutation Begin($id: ID!){
       orderEditBegin(id:$id){
         calculatedOrder{
           id
           lineItems(first:50){ nodes{ id quantity originalUnitPriceSet{ shopMoney{ amount } } } }
           shippingLines{ id title }
         }
         userErrors{ field message }
       }
     }`,
    { id: order.gid },
  );
  const beginErrs = begun.orderEditBegin?.userErrors || [];
  if (beginErrs.length) throw new Error(`orderEditBegin: ${JSON.stringify(beginErrs)}`);
  const calc = begun.orderEditBegin.calculatedOrder;

  const codLine = (calc.shippingLines || []).find((sl) => /cash on delivery/i.test(sl.title || ''));
  if (codLine) {
    const r = await graphql(
      `mutation RmShip($id: ID!, $lineId: ID!){
         orderEditRemoveShippingLine(id:$id, shippingLineId:$lineId){ userErrors{ field message } }
       }`,
      { id: calc.id, lineId: codLine.id },
    );
    const e = r.orderEditRemoveShippingLine?.userErrors || [];
    if (e.length) throw new Error(`orderEditRemoveShippingLine: ${JSON.stringify(e)}`);
  }

  if (amounts.discountPaise > 0) {
    // A removed line stays on the calculated order at quantity 0 with its
    // original price intact, and it sorts first on a tie. On #1182 both lines
    // are the same price, so the top-priced pick would have put the prepaid
    // discount on the line the customer is not getting. This is the money
    // path, so filter before sorting.
    const lines = (calc.lineItems?.nodes || []).filter((li) => (li.quantity ?? 1) > 0);
    const top = lines
      .slice()
      .sort(
        (a, b) =>
          Number(b.originalUnitPriceSet?.shopMoney?.amount || 0) -
          Number(a.originalUnitPriceSet?.shopMoney?.amount || 0),
      )[0];
    if (!top) throw new Error('convertToPrepaid: no line item to discount');
    const r = await graphql(
      `mutation Disc($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!){
         orderEditAddLineItemDiscount(id:$id, lineItemId:$lineItemId, discount:$discount){ userErrors{ field message } }
       }`,
      {
        id: calc.id,
        lineItemId: top.id,
        discount: {
          description: 'Prepaid offer',
          fixedValue: { amount: (amounts.discountPaise / 100).toFixed(2), currencyCode: 'INR' },
        },
      },
    );
    const e = r.orderEditAddLineItemDiscount?.userErrors || [];
    if (e.length) throw new Error(`orderEditAddLineItemDiscount: ${JSON.stringify(e)}`);
  }

  const committed = await graphql(
    `mutation Commit($id: ID!, $note: String){
       orderEditCommit(id:$id, notifyCustomer:false, staffNote:$note){
         order{ id totalOutstandingSet{ shopMoney{ amount } } }
         userErrors{ field message }
       }
     }`,
    { id: calc.id, note: `WhatsApp prepaid conversion, razorpay ${paymentId || '(no payment id)'}` },
  );
  const commitErrs = committed.orderEditCommit?.userErrors || [];
  if (commitErrs.length) throw new Error(`orderEditCommit: ${JSON.stringify(commitErrs)}`);

  // HARD CHECK before recording money: what is still owed must equal what was
  // captured. orderMarkAsPaid settles the WHOLE outstanding, so a mismatch here
  // would record the wrong amount against a real customer order.
  const outstandingPaise = Math.round(
    Number(committed.orderEditCommit.order.totalOutstandingSet.shopMoney.amount) * 100,
  );
  if (outstandingPaise !== amounts.newTotalPaise) {
    throw new Error(
      `convertToPrepaid: outstanding ${outstandingPaise} != expected ${amounts.newTotalPaise} after edit; ` +
        'order edited but NOT marked paid, reconcile by hand',
    );
  }

  const paid = await graphql(
    `mutation MarkPaid($input: OrderMarkAsPaidInput!){
       orderMarkAsPaid(input:$input){
         order{ id displayFinancialStatus netPaymentSet{ shopMoney{ amount } } }
         userErrors{ field message }
       }
     }`,
    { input: { id: order.gid } },
  );
  const paidErrs = paid.orderMarkAsPaid?.userErrors || [];
  if (paidErrs.length) throw new Error(`orderMarkAsPaid: ${JSON.stringify(paidErrs)}`);

  return {
    ...plan,
    applied: true,
    outstandingPaise,
    financialStatus: paid.orderMarkAsPaid.order.displayFinancialStatus,
  };
}

/**
 * Swap one line item onto another variant of the SAME product. Nothing else.
 *
 * NOT IDEMPOTENT: it removes a line and adds a line. The caller wraps it in
 * runOnce keyed by line AND target variant, and FIFO per-order serialization
 * keeps two taps from interleaving.
 *
 * The invariant check before the commit is the real guard, because an order
 * edit cannot be rolled back afterwards. It asserts on the CALCULATED order,
 * where totalPriceSet reflects the staged changes. Note the trap: on the Order
 * type the same field name is a pre-edit SNAPSHOT that does not move when a
 * line is removed (order #1182 reads totalPrice 2548.00 against
 * currentTotalPrice 1299.00), so asserting there would pass no matter what the
 * edit did. Same field name, opposite meaning.
 */
async function changeLineItemVariant({ order, lineItemId, newVariantId, carryDiscountPaise = 0, staffNote }) {
  const plan = { orderId: order.numericId, lineItemId, newVariantId };
  if (config.dryRun) {
    log.info('changeLineItemVariant plan (dry_run)', plan);
    return { ...plan, applied: false, method: 'dry_run' };
  }

  // The invariant fields. There is no root `calculatedOrder(id:)` query - that
  // field does not exist on QueryRoot - so the staged state is read from each
  // mutation's OWN response instead. The discount comes in as an argument,
  // read off the Order type by the caller: CalculatedLineItem's
  // calculatedDiscountAllocations additionally requires read_returns, which
  // this app does not hold.
  const CALC = `
    id
    totalPriceSet{ shopMoney{ amount } }
    shippingLines{ id title }
    lineItems(first:50){ nodes{ id quantity restockable variant{ id } } }
    addedLineItems(first:50){ nodes{ id quantity variant{ id } } }`;
  /*
   * addedLineItems IS PART OF THE COUNT. A staged addition does NOT appear in
   * calculatedOrder.lineItems, which only holds the order's original lines, so
   * counting lineItems alone saw the swap as "one line became zero" and the
   * invariant refused to commit EVERY time. The unit tests could not catch
   * that: it is a fact about Shopify's response shape, and only the first live
   * run on a throwaway order exposed it.
   */
  const snapshot = (c) => ({
    total: c.totalPriceSet.shopMoney.amount,
    lines:
      (c.lineItems?.nodes || []).filter((l) => (l.quantity ?? 0) > 0).length +
      (c.addedLineItems?.nodes || []).filter((l) => (l.quantity ?? 0) > 0).length,
    shipping: (c.shippingLines || []).map((sl) => `${sl.id}:${sl.title}`).sort().join('|'),
  });

  const begun = await graphql(
    `mutation Begin($id: ID!){ orderEditBegin(id:$id){ calculatedOrder{ ${CALC} } userErrors{ field message } } }`,
    { id: order.gid },
  );
  const beginErrs = begun.orderEditBegin?.userErrors || [];
  if (beginErrs.length) throw new Error(`orderEditBegin: ${JSON.stringify(beginErrs)}`);
  const calc = begun.orderEditBegin.calculatedOrder;
  const before = snapshot(calc);

  /*
   * orderEditSetQuantity wants the CALCULATED line item id, not the order's
   * line item id. Passing the order's id straight through is rejected with
   * "Invalid id ... RESOURCE_NOT_FOUND", which is exactly what the first live
   * attempt did. The two ids share a numeric suffix
   * (gid://shopify/LineItem/371675... <-> gid://shopify/CalculatedLineItem/371675...)
   * so the calculated line is LOOKED UP by that suffix rather than built by
   * swapping the prefix: a lookup survives Shopify changing the shape, and a
   * reconstruction would send a plausible id that silently names nothing.
   */
  const suffix = String(lineItemId).split('/').pop();
  const calcLine =
    (calc.lineItems?.nodes || []).find((l) => String(l.id).split('/').pop() === suffix) || null;
  if (!calcLine) {
    throw new Error(`changeLineItemVariant: no calculated line matches ${lineItemId}; nothing was changed`);
  }

  // Redelivery: the target is already on the order, so a previous attempt got
  // through. Nothing to do, and nothing to undo.
  const already = (calc.lineItems?.nodes || []).some(
    (l) => (l.quantity ?? 0) > 0 && l.variant?.id === newVariantId,
  );
  if (already) {
    log.info('changeLineItemVariant: target already on the order, treating as done', plan);
    return { ...plan, applied: true, method: 'already_applied' };
  }

  // restock returns the garment they are NOT taking to sellable stock. Without
  // it every swap quietly loses a unit of inventory. It is asked for only when
  // Shopify says the line is restockable, so a line that cannot be restocked
  // degrades to a plain removal instead of failing the whole change.
  const removed = await graphql(
    `mutation Rm($id: ID!, $lineItemId: ID!, $restock: Boolean){
       orderEditSetQuantity(id:$id, lineItemId:$lineItemId, quantity:0, restock:$restock){ userErrors{ field message } }
     }`,
    { id: calc.id, lineItemId: calcLine.id, restock: calcLine.restockable !== false },
  );
  const rmErrs = removed.orderEditSetQuantity?.userErrors || [];
  if (rmErrs.length) throw new Error(`orderEditSetQuantity: ${JSON.stringify(rmErrs)}`);

  const added = await graphql(
    `mutation Add($id: ID!, $variantId: ID!){
       orderEditAddVariant(id:$id, variantId:$variantId, quantity:1, allowDuplicates:true){
         calculatedLineItem{ id }
         calculatedOrder{ ${CALC} }
         userErrors{ field message }
       }
     }`,
    { id: calc.id, variantId: newVariantId },
  );
  const addErrs = added.orderEditAddVariant?.userErrors || [];
  if (addErrs.length) throw new Error(`orderEditAddVariant: ${JSON.stringify(addErrs)}`);
  const newLineId = added.orderEditAddVariant?.calculatedLineItem?.id;
  let latest = added.orderEditAddVariant.calculatedOrder;

  // Carry the old line's discount across. 9 of the last 15 orders had one, so
  // this is the normal case: without it a customer loses their discount by
  // changing size. A fixed amount is expressed by SETTING fixedValue; there is
  // no valueType enum on OrderEditAppliedDiscountInput.
  if (carryDiscountPaise > 0 && newLineId) {
    const disc = await graphql(
      `mutation Disc($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!){
         orderEditAddLineItemDiscount(id:$id, lineItemId:$lineItemId, discount:$discount){
           calculatedOrder{ ${CALC} }
           userErrors{ field message }
         }
       }`,
      {
        id: calc.id,
        lineItemId: newLineId,
        discount: {
          description: 'Carried over on a size or colour change',
          fixedValue: { amount: (carryDiscountPaise / 100).toFixed(2), currencyCode: 'INR' },
        },
      },
    );
    const dErrs = disc.orderEditAddLineItemDiscount?.userErrors || [];
    if (dErrs.length) throw new Error(`orderEditAddLineItemDiscount: ${JSON.stringify(dErrs)}`);
    latest = disc.orderEditAddLineItemDiscount.calculatedOrder;
  }

  // Refuse to commit unless ONLY the variant moved. This check is the real
  // guard: an order edit cannot be rolled back once committed, and abandoning
  // an UNCOMMITTED edit leaves the order untouched, so returning here IS the
  // rollback.
  const after = snapshot(latest);
  const paise = (x) => Math.round(Number(x) * 100);
  const breaches = [];
  if (paise(after.total) !== paise(before.total)) breaches.push(`total ${before.total} -> ${after.total}`);
  if (after.lines !== before.lines) breaches.push(`active lines ${before.lines} -> ${after.lines}`);
  if (after.shipping !== before.shipping) breaches.push('shipping lines changed');
  if (breaches.length) {
    throw new Error(`changeLineItemVariant: invariant breach, NOT committed: ${breaches.join('; ')}`);
  }

  const committed = await graphql(
    `mutation Commit($id: ID!, $note: String){
       orderEditCommit(id:$id, notifyCustomer:false, staffNote:$note){
         order{ id currentTotalPriceSet{ shopMoney{ amount } } totalOutstandingSet{ shopMoney{ amount } } }
         userErrors{ field message }
       }
     }`,
    { id: calc.id, note: staffNote || 'WhatsApp size or colour change' },
  );
  const cErrs = committed.orderEditCommit?.userErrors || [];
  if (cErrs.length) throw new Error(`orderEditCommit: ${JSON.stringify(cErrs)}`);

  // Past this point we can only report. currentTotalPriceSet, NOT totalPriceSet:
  // on the Order type the latter is a pre-edit snapshot that does not move when
  // a line is removed (#1182 reads 2548.00 against a currentTotal of 1299.00),
  // so asserting on it would pass whatever the edit did.
  const o = committed.orderEditCommit.order;
  const currentTotal = o.currentTotalPriceSet.shopMoney.amount;
  const outstanding = o.totalOutstandingSet.shopMoney.amount;
  const drifted = paise(currentTotal) !== paise(before.total) || paise(outstanding) !== paise(before.total);

  return { ...plan, applied: true, method: 'order_edit', currentTotal, outstanding, drifted };
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
/*
 * A single-use, expiring, flat-rupee code.
 *
 * usageLimit 1 AND appliesOncePerCustomer: the first stops the code being
 * passed around, the second stops the same customer reusing it. endsAt is what
 * makes it expire; without it a code lives forever.
 *
 * discountAmount expresses a FIXED amount. There is no valueType enum on
 * DiscountCustomerGetsValueInput: a percentage and an amount are different
 * FIELDS, and setting the wrong one silently changes what the customer gets.
 */
async function createDiscountCode({ code, title, startsAt, endsAt, amountInr, minSubtotalInr }) {
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
        customerGets: { value: { discountAmount: { amount: String(amountInr), appliesOnEachItem: false } }, items: { all: true } },
        minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(minSubtotalInr) } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
      },
    },
  );
  const errs = data.discountCodeBasicCreate?.userErrors || [];
  if (errs.length) throw new Error(`createDiscountCode errors: ${JSON.stringify(errs)}`);
  return { id: data.discountCodeBasicCreate.codeDiscountNode.id, code };
}

// ---- Flow R: abandoned checkouts, order lookback, public codes -------------
/*
 * Everything a checkout needs to be priced and described. Validated against the
 * live 2026-07 schema (read_orders + read_customers + read_products).
 *
 * `completedAt` is selected because a checkout CAN complete between the sweep
 * listing it and the worker picking it up, and `createdAt` because `updatedAt`
 * is not customer activity: a checkout created 3 Aug read updatedAt 12 Oct.
 * `image { width height }` is needed by heroImageUrl, which clamps the square
 * crop to the shorter side rather than letting Shopify refuse to upscale.
 */
const CHECKOUT_FIELDS = `
  id
  name
  createdAt
  completedAt
  abandonedCheckoutUrl
  totalPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }
  customAttributes { key value }
  customer { id firstName }
  shippingAddress { firstName }
  billingAddress { firstName }
  lineItems(first: 50) {
    nodes {
      title
      quantity
      originalUnitPriceSet { shopMoney { amount } }
      image { url width height }
      variant { id availableForSale selectedOptions { name value } }
    }
  }
`;

/**
 * One abandoned checkout, by numeric id or gid.
 *
 * Deliberately `node(id:)`. Both `abandonedCheckouts(query: "id:<n>")` and the
 * `id:>=` range form return NOTHING for a checkout that is definitely there,
 * so a query-by-id lookup would read as "this checkout is gone" and the flow
 * would skip every single one.
 */
async function getAbandonedCheckout(numericOrGid) {
  const id = String(numericOrGid).startsWith('gid://')
    ? numericOrGid
    : `gid://shopify/AbandonedCheckout/${numericOrGid}`;
  const data = await graphql(
    `query GetCheckout($id: ID!){ node(id:$id){ ... on AbandonedCheckout { ${CHECKOUT_FIELDS} } } }`,
    { id },
    { idempotent: true },
  );
  return data.node || null;
}

/** Open (not completed) checkouts created on/after sinceISO, newest first. */
async function listAbandonedCheckouts(sinceISO) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(
      `query Carts($q: String!, $after: String){
         abandonedCheckouts(first: 50, after: $after, query: $q, sortKey: CREATED_AT, reverse: true){
           edges { cursor node { ${CHECKOUT_FIELDS} } } pageInfo { hasNextPage endCursor }
         } }`,
      { q: `status:open created_at:>='${sinceISO}'`, after: cursor },
      { idempotent: true },
    );
    for (const e of data.abandonedCheckouts.edges) out.push(e.node);
    if (!data.abandonedCheckouts.pageInfo.hasNextPage) break;
    cursor = data.abandonedCheckouts.pageInfo.endCursor;
  }
  return out;
}

/**
 * Orders CREATED on/after sinceISO, with what Flow R needs to attribute one.
 *
 * Separate from ordersUpdatedSince because the question is different: that one
 * asks "what moved", this one asks "did this person buy since they abandoned",
 * and an old order edited today must not answer yes to that.
 */
async function ordersCreatedSince(sinceISO) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(
      `query Since($q: String!, $after: String){
         orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT, reverse: true){
           edges { cursor node {
             id name createdAt discountCodes
             customAttributes { key value }
             customer { id }
             totalPriceSet { shopMoney { amount } }
           } } pageInfo { hasNextPage endCursor }
         } }`,
      { q: `created_at:>='${sinceISO}'`, after: cursor },
      { idempotent: true },
    );
    for (const e of data.orders.edges) out.push(e.node);
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  return out;
}

/*
 * The codes any shopper could already be using, cached for ten minutes.
 *
 * A code counts as PUBLIC when anyone can type it: ACTIVE, buyer selection
 * "all", and NO usage limit. That last one is what excludes both the one-shot
 * THANKS-* review codes and every code this flow creates, since those are all
 * usageLimit 1. The title prefix check is a second line of defence only.
 *
 * `context` replaced the deprecated `customerSelection` in this API version and
 * is an object, so it needs a subselection; all three live public codes read
 * DiscountBuyerSelectionAll.
 */
let codeCache = { at: 0, codes: /** @type {any[]} */ ([]) };
const CODE_CACHE_MS = 10 * 60 * 1000;
export const CART_RECOVERY_TITLE = 'Cart recovery #';

async function publicCodeDiscounts({ now = Date.now() } = {}) {
  if (codeCache.at && now - codeCache.at < CODE_CACHE_MS) return codeCache.codes;
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(
      `query PublicCodes($after: String){
         discountNodes(first: 50, after: $after, query: "status:active"){
           edges { cursor node { id discount {
             __typename
             ... on DiscountCodeBasic {
               title status usageLimit appliesOncePerCustomer
               context { __typename }
               codes(first: 1) { nodes { code } }
               customerGets { value {
                 ... on DiscountPercentage { percentage }
                 ... on DiscountAmount { amount { amount } appliesOnEachItem }
               } }
               minimumRequirement {
                 ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
                 ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
               }
             }
           } } } pageInfo { hasNextPage endCursor }
         } }`,
      { after: cursor },
      { idempotent: true },
    );
    for (const e of data.discountNodes.edges) {
      const d = e.node.discount;
      if (d?.__typename !== 'DiscountCodeBasic') continue;
      if (d.status !== 'ACTIVE') continue;
      if (d.context?.__typename !== 'DiscountBuyerSelectionAll') continue;
      if (d.usageLimit != null) continue;
      if (String(d.title || '').startsWith(CART_RECOVERY_TITLE)) continue;
      const v = d.customerGets?.value || {};
      const min = d.minimumRequirement || {};
      // Shopify returns every quantity and money field as a STRING.
      const code = {
        code: d.codes?.nodes?.[0]?.code || '',
        title: d.title,
        type: v.percentage != null ? 'percentage' : 'amount',
        percentage: v.percentage != null ? Number(v.percentage) : undefined,
        amountPaise: v.amount?.amount != null ? toPaise(v.amount.amount) : undefined,
        minQuantity: min.greaterThanOrEqualToQuantity != null ? Number(min.greaterThanOrEqualToQuantity) : undefined,
        minSubtotalPaise:
          min.greaterThanOrEqualToSubtotal?.amount != null ? toPaise(min.greaterThanOrEqualToSubtotal.amount) : undefined,
      };
      // A per-item fixed amount is not a whole-order saving we can compare, so
      // it is left out rather than guessed at.
      if (code.type === 'amount' && v.appliesOnEachItem) continue;
      out.push(code);
    }
    if (!data.discountNodes.pageInfo.hasNextPage) break;
    cursor = data.discountNodes.pageInfo.endCursor;
  }
  codeCache = { at: now, codes: out };
  return out;
}

/** How many times a discount has been used. The reminder must not chase a used code. */
async function discountUsageCount(discountId) {
  const data = await graphql(
    `query Usage($id: ID!){ discountNode(id:$id){ discount {
       ... on DiscountCodeBasic { asyncUsageCount status } } } }`,
    { id: discountId },
    { idempotent: true },
  );
  const d = data.discountNode?.discount;
  return { count: Number(d?.asyncUsageCount || 0), status: d?.status || null };
}

/** Test-only: drop the public-code cache. */
function _resetCodeCache() {
  codeCache = { at: 0, codes: [] };
}

/**
 * The product behind a line item, with everything the variant-change rules need.
 *
 * inventoryQuantity and availableForSale need nothing beyond read_products,
 * verified against the live 2026-07 schema; it is inventory LEVELS (per
 * location) that need read_inventory, and this app does not hold it.
 */
async function getProductVariants(productGid) {
  const data = await graphql(
    `query P($id: ID!){
       product(id:$id){
         id handle title
         options { name values }
         variants(first:100){ nodes{
           id title price availableForSale inventoryQuantity
           selectedOptions{ name value }
         } }
       }
     }`,
    { id: productGid },
    { idempotent: true },
  );
  return data.product || null;
}

/**
 * Variants by their OWN gids, with the price, availability and options a
 * captured cart needs.
 *
 * Separate from getProductVariants because a captured cart knows only the
 * variant ids the browser had, not the products behind them, and asking per
 * product would be one round trip per line. `nodes(ids:)` takes up to 250.
 *
 * THE PRICE READ HERE IS THE ONLY ONE FLOW R TRUSTS for a captured cart. The
 * browser payload is attacker-controlled and the offer is a percentage OF THE
 * BAG, so a client-supplied price is a client-supplied discount.
 */
async function getVariantsByIds(gids) {
  const ids = (gids || []).slice(0, 250);
  if (!ids.length) return [];
  const data = await graphql(
    `query V($ids: [ID!]!){
       nodes(ids: $ids){
         ... on ProductVariant {
           id title price availableForSale
           selectedOptions{ name value }
           image { url width height }
           product { id handle title featuredImage { url width height } }
         }
       }
     }`,
    { ids },
    { idempotent: true },
  );
  return (data.nodes || []).filter(Boolean);
}

/**
 * The customer behind an OTP-verified phone, for a captured cart.
 *
 * A captured cart carries a phone and variant ids and nothing else: there is
 * no customer object on it, because it never became a Shopify checkout. Left
 * at null, every captured cart is greeted "Hello there" and gets the VIP
 * fallback code instead of the shopper's own name, which on a recovery
 * message is the difference between a note and a mailshot.
 *
 * COD King creates a bare Shopify customer at OTP time, carrying the phone, so
 * this almost always finds one. customerByIdentifier is used rather than
 * customers(query:) because that search index lags creates by seconds and
 * these customers are minutes old.
 */
async function getCustomerByPhone(phone) {
  if (!phone) return null;
  const data = await graphql(
    `query C($p: String!){
       customerByIdentifier(identifier: { phoneNumber: $p }){ id firstName lastName }
     }`,
    { p: phone },
    { idempotent: true },
  );
  return data.customerByIdentifier || null;
}

export const shopify = {
  graphql,
  getCustomerByPhone,
  getOrder,
  getOrderByName,
  getShippingDetails,
  getProductVariants,
  getVariantsByIds,
  ordersUpdatedSince,
  tagsAdd,
  orderCancel,
  metafieldsSet,
  convertToPrepaid,
  changeLineItemVariant,
  createReview,
  appendProductReview,
  createDiscountCode,
  ensureWebhooks,
  getAbandonedCheckout,
  listAbandonedCheckouts,
  ordersCreatedSince,
  publicCodeDiscounts,
  discountUsageCount,
  _resetCodeCache,
  ORDER_FIELDS,
  CHECKOUT_FIELDS,
};
