/*
 * replace.run.mjs — /replace: a replacement is two courier parcels and no
 * Shopify edit at all.
 *
 * The owner types `/replace #1234 noor m xl`, gets a preview with Confirm and
 * Cancel, and on Confirm we book a reverse pickup of what the customer has, a
 * prepaid forward parcel of what they should have had, message the customer
 * once BOTH exist, and report both waybills back. The money was collected on
 * the original order and the replacement goes out at our cost, so there is no
 * Shopify-side truth to update: nothing here creates, edits, tags, notes,
 * refunds, fulfils or re-stocks anything. That is what keeps the feature
 * reversible, because the only thing to undo is a courier shipment.
 *
 * THE RETURN LEG GOES FIRST, ALWAYS. It is the leg that is correct regardless
 * of what happens next: the customer has the wrong item either way. So if the
 * forward leg fails we KEEP the return, set FAILED, and tell the admin the
 * pickup is already booked and which command fixes it.
 *
 * EVERY STEP PERSISTS BEFORE THE NEXT ONE STARTS, so a re-run resumes at the
 * first incomplete step rather than repeating a booked parcel. Each leg is its
 * own runOnce action keyed by leg and sequence, with the whole irreversible
 * call inside it and nothing else, because runOnce records nothing when its
 * function throws and that is exactly what makes a half-finished execution
 * safe to resume.
 *
 * ONE REPLACEMENT MUST NEVER BECOME TWO PARCELS. References are deterministic
 * (<order>-REPLACE-<seq>R / F) and on a duplicate reference, or an outcome that is
 * merely ambiguous (a timeout or a 5xx AFTER the request went out), we look the
 * shipment up by reference and ADOPT it. A blind retry is how one replacement
 * becomes two.
 *
 * Shadow is the DEFAULT mode and performs zero provider writes and zero
 * customer sends: it describes exactly what it would have created. A deploy
 * that forgets REPLACE_MODE is safe. See DECISIONS.md section T.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { log, metric, maskPhone } from '../log.mjs';
import { soft, withRetry, maybeSent } from '../lib/resilience.mjs';
import { formatIST } from '../lib/time.mjs';
import { classify } from '../domain/classify.mjs';
// "Noor, size M" / "Bandhan, Brown, size XL". The same words the self-service
// size change already puts in front of a customer, so the two features do not
// describe the same garment two different ways.
import { describeVariant } from '../domain/variantChange.mjs';
import { getState, runOnce } from '../store/orderState.mjs';
import { windowOpen, isOptedOut, isUndeliverable } from '../store/phoneProfile.mjs';
import { sess, tpl, isTemplateUnusable, getNormByName } from './send.mjs';
import * as store from '../store/replace.mjs';
import { parseReplaceCommand, resolveLine, resolveTarget, validate } from '../domain/replace.mjs';

const R = RULES.replace;
const nowOf = (deps) => deps.now || new Date();

/** The flow letter in the button payload. No other flow uses P. */
const FLOW = 'P';

/**
 * Meta's interactive body cap. A text message gets 4096 characters, a message
 * WITH BUTTONS gets 1024, and a preview carrying a full address, two swaps and
 * two freight quotes goes past that. Over the cap the detail is sent as text
 * first and the buttons follow on a short question.
 */
const BUTTONS_BODY_MAX = 1024;

/**
 * A six digit nonce, stored on the request and required by the tap.
 *
 * Payloads are unsigned clear text and decodePayload splits on '|' into exactly
 * four parts, so an id may not contain one; numeric ids are the convention here
 * (see ids.mjs). Six digits against an admin-phone-only gate is plenty: this
 * exists to stop a STALE preview being tapped, not to resist an attacker who
 * would first have to be an admin.
 */
const nonce = () => String(randomBytes(4).readUInt32BE(0) % 1e6).padStart(6, '0');

/**
 * The states where nothing can be in flight, so there is nothing to call off.
 * DONE is not one of them: both parcels exist and are still moving.
 */
const CLOSED = new Set(['REJECTED', 'EXPIRED', 'CANCELLED']);

