/*
 * order.mjs — normalize a Shopify GraphQL order into the clean shape the flows
 * use. Pure. Keeps all the "where does this field live" knowledge in one place.
 */
import { toPaise } from '../lib/money.mjs';
import { verifiedPhoneFromCustomAttributes } from '../lib/phone.mjs';

/** COD King tags carry emoji + text; match on the text, case-insensitive. */
export function hasTag(tags, needle) {
  const n = needle.toLowerCase();
  return (tags || []).some((t) => String(t).toLowerCase().includes(n));
}

/**
 * True when the order carries a real RTO tag.
 *
 * Deliberately NOT hasTag(tags, 'RTO'): hasTag is a substring match and COD
 * King tags EVERY order "LOW RTO Risk" / "MEDIUM RTO Risk" / "HIGH RTO Risk",
 * so 'RTO' matches every order ever placed. That silently suppressed every
 * Flow B review ask and made the digest count all orders as RTO.
 */
export function hasRtoTag(tags) {
  return (tags || []).some((t) => {
    const s = String(t).toLowerCase();
    return s.includes('rto') && !s.includes('risk');
  });
}

/** 'HIGH' | 'MEDIUM' | 'LOW' | null from the COD King RTO risk tags. */
export function riskTag(tags) {
  for (const level of ['HIGH', 'MEDIUM', 'LOW']) if (hasTag(tags, `${level} RTO Risk`)) return level;
  return null;
}

const attrMap = (arr) => Object.fromEntries((arr || []).map((a) => [a.key ?? a.name, a.value]));

/** @param {any} o a GraphQL order (shopify.getOrder shape) */
export function normalizeOrder(o) {
  if (!o) return null;
  const tags = Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const attrs = attrMap(o.customAttributes);
  const shippingNodes = o.shippingLines?.nodes || [];
  const codLine = shippingNodes.find((s) => /cash on delivery/i.test(s.title || ''));
  const fulfillments = (o.fulfillments || []).map((f) => ({
    status: f.status,
    displayStatus: f.displayStatus,
    awb: f.trackingInfo?.[0]?.number || null,
    company: f.trackingInfo?.[0]?.company || null,
  }));
  const delhiveryAwb = fulfillments.find((f) => /delhivery/i.test(f.company || ''))?.awb || null;

  return {
    gid: o.id,
    numericId: String(o.id || '').split('/').pop(),
    name: o.name,
    isTest: o.test === true,
    tags,
    attrs,
    financialStatus: o.displayFinancialStatus,
    gateways: o.paymentGatewayNames || [],
    receivedPaise: toPaise(o.netPaymentSet?.shopMoney?.amount || 0),
    currentTotalPaise: toPaise(o.currentTotalPriceSet?.shopMoney?.amount || o.totalPriceSet?.shopMoney?.amount || 0),
    codFeePaise: codLine ? toPaise(codLine.originalPriceSet?.shopMoney?.amount || 0) : 0,
    verifiedPhone: verifiedPhoneFromCustomAttributes(o.customAttributes),
    firstName: o.customer?.firstName || 'there',
    customerGid: o.customer?.id || null,
    zip: o.shippingAddress?.zip || null,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    riskTag: riskTag(tags),
    fulfillments,
    delhiveryAwb,
    lineItems: (o.lineItems?.nodes || []).map((li) => ({
      id: li.id,
      title: li.title,
      quantity: li.quantity,
      productGid: li.product?.id || null,
      unitPaise: toPaise(li.originalUnitPriceSet?.shopMoney?.amount || 0),
    })),
    // COD King attributes
    codkAmountType: attrs._codkAmountType || null,
    codkAmountValue: attrs._codkAmountValue || null,
    codkPartiallyPaid: attrs.codk_partially_paid || null,
  };
}
