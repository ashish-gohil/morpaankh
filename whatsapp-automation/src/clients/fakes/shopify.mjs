/* Fake Shopify client: seedable orders, records mutations. */
export function makeFakeShopify({ orders = {} } = {}) {
  const store = new Map(Object.entries(orders));
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
    async createDiscountCode(args) {
      calls.push({ op: 'createDiscountCode', args });
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
  };
}
