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

/*
 * The line items the order actually stands at, not the ones it was placed with.
 *
 * Shopify keeps a removed line forever: `quantity` stays at what was bought and
 * `currentQuantity` drops to 0. Reading `quantity` therefore describes history,
 * so a hand-edited order named the wrong garment in every message, and through
 * flowB it could publish a real review onto a product the customer no longer
 * had. Order #1182 (XS removed, 2XL added by hand) is the live example; 12 of
 * the last 150 orders have the same shape.
 *
 * The fallback matters as much as the filter. A cancelled or voided order has
 * EVERY line at currentQuantity 0 (33 of the last 150), and dropping them all
 * would leave itemLine and heroImageUrl with nothing to describe. For those the
 * order as placed is the only truthful answer, so it is what we keep, with the
 * original quantities.
 */
function liveLineItems(nodes) {
  const shape = (li, quantity) => ({
    id: li.id,
    title: li.title,
    quantity,
    productGid: li.product?.id || null,
    unitPaise: toPaise(li.originalUnitPriceSet?.shopMoney?.amount || 0),
    size: sizeOf(li),
    image: li.image?.url ? { url: li.image.url, width: li.image.width, height: li.image.height } : null,
  });
  // `?? li.quantity` keeps callers that never selected currentQuantity working.
  const current = (li) => li.currentQuantity ?? li.quantity ?? 1;
  const live = nodes.filter((li) => current(li) > 0).map((li) => shape(li, current(li)));
  return live.length ? live : nodes.map((li) => shape(li, li.quantity ?? 1));
}

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
    createdAt: f.createdAt || null,
    awb: f.trackingInfo?.[0]?.number || null,
    company: f.trackingInfo?.[0]?.company || null,
  }));
  const delhiveryAwb = fulfillments.find((f) => /delhivery/i.test(f.company || ''))?.awb || null;
  // When it actually left us. Needed for the assumed-delivery date on orders
  // shipped without a trackable waybill; `now` would be wrong on a redelivered
  // fulfillments/update days after the fact.
  const fulfilledAt = fulfillments.map((f) => f.createdAt).filter(Boolean).sort()[0] || null;

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
    fulfilledAt,
    delhiveryAwb,
    lineItems: liveLineItems(o.lineItems?.nodes || []),
    // COD King attributes
    codkAmountType: attrs._codkAmountType || null,
    codkAmountValue: attrs._codkAmountValue || null,
    codkPartiallyPaid: attrs.codk_partially_paid || null,
  };
}

/**
 * The size a line item was ordered in, or null.
 *
 * variantTitle is NOT usable on its own: a two-option product returns
 * "S / Lavender" and a single-option one returns "XS", so the option named
 * Size is read first and variantTitle is only a fallback for single-option
 * variants. "Default Title" (Shopify's name for a product with no options)
 * is not a size.
 */
function sizeOf(li) {
  const opt = (li.variant?.selectedOptions || []).find((o) => /^size$/i.test(o.name || ''));
  if (opt?.value) return opt.value;
  const vt = li.variantTitle || '';
  if (!vt || vt === 'Default Title' || vt.includes('/')) return null;
  return vt;
}

/**
 * One line naming what was ordered, for a WhatsApp body parameter.
 *
 * Must stay on ONE line: Meta rejects template parameters containing newlines,
 * tabs or long runs of spaces. Extra items are counted rather than listed so
 * the line stays short on a phone.
 */
export function itemLine(n) {
  const items = n?.lineItems || [];
  if (!items.length) return null;
  const [first, ...rest] = items;
  let line = first.title;
  if (first.size) line += `, size ${first.size}`;
  if (first.quantity > 1) line += `, ${first.quantity} pieces`;
  if (rest.length) {
    const more = rest.reduce((sum, li) => sum + (li.quantity || 1), 0);
    line += ` and ${more} more item${more === 1 ? '' : 's'}`;
  }
  return line;
}

/**
 * A square product image for the WhatsApp template header, or null.
 *
 * Shopify's CDN centre-crops on demand but REFUSES TO UPSCALE: asking for
 * 800x800 from a 473x593 source silently returns the original 473x593
 * portrait. The requested edge is therefore clamped to the shorter side of
 * the source, which always yields a true square.
 */
export function heroImageUrl(n, max = 800) {
  const img = (n?.lineItems || []).find((li) => li.image?.url)?.image;
  if (!img) return null;
  const edge = Math.min(img.width || max, img.height || max, max);
  if (!edge) return img.url;
  const u = new URL(img.url);
  u.searchParams.set('width', String(edge));
  u.searchParams.set('height', String(edge));
  u.searchParams.set('crop', 'center');
  return u.toString();
}
