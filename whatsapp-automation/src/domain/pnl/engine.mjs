/*
 * engine.mjs — PnlInputs in, Report out. Pure: no clients, no clock, no fs, no
 * network. The same inputs always produce the same report.
 *
 * THE CENTRAL RULE, carried over from finance/pnl.mjs: the engine never
 * invents a cost. A row whose freight, unit cost or gateway fee could not be
 * read is INCOMPLETE, contributes nothing to any total, and is named with the
 * code of what it is missing. A number in the statement is traceable to a
 * verified input or it is not in the statement. Rates that are assumed rather
 * than read are carried through to `assumptions` so every figure can be
 * followed back to VERIFIED, ASSUMED or CONFIG.
 *
 * Only SETTLED orders reach the P&L: DELIVERED and RTO. Pending and cancelled
 * orders are listed with the charges incurred on them so far, and only the
 * charges Delhivery actually billed on a cancelled parcel enter a total.
 */
import { classifyInclusion, inCohort, istDateKey, istDatesIn, istWallToUtc } from './cohort.mjs';
import { deriveOutcome, shopifyConflict, rtoIsFinal, customerDeliveredAt } from './outcome.mjs';
import { lineGstPaise, backOutGst, nearSlabBoundary, shopifyTaxMismatch, pickSlabRatePct } from './gst.mjs';
import { assumptionRows, RULE_OF_THUMB_TOLERANCE_PCT } from './config.mjs';

/** @typedef {import('./types.mjs').PnlInputs} PnlInputs */
/** @typedef {import('./types.mjs').PnlConfig} PnlConfig */
/** @typedef {import('./types.mjs').NormOrder} NormOrder */
/** @typedef {import('./types.mjs').NormLine} NormLine */
/** @typedef {import('./types.mjs').NormShipment} NormShipment */
/** @typedef {import('./types.mjs').CourierCharge} CourierCharge */
/** @typedef {import('./types.mjs').GatewayFee} GatewayFee */
/** @typedef {import('./types.mjs').ReportRow} ReportRow */
/** @typedef {import('./types.mjs').Outcome} Outcome */

const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);
/**
 * Add up parts that may be unknown. ONE null makes the whole thing null, which
 * is the rule the whole report rests on: a cost we could not read is not zero.
 * @type {(...parts:(number|null|undefined)[]) => number|null}
 */
const addUp = (...parts) =>
  parts.some((p) => p == null) ? null : parts.reduce((a, b) => Number(a) + Number(b), 0) ?? 0;
/** Ratios are the only floats in the feature, and a zero denominator is null, not 0. */
const div = (a, b) => (b ? a / b : null);
const pct = (a, b) => (b ? (a / b) * 100 : null);

// ---------------------------------------------------------------- charges

/**
 * One parcel's courier cost, split into the legs the statement shows apart.
 *
 * `gstInputCreditClaimed` decides the basis: while it is false every cost is
 * booked GST-inclusive (the conservative reading), so the basis is
 * `totalPaise`; when it is true the costs are ex-GST and the basis is
 * `totalPaise - gstPaise`.
 *
 * The per-head figures from Delhivery are ex-GST and do not add up to
 * `total_amount`, so the heads are scaled onto the basis pro rata with the
 * rounding remainder landing on the forward leg. That keeps "forward + COD" on
 * the statement tied exactly to the Courier Ledger total, which is one of the
 * reconciliations the report has to pass.
 *
 * @param {CourierCharge|undefined} charge
 * @param {PnlConfig} config
 * @returns {{forward:number, rto:number, dto:number, cod:number, total:number}|null}
 */
export function parcelLegs(charge, config) {
  if (!charge) return null;
  const heads = {
    forward: charge.forwardPaise ?? 0,
    rto: charge.rtoPaise ?? 0,
    dto: charge.dtoPaise ?? 0,
    cod: charge.codChargePaise ?? 0,
  };
  const headsSum = heads.forward + heads.rto + heads.dto + heads.cod;
  if (charge.totalPaise == null && headsSum === 0 && charge.forwardPaise == null) return null;

  const gst = charge.gstPaise ?? 0;
  const credit = config.gstInputCreditClaimed;
  const basis =
    charge.totalPaise != null
      ? credit
        ? charge.totalPaise - gst
        : charge.totalPaise
      : credit
        ? headsSum
        : headsSum + gst;

  if (headsSum === 0) return { forward: basis, rto: 0, dto: 0, cod: 0, total: basis };
  const rto = Math.round((heads.rto * basis) / headsSum);
  const dto = Math.round((heads.dto * basis) / headsSum);
  const cod = Math.round((heads.cod * basis) / headsSum);
  return { forward: basis - rto - dto - cod, rto, dto, cod, total: basis };
}

/**
 * Split an integer paise amount across weights so the parts sum back to it
 * EXACTLY, with the remainder going to the largest weight.
 *
 * Plain `round(total * share)` per order does not: three orders on one parcel
 * lose or gain a paisa, and then the Data Checks reconciliation "courier total
 * = sum of the courier ledger" fails by that paisa every month and nobody ever
 * trusts it again.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export function splitPaise(total, weights) {
  const n = weights.length;
  if (n === 1) return [total];
  const sumW = weights.reduce((a, b) => a + b, 0);
  // Every order in the parcel is worth nothing (all voided): split it evenly.
  const w = sumW > 0 ? weights : weights.map(() => 1);
  const denom = sumW > 0 ? sumW : n;
  const parts = w.map((x) => Math.floor((total * x) / denom));
  const biggestFirst = w.map((x, i) => i).sort((a, b) => w[b] - w[a] || a - b);
  let rem = total - parts.reduce((a, b) => a + b, 0);
  for (let k = 0; rem > 0; k = (k + 1) % n, rem -= 1) parts[biggestFirst[k]] += 1;
  return parts;
}

/** A whole-rupee gateway fee from the config rate, used only when no gateway read it. */
function assumedGatewayPaise(onlinePaise, config) {
  const fee = Math.round((onlinePaise * config.gatewayFeePct) / 100);
  const gst = Math.round((fee * config.gatewayGstPct) / 100);
  return config.gstInputCreditClaimed ? fee : fee + gst;
}

// ---------------------------------------------------------------- one row

/** The lines the order actually stands at. An edited-away line is quantity 0. */
const liveLines = (order) => order.lines.filter((l) => l.currentQuantity > 0);

/**
 * The highest slab rate across an order's live lines. The COD fee is taxed at
 * this rate, per section 7.
 * @param {NormOrder} order
 * @param {PnlConfig} config
 */
function topRatePct(order, config) {
  const rates = liveLines(order).map((l) => pickSlabRatePct(l.discountedUnitPaise, config.gstSlabs));
  return rates.length ? Math.max(...rates) : config.gstSlabs[0].ratePct;
}

/**
 * COGS from current quantities only, and null the moment one unit cost is
 * unreadable. A null unit cost never means free: #1233's custom "Dupatta" line
 * has no variant at all and #1174's "Toran" variant carries no cost, and
 * costing either at zero would turn a loss into a margin.
 * @param {NormOrder} order
 */