const act = (step, seq, nce) => `${step}:${seq}:${nce}`;
const bare = (name) => String(name || '').trim().replace(/^#/, '');
const rupees = (inr) => `Rs ${Number(inr || 0).toLocaleString('en-IN')}`;

/**
 * The reference Delhivery files the shipment under: 1234-REPLACE-1R.
 *
 * The ORDER NUMBER LEADS, so typing 1234 into Delhivery One's search turns up
 * the original delivery and both replacement legs together. The old RPL1234-1R
 * put the prefix first, which read as a machine id and sorted all replacements
 * away from the orders they belong to.
 *
 * The seq and the leg letter are not decoration and must not be dropped. Two
 * legs booked under one reference would collide, and the collision is not
 * harmless: bookLeg answers a duplicate-reference refusal by calling findByRef
 * and ADOPTING whatever shipment comes back, so a shared reference could staple
 * the return waybill onto the forward leg. The seq does the same job for a
 * second replacement on the same order via `again`.
 *
 * Letters, digits and hyphens only. That is exactly the alphabet of
 * RPL1222-1R, which is the one reference this endpoint has actually accepted
 * (2026-10-23), and Delhivery publishes no spec for cmu/create.json to tell us
 * whether an underscore or a longer field would be taken. Readability is worth
 * a change; re-opening a question we just closed by experiment is not.
 */
const refFor = (orderName, seq, leg) => `${bare(orderName)}-REPLACE-${seq}${leg}`;

/**
 * Who may run the command. `replaceAdminPhones` when it is set, otherwise the
 * owner alert phones, so there is one list to maintain until a second person
 * genuinely needs the command. Exported because worker/index.mjs gates the
 * command and the tap on exactly this, and two copies of an admission rule is
 * one copy too many.
 */
export function isReplaceAdmin(phone) {
  const admins = config.replaceAdminPhones.length ? config.replaceAdminPhones : config.ownerAlertPhones;
  return admins.includes(phone);
}

/**
 * Answer the ONE admin who typed the command. Never ownerAlert.
 *
 * ownerAlert loops every owner phone, which for a reply to a question one
 * person asked means telling everybody else about it too. soft() because a
 * failed reply must never fail the command, and the owner gets an answer on
 * every branch because a command that fails silently is worse than no command.
 *
 * Free-form while their window is open, which on the command path it always is:
 * they just wrote to us. The template is the fallback for a reply that lands
 * later, and ops_alert flattens newlines (sanitizeParam), so the long previews
 * only ever go out free-form.
 */
function replier(deps, phone, orderName) {
  return (text) =>
    soft('replaceAdminReply', async () => {
      if (await windowOpen(phone, nowOf(deps))) return sess(deps, phone, 'ops_reply', { text });
      return tpl(deps, phone, 'ops_alert', { order_number: orderName || 'replace', alert_text: text }, {});
    }, {});
}

const HELP = [
  'What I understand:',
  '',
  '/replace 1234 noor m xl',
  'Books a reverse pickup of the size M and sends size XL instead.',
  '',
  '/replace status 1234',
  '/replace cancel 1234',
  '/replace retry 1234',
  '/replace list',
].join('\n');

// ---- loading ----------------------------------------------------------------

/**
 * Everything a command needs, re-derived from scratch every time.
 *
 * Deliberately re-read on every tap rather than trusted from the preview:
 * stock, payment and the courier all move between two taps, and a preview that
 * is minutes old has already been wrong once.
 */
async function load(orderName, deps) {
  /*
   * getNormByName, not getOrderByName: it runs the same recipient resolver
   * Flows A, B and C use. This read ONE field for the customer's number, so a
   * recovery-link or admin order had no recipient here and /replace booked
   * both parcels and told the customer nothing at all.
   */
  const n = await getNormByName(deps, bare(orderName));
  if (!n) return { missing: true };
  const st = (await getState(n.numericId)) || {};
  const shipping = await deps.clients.shopify.getShippingDetails(n.numericId);
  return { n, st, shipping };
}

/**
 * Was this order delivered, and when.
 *
 * The COURIER STATUS is the delivery record. `flowB.deliveredAt` is not: it is
 * written as a side effect of scheduling the review ask, so it only exists when
 * that ask was actually scheduled. onDelivered returns before writing it when
 * Flow B is off, when the review ask is off, when the order has a skip reason,
 * when there is no OTP verified phone, when a review was already asked or left,
 * or when a real delivery had already scheduled one.
 *
 * Reading that field alone therefore answered "has the courier confirmed this
 * as delivered?" with Flow B's bookkeeping. On 19 of the 41 delivered orders in
 * the table the answer was no while courierStatus said DELIVERED, and each of
 * those was soft refused with a reason that was not true. #1213 is one: it has
 * no verified phone, so onDelivered took that exit and left nothing behind.
 *
 * track-active writes courierStatus on every status change and nothing else
 * moves it, and reconcile already treats it as the authority for the same fact.
 *
 * The time comes back ONLY when the delivery did, because courierStatusAt is
 * the last status change whatever that status was: reading it off an IN_TRANSIT
 * row would have handed validate a transit timestamp to measure the
 * replacement window against. Older rows carry no courierStatusAt at all, so a
 * confirmed delivery with a null time is a real and expected shape.
 */
function deliveryOf(st) {
  const byCourier = String(st?.courierStatus || '').toUpperCase() === 'DELIVERED';
  const at = st?.flowB?.deliveredAt || (byCourier ? st?.courierStatusAt : null) || null;
  return { confirmed: byCourier || Boolean(st?.flowB?.deliveredAt), at };
}

const hsnFor = (handle) => R.hsnByHandle[handle] || R.hsn;
const parcelFor = (handle) => R.parcelByHandle[handle] || R.parcel;

const wordsOf = (swap) => swap?.productWords || [];

/**
 * Turn each parsed swap into a line and a target variant.
 *
 * A swap whose TARGET will not resolve is kept, carrying its reason, because
 * validate() has the words for every one of those and refusing in two places
 * would mean two vocabularies for the same refusal. A swap whose LINE will not
 * resolve returns early instead: only here do we still have the words the owner
 * typed and the candidate titles, which is the one answer validate cannot give.
 */
async function resolveSwaps(n, shipping, swaps, deps) {
  // resolveLine matches on title, options, handle and sku, and only the
  // NORMALIZED lines carry the first three: getShippingDetails selects ids,
  // quantities and skus. So the match runs on the order and the sku is read
  // back off the shipping line by id.
  const skuOf = (id) => (shipping?.lines || []).find((l) => String(l.id) === String(id))?.sku || '';
  const out = [];
  for (const swap of swaps) {
    const hit = resolveLine(n.lineItems, wordsOf(swap));
    if (!hit?.line) return { problem: { swap, candidates: hit?.candidates, none: hit?.none } };

    const li = hit.line;
    const product = li.productGid ? await deps.clients.shopify.getProductVariants(li.productGid) : null;
    // The whole product, not its variant array: resolveTarget reads the Size
    // option block off it and hands the product back on a hit.
    const target = resolveTarget({ line: li, swap, variants: product, catalog: null });
    out.push({
      swap,
      line: li,
      sku: skuOf(li.id),
      variant: target?.variant || null,
      product: target?.product || product,
      reason: target?.variant ? null : target?.reason || 'unresolved',
      qty: Math.min(Number(swap?.qty) || 1, Number(li.quantity) || 1),
    });
  }
  return { resolved: out };
}

// ---- the two shipment specs -------------------------------------------------

/**
 * Build both specs. NO COD FIELD EXISTS: a replacement is prepaid by
 * construction and a field that cannot be set correctly is better absent than
 * defaulted.
 */
function specsFor({ n, shipping, resolved, seq }) {
  const a = shipping.address;
  const customer = {
    name: a.name,
    phone: a.phone,
    address1: a.address1,
    address2: a.address2,
    city: a.city,
    state: a.state,
    pin: a.pin,
    country: a.country,
  };
  const item = (r, which) => {
    const fwd = which === 'forward';
    // What the customer HAS for the reverse leg, what they should have had for
    // the forward one. The line's own options describe the first; only the
    // target variant describes the second.
    const self = fwd ? r.variant : { selectedOptions: r.line.selectedOptions };
    return {
      sku: (fwd ? r.variant.sku : r.sku) || r.sku || '',
      name: describeVariant(r.line.title, self),
      qty: r.qty,
      // The declared value is what the goods are worth. The variant's own price
      // for the new one, what the customer actually paid for the old one.
      unitValueInr: fwd && r.variant.price != null ? Number(r.variant.price) : r.line.unitPaise / 100,
      hsn: hsnFor(r.line.productHandle),
    };
  };
  const build = (which, leg) => {
    const items = resolved.map((r) => item(r, which));
    const parcel = parcelFor(resolved[0]?.line?.productHandle);
    return {
      ref: refFor(n.name, seq, leg),
      invoiceRef: n.name,
      customer,
      items,
      parcel: { ...parcel, weightGrams: parcel.weightGrams * items.reduce((s, i) => s + i.qty, 0) },
      // Surface, never express: a replacement is not an emergency and the
      // forward leg is left Ready to Ship rather than pickup-requested.
      mode: 'surface',
      declaredValueInr: items.reduce((s, i) => s + i.qty * i.unitValueInr, 0),
    };
  };
  return { returnSpec: build('return', 'R'), forwardSpec: build('forward', 'F') };
}

// ---- the preview ------------------------------------------------------------

function previewText({ n, st, shipping, resolved, reason, pays, serviceability, quotes, warnings, confirmBy }) {
  const a = shipping.address;
  const lines = [
    `Replacement for ${n.name}`,
    '',
    `${a.name || n.firstName}, ${maskPhone(a.phone || n.verifiedPhone)}`,
    [a.address1, a.address2, a.city, a.state, a.pin, a.country].filter(Boolean).join(', '),
    '',
  ];
  for (const r of resolved) {
    const from = describeVariant(r.line.title, { selectedOptions: r.line.selectedOptions });
    const to = describeVariant(r.line.title, r.variant);
    lines.push(`${r.qty} x ${from} goes back, ${to} goes out`);
  }
  lines.push('');
  lines.push(`Paid as: ${st.class || classify(n)}`);
  lines.push(`Reason: ${reason}`);
  lines.push(`Freight paid by: ${pays}`);
  /*
   * No answer is NOT a no. Either leg coming back unserviceable is a hard stop,
   * so a preview exists only when the courier said yes to both or was never
   * reached, which means a printed NO could only ever have meant "the pin check
   * failed". Reading that as a refusal is how a perfectly serviceable pin gets
   * abandoned, and the owner cannot tell the two apart from a yes/NO line.
   */
  lines.push(
    serviceability
      ? `Pincode ${a.pin}: reverse pickup ${serviceability.reversePickup ? 'yes' : 'NO'}, ` +
          `prepaid delivery ${serviceability.prepaidDelivery ? 'yes' : 'NO'}${serviceability.oda ? ', out of delivery area' : ''}`
      : `Pincode ${a.pin}: the courier did not answer the pin check, so neither leg is confirmed serviceable.`,
  );
  lines.push(
    `Freight: pickup ${quotes.ret == null ? 'quote unavailable' : rupees(quotes.ret)}, ` +
      `delivery ${quotes.fwd == null ? 'quote unavailable' : rupees(quotes.fwd)}`,
  );
  for (const w of warnings) lines.push(`Note: ${w.message}`);
  lines.push('');
  lines.push(`Confirm by ${formatIST(confirmBy)} IST or this preview goes stale.`);
  return lines.join('\n');
}

// ---- the command ------------------------------------------------------------

/**
 * `/replace ...` typed by an admin into the business number.
 *
 * Parses, resolves and validates, then either sends the preview or, with a
 * trailing `!` and REPLACE_ALLOW_SKIP_CONFIRM on, executes straight away.
 */
export async function onOwnerRequest(text, deps, adminPhone) {
  const reply = replier(deps, adminPhone);
  if (!isReplaceAdmin(adminPhone)) {
    // Nothing is sent back. An unrecognised phone is told nothing about what
    // this number can do.
    return log.warn('replace: command from a phone that is not an admin', { phone: maskPhone(adminPhone) });
  }
  if (config.replaceMode === 'off') return reply('The replacement command is switched off right now.');

  /*
   * The WHOLE command, slash included: parseReplaceCommand matches the alias
   * itself (/replace, /replace-order, /rp), which is also what makes one parser
   * answer all three spellings.
   */
  const raw = String(text || '').trim();
  const parsed = parseReplaceCommand(raw) || {};
  if (parsed.error) return reply(`${parsed.error}\n\n${HELP}`);

  const verb = parsed.verb || 'help';
  if (verb === 'list') return onList(deps, adminPhone);
  if (verb === 'status') return onStatus(parsed.orderName, deps, adminPhone);
  if (verb === 'cancel') return onCancel(parsed.orderName, deps, adminPhone);
  if (verb === 'retry') return onRetry(parsed.orderName, deps, adminPhone);
  // A bare /replace, and anything the parser could not place, is a request for
  // the help text rather than an error: it is the only reply that teaches.
  if (verb !== 'create') return onHelp(deps, adminPhone);

  return startRequest(raw, parsed, deps, adminPhone);
}

async function startRequest(raw, parsed, deps, adminPhone) {
  const reply = replier(deps, adminPhone);
  const asked = parsed.orderName;
  /*
   * Every refusal leaves a line behind, carrying the order number and a code.
   *
   * It used to leave none. Only "request raised" was logged, so a command that
   * refused was indistinguishable in CloudWatch from one that was never typed:
   * the owner's four /replace attempts on 22 Oct showed up as four "owner
   * command" lines, four sends, and nothing about which order or why. Working
   * out that they had been refused for a delivery the courier HAD confirmed
   * took reading the state rows of nine orders by hand.
   *
   * Codes and the order number only. The reply text names the customer's
   * address; the log never does.
   */
  const refuse = (code, text) => {
    log.info('replace: refused', { order: asked ? bare(asked) : null, code });
    return reply(text);
  };
  if (!asked) return refuse('no-order-number', `Send it with the order number, like /replace 1234 noor m xl\n\n${HELP}`);

  const { missing, n, st, shipping } = await load(asked, deps);
  if (missing) return refuse('order-not-found', `No order #${bare(asked)} here. Check the number and send it again.`);
  if (!shipping) return refuse('order-gone', `Order ${n.name} has gone from Shopify, so there is nothing to read an address from.`);
  if (shipping.scopeProblem) {
    return refuse(
      'shipping-scope',
      `Order ${n.name}: Shopify refused the address query, which is a PERMISSIONS problem and not a typo ` +
        `(${shipping.error || 'access denied'}). The app needs protected customer data approval before /replace can book anything.`,
    );
  }
  if (!shipping.address) return refuse('no-shipping-address', `Order ${n.name} has no shipping address on it, so there is nowhere to send a courier.`);

  /*
   * The preview is a buttons message, and there is no approved template that
   * could carry our Confirm payload, so a closed window means the question
   * cannot be asked at all. Checked here rather than left to fail at Meta,
   * where it would throw, redeliver the record and raise a fresh preview on
   * every one of the five attempts. The reply itself still lands, through
   * ops_alert.
   */
  if (config.replaceRequireConfirm && !(await windowOpen(adminPhone, nowOf(deps)))) {
    return refuse(
      'admin-window-closed',
      `Order ${n.name}: our 24 hour window with this number has closed, so WhatsApp will not let us send you ` +
        'the Confirm buttons. Send any message here first, then run the command again.',
    );
  }

  /*
   * One execution per order at a time, taken BEFORE the preview is written.
   * A second command racing the first would otherwise both read the same
   * sequence and one of the two previews would be lost. The lease expires on
   * its own, so a worker killed mid-execution cannot block the order for good.
   */
  const now = nowOf(deps);
  const until = new Date(now.getTime() + R.confirmMinutes * 60 * 1000);
  if (!(await store.acquireLock(n.numericId, { until, now, by: 'command' }))) {
    return refuse('locked', `Order ${n.name} already has a replacement running. Wait for it to finish, then /replace status ${bare(n.name)}`);
  }

  try {
    const swaps = parsed.swaps || [];
    if (!swaps.length) return refuse('no-swap', `Tell me what to swap, like /replace ${bare(n.name)} noor m xl`);

    const { resolved, problem } = await resolveSwaps(n, shipping, swaps, deps);
    if (problem) return refuse('line-unresolved', resolveProblemText(n, problem));

    const api = deps.clients.logistics;
    const pin = shipping.address.pin;
    const serviceability = await soft('replaceServiceability', () => api.serviceability(pin), {});

    const flags = parsed.flags || {};
    const existing = await store.latestRequest(n.numericId);
    /*
     * What this order has already had replaced, per line. validate() needs it
     * to refuse a quantity above what was bought, and `again` is exactly the
     * case where that matters: it clears the "one already open" stop, so this
     * total is the only thing left standing between a two-piece order and a
     * third replacement parcel.
     */
    const already = await store.replacedByLine(n.numericId);
    for (const r of resolved) r.alreadyReplaced = already[r.line.id] || 0;
    const customerPhone = n.verifiedPhone;
    const declaredValueInr = resolved.reduce(
      (s, r) => s + r.qty * Math.max(r.line.unitPaise / 100, Number(r.variant?.price) || 0),
      0,
    );
    const v = validate({
      n,
      st,
      shipping,
      resolved,
      flags,
      serviceability,
      delivered: deliveryOf(st),
      /*
       * A VIEW of the previous request, not the row. validate speaks `status`
       * and `lineIds`; this store speaks `state` and keeps the parsed swaps.
       * One expression here is cheaper than a duplicate field on every record,
       * and it is the only place the two vocabularies have to meet.
       */
      existing: existing
        ? { status: existing.state, lineIds: existing.lineIds || [], confirmBy: existing.confirmBy || null }
        : null,
      courierAwb: n.delhiveryAwb || st.awb || null,
      declaredValueInr,
      testOrders: config.replaceTestOrders,
      // The mode, because REPLACE_TEST_ORDERS is an allowlist for LIVE bookings
      // only: shadow writes nothing, so a rehearsal stays runnable on any order.
      mode: config.replaceMode,
      configPresent: {
        pickupLocation: Boolean(config.delhiveryPickupLocation),
        gstin: Boolean(config.sellerGstin),
        // Per LINE, because hsnByHandle can cover one garment and not the next.
        hsn: resolved.length > 0 && resolved.every((r) => Boolean(hsnFor(r.line.productHandle))),
      },
      customer: {
        verifiedPhone: customerPhone,
        optedOut: customerPhone ? await isOptedOut(customerPhone) : false,
        undeliverable: customerPhone ? await isUndeliverable(customerPhone) : false,
      },
      // The WHOLE rules object: validate reaches for `rules.replace` itself.
      rules: RULES,
      now,
    }) || { stops: [], warnings: [] };

    /*
     * The orchestrator owns the policy and the domain owns the codes: a hard
     * stop refuses, a soft stop refuses until `force`, warnings are printed and
     * never block. Nothing here branches on an individual code by name, which
     * is why a new check needs no change in this file.
     */
    const stops = (v.stops || []).filter((s) => s.kind === 'hard' || !flags.force);
    if (stops.length) {
      const hard = stops.some((s) => s.kind === 'hard');
      log.info('replace: refused', { order: bare(n.name), codes: stops.map((s) => `${s.kind}:${s.code}`) });
      return reply(
        `Order ${n.name} cannot take a replacement:\n\n` +
          stops.map((s) => `${s.message}`).join('\n') +
          (hard ? '' : '\n\nAdd force to the end of the command if you want it anyway.'),
      );
    }

    const warnings = v.warnings || [];
    const seqPeek = (Number(existing?.seq) || 0) + 1;
    const { returnSpec, forwardSpec } = specsFor({ n, shipping, resolved, seq: seqPeek });
    const from = config.replaceReturnTo.pin || '';
    const quotes = {
      ret: await quoteLeg(api, { fromPin: pin, toPin: from, leg: 'return', spec: returnSpec, deps }),
      fwd: await quoteLeg(api, { fromPin: from, toPin: pin, leg: 'forward', spec: forwardSpec, deps }),
    };

    const nce = nonce();
    const req = await store.createRequest(
      n.numericId,
      {
        orderName: n.name,
        adminPhone,
        command: raw,
        nonce: nce,
        swaps,
        // The lines this replacement is about. Kept flat because the next
        // command's validate() asks whether an open request already covers the
        // same garment, and it asks by line id.
        lineIds: resolved.map((r) => r.line.id),
        /*
         * Per line, so the next command can total it without assuming `swaps`
         * and `lineIds` stayed index aligned through a retry or an edit.
         */
        replacedQty: resolved.reduce((m, r) => ({ ...m, [r.line.id]: (m[r.line.id] || 0) + r.qty }), {}),
        flags,
        reason: flags.reason,
        pays: flags.pays,
        paidAs: st.class || classify(n),
        // The minimum snapshot a retry or a cancel needs, so neither has to
        // re-read protected customer data to finish or undo a booking.
        customer: returnSpec.customer,
        verifiedPhone: n.verifiedPhone || null,
        /*
         * WHICH field the recipient came from: 'otp', or shipping, billing or
         * the customer record through the resolver. An owner asking "whose
         * number did we message about this replacement" gets an answer rather
         * than a guess, and it is the one field that says this request was
         * booked for an order COD King never touched.
         */
        phoneSource: n.phoneSource || null,
        customerName: n.firstName,
        items: { return: returnSpec.items, forward: forwardSpec.items },
        parcel: returnSpec.parcel,
        declaredValueInr: forwardSpec.declaredValueInr,
        returnRef: returnSpec.ref,
        forwardRef: forwardSpec.ref,
        quoteReturnInr: quotes.ret,
        quoteForwardInr: quotes.fwd,
        serviceability: serviceability || null,
        warnings,
        describe: {
          returnItem: describeItems(returnSpec.items),
          newItem: describeItems(forwardSpec.items),
        },
        confirmBy: new Date(now.getTime() + R.confirmMinutes * 60 * 1000).toISOString(),
      },
      now,
    );

    log.info('replace: request raised', {
      orderId: n.numericId,
      order: n.name,
      seq: req.seq,
      mode: config.replaceMode,
      swaps: swaps.length,
    });
    metric('ReplaceRequested', 1, { mode: config.replaceMode });

    const body = previewText({
      n, st, shipping, resolved,
      reason: req.reason,
      pays: req.pays,
      serviceability,
      quotes,
      warnings,
      confirmBy: new Date(req.confirmBy),
    });

    /*
     * A trailing `!` skips the preview, and ONLY when
     * REPLACE_ALLOW_SKIP_CONFIRM says it may: the owner typing it is a request,
     * not a permission. The preview still goes out, it just goes out as a
     * record of what is being booked rather than as a question.
     */
    const skip = flags.skipConfirm && config.replaceAllowSkipConfirm;
    if (skip || !config.replaceRequireConfirm) {
      await reply(body);
      return execute(n.numericId, req.seq, deps, adminPhone, { holdsLock: true });
    }

    await sendPreview(deps, adminPhone, n, req, body);
    return { state: req.state, seq: req.seq };
  } finally {
    // The preview is confirmed by a LATER tap, which takes the lease again, so
    // the command must not sit on it while it waits.
    await soft('replaceReleaseLock', () => store.releaseLock(n.numericId), { orderId: n.numericId });
  }
}

/** The detail, then the buttons. One message when it fits, two when it does not. */
async function sendPreview(deps, adminPhone, n, req, body) {
  const actions = {
    Confirm: act('rpok', req.seq, req.nonce),
    Cancel: act('rpno', req.seq, req.nonce),
  };
  const short = `Book this replacement for ${n.name}?`;
  const fits = body.length + short.length < BUTTONS_BODY_MAX;
  if (!fits) await soft('replacePreviewDetail', () => sess(deps, adminPhone, 'ops_reply', { text: body }), {});
  return sess(
    deps,
    adminPhone,
    'replace_confirm',
    { text: fits ? `${body}\n\n${short}` : short },
    { orderId: n.numericId, actions },
  );
}

function resolveProblemText(n, p) {
  const what = wordsOf(p.swap).join(' ') || 'that item';
  if (p.candidates?.length) {
    const names = p.candidates.map((c) => c.title || c.name || String(c)).join(', ');
    return `Order ${n.name}: "${what}" matches more than one thing (${names}). Name it more exactly and send it again.`;
  }
  if (p.none) return `Order ${n.name} has nothing on it matching "${what}".`;
  return `Order ${n.name}: cannot work out what to send instead of "${what}" (${p.reason || 'no match'}).`;
}

async function quoteLeg(api, { fromPin, toPin, leg, spec, deps }) {
  if (!api?.capabilities?.quote || !fromPin || !toPin) return null;
  const q = await soft(`replaceQuote:${leg}`, () =>
    api.quote({ fromPin, toPin, weightGrams: spec.parcel.weightGrams, mode: spec.mode, leg }), {});
  return q?.amountInr ?? null;
}

const describeItems = (items) =>
  items.map((i) => `${i.name}${i.qty > 1 ? ` x ${i.qty}` : ''}`).join(', ');

// ---- execution --------------------------------------------------------------

/**
 * Book one leg, adopting an existing shipment rather than retrying blind.
 *
 * withRetry is NOT idempotent here on purpose: a connection reset after the
 * request went out may already have booked a parcel, so those errors are not
 * retried at all. They are resolved by looking the reference up instead, which
 * is the only answer that cannot produce a second parcel.
 */
async function bookLeg(api, leg, spec) {
  const call = leg === 'R' ? 'createReverse' : 'createForward';
  try {
    return await withRetry(`replace:${call}`, () => api[call](spec), { attempts: 3, baseMs: 300 });
  } catch (e) {
    const err = /** @type {any} */ (e);
    const ambiguous = err.duplicate === true || maybeSent(err);
    if (!ambiguous || !api.capabilities?.findByRef) throw err;
    const found = await api.findByRef(spec.ref);
    if (!found?.awb) throw err;
    log.warn('replace: adopted an existing shipment instead of booking a second', {
      leg, ref: spec.ref, awb: found.awb, why: err.duplicate ? 'duplicate' : 'ambiguous', err: err.message,
    });
    metric('ReplaceAdopted', 1, { leg });
    return { ...found, ref: spec.ref, adopted: true };
  }
}

/**
 * Confirm: book the return, book the forward, message the customer, report.
 *
 * Resumable at every boundary. Called by the Confirm tap, by `/replace retry`
 * and by a `!` command, and all three land on the same first incomplete step.
 */
export async function execute(orderId, seqIn, deps, adminPhone, { holdsLock = false } = {}) {
  const now = nowOf(deps);
  // A tap payload carries the sequence as a STRING. Coerced once, here, so the
  // records this writes are not half numbers and half digits.
  const seq = Number(seqIn);
  let req = await store.getRequest(orderId, seq);
  if (!req) return { skipped: 'no-request' };
  const reply = replier(deps, adminPhone, req.orderName);
  const ordNum = bare(req.orderName);

  if (!holdsLock) {
    const until = new Date(now.getTime() + R.confirmMinutes * 60 * 1000);
    if (!(await store.acquireLock(orderId, { until, now, by: 'execute' }))) {
      await reply(`Order ${req.orderName} already has a replacement running. Try /replace status ${ordNum} in a minute.`);
      return { skipped: 'locked' };
    }
  }

  try {
    if (req.state === 'AWAITING_CONFIRMATION') {
      req = await store.patchRequest(orderId, seq, { state: 'CONFIRMED', confirmedAt: now.toISOString() });
    }

    const { returnSpec, forwardSpec } = specsFromRequest(req);

    /*
     * Shadow: zero provider writes, zero customer sends. The specs are built
     * first anyway, so the log line and the reply describe the REAL payload
     * rather than a summary of one, which is the only way a shadow run proves
     * anything about the shape we would send.
     */
    if (config.replaceMode !== 'live') {
      return shadowFinish(orderId, seq, req, { returnSpec, forwardSpec }, deps, reply, 'shadow');
    }

    if (!req.returnAwb) {
      const res = await step(orderId, seq, 'return', req, reply, ordNum, () =>
        runOnce(orderId, `replace:${seq}:R`, () => bookLeg(deps.clients.logistics, 'R', returnSpec)));
      if (res.failed) return res;
      if (!res.value?.awb && res.value?.skipped) {
        return shadowFinish(orderId, seq, req, { returnSpec, forwardSpec }, deps, reply, res.value.skipped);
      }
      await store.setReplAwb(res.value.awb, { orderId: String(orderId), seq, leg: 'return' }, now);
      req = await store.patchRequest(orderId, seq, {
        state: 'RETURN_CREATED',
        returnAwb: res.value.awb,
        returnStatus: res.value.status || null,
        returnAdopted: Boolean(res.value.adopted),
        returnCreatedAt: now.toISOString(),
      });
    }

    if (!req.forwardAwb) {
      const res = await step(orderId, seq, 'forward', req, reply, ordNum, () =>
        runOnce(orderId, `replace:${seq}:F`, () => bookLeg(deps.clients.logistics, 'F', forwardSpec)));
      if (res.failed) return res;
      if (!res.value?.awb && res.value?.skipped) {
        return shadowFinish(orderId, seq, req, { returnSpec, forwardSpec }, deps, reply, res.value.skipped);
      }
      await store.setReplAwb(res.value.awb, { orderId: String(orderId), seq, leg: 'forward' }, now);
      req = await store.patchRequest(orderId, seq, {
        state: 'FORWARD_CREATED',
        forwardAwb: res.value.awb,
        forwardStatus: res.value.status || null,
        forwardAdopted: Boolean(res.value.adopted),
        forwardCreatedAt: now.toISOString(),
      });
    }

    // Only now, with both parcels booked. A pickup notice with no replacement
    // on the way is worse than silence.
    const notified = await runOnce(orderId, `replace:${seq}:notify`, () => notifyCustomer(deps, req, orderId));
    req = await store.patchRequest(orderId, seq, {
      state: 'CUSTOMER_NOTIFIED',
      notified,
      notifiedAt: now.toISOString(),
    });

    const labelUrl = config.replaceSendLabel ? await labelFor(deps, req.returnAwb) : null;
    req = await store.patchRequest(orderId, seq, { state: 'DONE', labelUrl, doneAt: now.toISOString() });

    log.info('replace: done', { orderId, seq, order: req.orderName });
    metric('ReplaceBooked', 1, { mode: 'live' });

    await reply(
      [
        `Booked for ${req.orderName}.`,
        `Pickup waybill ${req.returnAwb}`,
        `Delivery waybill ${req.forwardAwb}`,
        labelUrl ? `Label: ${labelUrl}` : 'Label: not available from the courier',
        notifyLine(notified),
        `Nothing in Shopify was changed. /replace status ${ordNum} reads the courier directly.`,
      ].join('\n'),
    );
    return { state: 'DONE', seq, returnAwb: req.returnAwb, forwardAwb: req.forwardAwb, notified };
  } finally {
    await soft('replaceReleaseLock', () => store.releaseLock(orderId), { orderId });
  }
}

/**
 * Run one leg and turn a failure into FAILED plus the exact next command.
 *
 * A permanent error carries the provider's remark verbatim: the fix is almost
 * always something only the owner can do in the courier's dashboard, and our
 * paraphrase of it would be one more thing to disbelieve.
 */
async function step(orderId, seq, which, req, reply, ordNum, fn) {
  try {
    return { value: await fn() };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const remark = err.remark || err.message;
    await store.patchRequest(orderId, seq, {
      state: 'FAILED',
      failedStep: which,
      error: String(remark).slice(0, 300),
      permanent: Boolean(err.permanent),
    });
    // WARN, not ERROR: this is a handled outcome that has already been reported
    // to the person who can act on it, and a level:"error" line emails the
    // owner an incident describing an automatic retry that is not happening.
    log.warn('replace: leg failed', { orderId, seq, step: which, permanent: Boolean(err.permanent), err: err.message });
    metric('ReplaceFailed', 1, { step: which });

    const fix = err.permanent
      ? `The courier said: ${remark}. Fix that, then /replace retry ${ordNum}`
      : `The courier did not answer: ${remark}. Try /replace retry ${ordNum}`;
    await reply(
      which === 'forward'
        ? [
            `${req.orderName}: the RETURN PICKUP IS ALREADY BOOKED (waybill ${req.returnAwb}) but the replacement parcel was not.`,
            'The pickup is right either way, so it stays.',
            fix,
            `Or /replace cancel ${ordNum} to call off the pickup as well.`,
            'The customer has not been told anything yet.',
          ].join('\n')
        : [`${req.orderName}: nothing was booked.`, fix, `Or /replace cancel ${ordNum} to drop the request.`].join('\n'),
    );
    return { failed: true, state: 'FAILED', failedStep: which };
  }
}

/** What shadow (and a dry-running adapter) does instead of the two writes. */
async function shadowFinish(orderId, seq, req, specs, deps, reply, why) {
  log.info('replace: shadow run, nothing booked and nobody messaged', {
    orderId,
    seq,
    why,
    returnRef: specs.returnSpec.ref,
    forwardRef: specs.forwardSpec.ref,
    // The payload shape is the whole point of a shadow run, so it is logged in
    // full EXCEPT the consignee, which is protected customer data.
    items: specs.forwardSpec.items.map((i) => ({ sku: i.sku, qty: i.qty, hsn: i.hsn })),
    parcel: specs.returnSpec.parcel,
    declaredValueInr: specs.forwardSpec.declaredValueInr,
    pin: req.customer?.pin,
  });
  metric('ReplaceShadow', 1, {});
  await store.patchRequest(orderId, seq, { state: 'DONE', shadow: true, shadowReason: why, doneAt: new Date().toISOString() });
  await reply(
    [
      `${req.orderName}: REPLACE_MODE is ${config.replaceMode}, so nothing was booked and the customer was not messaged.`,
      'What a live run would have sent:',
      `Reverse pickup ${specs.returnSpec.ref}: ${describeItems(specs.returnSpec.items)} from ${req.customer?.city} ${req.customer?.pin}`,
      `Forward parcel ${specs.forwardSpec.ref}: ${describeItems(specs.forwardSpec.items)}, prepaid, surface, ${specs.forwardSpec.parcel.weightGrams}g`,
      `Declared value ${rupees(specs.forwardSpec.declaredValueInr)}, HSN ${specs.forwardSpec.items.map((i) => i.hsn).join('/')}`,
      'Set REPLACE_MODE=live when the payload has been checked against a real waybill.',
    ].join('\n'),
  );
  return { state: 'DONE', shadow: true, seq };
}

/** Rebuild the specs from the stored request, so a retry sends the same payload. */
function specsFromRequest(req) {
  const base = {
    invoiceRef: req.orderName,
    customer: req.customer,
    parcel: req.parcel,
    mode: 'surface',
    declaredValueInr: req.declaredValueInr,
  };
  return {
    returnSpec: { ...base, ref: req.returnRef, items: req.items.return },
    forwardSpec: { ...base, ref: req.forwardRef, items: req.items.forward },
  };
}

async function labelFor(deps, awb) {
  const api = deps.clients.logistics;
  if (!awb || !api?.capabilities?.label) return null;
  const l = await soft('replaceLabel', () => api.label(awb), {});
  return l?.url || null;
}

// ---- the customer -----------------------------------------------------------

/**
 * The one message the customer gets. Never a silent failure.
 *
 * Only to the order's OTP verified number, and only past opt-out and
 * undeliverable, because sess() enforces none of that: the router checks
 * opt-out for inbound and tpl() checks undeliverable, and a /replace send goes
 * through neither of those doors.
 */
async function notifyCustomer(deps, req, orderId) {
  if (!config.replaceNotifyCustomer) return { skipped: 'notify-off' };
  const phone = req.verifiedPhone;
  if (!phone) return { skipped: 'no-verified-phone' };
  if (await isOptedOut(phone)) return { skipped: 'opted-out' };
  if (await isUndeliverable(phone)) return { skipped: 'undeliverable' };

  const vars = {
    customer_name: req.customerName || 'there',
    order_number: req.orderName,
    return_item: req.describe?.returnItem || 'the item',
    new_item: req.describe?.newItem || 'the replacement',
  };

  if (await windowOpen(phone, nowOf(deps))) {
    await sess(deps, phone, 'replacement_raised', vars);
    return { sent: 'session' };
  }
  try {
    // The button tracks the pickup, which is the only leg the customer has to
    // be home for.
    // orderId so the send is logged against the order: this template can be
    // accepted and then refused seconds later on a status webhook that carries
    // only the wamid, and without the reverse map that failure would reach
    // nobody, which is the one thing this function promises not to do.
    const r = await tpl(deps, phone, 'replacement_raised', vars, { token: req.returnAwb, orderId });
    if (r?.skipped) return { skipped: r.skipped };
    return { sent: 'template' };
  } catch (e) {
    const err = /** @type {any} */ (e);
    // Not approved, paused, or failing, with the window closed: there is no
    // other way to reach them, so say so rather than pretend it went.
    if (!isTemplateUnusable(err)) throw err;
    log.warn('replace: the template is unusable and the window is closed', { err: err.message, waCode: err.waCode });
    return { skipped: 'template-unusable', error: err.message };
  }
}

function notifyLine(notified) {
  if (notified?.sent) return `The customer was messaged (${notified.sent}).`;
  const why = {
    'notify-off': 'REPLACE_NOTIFY_CUSTOMER is off',
    'no-verified-phone': 'the order has no OTP verified number',
    'opted-out': 'they sent STOP',
    undeliverable: 'WhatsApp says that number cannot receive messages',
    'template-unusable': 'our 24 hour window is closed and the template cannot be sent',
  }[notified?.skipped] || notified?.skipped || 'unknown';
  return `THE CUSTOMER WAS NOT MESSAGED, because ${why}. Call them.`;
}

// ---- status, cancel, retry, list, help --------------------------------------

export async function onStatus(orderName, deps, adminPhone) {
  const reply = replier(deps, adminPhone);
  if (!orderName) return reply('Send it with the order number, like /replace status 1234');
  const n = await getNormByName(deps, bare(orderName));
  if (!n) return reply(`No order #${bare(orderName)} here.`);
  const req = await store.latestRequest(n.numericId);
  if (!req) return reply(`No replacement has ever been raised on ${n.name}.`);

  /*
   * The courier is asked DIRECTLY rather than read off a stored status, because
   * replacement waybills are deliberately kept out of the poller (DECISIONS T2)
   * and nothing updates them in the background.
   */
  const live = async (ref, stored) => {
    const api = deps.clients.logistics;
    if (!ref || !api?.capabilities?.findByRef) return stored || 'unknown';
    const f = await soft('replaceFindByRef', () => api.findByRef(ref), {});
    return f?.status || stored || 'unknown';
  };

  return reply(
    [
      `${n.name} replacement ${req.seq}: ${req.state}${req.shadow ? ' (shadow, nothing was booked)' : ''}`,
      `Swap: ${req.describe?.returnItem} back, ${req.describe?.newItem} out`,
      req.returnAwb ? `Pickup ${req.returnAwb}: ${await live(req.returnRef, req.returnStatus)}` : 'Pickup: not booked',
      req.forwardAwb ? `Delivery ${req.forwardAwb}: ${await live(req.forwardRef, req.forwardStatus)}` : 'Delivery: not booked',
      req.state === 'FAILED'
        ? `Failed at the ${req.failedStep} leg: ${req.error}. /replace retry ${bare(n.name)}`
        : req.notified
          ? notifyLine(req.notified)
          : 'The customer has not been messaged yet.',
    ].join('\n'),
  );
}

/**
 * `/replace cancel 1234`.
 *
 * Before pickup this is a clean undo. After it, the courier decides: a parcel
 * already collected cannot be un-collected, so we report what the courier said
 * and leave the request where it is rather than claiming a cancellation we did
 * not get.
 */
export async function onCancel(orderName, deps, adminPhone) {
  const reply = replier(deps, adminPhone);
  if (!orderName) return reply('Send it with the order number, like /replace cancel 1234');
  const n = await getNormByName(deps, bare(orderName));
  if (!n) return reply(`No order #${bare(orderName)} here.`);
  const req = await store.latestRequest(n.numericId);
  if (!req) return reply(`No replacement has ever been raised on ${n.name}.`);
  /*
   * DONE is deliberately NOT a refusal. It means both parcels were booked and
   * the customer was told, and both of those parcels are still in flight: a
   * replacement is cancellable right up to the moment the courier has it.
   * Only the states where nothing can be moving close the door.
   */
  if (CLOSED.has(req.state)) return reply(`${n.name} replacement ${req.seq} is already ${req.state}. Nothing to cancel.`);

  if (req.state === 'AWAITING_CONFIRMATION') {
    await store.patchRequest(n.numericId, req.seq, { state: 'REJECTED', rejectedAt: nowOf(deps).toISOString() });
    return reply(`Dropped. ${n.name} was never booked and the customer was not messaged.`);
  }

  const api = deps.clients.logistics;
  const legs = [['pickup', req.returnAwb], ['delivery', req.forwardAwb]].filter(([, awb]) => awb);
  if (!legs.length) {
    // A shadow run, or a failure before the first leg: there is nothing at the
    // courier to call off, so this is bookkeeping.
    await store.patchRequest(n.numericId, req.seq, { state: 'CANCELLED', cancelledAt: nowOf(deps).toISOString() });
    return reply(`Dropped. ${n.name} had nothing booked at the courier.`);
  }
  const done = [];
  const stuck = [];
  for (const [label, awb] of legs) {
    const res = await soft(`replaceCancel:${label}`, () => api.cancel(awb), { awb });
    if (res?.cancelled) done.push(`${label} ${awb} cancelled`);
    else stuck.push(`${label} ${awb} could NOT be cancelled (${res?.reason || 'the courier refused'})`);
  }

  if (stuck.length) {
    log.warn('replace: cancel refused by the courier', { orderId: n.numericId, seq: req.seq, legs: stuck.length });
    return reply(
      [`${n.name}: ${done.concat(stuck).join('. ')}.`,
        'A parcel the courier already has cannot be called back from here. Phone them, and handle the refund by hand.',
      ].join('\n'),
    );
  }

  await store.patchRequest(n.numericId, req.seq, { state: 'CANCELLED', cancelledAt: nowOf(deps).toISOString() });
  return reply(
    `${n.name}: ${done.join('. ') || 'nothing was booked'}. ` +
      `${req.notified?.sent ? 'The customer WAS already told a pickup was coming, so tell them it is off.' : 'The customer was never told.'}`,
  );
}

/** `/replace retry 1234`: pick a FAILED or half-finished request back up. */
export async function onRetry(orderName, deps, adminPhone) {
  const reply = replier(deps, adminPhone);
  if (!orderName) return reply('Send it with the order number, like /replace retry 1234');
  const n = await getNormByName(deps, bare(orderName));
  if (!n) return reply(`No order #${bare(orderName)} here.`);
  const req = await store.latestRequest(n.numericId);
  if (!req) return reply(`No replacement has ever been raised on ${n.name}.`);
  if (store.TERMINAL.has(req.state)) {
    return reply(`${n.name} replacement ${req.seq} is ${req.state}, so there is nothing to pick up. Send a fresh /replace.`);
  }
  if (req.state === 'AWAITING_CONFIRMATION') {
    return reply(`${n.name} is still waiting for you to tap Confirm. Nothing has been booked, so there is nothing to retry.`);
  }
  log.info('replace: retry', { orderId: n.numericId, seq: req.seq, from: req.state });
  return execute(n.numericId, req.seq, deps, adminPhone, {});
}

/** `/replace list`: everything still open, which is one scan of the pointers. */
export async function onList(deps, adminPhone) {
  const reply = replier(deps, adminPhone);
  const rows = await store.listOpen(10, nowOf(deps));
  if (!rows.length) return reply('No replacement is open right now.');
  return reply(
    ['Open replacements:', '']
      .concat(
        rows.map((r) =>
          `${r.orderName} (${r.seq}) ${r.state}${r.state === 'FAILED' ? ` at the ${r.failedStep} leg` : ''}: ` +
            `${r.describe?.returnItem} to ${r.describe?.newItem}`),
      )
      .join('\n'),
  );
}

export function onHelp(deps, adminPhone) {
  return replier(deps, adminPhone)(HELP);
}

// ---- taps -------------------------------------------------------------------

/**
 * `rpok:<seq>:<nonce>` / `rpno:<seq>:<nonce>`.
 *
 * Admission is re-checked here STRICTLY, because worker/index.mjs routes P
 * payloads AHEAD of the per-order ownership gate: an admin never owns the
 * customer's order, so that gate would refuse every Confirm there is.
 */
async function onTap(orderId, stepName, seq, nce, deps, phone) {
  if (!isReplaceAdmin(phone)) {
    return log.warn('replace: tap from a phone that is not an admin, ignoring', { orderId, phone: maskPhone(phone) });
  }
  const reply = replier(deps, phone);
  const req = await store.getRequest(orderId, seq);
  if (!req) return reply('That preview is gone. Send the /replace command again.');
  const ordNum = bare(req.orderName);

  if (String(req.nonce) !== String(nce)) {
    log.warn('replace: tap carried a stale nonce', { orderId, seq });
    return reply(`That button belongs to an older preview for ${req.orderName}. Send /replace again to get a fresh one.`);
  }

  // A newer command for the same order supersedes an older preview, by
  // arithmetic rather than by a flag somebody has to remember to clear.
  const latest = await store.latestRequest(orderId);
  if (latest && Number(latest.seq) > Number(seq)) {
    return reply(`A newer /replace for ${req.orderName} has replaced that one. Use the latest preview.`);
  }

  // Idempotent: a double tap gets a short answer, not a second parcel.
  if (req.state !== 'AWAITING_CONFIRMATION') {
    if (stepName === 'rpok') {
      return reply(`${req.orderName} replacement ${req.seq} is already ${req.state}. /replace status ${ordNum}`);
    }
    return reply(`${req.orderName} replacement ${req.seq} is already ${req.state}.`);
  }

  const now = nowOf(deps);
  if (req.confirmBy && new Date(req.confirmBy).getTime() <= now.getTime()) {
    await store.patchRequest(orderId, seq, { state: 'EXPIRED', expiredAt: now.toISOString() });
    return reply(
      `That preview for ${req.orderName} is more than ${R.confirmMinutes} minutes old, and stock, serviceability and ` +
        'freight all move. Send /replace again for a fresh one.',
    );
  }

  if (stepName === 'rpno') {
    await store.patchRequest(orderId, seq, { state: 'REJECTED', rejectedAt: now.toISOString() });
    log.info('replace: rejected at the preview', { orderId, seq });
    return reply(`Dropped. ${req.orderName} was never booked and the customer was not messaged.`);
  }

  return execute(orderId, seq, deps, phone, {});
}

/**
 * Router for the P flow. Returns a promise when the action is ours and null
 * when it is not, so index.mjs can log an unknown payload rather than swallow
 * it. With the mode off the tap is swallowed, because the payload IS ours.
 */
export function route(orderId, action, deps, phone) {
  const [stepName, seq, nce] = String(action || '').split(':');
  if (stepName !== 'rpok' && stepName !== 'rpno') return null;
  if (config.replaceMode === 'off') {
    log.info('replace: switched off, ignoring tap', { orderId, action: stepName });
    return Promise.resolve();
  }
  return onTap(orderId, stepName, seq, nce, deps, phone);
}
