/* Fake Shopify client: seedable orders, records mutations. */
export function makeFakeShopify({
  orders = {},
  products = {},
  failChangeVariant = null,
  checkouts = {},
  publicCodes = null,
  discountUsage = {},
  failPublicCodes = null,
  takenCodes = [],
} = {}) {
  const store = new Map(Object.entries(orders));
  const carts = new Map(Object.entries(checkouts));
  const variants = new Map();
  const customersByPhone = new Map();
  const cartGid = (id) =>
    String(id).startsWith('gid://') ? id : `gid://shopify/AbandonedCheckout/${id}`;
  const calls = [];
  const gidOf = (id) => (String(id).startsWith('gid://') ? id : `gid://shopify/Order/${id}`);
  return {
    store,
    calls,
    seed(order) {
      store.set(gidOf(order.id ?? order.name), order);
    },
    async getOrder(idOrGid) {
      return store.get(gidOf(idOrGid)) || store.get(String(idOrGid)) || null;
    },
    async tagsAdd(orderGid, tags) {
      calls.push({ op: 'tagsAdd', orderGid, tags });
      const o = store.get(orderGid);
      if (o) o.tags = [...(Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(',').filter(Boolean)), ...tags];
      return { ok: true };
    },
    // Shopify answers a cancel on an already cancelled order with a
    // userError, and the real client throws on userErrors. The fake used to
    // accept it silently, so the DLQ path it caused was invisible in tests.
    async orderCancel(orderGid, opts) {
      calls.push({ op: 'orderCancel', orderGid, opts });
      const o = store.get(orderGid);
      if (o?.cancelledAt) throw new Error('orderCancel errors: [{"message":"Order has already been cancelled."}]');
      if (o) o.cancelledAt = new Date().toISOString();
      return { ok: true };
    },
    async metafieldsSet(metafields) {
      calls.push({ op: 'metafieldsSet', metafields });
      return { ok: true };
    },
    // Seed with makeFakeClients({ shopify: { products: { 'gid://shopify/Product/1': {...} } } })
    async getProductVariants(productGid) {
      calls.push({ op: 'getProductVariants', productGid });
      return products[productGid] || null;
    },
    async changeLineItemVariant(args) {
      calls.push({ op: 'changeLineItemVariant', args });
      if (failChangeVariant) throw new Error(String(failChangeVariant));
      const o = store.get(args.order.gid);
      // Mirror a real edit closely enough that itemLine and the invariant see
      // what production would: old line to currentQuantity 0, new line added.
      if (o?.lineItems?.nodes) {
        const old = o.lineItems.nodes.find((l) => l.id === args.lineItemId);
        if (old) {
          old.currentQuantity = 0;
          o.lineItems.nodes.push({
            ...old,
            id: `${old.id}-new`,
            currentQuantity: 1,
            quantity: 1,
            variant: { id: args.newVariantId, selectedOptions: args.fakeOptions || old.variant?.selectedOptions },
            variantTitle: args.fakeVariantTitle || old.variantTitle,
          });
        }
      }
      return { applied: true, method: 'order_edit', drifted: false, ...args };
    },
    async convertToPrepaid(args) {
      calls.push({ op: 'convertToPrepaid', args });
      return { applied: true, method: 'order_edit', ...args };
    },
    async createReview(args) {
      calls.push({ op: 'createReview', args });
      return { id: `gid://shopify/Metaobject/${calls.length}`, status: args.status };
    },
    async appendProductReview(productGid, reviewGid) {
      calls.push({ op: 'appendProductReview', productGid, reviewGid });
      return { ok: true };
    },
    /*
     * `takenCodes` makes the next N attempts collide the way Shopify does, so
     * the retry-then-widen path can be exercised. The real error text is a
     * userError, which the real client turns into a throw.
     */
    async createDiscountCode(args) {
      calls.push({ op: 'createDiscountCode', args });
      if (takenCodes.length) {
        takenCodes.pop();
        throw new Error('createDiscountCode errors: [{"message":"Code has already been taken"}]');
      }
      return { id: `gid://shopify/DiscountCodeNode/${calls.length}`, code: args.code };
    },
    async graphql(query, variables) {
      calls.push({ op: 'graphql', query: query.slice(0, 40), variables });
      return {};
    },
    async ensureWebhooks() {
      return [];
    },
    async ordersUpdatedSince() {
      return [...store.values()].map((o) => ({ id: o.id, tags: o.tags }));
    },

    // ---- Flow R ----------------------------------------------------------
    carts,
    variants,
    seedCheckout(c) {
      carts.set(cartGid(c.id ?? c.name), c);
    },
    /** Seed a ProductVariant the captured-cart path prices against. */
    seedVariant(v) {
      variants.set(String(v.id), v);
    },
    /** Seed the customer COD King creates at OTP, keyed by phone. */
    seedCustomerByPhone(phone, customer) {
      customersByPhone.set(String(phone), customer);
    },
    async getCustomerByPhone(phone) {
      calls.push({ op: 'getCustomerByPhone', phone });
      return customersByPhone.get(String(phone)) || null;
    },
    async getVariantsByIds(gids) {
      calls.push({ op: 'getVariantsByIds', gids });
      return (gids || []).map((g) => variants.get(String(g))).filter(Boolean);
    },
    async getAbandonedCheckout(idOrGid) {
      calls.push({ op: 'getAbandonedCheckout', idOrGid });
      return carts.get(cartGid(idOrGid)) || carts.get(String(idOrGid)) || null;
    },
    async listAbandonedCheckouts(sinceISO) {
      calls.push({ op: 'listAbandonedCheckouts', sinceISO });
      const since = new Date(sinceISO).getTime();
      return [...carts.values()]
        .filter((c) => !c.completedAt && new Date(c.createdAt).getTime() >= since)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    async ordersCreatedSince(sinceISO) {
      calls.push({ op: 'ordersCreatedSince', sinceISO });
      const since = new Date(sinceISO).getTime();
      return [...store.values()]
        .filter((o) => new Date(o.createdAt || 0).getTime() >= since)
        .map((o) => ({
          id: o.id,
          name: o.name,
          createdAt: o.createdAt,
          discountCodes: o.discountCodes || [],
          customAttributes: o.customAttributes || [],
          customer: o.customer || null,
          totalPriceSet: o.totalPriceSet || null,
        }));
    },
    /*
     * Defaults to the three codes that are really live, so a test that does not
     * mention discounts still prices its bag the way production would. `[]` is
     * a deliberate "no codes", and failPublicCodes simulates a missing
     * read_discounts scope, which must make the flow refuse rather than offer
     * less than the cart page already shows.
     */
    async publicCodeDiscounts() {
      calls.push({ op: 'publicCodeDiscounts' });
      if (failPublicCodes) throw new Error(String(failPublicCodes));
      return (
        publicCodes || [
          { code: 'BUY2', title: 'Buy 2, get 10% off (code BUY2)', type: 'percentage', percentage: 0.1, minQuantity: 2 },
          { code: 'BUY3', title: 'Buy 3, get 15% off (code BUY3)', type: 'percentage', percentage: 0.15, minQuantity: 3 },
          { code: 'WELCOME150', title: 'WELCOME150', type: 'amount', amountPaise: 15000, minSubtotalPaise: 119900 },
        ]
      );
    },
    async discountUsageCount(discountId) {
      calls.push({ op: 'discountUsageCount', discountId });
      return { count: discountUsage[discountId] || 0, status: 'ACTIVE' };
    },
  };
}
