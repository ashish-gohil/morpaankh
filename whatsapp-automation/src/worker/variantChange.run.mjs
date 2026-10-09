/*
 * variantChange.run.mjs — the customer swaps a size or colour on their own.
 *
 * Entered from the existing Cancel button, because cancelling was the only
 * self-service option a customer had and some of them only wanted a different
 * size. Order #1187 became #1188 that way: cancelled, then reordered one size
 * up 36 minutes later, and the duplicate broke order classification. 11 of the
 * last 12 hand edits in this store were the same swap done by a human.
 *
 * STATE LIVES IN THE PAYLOAD, NOT THE DATABASE. Every step encodes the line and
 * variant it is about, so there is no half-finished conversation to store,
 * expire or clean up, and a stale tap from yesterday is re-validated from
 * scratch rather than trusted. The action field is `v<step>:<lineNum>:<varNum>`
 * with numeric ids only, because decodePayload splits on '|' into exactly four
 * parts so the ids cannot contain one. Row ids allow 200 characters and button
 * ids 256; the longest of these is about 55.
 *
 * NOTHING IS WRITTEN UNTIL THE CONFIRM TAP. Every step before vcok only reads.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { getState, patchFlowA, runOnce } from '../store/orderState.mjs';
import { soft } from '../lib/resilience.mjs';
import { log } from '../log.mjs';
import { sess, getNorm, ownerAlert } from './send.mjs';
import { touchInbound } from '../store/phoneProfile.mjs';
import {
  orderChangeable,
  changeableLines,
  targetsFor,
  coloursFor,
  sizesFor,
  hasOtherColours,
  resolveTarget,
  describeVariant,
  currentVariantOf,
  colourOfVariant,
  sizeOfVariant,
} from '../domain/variantChange.mjs';

// Same local helper the other three flow modules use.
const nowOf = (deps) => deps.now || new Date();

/** Meta allows 10 list rows for all sections combined. Not 10 per section. */
const MAX_ROWS = 10;

const numOf = (gid) => String(gid || '').split('/').pop();
const rupees = (paise) => `Rs ${(paise / 100).toLocaleString('en-IN')}`;

/** Build the action string for a step, with numeric ids only. */
const act = (step, lineNum, varNum) => [step, lineNum, varNum].filter((x) => x != null).join(':');

/**
 * Everything a step needs, re-derived from scratch and re-checked.
 *
 * Deliberately re-reads the order and the product on EVERY tap rather than
 * trusting the previous step: the courier can take the parcel, the customer can
 * pay, or the last unit of a size can sell, between two taps.
 */
async function load(orderId, lineNum, deps, phone) {
  const n = await getNorm(deps, orderId);
  const st = (await getState(orderId)) || {};
  const gate = orderChangeable(n, st, phone, { orderAllowlist: config.orderAllowlist });
  if (!gate.ok) return { n, st, bad: gate.reason };

  const lines = changeableLines(n);
  if (!lines.length) return { n, st, lines, bad: 'no-changeable-line' };

  const line = lineNum ? lines.find((l) => numOf(l.id) === String(lineNum)) : lines.length === 1 ? lines[0] : null;
  if (lineNum && !line) return { n, st, lines, bad: 'unknown-line' };
  if (!line) return { n, st, lines };

  const product = await deps.clients.shopify.getProductVariants(line.productGid);
  const targets = targetsFor(line, product);
  return { n, st, lines, line, product, targets };
}

/** One place to end badly: change nothing, tell them a person is coming. */
async function handoff(orderId, n, reason, deps) {
  log.warn('variantChange: handing off', { orderId, reason });
  await soft('tagsAdd:wa-variant-change-requested', () =>
    deps.clients.shopify.tagsAdd(n.gid, ['wa-variant-change-requested']), { orderId });
  await ownerAlert(deps, n.name, `size or colour change could not be completed from WhatsApp (${reason}). Customer is waiting`);
  await sess(deps, n.verifiedPhone, 'vc_handoff', { order_number: n.name });
}

/** True when the Cancel tap should offer a change first. Read only. */
export async function changeOffered(n, st, phone) {
  if (!config.variantChangeEnabled) return false;
  if (!orderChangeable(n, st, phone, { orderAllowlist: config.orderAllowlist }).ok) return false;
  return changeableLines(n).length > 0;
}

// ---- steps ------------------------------------------------------------------

/** `vc` - entry, and the Go back target. */
export async function onStart(orderId, deps, phone) {
  const { n, line, lines, targets, bad } = await load(orderId, null, deps, phone);
  if (!n) return;
  await touchInbound(phone, nowOf(deps));
  if (bad) return handoff(orderId, n, bad, deps);

  // More than one changeable item: ask which.
  if (!line) {
    const rows = lines.slice(0, MAX_ROWS).map((l) => ({
      action: act('vcl', numOf(l.id)),
      title: l.title.slice(0, 24),
      description: [colourOfVariant(currentVariantOf(l)), l.size && `size ${l.size}`].filter(Boolean).join(', ').slice(0, 72),
    }));
    return sess(deps, n.verifiedPhone, 'vc_pick_item', { order_number: n.name }, { orderId: n.numericId, rows });
  }
  return offerFor(orderId, n, line, targets, deps);
}

