/*
 * replace.mjs: reading a /replace command, resolving what it points at, and
 * classifying every reason the owner should not be allowed to book it.
 *
 * Pure: no I/O, no clients, no clock of its own. `now`, the courier's answers,
 * the Shopify reads and the config presence all arrive as arguments, so every
 * rule below can be tested without a courier account or a WhatsApp fake.
 *
 * THREE IDEAS DO THE SAFETY WORK HERE.
 *
 * 1. The parser never guesses. A replacement books two real courier movements
 *    against a customer's address, so a half understood command is worth less
 *    than no command: `error` is set and the owner retypes. The one place a
 *    guess would be tempting is telling a size token from a product word, and
 *    that is settled by POSITION (the first recognised token after the product
 *    words is the size they have, the last token is the size they should get)
 *    rather than by trying to be clever about which word looks like a garment.
 *
 * 2. Nothing claims a size exists. `normaliseSize` only canonicalises spelling;
 *    whether XXL is a thing on that product is answered by the product's own
 *    Size option values, and a size that is not there resolves to
 *    'size-not-stocked' instead of a booking for a garment nobody can pack.
 *
 * 3. `validate` classifies and does not decide. It returns hard stops, soft
 *    stops and warnings, and the orchestrator owns the policy (hard refuses,
 *    soft refuses unless `force`, warnings print and never block). Keeping the
 *    policy out of here is what lets the stop list be read as a checklist.
 */
import { RULES } from '../../messages/rules.mjs';
import { hasRtoTag } from './order.mjs';
import { sizeOfVariant, colourOfVariant } from './variantChange.mjs';

/* ------------------------------------------------------------------ *
 * small shared helpers
 * ------------------------------------------------------------------ */

/** Lowercase alphanumeric tokens. Used for every fuzzy match in this file. */
const tokensOf = (...parts) =>
  parts
    .filter((p) => p !== null && p !== undefined)
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Every word must be the PREFIX of some token in the haystack.
 *
 * Prefix rather than equality because the owner types "noor" for "Noor Bagh"
 * and "bandh" when they are in a hurry. Deliberately AND, not OR: one word
 * matching out of three is how two different garments both look like a match.
 */
function matchesWords(words, ...haystack) {
  const toks = tokensOf(...haystack);
  // The WORDS are tokenised as well, because the owner types a handle
  // ("taana-bana") as readily as a title and a hyphen is not part of any token.
  const want = tokensOf(...words);
  if (!want.length || !toks.length) return false;
  return want.every((w) => toks.some((t) => t.startsWith(w)));
}

const sameText = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Is this value actually filled in?
 *
 * Booleans are answered as themselves because `configPresent` may be passed as
 * flags rather than values, and String(false) is a non empty string, which
 * would have reported a missing GSTIN as present.
 *
 * A string of asterisks or the word redacted is NOT present. Shopify replaces
 * the address on an order it has redacted, and a label printed with "***" as
 * the street is a parcel that never arrives.
 */
function present(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (/^[*x•.\s_-]+$/i.test(s)) return false;
  return !/^redacted$/i.test(s);
}

/* ------------------------------------------------------------------ *
 * 1. the command
 * ------------------------------------------------------------------ */

/*
 * Longest alias first. `/replace` is a prefix of `/replace-order`, so the
 * obvious ordering silently reads `/replace-order 1234 m xl` as the create verb
 * with a sub-verb of "order" and refuses a command that is spelled correctly.
 */
