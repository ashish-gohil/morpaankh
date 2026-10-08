/*
 * variantChange.mjs — who may swap a size or colour, and what they may swap to.
 *
 * Pure: no I/O, no clients, no clock beyond what is passed in. Every rule lives
 * here so the worker reads as a sequence of questions and the rules can be
 * tested without a WhatsApp fake.
 *
 * TWO IDEAS DO THE SAFETY WORK HERE.
 *
 * 1. Candidates are ENUMERATED from the line's own product, never validated
 *    against a request. A different product cannot be offered because it is
 *    never in the source set. `resolveTarget` then re-derives that same set and
 *    looks the tapped id up inside it, so a crafted payload naming any other
 *    variant in the store resolves to nothing. Validation alone would not be
 *    enough: button payloads are clear text and carry no signature.
 *
 * 2. Price equality is required, not assumed. Every variant of every product in
 *    this catalogue shares one price today (54 products, 466 variants, no
 *    exceptions), which is what makes this swap free of money movement. That is
 *    a fact about the catalogue, not a guarantee, so a target priced
 *    differently is simply not offered and the customer gets a handoff.
 */
import { RULES } from '../../messages/rules.mjs';
import { excludeFromAll } from './eligibility.mjs';

/** Options we understand well enough to change. Anything else is refused. */
const SIZE = 'size';
const COLOUR = new Set(['color', 'colour']);
const isSize = (name) => String(name || '').trim().toLowerCase() === SIZE;
const isColour = (name) => COLOUR.has(String(name || '').trim().toLowerCase());

/*
 * The COD King helper product. Its only option is named "Payment Type", so the
 * option rule below already excludes it, but that is a coincidence rather than
 * an intention: rename that option to "Size" and the guard evaporates. This
 * product must never be touched, so it is named explicitly as well.
 */
const NEVER_CHANGE_HANDLES = new Set(['partial-payment']);

const optionValue = (variant, pred) =>
  (variant?.selectedOptions || []).find((o) => pred(o.name))?.value ?? null;

export const sizeOfVariant = (v) => optionValue(v, isSize);

/**
 * A normalized order LINE in the shape the variant helpers expect.
 *
 * normalizeOrder flattens a line to {variantGid, selectedOptions, size, ...},
 * while a product's variant is {id, selectedOptions, ...}. Passing a line
 * straight into colourOfVariant silently returned null for every line, which
 * blanked the "from" description and stopped the current colour being excluded
 * from the colour list.
 */
export const currentVariantOf = (line) => ({
  id: line?.variantGid || null,
  selectedOptions: line?.selectedOptions || [],
});
export const colourOfVariant = (v) => optionValue(v, isColour);

/**
 * Order-level gate. Re-run at EVERY step, not just the first: the courier can
 * pick the parcel up, or the customer can pay, between two taps.
 *
 * @param {any} n normalized order
 * @param {any} st stored state row (for class and the change count)
 * @param {string} phone the phone the tap arrived from
 * @param {{orderAllowlist?:string[]}} [opts] passed in rather than read from
 *   config, so this module stays pure and testable
 * @returns {{ok:boolean, reason?:string}}
 */
export function orderChangeable(n, st, phone, { orderAllowlist = [] } = {}) {
  if (!n) return { ok: false, reason: 'no-order' };
  // Returns {excluded, reason}, NOT a boolean. Reading it as one would make
  // every order pass, which is the opposite of what this line is for.
  const ex = excludeFromAll(n, { orderAllowlist });
  if (ex.excluded) return { ok: false, reason: ex.reason };
  if (n.cancelledAt) return { ok: false, reason: 'cancelled' };

  // Strict, unlike the shared ownsOrder gate which fails OPEN on an order whose
  // verified phone was never stored. Fail-open is defensible for a read; this
  // edits someone's order, so an unknown owner is a refusal.
  if (!n.verifiedPhone || !phone || n.verifiedPhone !== phone) return { ok: false, reason: 'not-owner' };

  // COD only, and nothing captured. A paid or part-paid order means a refund or
  // a top-up could be involved, and that is a person's decision.
  if ((st?.class || null) !== 'COD') return { ok: false, reason: 'not-cod' };
  if ((n.receivedPaise || 0) > 0) return { ok: false, reason: 'money-received' };

  // The owner's hard window: once an AWB exists the label is printed and
  // carries the old SKU, so changing the order would send the wrong garment
  // under a correct-looking tracking number.
  if (n.delhiveryAwb) return { ok: false, reason: 'awb-exists' };
  if ((n.fulfillments || []).length > 0) return { ok: false, reason: 'fulfilled' };

  const used = st?.flowA?.variantChanges || 0;
  if (used >= RULES.variantChangeMaxPerOrder) return { ok: false, reason: 'limit-reached' };

  return { ok: true };
}