/** `vcl:<line>` - they chose which item. */
export async function onPickLine(orderId, lineNum, deps, phone) {
  const { n, line, targets, bad } = await load(orderId, lineNum, deps, phone);
  if (!n) return;
  await touchInbound(phone, nowOf(deps));
  if (bad) return handoff(orderId, n, bad, deps);
  return offerFor(orderId, n, line, targets, deps);
}

/** Size only, or a size/colour choice when the product has other colours. */
async function offerFor(orderId, n, line, targets, deps) {
  if (!targets.length) {
    return sess(deps, n.verifiedPhone, 'vc_nothing_available', {
      order_number: n.name,
      item_desc: describeVariant(line.title, currentVariantOf(line)),
    });
  }
  const itemDesc = describeVariant(line.title, currentVariantOf(line));
  const currentColour = colourOfVariant(currentVariantOf(line));
  const lineNum = numOf(line.id);

  if (hasOtherColours(targets, currentColour)) {
    return sess(
      deps,
      n.verifiedPhone,
      'vc_pick_option',
      { item_desc: itemDesc },
      {
        orderId: n.numericId,
        actions: { Size: act('vcos', lineNum), Colour: act('vcoc', lineNum) },
      },
    );
  }
  return sizeList(orderId, n, line, targets, currentColour, deps);
}

/** `vcos:<line>` / `vcoc:<line>` - size or colour. */
export async function onPickOption(orderId, lineNum, which, deps, phone) {
  const { n, line, targets, bad } = await load(orderId, lineNum, deps, phone);
  if (!n) return;
  await touchInbound(phone, nowOf(deps));
  if (bad) return handoff(orderId, n, bad, deps);
  const currentColour = colourOfVariant(currentVariantOf(line));

  if (which === 'colour') {
    const rows = coloursFor(targets, currentColour)
      .slice(0, MAX_ROWS)
      .map(({ colour, variant }) => ({ action: act('vcc', lineNum, numOf(variant.id)), title: colour.slice(0, 24) }));
    if (!rows.length) return sizeList(orderId, n, line, targets, currentColour, deps);
    return sess(
      deps,
      n.verifiedPhone,
      'vc_pick_colour',
      { item_desc: describeVariant(line.title, currentVariantOf(line)) },
      { orderId: n.numericId, rows },
    );
  }
  return sizeList(orderId, n, line, targets, currentColour, deps);
}

/** `vcc:<line>:<variant>` - a colour was chosen; now the size within it. */
export async function onPickColour(orderId, lineNum, varNum, deps, phone) {
  const { n, line, targets, bad } = await load(orderId, lineNum, deps, phone);
  if (!n) return;
  await touchInbound(phone, nowOf(deps));
  if (bad) return handoff(orderId, n, bad, deps);
  // The tapped id names a variant OF the chosen colour; the colour is read back
  // off it rather than carried as a string, which keeps spaces and long names
  // out of the payload entirely.
  const picked = targets.find((v) => numOf(v.id) === String(varNum));
  if (!picked) return handoff(orderId, n, 'unknown-colour', deps);
  return sizeList(orderId, n, line, targets, colourOfVariant(picked), deps);
}

async function sizeList(orderId, n, line, targets, colour, deps) {
  const sizes = sizesFor(targets, colour).slice(0, MAX_ROWS);
  if (!sizes.length) {
    return sess(deps, n.verifiedPhone, 'vc_nothing_available', {
      order_number: n.name,
      item_desc: describeVariant(line.title, currentVariantOf(line)),
    });
  }
  const lineNum = numOf(line.id);
  const rows = sizes.map(({ size, variant }) => ({
    action: act('vcs', lineNum, numOf(variant.id)),
    // The option VALUE only. "Khili Dhoop / Aubergine purple" is 34 characters
    // against a 24 character row title cap.
    title: String(size || variant.title).slice(0, 24),
  }));
  return sess(
    deps,
    n.verifiedPhone,
    'vc_pick_size',
    { item_desc: describeVariant(line.title, currentVariantOf(line)) },
    { orderId: n.numericId, rows },
  );
}