function cogsOf(order) {
  let paise = 0;
  for (const l of liveLines(order)) {
    if (l.unitCostPaise == null) return { paise: null, missingTitles: missingCostTitles(order) };
    paise += l.unitCostPaise * l.currentQuantity;
  }
  return { paise, missingTitles: missingCostTitles(order) };
}

/**
 * Every line with no readable cost, live or not. The Data Checks sheet lists
 * these so they can be fixed at product > variant > Cost per item, and it
 * wants #1174's "Toran" even though the order was voided and the line now
 * stands at quantity 0.
 * @param {NormOrder} order
 */
function missingCostTitles(order) {
  return order.lines.filter((l) => l.unitCostPaise == null).map((l) => l.title);
}

/**
 * The shipments this order's AWBs point at. One definition, because an order
 * whose parcel is looked up two different ways is an order that can be costed
 * one way and explained another.
 * @param {NormOrder} order
 * @param {{shipByAwb: Map<string, NormShipment>}} ctx
 * @returns {NormShipment[]}
 */
function shipmentsOf(order, ctx) {
  return order.awbs.flatMap((a) => {
    const s = ctx.shipByAwb.get(a);
    return s ? [s] : [];
  });
}

/**
 * Money the customer has paid that we have not given back.
 *
 * ONE definition, used by the RTO branch, the cancelled branch and the open
 * questions, because the bug this replaces was two branches disagreeing about
 * the same 104.95 on two orders of identical shape (#1225 and #1228).
 * @param {NormOrder} order
 */
export function unrefundedAdvancePaise(order) {
  const paid = order.paymentType === 'partial' ? order.prepaidReceivedPaise : order.netPaymentPaise;
  return Math.max(0, paid - order.refundedPaise);
}

/**
 * The partial-payment guard, ported from finance/pnl.mjs.
 *
 * COD King records a partial payment as TWO lines for the SAME garment: a
 * deposit line and the real line (#1197, #1224, #1228). Costing both
 * double-counts COGS, so the old engine refused any order with duplicate line
 * titles and a discount rather than guessing which line was real.
 *
 * It is kept, and narrowed to the case that is still genuinely ambiguous.
 * Shopify drops the deposit line to `currentQuantity 0`, which the old engine
 * never read: once the dead lines are gone the duplicate has resolved itself
 * and the order costs correctly. Duplicate titles that are BOTH still live
 * plus a discount is the shape nothing can disambiguate, and that still
 * refuses the row rather than halving or doubling it.
 * @param {NormOrder} order
 */
function duplicateLineRefusal(order) {
  const live = liveLines(order);
  const byTitle = new Map();
  for (const l of live) byTitle.set(l.title, (byTitle.get(l.title) ?? 0) + 1);
  const dup = [...byTitle.entries()].filter(([, n]) => n > 1).map(([t]) => t);
  return dup.length && order.discountsPaise > 0 ? dup : null;
}

/**
 * Cost one order into the shape every sheet reads.
 * @returns {ReportRow}
 */
