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
    async orderCancel(orderGid, opts) {
      calls.push({ op: 'orderCancel', orderGid, opts });
      const o = store.get(orderGid);
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
    async graphql(query, variables) {
      calls.push({ op: 'graphql', query: query.slice(0, 40), variables });
      return {};
    },
    async ensureWebhooks() {
      return [];
    },
  };
}