const ALIAS = /^\/(replace-order|replace|rp)(?=$|[\s#\d])/i;
const SUB_VERBS = new Set(['status', 'cancel', 'retry', 'list', 'help']);
const REASONS = new Set(['size', 'damaged', 'wrong', 'other']);
const PAYERS = new Set(['us', 'customer']);

/** '#1234' and '1234' both mean 1234. Anything else is not an order number. */
const orderNumber = (tok) => {
  const m = String(tok ?? '').match(/^#?(\d+)$/);
  return m ? m[1] : null;
};

/**
 * A trailing token read as a flag, or null when it is part of the swap.
 *
 * None of these can collide with a size: `x2` is not a size alias and `xl`
 * does not match x followed by digits, which is the one collision that would
 * have eaten the size the customer is meant to receive.
 *
 * @param {string} tok
 * @returns {{kind:string, value:any}|null}
 */
function asFlag(tok) {
  const t = String(tok || '');
  let m;
  if ((m = t.match(/^x(\d+)$/i))) return { kind: 'qty', value: Number(m[1]) };
  if ((m = t.match(/^reason:(.*)$/i))) return { kind: 'reason', value: m[1].toLowerCase() };
  if ((m = t.match(/^pays:(.*)$/i))) return { kind: 'pays', value: m[1].toLowerCase() };
  if (/^force$/i.test(t)) return { kind: 'force', value: true };
  if (/^again$/i.test(t)) return { kind: 'again', value: true };
  return null;
}

/**
 * The canonical size token for whatever the owner typed, or null.
 *
 * Spelling only. The product's real Size option values stay the only authority
 * on what exists, which is why this returning 'XXL' is not permission to book
 * one.
 *
 * @param {string|null|undefined} word
 * @returns {string|null}
 */
export function normaliseSize(word) {
  const w = String(word ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!w) return null;
  /** @type {Record<string,string>} */
  const aliases = RULES.replace.sizeAliases;
  return aliases[w] ?? null;
}

/** 'free size' is two words, so a size can consume two tokens, not just one. */
function sizeAt(toks, i) {
  if (i + 1 < toks.length) {
    const two = normaliseSize(`${toks[i]} ${toks[i + 1]}`);
    if (two) return { size: two, len: 2 };
  }
  const one = normaliseSize(toks[i]);
  return one ? { size: one, len: 1 } : null;
}

function sizeAtEnd(toks) {
  if (toks.length >= 2) {
    const two = normaliseSize(`${toks[toks.length - 2]} ${toks[toks.length - 1]}`);
    if (two) return { size: two, len: 2 };
  }
  const one = normaliseSize(toks[toks.length - 1]);
  return one ? { size: one, len: 1 } : null;
}

/**
 * @typedef {{productWords:string[], fromSize:string|null, targetWords:string[],
 *            toSize:string|null, qty:number}} ParsedSwap
 * @typedef {{reason:string, pays:string, force:boolean, again:boolean,
 *            skipConfirm:boolean, notify:boolean}} ParsedFlags
 * @typedef {{verb:string, orderName:string|null, swaps:ParsedSwap[],
 *            flags:ParsedFlags, error:string|null}} ParsedCommand
 */

/**
 * Read a /replace command. Never throws: garbage comes back as the help verb
 * carrying an `error`, because an owner typing from a phone deserves a sentence
 * rather than a stack trace in the logs.
 *
 * @param {string} text
 * @returns {ParsedCommand}
 */
export function parseReplaceCommand(text) {
  /** @type {ParsedCommand} */
  const out = {
    verb: 'help',
    orderName: null,
    swaps: [],
    flags: { reason: 'size', pays: 'customer', force: false, again: false, skipConfirm: false, notify: false },
    error: null,
  };
  try {
    return parseInner(String(text ?? ''), out);
  } catch (e) {
    out.error = 'I could not read that command. Send /replace help for the shape of it.';
    return out;
  }
}

/** @param {string} raw @param {ParsedCommand} out */
function parseInner(raw, out) {
  const s = raw.trim().replace(/\s+/g, ' ');
  const m = s.match(ALIAS);
  if (!m) {
    out.error = 'That is not a /replace command. Send /replace help for the shape of it.';
    return out;
  }

  const rest = s.slice(m[0].length).trim();
  if (!rest) return out; // a bare /replace is a request for the help text

  const words = rest.split(' ');
  const first = words[0].toLowerCase();

  if (SUB_VERBS.has(first)) return parseSubVerb(first, words.slice(1), out);

  out.verb = 'create';
  const num = orderNumber(words[0]);
  if (!num) {
    out.error = 'I need the order number first, like /replace #1234 noor m xl.';
    return out;
  }
  out.orderName = num;

  /*
   * A bare trailing `!` skips the preview, and it arrives stuck to the last
   * token as often as it arrives on its own ("...m xl!"), so it comes off the
   * whole string before anything is tokenised.
   */
  let body = words.slice(1).join(' ').trim();
  if (/!+$/.test(body)) {
    out.flags.skipConfirm = true;
    body = body.replace(/!+$/, '').trim();
  }
  if (!body) {
    out.error = 'I need at least one swap, like /replace #1234 noor m xl.';
    return out;
  }

  const segments = body.split(',').map((t) => t.trim()).filter(Boolean);
  if (!segments.length) {
    out.error = 'I need at least one swap, like /replace #1234 noor m xl.';
    return out;
  }
  if (segments.length > RULES.replace.maxSwapsPerCommand) {
    out.error = `That is ${segments.length} swaps and ${RULES.replace.maxSwapsPerCommand} is the most one command may carry. Split it into two commands.`;
  }

  let paysGiven = null;
  for (const seg of segments) {
    const toks = seg.split(' ').filter(Boolean);
    /** @type {ParsedSwap} */
    const swap = { productWords: [], fromSize: null, targetWords: [], toSize: null, qty: 1 };

    /*
     * Flags are pulled off the END of the segment, repeatedly, which is what
     * makes them order free among themselves without ever eating a word out of
     * the middle of a product name.
     */
    while (toks.length) {
      const f = asFlag(toks[toks.length - 1]);
      if (!f) break;
      toks.pop();
      if (f.kind === 'qty') {
        if (!Number.isInteger(f.value) || f.value < 1) out.error = `x${f.value} is not a quantity. Use x1 or more.`;
        else swap.qty = f.value;
      } else if (f.kind === 'reason') {
        if (!REASONS.has(String(f.value))) out.error = `I do not know the reason "${f.value}". Use ${[...REASONS].join(', ')}.`;
        else out.flags.reason = String(f.value);
      } else if (f.kind === 'pays') {
        if (!PAYERS.has(String(f.value))) out.error = `I do not know who "${f.value}" is. Use pays:us or pays:customer.`;
        else paysGiven = String(f.value);
      } else if (f.kind === 'force') out.flags.force = true;
      else if (f.kind === 'again') out.flags.again = true;
    }

    if (!toks.length) {
      out.error = `There is nothing left to swap in "${seg}" once the flags are read off it.`;
      out.swaps.push(swap);
      continue;
    }

    const end = sizeAtEnd(toks);
    if (!end) {
      // Best effort so the reply can quote back what it did understand.
      swap.productWords = toks.map((t) => t.toLowerCase());
      out.error = `I could not read a size at the end of "${seg}". The last word is the size they should get, like "noor m xl".`;
      out.swaps.push(swap);
      continue;
    }
    swap.toSize = end.size;

    const head = toks.slice(0, toks.length - end.len);
    let at = -1;
    let from = null;
    for (let i = 0; i < head.length; i++) {
      const hit = sizeAt(head, i);
      if (hit) {
        at = i;
        from = hit;
        break;
      }
    }
    if (!from) {
      /*
       * The grammar needs BOTH sizes. "Change #1234 to XL" cannot be acted on
       * when the order has two garments in it, and quietly picking one is how
       * the wrong piece gets picked up from the customer's house.
       */
      swap.productWords = head.map((t) => t.toLowerCase());
      out.error = `I need the size they have now and the size they should get, like "noor m xl". "${seg}" only names one size.`;
      out.swaps.push(swap);
      continue;
    }
    swap.fromSize = from.size;
    swap.productWords = head.slice(0, at).map((t) => t.toLowerCase());
    swap.targetWords = head.slice(at + from.len).map((t) => t.toLowerCase());
    out.swaps.push(swap);
  }

  /*
   * Who pays follows the reason unless the owner overrides it. Only a size swap
   * is the customer's own choice; damaged, wrong and anything we could not
   * classify are ours until a person says otherwise. Recorded only. There is no
   * way to collect freight on a reverse leg, so this is a note for the owner
   * settling courier bills by hand, never a charge.
   */
  out.flags.pays = paysGiven ?? (out.flags.reason === 'size' ? 'customer' : 'us');
  return out;
}

/** @param {string} verb @param {string[]} words @param {ParsedCommand} out */
function parseSubVerb(verb, words, out) {
  out.verb = verb;
  if (verb === 'list' || verb === 'help') return out; // neither takes an order

  const num = orderNumber(words[0]);
  if (!num) {
    out.error = `I need an order number, like /replace ${verb} #1234.`;
    return out;
  }
  out.orderName = num;

  for (const w of words.slice(1)) {
    if (verb === 'cancel' && /^notify$/i.test(w)) out.flags.notify = true;
    else out.error = `I did not understand "${w}" after /replace ${verb}.`;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. which line
 * ------------------------------------------------------------------ */

/**
 * Which ordered line the product words point at. Never guesses between two.
 *
 * The haystack is built from the line's own selected options rather than a
 * `variantTitle` field, because normalizeOrder does not keep one: it flattens
 * the variant to `selectedOptions`, so "bandhan brown" has to reach the colour
 * through there or a colour word matches nothing. `sku` and `product.handle`
 * are read when present so a line that came from getShippingDetails matches
 * the same way.
 *
 * @param {any[]} lines normalized order lines
 * @param {string[]} [productWords]
 * @returns {{line?:any, candidates?:any[], none?:boolean, lines?:any[]}}
 */
export function resolveLine(lines, productWords) {
  const all = Array.isArray(lines) ? lines : [];
  const words = (productWords || []).map((w) => String(w).toLowerCase()).filter(Boolean);

  if (!words.length) {
    if (all.length === 1) return { line: all[0] };
    if (!all.length) return { none: true, lines: all };
    return { candidates: all };
  }

  const hits = all.filter((l) =>
    matchesWords(
      words,
      l?.title,
      l?.variantTitle,
      l?.productHandle,
      l?.product?.handle,
      l?.sku,
      l?.variant?.sku,
      ...(l?.selectedOptions || []).map((o) => o?.value),
    ),
  );
  if (hits.length === 1) return { line: hits[0] };
  if (!hits.length) return { none: true, lines: all };
  return { candidates: hits };
}

/* ------------------------------------------------------------------ *
 * 3. which variant
 * ------------------------------------------------------------------ */

/*
 * getProductVariants returns the whole product ({options, variants:{nodes}}),
 * a catalog entry carries {title, handle, variants}, and a caller with nothing
 * but a list has an array. All three are read here rather than making the two
 * concurrent callers agree on one, because the cost of guessing wrong is a
 * silent empty candidate set that reads as "that size is not stocked".
 */
function variantsOf(src) {
  if (!src) return [];
  if (Array.isArray(src)) return src;
  if (Array.isArray(src.nodes)) return src.nodes;
  if (Array.isArray(src.variants)) return src.variants;
  if (Array.isArray(src.variants?.nodes)) return src.variants.nodes;
  return [];
}

/**
 * The product's REAL Size option values.
 *
 * The options block is the authority when there is one. A bare variant array
 * has none, so the sizes its own variants carry are the next best answer, and
 * both are facts about the product rather than an assumption that a size the
 * owner typed must exist somewhere.
 */
function sizeValues(src) {
  const opts = !src || Array.isArray(src) ? [] : src.options || [];
  const opt = opts.find((o) => /^size$/i.test(String(o?.name || '')));
  if (opt && Array.isArray(opt.values) && opt.values.length) return opt.values.map(String);
  return variantsOf(src).map(sizeOfVariant).filter(Boolean);
}

const colourValues = (src) => {
  const seen = [];
  for (const v of variantsOf(src)) {
    const c = colourOfVariant(v);
    if (c && !seen.some((x) => sameText(x, c))) seen.push(c);
  }
  return seen;
};

/**
 * Does this variant's size answer to the token the owner typed?
 *
 * Canonicalised both ways first, so "2XL" on the command matches "XXL" in
 * Shopify, then compared raw so a value this catalogue has never seen (a
 * numbered size, say) still matches itself instead of silently failing.
 */
const sameSize = (value, want) =>
  !!value && !!want && (sameText(value, want) || (normaliseSize(value) !== null && normaliseSize(value) === normaliseSize(want)));

/** Same stock test as targetsFor: policy on this catalogue is DENY, so 0 is gone. */
const active = (v) => !!v && v.availableForSale !== false && (v.inventoryQuantity ?? 0) > 0;

const optionValuesOf = (v) => (v?.selectedOptions || []).map((o) => o?.value);

/**
 * The one active variant a swap should go out as.
 *
 * The source product is tried first and the catalog only when the words name
 * something that is not this product, so a colour that exists on both cannot
 * turn a size swap into a different garment.
 *
 * @param {{line?:any, swap?:any, variants?:any, catalog?:any[]}} input
 * @returns {{variant?:any, product?:any, reason?:string, candidates?:any[]}}
 */
export function resolveTarget({ line, swap, variants, catalog } = {}) {
  const toSize = swap?.toSize || null;
  const words = (swap?.targetWords || []).map((w) => String(w).toLowerCase()).filter(Boolean);
  if (!line || !toSize) return { reason: 'unresolved' };

  const srcVariants = variantsOf(variants);
  const source = srcVariants.find((v) => v.id === line.variantGid) || null;
  const product = Array.isArray(variants) ? null : variants || null;
  const srcHay = [product?.title, product?.handle, line.title, line.productHandle];

  let sourceNamed = false;
  let wantColour = source ? colourOfVariant(source) : null;
  if (!words.length || matchesWords(words, ...srcHay)) {
    /*
     * No target words, or words that name the product they already have. Both
     * mean a size change, so the colour is PINNED to the one they own: letting
     * it float would offer every colour at that size and a two colour product
     * would come back ambiguous for the commonest command there is.
     */
    sourceNamed = true;
  } else {
    const hits = colourValues(variants).filter((c) => matchesWords(words, ...srcHay, c));
    if (hits.length === 1) {
      sourceNamed = true;
      wantColour = hits[0];
    } else if (hits.length > 1) {
      return {
        reason: 'ambiguous',
        candidates: srcVariants.filter((v) => hits.some((c) => sameText(colourOfVariant(v), c)) && sameSize(sizeOfVariant(v), toSize)),
      };
    }
  }

  if (sourceNamed) {
    const hasColour = colourValues(variants).length > 0;
    const sized = srcVariants.filter(
      (v) => sameSize(sizeOfVariant(v), toSize) && (!hasColour || !wantColour || sameText(colourOfVariant(v), wantColour)),
    );
    /*
     * Checked BEFORE the stock filter and before the source is dropped. An
     * out of stock source variant would otherwise fall through and be reported
     * as "that size is not stocked", which sends the owner hunting for stock
     * when what they actually typed was the size the customer already has.
     */
    if (sized.length && sized.every((v) => v.id === line.variantGid)) return { reason: 'identical' };
    const ok = sized.filter((v) => v.id !== line.variantGid && active(v));
    if (ok.length === 1) return { variant: ok[0], product };
    if (ok.length > 1) return { reason: 'ambiguous', candidates: ok };
    // Either the Size option has no such value, or it does and nothing is
    // packable. Both answers are the same sentence to the owner.
    return { reason: 'size-not-stocked' };
  }

  /*
   * A different product. Matched per VARIANT so "taana" and "taana indigo"
   * both work off one rule, and so a product with three colours in that size
   * comes back ambiguous rather than picking the first colour in the list.
   */
  const named = [];
  for (const p of catalog || []) {
    for (const v of variantsOf(p)) {
      if (matchesWords(words, p?.title, p?.handle, ...optionValuesOf(v))) named.push({ variant: v, product: p });
    }
  }
  if (!named.length) return { reason: 'unresolved' };
  const hits = named.filter(
    (h) => sameSize(sizeOfVariant(h.variant), toSize) && h.variant.id !== line.variantGid && active(h.variant),
  );
  if (hits.length === 1) return { variant: hits[0].variant, product: hits[0].product };
  if (hits.length > 1) return { reason: 'ambiguous', candidates: hits };
  return { reason: 'size-not-stocked' };
}

/* ------------------------------------------------------------------ *
 * 4. may we book it
 * ------------------------------------------------------------------ */

/*
 * A request that already holds a courier booking, or is holding the lease to
 * take one. Creating a second replacement on top of any of these is how one
 * wrong garment becomes four parcels. FAILED is in here on purpose: a failed
 * run has usually booked the return leg already and is resumable with
 * /replace retry, so it is mid execution even though it has stopped.
 */
const MID_EXECUTION = new Set(['CONFIRMED', 'RETURN_CREATED', 'FORWARD_CREATED', 'CUSTOMER_NOTIFIED', 'FAILED']);

/*
 * A request that is over. Everything NOT in here and not mid execution is read
 * as still open, including a status this build has never heard of: a state we
 * cannot place is not a reason to book a second parcel.
 */
const FINISHED = new Set(['REJECTED', 'EXPIRED', 'CANCELLED', 'DONE']);

const lineIdsOf = (req) => {
  if (Array.isArray(req?.lineIds)) return req.lineIds.filter(Boolean);
  return (req?.swaps || []).map((s) => s?.lineId || s?.line?.id).filter(Boolean);
};

const rupeesOf = (r) => {
  const paid = (r?.line?.unitPaise || 0) / 100;
  const asked = Number(r?.variant?.price || 0);
  return { paid, asked: Number.isFinite(asked) ? asked : 0 };
};

/**
 * Every reason not to book this replacement, classified and not acted on.
 *
 * Hard stops have no override. Soft stops are the ones an owner looking at a
 * real parcel can reasonably overrule, so they come back as 'soft' whether or
 * not `force` was typed: dropping them here would put the policy in two places
 * and the orchestrator is where it lives. Warnings are things the owner must
 * know and must not be stopped by.
 *
 * @param {{n?:any, st?:any, shipping?:any, resolved?:any[], flags?:any,
 *          serviceability?:any, delivered?:any, existing?:any,
 *          courierAwb?:string|null, rules?:any, now?:any, testOrders?:string[],
 *          configPresent?:any, customer?:any, declaredValueInr?:number}} input
 * @returns {{stops:{kind:string, code:string, message:string}[],
 *            warnings:{code:string, message:string}[]}}
 */
export function validate(input) {
  const {
    n,
    st,
    shipping,
    resolved = [],
    flags = {},
    serviceability,
    delivered,
    existing,
    courierAwb,
    rules = RULES,
    now,
    testOrders = [],
    configPresent = {},
    customer = {},
    declaredValueInr,
  } = input || {};
  const R = (rules || RULES).replace;
  /** @type {{kind:string, code:string, message:string}[]} */
  const stops = [];
  /** @type {{code:string, message:string}[]} */
  const warnings = [];
  const hard = (code, message) => stops.push({ kind: 'hard', code, message });
  const soft = (code, message) => stops.push({ kind: 'soft', code, message });
  const warn = (code, message) => warnings.push({ code, message });

  /*
   * Nothing else can be said about an order we could not read, and every check
   * below reads it, so this one returns rather than reporting ten more stops
   * that all mean the same thing.
   */
  if (!n) {
    hard('order-not-found', 'I could not find that order. Check the order number and try again.');
    return { stops, warnings };
  }

  if (n.cancelledAt) hard('order-cancelled', `Order ${n.name || ''} is cancelled, so there is nothing to replace.`.trim());
  const fin = String(n.financialStatus || '').toUpperCase();
  if (fin === 'VOIDED') hard('order-voided', `Order ${n.name || ''} is voided. Nothing was collected on it, so handle this by hand.`.trim());
  if (fin === 'REFUNDED') hard('order-refunded', `Order ${n.name || ''} is fully refunded. The customer has their money back, so handle this by hand.`.trim());

  /*
   * A test order is reachable only when it is named in REPLACE_TEST_ORDERS.
   * This is the switch that makes the first live booking safe: one order of
   * your own, nothing else in the store touchable.
   */
  const names = [n.numericId, String(n.name || '').replace(/^#/, '')].filter(Boolean).map(String);
  if (n.isTest && !names.some((x) => (testOrders || []).map(String).includes(x))) {
    hard('test-order', `Order ${n.name || ''} is a test order. Add it to REPLACE_TEST_ORDERS if you meant to use it.`.trim());
  }

  /*
   * hasRtoTag, NOT hasTag(tags,'RTO'): COD King tags every order "LOW/MEDIUM/
   * HIGH RTO Risk", so a substring test calls every order in the store an RTO
   * and refuses the whole feature.
   */
  const courierStatus = String(st?.courierStatus || '').toUpperCase();
  if (courierStatus.startsWith('RTO') || hasRtoTag(n.tags)) {
    hard('shipment-rto', 'The original parcel came back to us, so there is nothing at the customer to pick up. Reship it instead of replacing it.');
  }

  if (!resolved.length) {
    hard('swap-unresolved', 'I could not work out what to replace on that order. Name the garment and both sizes, like /replace #1234 noor m xl.');
  }
  for (const r of resolved) {
    if (!r) continue;
    const what = r.line?.title || 'that garment';
    if (r.reason === 'identical') {
      hard('swap-identical', `The ${what} swap asks for what the customer already has, so there is nothing to send.`);
      continue;
    }
    if (r.reason) {
      hard('swap-unresolved', `I could not resolve the ${what} swap (${r.reason}). Name the garment, the colour if it has one, and both sizes.`);
      continue;
    }
    /*
     * Purchased minus already replaced, because a line bought once and already
     * replaced once has nothing left to give: a second replacement on it sends
     * a garment the customer never paid for.
     */
    const purchased = Number(r.line?.quantity ?? 0);
    const already = Number(r.alreadyReplaced ?? st?.replace?.replacedByLine?.[r.line?.id] ?? 0);
    const qty = Number(r.qty ?? r.swap?.qty ?? 1);
    if (qty > purchased - already) {
      hard(
        'swap-quantity-exceeds-purchased',
        `The order has ${purchased} of ${what}${already ? ` and ${already} already replaced` : ''}, so x${qty} is more than there is to replace.`,
      );
    }
  }

  const requests = Array.isArray(existing) ? existing.filter(Boolean) : existing ? [existing] : [];
  const ourLines = new Set(resolved.map((r) => r?.line?.id).filter(Boolean));
  for (const req of requests) {
    const status = String(req.status || '').toUpperCase();
    if (MID_EXECUTION.has(status)) {
      hard('replacement-in-progress', `A replacement on this order is already running (${status}). Use /replace status to see it, or /replace retry if it stopped.`);
      continue;
    }
    if (FINISHED.has(status)) continue;
    const theirs = lineIdsOf(req);
    // No line ids on the open request means we cannot prove it is a different
    // garment, and assuming it is would book a second parcel for the same one.
    const clashes = !theirs.length || theirs.some((id) => ourLines.has(id));
    if (clashes && !flags.again) {
      hard('replacement-already-active', 'There is already an open replacement for that garment. Cancel it first, or add `again` if a second one is really meant.');
    }
  }

  if (shipping?.scopeProblem) {
    hard(
      'shipping-address-no-access',
      'Shopify would not give us the delivery address for this order. That is an app permissions problem with protected customer data, not a typo in the address, so no amount of retyping will fix it.',
    );
  } else {
    const a = shipping?.address || null;
    const labels = { name: 'name', address1: 'street address', city: 'city', pin: 'pincode', phone: 'phone' };
    const missing = Object.keys(labels).filter((k) => !present(a?.[k]));
    if (!a) hard('shipping-address-incomplete', 'This order has no delivery address on it, so there is nothing to book a pickup against.');
    else if (missing.length) {
      hard(
        'shipping-address-incomplete',
        `The delivery address is missing or redacted: ${missing.map((k) => labels[k]).join(', ')}. Fill it in on the order, or book this one by hand.`,
      );
    }
  }

  /*
   * Only answered when the courier actually answered. A null serviceability is
   * "we did not ask", and inventing a refusal from it would stop every command
   * the moment a pin check times out.
   */
  if (serviceability) {
    const pin = shipping?.address?.pin || delivered?.pin || 'that pincode';
    if (!serviceability.reversePickup) {
      hard('reverse-pickup-not-serviceable', `The courier does not do reverse pickup at ${pin}, so ask the customer to self-ship, or handle by hand.`);
    }
    if (!serviceability.prepaidDelivery) {
      hard('prepaid-delivery-not-serviceable', `The courier does not deliver prepaid parcels to ${pin}, so ask the customer to self-ship, or handle by hand.`);
    }
    if (serviceability.oda) soft('oda-pin', `${pin} is an out of delivery area pin, so both legs will be slow and may cost extra.`);
  }

  const declared = Number(
    declaredValueInr ?? resolved.reduce((sum, r) => {
      const { paid, asked } = rupeesOf(r);
      return sum + Math.max(paid, asked) * Number(r?.qty ?? r?.swap?.qty ?? 1);
    }, 0),
  );
  if (declared >= R.ewaybillThresholdInr) {
    hard(
      'ewaybill-threshold',
      `The declared value comes to Rs ${Math.round(declared)}, at or above the Rs ${R.ewaybillThresholdInr} e-waybill limit. An e-waybill is a separate document this service does not generate, so book this parcel by hand.`,
    );
  }

  /*
   * The label is a GST document in the owner's name. A guessed HSN code is a
   * wrong tax declaration on every parcel, so the key is named and the command
   * refuses until a real value is filled in.
   */
  const cfg = [
    ['pickupLocation', 'config-missing-pickup-location', 'DELHIVERY_PICKUP_LOCATION, the warehouse name registered with the courier'],
    ['gstin', 'config-missing-gstin', 'SELLER_GSTIN'],
    ['hsn', 'config-missing-hsn', 'RULES.replace.hsn, the HSN code for the garment'],
  ];
  for (const [key, code, label] of cfg) {
    if (!present(configPresent?.[key])) hard(code, `${label} is not set, and the shipping label cannot be printed without it. Fill it in and run the command again.`);
  }

  if (!courierAwb) soft('awb-missing', 'This order has no waybill, so I cannot check with the courier that it ever reached the customer.');
  if (!delivered?.at) {
    soft('delivery-unconfirmed', 'The courier has not confirmed this order as delivered, so the customer may not have the garment yet.');
  } else {
    const nowMs = now === null || now === undefined ? NaN : new Date(now).getTime();
    const atMs = new Date(delivered.at).getTime();
    if (Number.isFinite(nowMs) && Number.isFinite(atMs)) {
      const days = (nowMs - atMs) / 86400000;
      if (days > R.windowDays) {
        soft('outside-replacement-window', `This order was delivered ${Math.floor(days)} days ago and ${R.windowDays} days is the routine window.`);
      }
    }
  }

  const dearer = resolved
    .map((r) => {
      const { paid, asked } = rupeesOf(r);
      return { title: r?.line?.title || 'the new garment', diff: asked - paid };
    })
    .filter((x) => x.diff > 0)
    .sort((a, b) => b.diff - a.diff)[0];
  if (dearer) {
    warn('price-above-paid', `${dearer.title} is priced Rs ${Math.round(dearer.diff)} above what was paid. Nothing is collected automatically, so settle the difference by hand if you want it.`);
  }

  const cod = String(st?.class || '').toUpperCase() === 'COD' || (n.gateways || []).some((g) => /cash on delivery|\bcod\b/i.test(String(g)));
  if (cod) warn('original-order-cod', 'The original order was COD. The replacement goes out prepaid at our cost, so nothing is collected on delivery.');

  if (delivered?.pin && shipping?.address?.pin && String(delivered.pin) !== String(shipping.address.pin)) {
    warn('delivered-pin-mismatch', `The courier delivered to ${delivered.pin} and Shopify has ${shipping.address.pin}. Check which address the garment is actually at before booking the pickup.`);
  }

  /*
   * None of these three stop the logistics. The two parcels are the owner's
   * decision and they happen either way; what changes is that the customer
   * hears nothing from us, so the owner has to tell them.
   */
  if (!customer.verifiedPhone) warn('customer-no-verified-phone', 'This customer has no OTP verified WhatsApp number, so both parcels will be booked without a message going out. Tell them yourself.');
  if (customer.optedOut) warn('customer-opted-out', 'This customer has opted out of WhatsApp, so both parcels will be booked without a message going out. Tell them yourself.');
  if (customer.undeliverable) warn('customer-undeliverable', 'WhatsApp will not deliver to this customer right now, so both parcels will be booked without a message going out. Tell them yourself.');

  return { stops, warnings };
}