function buildRow(order, ctx, outcome, outcomeReason, outcomeInferred, inclusionFlags) {
  const { config } = ctx;
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const assumed = [];
  /** @type {string[]} */
  const flags = [...inclusionFlags];

  const shares = parcelShares(order, ctx);
  const ships = shipmentsOf(order, ctx);
  /** @type {CourierCharge[]} */
  const charges = order.awbs.map((a) => ctx.chargeByAwb.get(a)).filter(Boolean);
  const chargeSource = /** @type {import('./types.mjs').ChargeSource} */ (
    charges.length ? (charges.every((c) => c.source === 'ledger') ? 'ledger' : charges[0].source) : 'missing'
  );
  for (const c of charges) {
    if (c.weightAssumed) assumed.push('courier_weight');
    for (const f of c.flags || []) flags.push(`${c.awb}: ${f}`);
    if (
      c.variancePaise != null &&
      Math.abs(c.variancePaise) > config.ledgerVarianceAlertPaise
    ) {
      flags.push(`${c.awb}: ledger and computed differ by ${(c.variancePaise / 100).toFixed(2)}`);
    }
    if (c.chargedWeightGrams != null && c.chargedWeightGrams > config.weightAlertGrams) {
      flags.push(`${c.awb}: charged weight ${c.chargedWeightGrams}g is above the alert line`);
    }
  }

  // --- the legs, shared by order value when one parcel carries several orders
  let forward = null;
  let rto = null;
  let codCharge = null;
  if (order.awbs.length) {
    let f = 0;
    let r = 0;
    let cd = 0;
    let readable = 0;
    for (const { awb, weights, index } of shares.perAwb) {
      /*
       * A parcel sent by another courier never resolves against Delhivery: two
       * a month go out via Tirupati. config.manualCourierCostPaise is the
       * owner's hand-entered figure for those, and it is only read when there
       * is no charge record at all, so a real charge always wins.
       */
      const legs =
        parcelLegs(ctx.chargeByAwb.get(awb), config) ??
        (config.manualCourierCostPaise[awb] != null
          ? { forward: config.manualCourierCostPaise[awb], rto: 0, dto: 0, cod: 0, total: config.manualCourierCostPaise[awb] }
          : null);
      if (!legs) continue;
      if (!ctx.chargeByAwb.has(awb)) {
        assumed.push('manual_courier_cost');
        flags.push(`${awb}: courier cost entered by hand, not read from Delhivery`);
      }
      readable += 1;
      f += splitPaise(legs.forward, weights)[index];
      r += splitPaise(legs.rto + legs.dto, weights)[index];
      cd += splitPaise(legs.cod, weights)[index];
    }
    if (readable === order.awbs.length) {
      forward = f;
      rto = r;
      codCharge = cd;
    } else {
      missing.push('freight');
    }
  } else if (outcome === 'DELIVERED' || outcome === 'RTO') {
    // It shipped, so it cost something, and Delhivery has no record of it
    // (#1205: fulfilled with no AWB in Shopify, and ref_ids finds nothing).
    missing.push('awb');
    missing.push('freight');
  }

  const packing = order.awbs.length
    ? sum(shares.perAwb, (p) => splitPaise(config.packingCostPerOrderPaise, p.weights)[p.index])
    : shares.totalShare > 0
      ? config.packingCostPerOrderPaise
      : 0;

  // --- GST. Line GST is kept apart from the fee so the mismatch list can
  // compare like with like: Shopify excludes the COD fee from tax.
  const live = liveLines(order);
  let lineGst = 0;
  for (const l of live) {
    const { gstPaise, ratePct } = lineGstPaise(l.discountedUnitPaise, l.currentQuantity, config.gstSlabs);
    lineGst += gstPaise;
    if (nearSlabBoundary(l.discountedUnitPaise, config.gstSlabs, config.gstThresholdFlagPaise)) {
      flags.push(`${l.title} at ${(l.discountedUnitPaise / 100).toFixed(2)} is within a slab boundary (${ratePct}%)`);
    }
  }
  const top = topRatePct(order, config);
  const feeGst = backOutGst(order.codFeePaise, top);
  /*
   * Only compare tax on an order that still has something in it. A voided
   * order keeps its original taxLines while every line drops to quantity 0, so
   * comparing would flag all ten of October's voided orders as tax mismatches
   * and bury the three real ones (#1172, #1184, #1202) and #1227's wrong slab.
   */
  if (live.length) for (const note of shopifyTaxMismatch(order, lineGst, top)) flags.push(note);

  // --- gateway
  const onlinePaise =
    order.paymentType === 'prepaid'
      ? Math.max(0, order.currentTotalPaise - order.refundedPaise)
      : order.paymentType === 'partial'
        ? order.prepaidReceivedPaise
        : 0;
  let gatewayFee = /** @type {number|null} */ (0);
  if (onlinePaise > 0) {
    const row = ctx.gatewayByOrder.get(order.name);
    if (row && row.feePaise != null) {
      gatewayFee = config.gstInputCreditClaimed ? row.feePaise : row.feePaise + (row.gstPaise ?? 0);
      if (row.assumed) assumed.push('gateway_rate');
    } else if (row) {
      gatewayFee = null;
      missing.push('gateway_fee');
    } else {
      gatewayFee = assumedGatewayPaise(onlinePaise, config);
      assumed.push('gateway_rate');
    }
  }

  const dup = duplicateLineRefusal(order);
  if (dup) {
    missing.push('partial_payment_duplicate_lines');
    flags.push(`duplicate live lines with a discount (${dup.join(', ')}): refused rather than halved or doubled`);
  }

  const cogs = cogsOf(order);
  if (order.paymentType === 'partial') {
    flags.push('partial payment: revenue is the current total, COGS from current quantities only');
  }

  /** @type {ReportRow} */
  const row = {
    order,
    outcome,
    outcomeReason,
    outcomeInferred,
    awbs: order.awbs,
    parcelShare: shares.first,
    grossSalePaise: null,
    outputGstPaise: null,
    netRevenuePaise: null,
    cogsPaise: null,
    forwardFreightPaise: forward,
    rtoFreightPaise: null,
    codChargePaise: codCharge,
    packingPaise: packing,
    gatewayFeePaise: gatewayFee,
    advanceKeptPaise: null,
    totalCostPaise: null,
    contributionPaise: null,
    chargeSource,
    complete: false,
    missing,
    assumed,
    flags,
  };

  if (outcome === 'DELIVERED') {
    if (cogs.paise == null) missing.push('unit_cost');
    row.grossSalePaise = order.currentTotalPaise - order.refundedPaise;
    row.outputGstPaise = lineGst + feeGst;
    row.netRevenuePaise = row.grossSalePaise - row.outputGstPaise;
    row.cogsPaise = cogs.paise;
    /*
     * A delivered parcel should carry no return leg, but a ledger upload can
     * show one (a parcel that failed, came back and went out again on the same
     * waybill). Fold it into the forward leg rather than dropping it: money the
     * courier billed has to land somewhere, and the statement has no RTO line
     * for a delivered order.
     */
    if (rto) {
      forward = (forward ?? 0) + rto;
      row.forwardFreightPaise = forward;
      flags.push(`a return leg was billed on a delivered parcel: ${(rto / 100).toFixed(2)} added to forward freight`);
    }
    row.rtoFreightPaise = 0;
    row.advanceKeptPaise = 0;
    row.complete = missing.length === 0;
    row.totalCostPaise = addUp(cogs.paise, forward, codCharge, packing, gatewayFee);
    row.contributionPaise =
      row.totalCostPaise == null ? null : row.netRevenuePaise - row.totalCostPaise;
  } else if (outcome === 'RTO') {
    /*
     * No revenue, and COGS is NOT expensed: the garment comes back and is
     * restockable. What is lost is both freight legs, the packing, the gateway
     * fee on any advance, and any COD charge Delhivery still billed. Models
     * that write off COGS on an RTO overstate the damage; models that ignore
     * the return leg understate it.
     */
    row.cogsPaise = 0;
    row.rtoFreightPaise = rto;
    flags.push('RTO: COGS not expensed, the garment returns to stock');
    /*
     * An unrefunded deposit is other income ONLY once the garment is actually
     * back and the customer still has not been refunded. While the parcel is
     * in reverse transit the outcome is open, so whether we keep the money is
     * genuinely unknown and booking it would be inventing a number in the
     * favourable direction, which is the one thing this engine must not do.
     *
     * The discriminator is ReturnedDate, NOT which bucket the order is in.
     * Reading it as "RTO books it, cancelled asks about it" is what had #1225
     * booking 99.95 of income while #1228, the same 104.95 deposit on the same
     * partial-payment shape, was flagged as a question.
     */
    const advanceGross = unrefundedAdvancePaise(order);
    const legFinal = rtoIsFinal(ships);
    row.advanceKeptPaise = advanceGross && legFinal ? advanceGross - backOutGst(advanceGross, top) : 0;
    if (advanceGross && legFinal) {
      flags.push(
        `advance of ${(advanceGross / 100).toFixed(2)} kept and not refunded on a returned parcel: booked as other income net of GST`,
      );
    } else if (advanceGross) {
      flags.push(
        `advance of ${(advanceGross / 100).toFixed(2)} paid and not refunded: advance kept? confirm (parcel not back yet, nothing booked)`,
      );
    }
    row.complete = missing.length === 0;
    row.totalCostPaise = addUp(forward, rto, codCharge, packing, gatewayFee);
    row.contributionPaise =
      row.totalCostPaise == null ? null : row.advanceKeptPaise - row.totalCostPaise;
  } else if (outcome === 'LOST') {
    /*
     * The product and the freight are both gone. COGS IS expensed here, which
     * is the one case where an unreadable unit cost blocks a loss rather than a
     * profit, and the row is flagged so the claim gets filed.
     */
    if (cogs.paise == null) missing.push('unit_cost');
    row.cogsPaise = cogs.paise;
    row.rtoFreightPaise = rto;
    flags.push('claim pending with Delhivery: product cost and freight are a loss');
    row.complete = missing.length === 0;
    row.totalCostPaise = addUp(cogs.paise, forward, rto, codCharge, packing, gatewayFee);
    row.contributionPaise = row.totalCostPaise == null ? null : -row.totalCostPaise;
  } else if (outcome === 'CANCELLED') {
    /*
     * Nothing in the P&L except what Delhivery actually billed on a parcel
     * that was manifested. #1217 was manifested and then never picked up
     * ("Seller cancelled the order"), so the honest answer is zero charges and
     * a flag, not an estimate.
     */
    row.cogsPaise = 0;
    row.rtoFreightPaise = rto ?? 0;
    const cancelledPacking = charges.length ? packing : 0;
    row.packingPaise = cancelledPacking;
    row.gatewayFeePaise = 0;
    const billed = charges.length ? (forward ?? 0) + (rto ?? 0) + (codCharge ?? 0) + cancelledPacking : 0;
    row.totalCostPaise = billed;
    // A cancelled parcel with no charge row is not incomplete: nothing billed
    // is a real answer. Only a charge we could not read blocks it.
    row.missing = missing.filter((m) => m !== 'freight' && m !== 'awb' && m !== 'unit_cost');
    row.complete = row.missing.length === 0;
    if (order.awbs.length && !charges.length) {
      flags.push('cancelled after the parcel was manifested: confirm whether Delhivery billed it');
    }
    /*
     * A cancelled order is never income here. The outcome is closed but the
     * refund decision is not recorded anywhere we can read, so the money is an
     * open question, and advanceKeptPaise stays 0 so nothing reaches a total.
     */
    const advance = unrefundedAdvancePaise(order);
    row.advanceKeptPaise = 0;
    if (advance > 0) {
      flags.push(
        `advance of ${(advance / 100).toFixed(2)} paid and not refunded: advance kept? confirm (nothing booked)`,
      );
    }
  } else {
    // PENDING. Nothing in the P&L; the row carries the charges so far so the
    // Not Delivered sheet can show what is already spent on it.
    row.rtoFreightPaise = rto;
    row.totalCostPaise =
      forward == null ? null : (forward ?? 0) + (rto ?? 0) + (codCharge ?? 0) + packing + (gatewayFee ?? 0);
    row.missing = missing.filter((m) => m !== 'freight' && m !== 'awb');
    row.complete = false; // nothing pending contributes to a total by definition
  }

  if (cogs.missingTitles.length) {
    flags.push(`no unit cost on: ${cogs.missingTitles.join(', ')} (fix at product > variant > Cost per item)`);
  }
  return row;
}