/** `vcs:<line>:<variant>` - the pick. Shows the confirmation; writes nothing. */
export async function onPickSize(orderId, lineNum, varNum, deps, phone) {
  const { n, line, product, bad } = await load(orderId, lineNum, deps, phone);
  if (!n) return;
  await touchInbound(phone, nowOf(deps));
  if (bad) return handoff(orderId, n, bad, deps);

  const target = resolveTarget(line, product, (product?.variants?.nodes || []).find((v) => numOf(v.id) === String(varNum))?.id);
  if (!target) return handoff(orderId, n, 'target-unavailable', deps);

  return sess(
    deps,
    n.verifiedPhone,
    'vc_confirm',
    {
      customer_name: n.firstName,
      order_number: n.name,
      from_desc: describeVariant(line.title, currentVariantOf(line)),
      to_desc: describeVariant(line.title, target),
      order_total: rupees(n.currentTotalPaise),
    },
    {
      orderId: n.numericId,
      actions: { 'Yes, change it': act('vcok', lineNum, numOf(target.id)) },
    },
  );
}

/**
 * `vcok:<line>:<variant>` - the only step that writes.
 *
 * runOnce is keyed by line AND target so a redelivered tap is a no-op while a
 * genuinely different change is still possible. The count is kept separately in
 * flowA state, because runOnce cannot count: it stores one row per action name
 * and returns the first result forever.
 */
export async function onConfirm(orderId, lineNum, varNum, deps, phone) {
  const { n, st, line, product, bad } = await load(orderId, lineNum, deps, phone);
  if (!n) return;
  await touchInbound(phone, nowOf(deps));
  if (bad) return handoff(orderId, n, bad, deps);

  const target = resolveTarget(line, product, (product?.variants?.nodes || []).find((v) => numOf(v.id) === String(varNum))?.id);
  if (!target) return handoff(orderId, n, 'target-unavailable', deps);

  const fromDesc = describeVariant(line.title, currentVariantOf(line));
  const toDesc = describeVariant(line.title, target);

  try {
    const res = await runOnce(orderId, `variant-change:${lineNum}:${varNum}`, async () => {
      const out = await deps.clients.shopify.changeLineItemVariant({
        order: n,
        lineItemId: line.id,
        newVariantId: target.id,
        carryDiscountPaise: line.discountPaise || 0,
        staffNote: `WhatsApp: ${fromDesc} changed to ${toDesc} by the customer`,
      });
      await patchFlowA(orderId, { variantChanges: (st?.flowA?.variantChanges || 0) + 1 });
      return out;
    });

    if (res?.drifted) {
      await ownerAlert(
        deps,
        n.name,
        `URGENT: a size or colour change committed but the total moved. Was ${rupees(n.currentTotalPaise)}, ` +
          `order now reads ${res.currentTotal} with ${res.outstanding} outstanding. Check this order by hand`,
      );
    }
    await soft('tagsAdd:wa-variant-changed', () => deps.clients.shopify.tagsAdd(n.gid, ['wa-variant-changed']), { orderId });
    await ownerAlert(deps, n.name, `customer changed ${fromDesc} to ${toDesc} themselves. Pack the new one`);

    // Read the order back so the total quoted is the order's own, not ours.
    const fresh = (await getNorm(deps, orderId)) || n;
    return sess(deps, n.verifiedPhone, 'vc_changed', {
      order_number: n.name,
      to_desc: toDesc,
      order_total: rupees(fresh.currentTotalPaise),
    });
  } catch (e) {
    log.error('variantChange: apply failed', { orderId, err: e.message });
    return handoff(orderId, n, `apply-failed: ${e.message}`.slice(0, 120), deps);
  }
}

/**
 * Router for every vc* action.
 *
 * Returns a promise when the action is ours, or null when it is not, so the
 * caller can fall through to its own handlers. With the flag off it swallows
 * the tap rather than falling through, because the payload IS ours and falling
 * through would reach routeFlowATap's unknown-action log instead.
 */
const STEPS = {
  vc: (orderId, _a, _b, deps, phone) => onStart(orderId, deps, phone),
  vcl: (orderId, a, _b, deps, phone) => onPickLine(orderId, a, deps, phone),
  vcos: (orderId, a, _b, deps, phone) => onPickOption(orderId, a, 'size', deps, phone),
  vcoc: (orderId, a, _b, deps, phone) => onPickOption(orderId, a, 'colour', deps, phone),
  vcc: (orderId, a, b, deps, phone) => onPickColour(orderId, a, b, deps, phone),
  vcs: (orderId, a, b, deps, phone) => onPickSize(orderId, a, b, deps, phone),
  vcok: (orderId, a, b, deps, phone) => onConfirm(orderId, a, b, deps, phone),
};

export function route(orderId, action, deps, phone) {
  const [step, a, b] = String(action || '').split(':');
  const fn = STEPS[step];
  if (!fn) return null; // not one of ours
  if (!config.variantChangeEnabled) {
    log.info('variantChange: disabled, ignoring tap', { orderId, action });
    return Promise.resolve();
  }
  return fn(orderId, a, b, deps, phone);
}

export const MAX_PER_ORDER = RULES.variantChangeMaxPerOrder;