/** True when this line is the kind of thing we can swap at all. */
export function lineChangeable(line) {
  if (!line) return false;
  if (line.quantity !== 1) return false; // a multi-quantity line is a split, not a swap
  if (!line.productGid || !line.variantGid) return false;
  if (NEVER_CHANGE_HANDLES.has(line.productHandle)) return false;
  return true;
}

export const changeableLines = (n) => (n?.lineItems || []).filter(lineChangeable);

/**
 * Every variant of this line's product we would be willing to swap to.
 *
 * The product's options must ALL be Size or Colour. A product carrying an
 * option we do not understand (Fit, Length, Payment Type) is refused outright
 * rather than guessed at: picking the wrong option to vary is how a customer
 * ends up with something they did not choose.
 */
export function targetsFor(line, product) {
  if (!lineChangeable(line) || !product) return [];
  if (NEVER_CHANGE_HANDLES.has(product.handle)) return [];
  const names = (product.options || []).map((o) => o.name);
  if (!names.length || !names.every((nm) => isSize(nm) || isColour(nm))) return [];

  const current = (product.variants?.nodes || []).find((v) => v.id === line.variantGid) || null;
  const currentPrice = current ? String(current.price) : null;

  return (product.variants?.nodes || []).filter((v) => {
    if (v.id === line.variantGid) return false; // not the one they already have
    if (!v.availableForSale) return false;
    if ((v.inventoryQuantity ?? 0) <= 0) return false; // policy is DENY across this catalogue
    // Same money, to the paisa. Compared as strings from the same field, so no
    // float rounding is involved.
    if (currentPrice !== null && String(v.price) !== currentPrice) return false;
    return true;
  });
}

/** Colours that have at least one in-stock, same-price variant. */
export function coloursFor(targets, current) {
  const seen = new Map();
  for (const v of targets) {
    const c = colourOfVariant(v);
    if (c && c !== current && !seen.has(c)) seen.set(c, v);
  }
  return [...seen.entries()].map(([colour, variant]) => ({ colour, variant }));
}

/** In-stock sizes, optionally pinned to one colour. */
export function sizesFor(targets, colour = null) {
  const out = [];
  const seen = new Set();
  for (const v of targets) {
    if (colour && colourOfVariant(v) !== colour) continue;
    const sz = sizeOfVariant(v);
    const key = sz || v.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ size: sz, variant: v });
  }
  return out;
}

/** Does this product have a colour worth offering, beyond the one they have? */
export function hasOtherColours(targets, currentColour) {
  return coloursFor(targets, currentColour).length > 0;
}

/**
 * Look a tapped variant id up inside the freshly derived candidate set.
 *
 * This is the re-validation that makes a forged payload harmless: an id that is
 * not a current candidate resolves to null, whatever it names.
 */
export function resolveTarget(line, product, variantGid) {
  if (!variantGid) return null;
  return targetsFor(line, product).find((v) => v.id === variantGid) || null;
}

/** "Khili Dhoop, size 2XL" / "Bandhan, Brown, size XL" for the confirm line. */
export function describeVariant(title, variant) {
  const parts = [title];
  const c = colourOfVariant(variant);
  const sz = sizeOfVariant(variant);
  if (c) parts.push(c);
  if (sz) parts.push(`size ${sz}`);
  return parts.join(', ');
}