/**
 * This order's share of each parcel it is in, by order value.
 *
 * One AWB can carry several orders: #1208 and #1209 both ship on
 * 59152210001584, and Delhivery bills the parcel once. Freight and packing are
 * therefore split by order value, so the bigger order carries the bigger share
 * of a cost that was incurred once.
 */
function parcelShares(order, ctx) {
  if (!order.awbs.length) {
    return { perAwb: [], totalShare: order.fulfillments.length ? 1 : 0, first: 1 };
  }
  const perAwb = order.awbs.map((awb) => {
    const group = ctx.parcelGroups.get(awb) || [order];
    const weights = group.map((o) => o.currentTotalPaise);
    const index = Math.max(0, group.findIndex((o) => o.name === order.name));
    const total = sum(group, (o) => o.currentTotalPaise);
    const share = group.length === 1 ? 1 : total > 0 ? order.currentTotalPaise / total : 1 / group.length;
    return { awb, share, weights, index };
  });
  return {
    perAwb,
    totalShare: sum(perAwb, (p) => p.share),
    first: perAwb[0].share,
  };
}

// ---------------------------------------------------------------- the report

/**
 * @param {PnlInputs} inputs
 */
export function buildReport(inputs) {
  const { config } = inputs;
  const credit = config.gstInputCreditClaimed;

  /*
   * Re-cut the cohort here even though the adapter already did. Shopify's
   * `created_at:` filter ignores the time of day, so the fetch has to
   * over-fetch a day either side; a report that trusted the fetch would put
   * September orders in October the first time that guard moved.
   */
  const cohort = inputs.orders
    .filter((o) => inCohort(o, inputs.monthStartUtc, inputs.monthEndUtc))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  /** @type {Map<string, NormShipment>} */
  const shipByAwb = new Map(inputs.shipments.map((s) => [s.awb, s]));
  /** @type {Map<string, CourierCharge>} */
  const chargeByAwb = new Map(inputs.charges.map((c) => [c.awb, c]));
  /** @type {Map<string, GatewayFee>} */
  const gatewayByOrder = new Map(inputs.gateway.map((g) => [g.orderName, g]));
  /** @type {Map<string, NormOrder[]>} */
  const parcelGroups = new Map();
  for (const o of cohort) {
    for (const awb of o.awbs) {
      const g = parcelGroups.get(awb) || [];
      g.push(o);
      parcelGroups.set(awb, g);
    }
  }

  const ctx = { config, shipByAwb, chargeByAwb, gatewayByOrder, parcelGroups };

  /** @type {ReportRow[]} */
  const rows = [];
  /** @type {{code:string, orderName:string|null, note:string}[]} */
  const flags = [];
  const flag = (code, orderName, note) => flags.push({ code, orderName, note });

  for (const order of cohort) {
    const inc = classifyInclusion(order, config);
    for (const f of inc.flags) flag('review', order.name, f);
    if (!inc.included) {
      rows.push(excludedRow(order, inc.reason || 'excluded', ctx));
      continue;
    }
    const ships = shipmentsOf(order, ctx);
    const { outcome, reason, inferred } = deriveOutcome(order, ships);
    const conflict = shopifyConflict(order, ships, outcome);
    if (conflict) flag('shopify_delhivery_conflict', order.name, conflict);
    if (inferred) flag('inferred_outcome', order.name, reason);
    const row = buildRow(order, ctx, outcome, reason, inferred, inc.flags);
    rows.push(row);
    for (const note of row.flags) flag('row', order.name, note);
    for (const m of row.missing) flag('missing', order.name, m);
  }

  // ---- duplicates: same customer, two orders the same IST day
  const seen = new Map();
  for (const r of rows) {
    if (r.outcome === 'EXCLUDED' || !r.order.customerName) continue;
    const key = `${r.order.customerName.toLowerCase()}|${istDateKey(r.order.createdAt)}`;
    const prev = seen.get(key);
    if (prev) flag('possible_duplicate', r.order.name, `same customer as ${prev} on the same day`);
    else seen.set(key, r.order.name);
  }

  // ---- funnel
  const of = (outcome) => rows.filter((r) => r.outcome === outcome);
  const excluded = of('EXCLUDED');
  const delivered = of('DELIVERED');
  const rto = of('RTO');
  const pending = of('PENDING');
  const cancelled = of('CANCELLED');
  const lost = of('LOST');
  const parcelsOf = (rs) => new Set(rs.flatMap((r) => r.awbs)).size;

  const funnel = {
    onRecord: rows.length,
    excluded: excluded.length,
    cancelled: cancelled.length,
    shipped: rows.filter((r) => r.outcome !== 'EXCLUDED' && r.order.fulfillments.length > 0).length,
    delivered: delivered.length,
    rto: rto.length,
    pending: pending.length,
    lost: lost.length,
    deliveredParcels: parcelsOf(delivered),
    rtoParcels: parcelsOf(rto),
  };

  // ---- only COMPLETE rows contribute to a total
  const ok = (rs) => rs.filter((r) => r.complete);
  const dOk = ok(delivered);
  const rOk = ok(rto);
  const lOk = ok(lost);
  const cOk = ok(cancelled);
  for (const r of [...delivered, ...rto, ...lost]) {
    if (!r.complete) {
      flag('blocked_from_totals', r.order.name, `${r.outcome} row blocked by: ${r.missing.join(', ')}`);
    }
  }

  /*
   * Money the customer has paid that we have not given back, on an order that
   * never completed. It is NOT income: a question for the owner, carried as
   * data so the workbook can put it where it will be read and answered.
   */
  const openQuestions = rows.flatMap((r) => {
    if (r.outcome !== 'RTO' && r.outcome !== 'CANCELLED') return [];
    const amountPaise = unrefundedAdvancePaise(r.order);
    if (!amountPaise || r.advanceKeptPaise) return [];
    return [
      {
        orderName: r.order.name,
        code: 'advance_kept_unverified',
        amountPaise,
        outcome: r.outcome,
        note:
          r.outcome === 'RTO'
            ? 'parcel not back yet, so whether this deposit is kept is still open'
            : 'order cancelled and the deposit not refunded: kept, or owed back?',
      },
    ];
  });
  for (const q of openQuestions) flag(q.code, q.orderName, `${(q.amountPaise / 100).toFixed(2)}: ${q.note}`);

  // ---- replacements
  const repl = replacementTotals(inputs, ctx);
  for (const note of repl.flags) flag('replacement', note.orderName, note.note);

  // ---- courier charges not tied to a settled order of this month
  const claimed = new Set();
  for (const r of rows) if (r.outcome !== 'EXCLUDED') for (const a of r.awbs) claimed.add(a);
  for (const a of repl.awbs) claimed.add(a);
  const otherCharges = inputs.charges.filter((c) => !claimed.has(c.awb));
  const otherCourierOnlyPaise = sum(otherCharges, (c) => {
    const legs = parcelLegs(c, config);
    return legs ? legs.total : 0;
  });
  // An excluded order that really shipped still cost us a parcel and a bag, and
  // the bag is not a courier charge, so the two are kept apart: the statement
  // line wants both, the courier reconciliation wants only the courier part.
  const excludedPackingPaise = sum(excluded, (r) =>
    r.order.fulfillments.length ? config.packingCostPerOrderPaise : 0,
  );
  const otherCourierPaise = otherCourierOnlyPaise + excludedPackingPaise;
  /*
   * Hand-entered costs are not in the ledger, so the reconciliation has to
   * expect them on both sides or it fails every month there is a Tirupati
   * parcel. Only the AWBs the rows actually costed count: an excluded order's
   * parcel is never costed on its row.
   */
  const manualCourierPaise = sum(
    [...new Set(rows.filter((r) => r.outcome !== 'EXCLUDED').flatMap((r) => r.awbs))].filter(
      (a) => !chargeByAwb.has(a) && config.manualCourierCostPaise[a] != null,
    ),
    (a) => config.manualCourierCostPaise[a],
  );
  for (const c of otherCharges) {
    flag('other_courier_charge', null, `${c.awb} is not tied to a settled order of this month`);
  }

  // ---- Meta
  const metaIn = inputs.meta.filter((m) => {
    const d = Date.parse(`${m.date}T00:00:00+05:30`);
    return d >= Date.parse(inputs.monthStartUtc) && d < Date.parse(inputs.monthEndUtc);
  });
  const typeOf = (m) => config.campaignTypeOverrides[m.campaignId] || m.type;
  const metaSales = sum(metaIn.filter((m) => typeOf(m) === 'sales'), (m) => m.spendPaise);
  const metaBoost = sum(metaIn.filter((m) => typeOf(m) === 'boost'), (m) => m.spendPaise);
  const metaOther = sum(metaIn.filter((m) => typeOf(m) !== 'sales' && typeOf(m) !== 'boost'), (m) => m.spendPaise);
  const metaSpend = metaSales + metaBoost + metaOther;
  const metaGst = credit ? 0 : Math.round((metaSpend * config.metaGstPct) / 100);
  const totalMeta = metaSpend + metaGst;

  // ---- the statement
  const grossSales = sum(dOk, (r) => r.order.currentTotalPaise);
  const refunds = sum(dOk, (r) => r.order.refundedPaise);
  const outputGst = sum(dOk, (r) => r.outputGstPaise);
  const netRevenue = grossSales - refunds - outputGst;
  const cogs = sum(dOk, (r) => r.cogsPaise);
  const forwardFreight = sum(dOk, (r) => r.forwardFreightPaise);
  const codCharges = sum(dOk, (r) => r.codChargePaise);
  const packing = sum(dOk, (r) => r.packingPaise);
  const gatewayFees = sum(dOk, (r) => r.gatewayFeePaise);
  const contributionBeforeRtoAndAds =
    netRevenue - cogs - forwardFreight - codCharges - packing - gatewayFees;

  const rtoForward = sum(rOk, (r) => r.forwardFreightPaise);
  const rtoReturn = sum(rOk, (r) => r.rtoFreightPaise);
  const rtoCod = sum(rOk, (r) => r.codChargePaise);
  const rtoPackingAndGateway = sum(rOk, (r) => (r.packingPaise ?? 0) + (r.gatewayFeePaise ?? 0));
  const advanceKeptOnRto = sum(rOk, (r) => r.advanceKeptPaise);
  const rtoLoss = rtoForward + rtoReturn + rtoCod + rtoPackingAndGateway - advanceKeptOnRto;

  const cancelledCharges = sum(cOk, (r) => r.totalCostPaise);
  const lostLoss = sum(lOk, (r) => r.totalCostPaise);
  const contributionAfterRto =
    contributionBeforeRtoAndAds - rtoLoss - cancelledCharges - repl.netPaise - otherCourierPaise - lostLoss;

  const profitBeforeFixed = contributionAfterRto - totalMeta;
  const fixedCosts = sum(config.fixedMonthlyCosts, (f) => f.amountPaise);
  const netProfit = profitBeforeFixed - fixedCosts;
  if (!config.fixedMonthlyCosts.length) {
    flag('fixed_costs_not_set', null, 'No fixed monthly costs supplied, so net profit is OPTIMISTIC.');
  }

  const totals = {
    grossSalesPaise: grossSales,
    refundsPaise: refunds,
    outputGstPaise: outputGst,
    netRevenuePaise: netRevenue,
    cogsPaise: cogs,
    forwardFreightPaise: forwardFreight,
    codChargesPaise: codCharges,
    packingPaise: packing,
    gatewayFeesPaise: gatewayFees,
    contributionBeforeRtoAndAdsPaise: contributionBeforeRtoAndAds,
    rtoForwardFreightPaise: rtoForward,
    rtoReturnFreightPaise: rtoReturn,
    rtoCodChargesPaise: rtoCod,
    rtoPackingAndGatewayPaise: rtoPackingAndGateway,
    advanceKeptOnRtoPaise: advanceKeptOnRto,
    rtoLossPaise: rtoLoss,
    cancelledShipmentChargesPaise: cancelledCharges,
    replacementShipmentsPaise: repl.netPaise,
    otherCourierChargesPaise: otherCourierPaise,
    lostShipmentsPaise: lostLoss,
    contributionAfterRtoPaise: contributionAfterRto,
    metaSalesPaise: metaSales,
    metaBoostPaise: metaBoost,
    metaOtherPaise: metaOther,
    metaGstPaise: metaGst,
    totalMetaPaise: totalMeta,
    profitBeforeFixedCostsPaise: profitBeforeFixed,
    fixedCostsPaise: fixedCosts,
    netProfitPaise: netProfit,
    netProfitPctOfNetRevenue: pct(netProfit, netRevenue),
    netProfitOptimistic: config.fixedMonthlyCosts.length === 0,
    // Paid to us, not refunded, and not booked: an open question, not income.
    advanceUnverifiedPaise: sum(openQuestions, (q) => q.amountPaise),
    countedDelivered: dOk.length,
    countedRto: rOk.length,
    blockedDelivered: delivered.length - dOk.length,
    blockedRto: rto.length - rOk.length,
  };

  /*
   * The statement, in the order section 7 fixes, with one line added: LOST.
   * Section 7 lists no line for a lost parcel, and a lost parcel is a real loss
   * of both the garment and the freight, so hiding it would overstate profit.
   * It sits with the other non-delivered charges, before CONTRIBUTION AFTER
   * RTO, and reads 0 in a month with no losses.
   */
  const statement = [
    ['grossSales', 'Gross sales (delivered, incl. GST)', grossSales, 'total'],
    ['refunds', 'less refunds', -refunds, 'cost'],
    ['outputGst', 'less output GST', -outputGst, 'cost'],
    ['netRevenue', 'NET REVENUE', netRevenue, 'subtotal'],
    ['cogs', 'Product cost (COGS)', -cogs, 'cost'],
    ['forwardFreight', 'Forward freight (delivered)', -forwardFreight, 'cost'],
    ['codCharges', 'COD charges', -codCharges, 'cost'],
    ['packing', 'Packing', -packing, 'cost'],
    ['gatewayFees', 'Payment gateway fees', -gatewayFees, 'cost'],
    ['contributionBeforeRtoAndAds', 'CONTRIBUTION BEFORE RTO AND ADS', contributionBeforeRtoAndAds, 'subtotal'],
    ['rtoForwardFreight', 'RTO forward freight', -rtoForward, 'cost'],
    ['rtoReturnFreight', 'RTO return freight', -rtoReturn, 'cost'],
    ['rtoPackingAndGateway', 'RTO packing and gateway fees', -(rtoPackingAndGateway + rtoCod), 'cost'],
    ['advanceKeptOnRto', 'less advance kept on RTO', advanceKeptOnRto, 'credit'],
    ['rtoLoss', 'RTO LOSS (BOTH WAYS)', rtoLoss, 'subtotal'],
    ['cancelledShipmentCharges', 'Cancelled-shipment charges', -cancelledCharges, 'cost'],
    ['replacementShipments', 'Replacement shipments (net of reimbursements received)', -repl.netPaise, 'cost'],
    ['otherCourierCharges', 'Other courier charges', -otherCourierPaise, 'cost'],
    ['lostShipments', 'Lost shipments (product and freight)', -lostLoss, 'cost'],
    ['contributionAfterRto', 'CONTRIBUTION AFTER RTO', contributionAfterRto, 'subtotal'],
    ['metaSales', 'Meta ads: sales campaigns', -metaSales, 'cost'],
    ['metaBoost', 'Meta ads: boosts', -metaBoost, 'cost'],
    ['metaGst', credit ? 'GST on Meta (input credit claimed)' : 'GST on Meta (no input credit)', -metaGst, 'cost'],
    ['totalMeta', 'TOTAL META', totalMeta, 'subtotal'],
    ['profitBeforeFixedCosts', 'PROFIT BEFORE FIXED COSTS', profitBeforeFixed, 'subtotal'],
    ['fixedCosts', 'Fixed costs', -fixedCosts, 'cost'],
    ['netProfit', 'NET PROFIT / LOSS', netProfit, 'total'],
  ].map(([key, label, amountPaise, level]) => ({
    key,
    label,
    amountPaise,
    level,
    pctOfNetRevenue: pct(Number(amountPaise), netRevenue),
  }));

  // ---- ratios
  const nDelivered = dOk.length;
  const ratios = {
    aovPaise: div(grossSales, nDelivered),
    rtoRateByOrderPct: pct(funnel.rto, funnel.delivered + funnel.rto),
    rtoRateByParcelPct: pct(funnel.rtoParcels, funnel.deliveredParcels + funnel.rtoParcels),
    metaPerDeliveredOrderPaise: div(totalMeta, nDelivered),
    deliveredRoas: div(grossSales, totalMeta),
    // What the ads could have cost and still broken even on this month's
    // contribution. Below the delivered ROAS means the ads are underwater.
    breakEvenRoas: div(grossSales, contributionAfterRto),
    contributionPerDeliveredOrderPaise: div(contributionBeforeRtoAndAds, nDelivered),
    rtoLossPerDeliveredOrderPaise: div(rtoLoss, nDelivered),
    netPerDeliveredOrderPaise: div(netProfit, nDelivered),
    prepaidSharePctOfDelivered: pct(
      delivered.filter((r) => r.order.paymentType === 'prepaid').length,
      funnel.delivered,
    ),
  };

  const unitEconomics = {
    orders: nDelivered,
    netRevenuePaise: div(netRevenue, nDelivered),
    cogsPaise: div(cogs, nDelivered),
    freightPaise: div(forwardFreight, nDelivered),
    codChargePaise: div(codCharges, nDelivered),
    packingPaise: div(packing, nDelivered),
    gatewayFeePaise: div(gatewayFees, nDelivered),
    contributionPaise: div(contributionBeforeRtoAndAds, nDelivered),
  };

  // ---- the owner's rule of thumb, as a soft check only
  for (const [type, expected] of [
    ['prepaid', config.ruleOfThumbPrepaidPaise],
    ['cod', config.ruleOfThumbCodPaise],
  ]) {
    const rs = dOk.filter((r) => r.order.paymentType === type);
    if (!rs.length) continue;
    const actual = sum(rs, (r) => (r.forwardFreightPaise ?? 0) + (r.codChargePaise ?? 0) + (r.packingPaise ?? 0)) / rs.length;
    const off = pct(Math.abs(actual - Number(expected)), Number(expected));
    if (off != null && off > RULE_OF_THUMB_TOLERANCE_PCT) {
      flag(
        'rule_of_thumb_off',
        null,
        `${type}: delivery plus packing averages ${(actual / 100).toFixed(2)} against a rule of thumb of ${(Number(expected) / 100).toFixed(2)}, off by ${off.toFixed(0)}%`,
      );
    }
  }

  // ---- breakdowns
  const byPaymentType = ['cod', 'prepaid', 'partial'].map((type) => {
    const all = rows.filter((r) => r.outcome !== 'EXCLUDED' && r.order.paymentType === type);
    const d = all.filter((r) => r.outcome === 'DELIVERED');
    const t = all.filter((r) => r.outcome === 'RTO');
    return {
      type,
      orders: all.length,
      delivered: d.length,
      rto: t.length,
      rtoRatePct: pct(t.length, d.length + t.length),
      contributionPaise: sum(ok(d), (r) => r.contributionPaise) + sum(ok(t), (r) => r.contributionPaise),
    };
  });

  const byProduct = productBreakdown(dOk, rOk, config);
  const daily = dailySeries(inputs, rows, metaIn, config, credit);

  // ---- reconciliations
  const reconciliations = [
    {
      key: 'funnel',
      label: 'On record = excluded + cancelled + delivered + RTO + pending + lost',
      a: funnel.onRecord,
      b: funnel.excluded + funnel.cancelled + funnel.delivered + funnel.rto + funnel.pending + funnel.lost,
      agree: false,
    },
    {
      key: 'meta',
      label: 'Meta month total = sum of the daily rows',
      a: metaSpend,
      b: sum(daily, (d) => d.metaSpendPaise),
      agree: false,
    },
    {
      key: 'courier',
      label: 'Courier total = sum of the courier ledger (plus any hand-entered cost)',
      /*
       * Every paisa the courier billed, as the report attributed it, against
       * every paisa the ledger holds. Pending and incomplete rows are in here
       * even though they are not in the P&L: this check is about the ledger
       * being fully accounted for, and a month with no pending parcels has
       * never happened. It is what catches a parcel whose charge was dropped
       * on the floor by a share that did not add back to 1.
       */
      a:
        sum(rows, (r) => (r.forwardFreightPaise ?? 0) + (r.rtoFreightPaise ?? 0) + (r.codChargePaise ?? 0)) +
        otherCourierOnlyPaise,
      b:
        sum(inputs.charges, (c) => {
          const legs = parcelLegs(c, config);
          return legs ? legs.total : 0;
        }) + manualCourierPaise,
      agree: false,
    },
  ].map((r) => ({ ...r, agree: r.a === r.b }));

  for (const f of inputs.sourceStatus.failures) flag('source_failed', null, f);

  return {
    month: inputs.month,
    monthStartUtc: inputs.monthStartUtc,
    monthEndUtc: inputs.monthEndUtc,
    generatedAt: inputs.generatedAt,
    trigger: inputs.trigger,
    // "provisional" while anything could still change the numbers.
    provisional: funnel.pending > 0 || totals.blockedDelivered > 0 || totals.blockedRto > 0,
    note: 'Offline sales not recorded in Shopify are not included. Boost spend is included.',
    settlement: settlementCut(rows, inputs, ctx, netRevenue),
    openQuestions,
    funnel,
    rows,
    statement,
    totals,
    ratios,
    unitEconomics,
    byPaymentType,
    byProduct,
    daily,
    meta: { rows: metaIn, salesPaise: metaSales, boostPaise: metaBoost, otherPaise: metaOther, gstPaise: metaGst, totalPaise: totalMeta },
    flags,
    reconciliations,
    assumptions: assumptionRows(config),
    sourceStatus: inputs.sourceStatus,
  };
}

/**
 * When this order's parcel actually reached the customer, as a UTC instant.
 *
 * Delhivery first, and only through customerDeliveredAt, which returns null on
 * any RTO because an RTO's DeliveryDate is the return-accepted time. Shopify's
 * fulfilment date is the fallback and already carries Z. Null when nothing
 * knows, which is #1205: delivery inferred from COD cash, with no AWB at all.
 * @param {ReportRow} row
 * @param {{shipByAwb: Map<string, NormShipment>}} ctx
 * @returns {string|null}
 */
function deliveredAtUtc(row, ctx) {
  for (const s of shipmentsOf(row.order, ctx)) {
    const at = customerDeliveredAt(s);
    if (at) return istWallToUtc(at);
  }
  return row.order.fulfillments.map((f) => f.deliveredAt).find(Boolean) ?? null;
}

/**
 * THE DISCLOSURE AN ACCOUNTANT ASKS FOR FIRST.
 *
 * The cohort is orders PLACED in the month, which is the specification and is
 * right: it is the only cut that lets a month's ad spend be compared with the
 * orders that spend bought. But settlement does not stop when the month does.
 * A parcel posted on 29 October is delivered in November, its revenue lands in
 * this report, and nothing on the statement says so unless we say it here.
 *
 * Counts and amounts, not prose, so the workbook can place them. The money is
 * taken from rows that are actually IN the statement, so the share always ties
 * to the net revenue line rather than to a figure nobody can reconcile.
 */
function settlementCut(rows, inputs, ctx, netRevenuePaise) {
  const end = Date.parse(inputs.monthEndUtc);
  const delivered = rows.filter((r) => r.outcome === 'DELIVERED');

  const after = delivered
    .map((r) => ({ row: r, deliveredAt: deliveredAtUtc(r, ctx) }))
    .filter((x) => x.deliveredAt != null && Date.parse(x.deliveredAt) >= end)
    .map((x) => ({
      name: x.row.order.name,
      deliveredAt: x.deliveredAt,
      netRevenuePaise: x.row.complete ? x.row.netRevenuePaise : null,
      countedInStatement: x.row.complete,
    }))
    .sort((a, b) => String(a.deliveredAt).localeCompare(String(b.deliveredAt)));

  const afterMoney = sum(after, (o) => o.netRevenuePaise);
  const rtoOpen = rows
    .filter((r) => r.outcome === 'RTO' && !rtoIsFinal(shipmentsOf(r.order, ctx)))
    .map((r) => r.order.name);
  const rtoStartedAfter = rows
    .filter((r) => r.outcome === 'RTO')
    .filter((r) =>
      shipmentsOf(r.order, ctx).some((sh) => {
        const at = istWallToUtc(sh.rtoStartedAt);
        return at != null && Date.parse(at) >= end;
      }),
    )
    .map((r) => r.order.name);

  const share = pct(afterMoney, netRevenuePaise);
  return {
    cohortBasis: 'orders placed in the month (IST), not orders delivered in it',
    monthEndUtc: inputs.monthEndUtc,
    deliveredTotal: delivered.length,
    deliveredAfterMonthEnd: after.length,
    deliveredAfterMonthEndCounted: after.filter((o) => o.countedInStatement).length,
    netRevenueAfterMonthEndPaise: afterMoney,
    netRevenueAfterMonthEndPct: share,
    orders: after,
    rtoLegsNotFinal: rtoOpen.length,
    rtoLegsNotFinalOrders: rtoOpen,
    rtoStartedAfterMonthEndOrders: rtoStartedAfter,
    note:
      'This month is the orders PLACED in it (IST). Settlement continues afterwards: ' +
      `${after.length} of ${delivered.length} delivered orders were delivered after the month closed` +
      (afterMoney
        ? `, carrying ${(afterMoney / 100).toFixed(2)} of net revenue` +
          (share == null ? '' : ` (${share.toFixed(1)}% of the total)`)
        : '') +
      (rtoOpen.length ? `, and ${rtoOpen.length} RTO parcels have not reached us yet` : '') +
      '.',
  };
}

/**
 * An excluded order still gets a row: it is a real row in Shopify.
 * @returns {ReportRow}
 */
function excludedRow(order, reason, ctx) {
  return {
    order,
    outcome: 'EXCLUDED',
    outcomeReason: reason,
    outcomeInferred: false,
    awbs: order.awbs,
    parcelShare: 1,
    grossSalePaise: null,
    outputGstPaise: null,
    netRevenuePaise: null,
    cogsPaise: null,
    forwardFreightPaise: null,
    rtoFreightPaise: null,
    codChargePaise: null,
    packingPaise: order.fulfillments.length ? ctx.config.packingCostPerOrderPaise : 0,
    gatewayFeePaise: null,
    advanceKeptPaise: null,
    totalCostPaise: null,
    contributionPaise: null,
    chargeSource: 'missing',
    complete: false,
    missing: [],
    assumed: [],
    flags: [reason],
  };
}

/**
 * Replacements: both legs plus packing on the outgoing parcel, and a
 * reimbursement only when the money is recorded in Shopify. A job we have
 * cancelled is not a cost; October's only job is the test order #1222, whose
 * two waybills were never collected.
 */
function replacementTotals(inputs, ctx) {
  const { config } = ctx;
  let netPaise = 0;
  /** @type {string[]} */
  const awbs = [];
  /** @type {{orderName:string|null, note:string}[]} */
  const flags = [];
  for (const job of inputs.replacements) {
    if (job.state === 'CANCELLED') {
      flags.push({ orderName: job.orderName, note: `replacement job ${job.seq} is cancelled: not costed` });
      continue;
    }
    let cost = 0;
    for (const [awb, quote] of [
      [job.forwardAwb, job.quoteForwardPaise],
      [job.returnAwb, job.quoteReturnPaise],
    ]) {
      if (!awb) continue;
      awbs.push(String(awb));
      const legs = parcelLegs(ctx.chargeByAwb.get(String(awb)), config);
      if (legs) {
        cost += legs.total;
      } else if (quote != null) {
        cost += Number(quote);
        flags.push({ orderName: job.orderName, note: `${awb}: quoted, not billed` });
      } else {
        flags.push({ orderName: job.orderName, note: `${awb}: no charge and no quote` });
      }
    }
    if (job.forwardAwb) cost += config.packingCostPerOrderPaise;
    if (job.pays === 'customer' && job.reimbursementReceived) {
      cost -= (job.quoteForwardPaise ?? 0) + (job.quoteReturnPaise ?? 0);
    } else if (job.pays === 'customer') {
      flags.push({ orderName: job.orderName, note: 'customer pays, reimbursement expected but not verified' });
    }
    netPaise += cost;
  }
  return { netPaise, awbs, flags };
}

/**
 * By product, allocated by line value. A row's contribution is one number for
 * the whole order, so a multi-line order splits it by each line's share of the
 * order's line value: approximate by construction, and named as such on the
 * sheet rather than presented as per-garment truth.
 */
function productBreakdown(deliveredOk, rtoOk, config) {
  /** @type {Map<string, any>} */
  const byTitle = new Map();
  const get = (title) => {
    if (!byTitle.has(title)) {
      byTitle.set(title, {
        title,
        unitsDelivered: 0,
        netRevenuePaise: 0,
        cogsPaise: 0,
        grossMarginPct: null,
        rtoUnits: 0,
        rtoLossPaise: 0,
        contributionPaise: 0,
      });
    }
    return byTitle.get(title);
  };

  for (const r of deliveredOk) {
    const live = liveLines(r.order);
    const lineValue = sum(live, (l) => l.discountedUnitPaise * l.currentQuantity);
    for (const l of live) {
      const share = lineValue > 0 ? (l.discountedUnitPaise * l.currentQuantity) / lineValue : 1 / live.length;
      const p = get(l.title);
      p.unitsDelivered += l.currentQuantity;
      const { gstPaise } = lineGstPaise(l.discountedUnitPaise, l.currentQuantity, config.gstSlabs);
      p.netRevenuePaise += l.discountedUnitPaise * l.currentQuantity - gstPaise;
      p.cogsPaise += (l.unitCostPaise ?? 0) * l.currentQuantity;
      p.contributionPaise += Math.round((r.contributionPaise ?? 0) * share);
    }
  }
  for (const r of rtoOk) {
    const live = liveLines(r.order);
    const lineValue = sum(live, (l) => l.discountedUnitPaise * l.currentQuantity);
    for (const l of live) {
      const share = lineValue > 0 ? (l.discountedUnitPaise * l.currentQuantity) / lineValue : 1 / live.length;
      const p = get(l.title);
      p.rtoUnits += l.currentQuantity;
      p.rtoLossPaise += Math.round(-(r.contributionPaise ?? 0) * share);
    }
  }
  for (const p of byTitle.values()) {
    p.grossMarginPct = pct(p.netRevenuePaise - p.cogsPaise, p.netRevenuePaise);
  }
  return [...byTitle.values()].sort((a, b) => b.netRevenuePaise - a.netRevenuePaise);
}

/** Every day of the IST month, by ORDER date, with a running net. */
function dailySeries(inputs, rows, metaIn, config, credit) {
  const dates = istDatesIn(inputs.monthStartUtc, inputs.monthEndUtc);
  /** @type {Map<string, ReportRow[]>} */
  const byDate = new Map(dates.map((d) => [d, []]));
  for (const r of rows) {
    if (r.outcome === 'EXCLUDED') continue;
    const k = istDateKey(r.order.createdAt);
    const bucket = byDate.get(k);
    if (bucket) bucket.push(r);
  }
  const metaByDate = new Map();
  for (const m of metaIn) metaByDate.set(m.date, (metaByDate.get(m.date) ?? 0) + m.spendPaise);

  let cumulative = 0;
  return dates.map((date) => {
    const rs = byDate.get(date) || [];
    const d = rs.filter((r) => r.outcome === 'DELIVERED' && r.complete);
    const t = rs.filter((r) => r.outcome === 'RTO' && r.complete);
    const netRevenue = sum(d, (r) => r.netRevenuePaise);
    const cogs = sum(d, (r) => r.cogsPaise);
    const freight = sum(d, (r) => (r.forwardFreightPaise ?? 0) + (r.codChargePaise ?? 0));
    const rtoLoss = sum(t, (r) => -(r.contributionPaise ?? 0));
    const packing = sum(d, (r) => r.packingPaise);
    const gateway = sum(d, (r) => r.gatewayFeePaise);
    const spend = metaByDate.get(date) ?? 0;
    const metaWithGst = credit ? spend : spend + Math.round((spend * config.metaGstPct) / 100);
    const contribution = netRevenue - cogs - freight - packing - gateway;
    const net = contribution - rtoLoss - metaWithGst;
    cumulative += net;
    return {
      date,
      ordersPlaced: rs.length,
      delivered: rs.filter((r) => r.outcome === 'DELIVERED').length,
      rto: rs.filter((r) => r.outcome === 'RTO').length,
      pending: rs.filter((r) => r.outcome === 'PENDING').length,
      cancelled: rs.filter((r) => r.outcome === 'CANCELLED').length,
      netRevenuePaise: netRevenue,
      cogsPaise: cogs,
      freightAndCodPaise: freight,
      rtoLossPaise: rtoLoss,
      packingPaise: packing,
      gatewayFeesPaise: gateway,
      metaSpendPaise: spend,
      contributionPaise: contribution,
      netPaise: net,
      cumulativeNetPaise: cumulative,
    };
  });
}
