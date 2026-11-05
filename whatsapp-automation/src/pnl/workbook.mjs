/*
 * pnl/workbook.mjs — renders one month's Report into an .xlsx Buffer.
 *
 * THE LAMBDA LAYER (read this before deploying).
 * This service has no runtime dependencies and iac/lib/stack.js builds the
 * Lambda asset with `exclude: [... 'node_modules' ...]`, so nothing from npm
 * reaches a function by itself. exceljs therefore ships as a LAYER:
 *
 *     npm run pnl:layer          # scripts/build-pnl-layer.sh
 *     -> iac/layers/pnl/nodejs/node_modules/exceljs   (+ its own deps)
 *
 * The layer directory that CDK must point at is `iac/layers/pnl`, and the
 * runtime requires the `nodejs/node_modules` prefix inside it — that is what
 * puts exceljs on the function's NODE_PATH. Whoever wires the stack adds:
 *
 *     const pnlLayer = new lambda.LayerVersion(this, 'PnlLayer', {
 *       code: lambda.Code.fromAsset(path.join(__dirname, '..', 'layers', 'pnl')),
 *       compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
 *     });
 *
 * and attaches it to the wa-pnl-report function only. iac/layers/ is
 * gitignored: the layer is built at deploy time, never committed.
 *
 * The import below is dynamic and inside try/catch, in the shape of
 * clients/email.mjs, because the module genuinely may not be there: unit tests
 * and the type checker must not need the layer, and a cold start without it
 * must fail with a sentence that names the fix rather than a MODULE_NOT_FOUND.
 *
 * ---------------------------------------------------------------------------
 * WHAT buildWorkbook READS (the integration contract)
 *
 * Required: `report.rows` (ReportRow[] from src/domain/pnl/types.mjs). Every
 * money figure in the workbook is aggregated from these rows, so the Summary,
 * the Daily sheet and the per-order sheets agree by construction.
 *
 * Optional, each degrading to a "none this month" row rather than throwing:
 *   report.funnel          {onRecord, excluded, cancelled, shipped, delivered,
 *                           rto, pending, lost}  — derived from rows if absent
 *   report.ratios          {aov, rtoRateByOrder, rtoRateByParcel, ...} — same
 *   report.flags           [{code|label, count, severity?, note?}] or string[]
 *   report.reconciliations [{name|check, expected, actual, ok?, note?}]
 *   report.assumptions     [{key, label, value, unit?, source, note?, input?}]
 *   report.config          PnlConfig (packing, gateway %, Meta GST, rules of thumb)
 *   report.meta            MetaDay[], or the engine's own
 *                          {rows, salesPaise, ...} wrapper -> Meta Ads + the
 *                          Daily spend column. Both shapes are accepted.
 *   report.charges         CourierCharge[]  -> Courier Ledger
 *   report.shipments       NormShipment[]   -> Courier Ledger status columns
 *   report.replacements    ReplacementJob[] -> Replacements
 *
 * charges, shipments and replacements are NOT on the engine's Report: they are
 * PnlInputs, and only the orchestrator has both. It can put them on the report
 * it passes here, or hand the whole inputs object as `report.inputs`; either is
 * read. Without them the Courier Ledger and Replacements sheets render their
 * "none this month" row, which is a lie about a month that did have parcels,
 * so the orchestrator has to pass them.
 *   report.lastMonthUpdate [{orderName, was, now, at?, deltaPaise?, note?}]
 *                          -> sheet 11, which is OMITTED when this is absent
 *   report.previousMonth   {label?, reported:{}, restated:{}} -> Summary block
 *   report.totals          used ONLY as a cross-check on Data Checks. The
 *                          statement itself never reads it: a Summary cell and
 *                          its live formula have to be the same number, and the
 *                          only way to guarantee that is to total what the
 *                          workbook actually rendered.
 *
 * `meta` is {month, monthLabel, provisional, generatedAtIST, trigger,
 * courierChargeBasis, incomplete} plus optional `adminOrderUrlBase`. Without
 * that base the Order # column stays plain text — a link to the wrong store is
 * worse than no link.
 *
 * MONEY ARRIVES AS INTEGER PAISE. Every total is computed in paise and divided
 * by 100 once, at the cell. Cells carry real numbers and a number format,
 * never a pre-formatted string.
 *
 * EVERY FORMULA CARRIES ITS CACHED RESULT (`{formula, result}`). A formula
 * without one shows blank in Numbers, in Google Sheets' first paint and in the
 * WhatsApp document preview, which is where this report is actually read.
 */

import { shopifyConflict } from '../domain/pnl/outcome.mjs';
import { istWallToUtc } from '../domain/pnl/cohort.mjs';

/** @typedef {import('../domain/pnl/types.mjs').ReportRow} ReportRow */

// ---------------------------------------------------------------------------
// exceljs, which may not be in this bundle.

let xl = null;
async function exceljs() {
  if (xl) return xl;
  try {
    const mod = await import('exceljs');
    xl = /** @type {any} */ (mod).default ?? mod;
  } catch (e) {
    throw new Error(
      'pnl/workbook: exceljs is not available in this bundle. The Lambda asset ' +
        'excludes node_modules, so exceljs must come from the pnl layer ' +
        '(iac/layers/pnl/nodejs/node_modules/exceljs, built by `npm run pnl:layer`). ' +
        'Underlying error: ' + /** @type {any} */ (e).message,
    );
  }
  return xl;
}

// ---------------------------------------------------------------------------
// Look.

const GREEN = 'FF2E4B3C';
const GOLD = 'FFB08D57';
const RED_TAB = 'FFC0392B';
const AMBER_TAB = 'FFE1A94F';
const GREY_TAB = 'FF808080';
const AMBER_FILL = 'FFFFE0A3'; // a cell we could not fill in
const LOSS_FILL = 'FFFCE4E4'; // a row that lost money
const ZEBRA_FILL = 'FFF7F5F0';
const INPUT_FILL = 'FFFFF2CC'; // pale yellow: edit me
const TITLE_SIZE = 16;

const FMT = {
  money: '₹#,##0;[Red]-₹#,##0',
  money2: '₹#,##0.00;[Red]-₹#,##0.00',
  pct: '0.0%',
  date: 'dd-mmm-yyyy',
  int: '#,##0',
  num1: '0.0',
};

const BODY = { name: 'Calibri', size: 10 };
const BODY_B = { name: 'Calibri', size: 10, bold: true };
const HEAD_FONT = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
const solid = (argb) => ({ type: /** @type {const} */ ('pattern'), pattern: /** @type {const} */ ('solid'), fgColor: { argb } });

const DELHIVERY_TRACK = 'https://www.delhivery.com/track/package/';

// ---------------------------------------------------------------------------
// Small pure helpers.

const colLetter = (n) => {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1 - r) / 26;
  }
  return s;
};

/** paise -> rupees, exact to 2dp. */
const rup = (paise) => Math.round(Number(paise)) / 100;
/** Sum a paise field over rows, treating unknown (null) as nothing. */
const sumP = (arr, f) => arr.reduce((a, r) => a + (f(r) ?? 0), 0);
/** How many rows had an unknown where we needed a number. */
const nullsIn = (arr, f) => arr.filter((r) => f(r) == null).length;
const round2 = (n) => Math.round(n * 100) / 100;

/*
 * EVERY DATE IN THIS FILE GOES THROUGH istWallToUtc FIRST.
 *
 * Delhivery's timestamps carry no offset and are IST wall time, and
 * `Date.parse` reads an offsetless stamp as LOCAL time. Our machines are IST,
 * so every local run has been right and would have stayed right forever; on a
 * Lambda running UTC the same stamp lands 5.5 hours early, which is enough to
 * file a 31 Oct 23:00 IST scan under November. Shopify's stamps carry Z and
 * pass through untouched, so normalising at the two entry points below covers
 * the delivered date, the RTO start and return dates, the Not Delivered status
 * date, days-to-deliver and the Daily bucketing in one place.
 */

/** IST calendar date of a stamp, as 'YYYY-MM-DD'. */
function istDay(iso) {
  const norm = istWallToUtc(iso);
  if (!norm) return null;
  return new Date(Date.parse(norm) + 330 * 60 * 1000).toISOString().slice(0, 10);
}
const daysInMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
/** A date cell for an ISO instant, placed on its IST day so it never reads a day early. */
function dateCell(iso) {
  const d = istDay(iso);
  return d ? new Date(d + 'T00:00:00Z') : null;
}
const daysBetween = (a, b) => {
  const x = istWallToUtc(a);
  const y = istWallToUtc(b);
  if (!x || !y) return null;
  return Math.round(((Date.parse(y) - Date.parse(x)) / 86400000) * 10) / 10;
};

// Cell descriptors understood by writeTable / put.
/** A number we could not establish: amber, with the reason as a note. */
const miss = (why) => ({ _miss: why || 'not available' });
/** paise -> cell, or MISSING when the engine said null. */
const money = (paise, why) => (paise == null ? miss(why || 'cost not available') : rup(paise));
/** A live formula with its cached result. */
const fx = (formula, result) => ({ formula, result: result == null ? 0 : result });
/** A value we inferred rather than read: italic. */
const inferred = (v, why) => ({ _v: v, italic: true, note: why });
const noted = (v, why) => ({ _v: v, note: why });
const link = (text, url) => (url ? { text: String(text), hyperlink: url } : String(text));

// ---------------------------------------------------------------------------
// The table writer. One of these per block; sheets are just stacked blocks.

/**
 * @typedef {Object} Col
 * @property {string} h            header text
 * @property {string} [fmt]        number format
 * @property {number} [w]          forced width
 * @property {boolean} [wrap]
 * @property {string|((h:TableHandle)=>any)} [total]  'sum', or a builder for a custom total cell
 *
 * @typedef {Object} TableHandle
 * @property {number} header
 * @property {number} first
 * @property {number} last
 * @property {number|null} totals
 * @property {(h:string)=>string} letter
 * @property {(h:string)=>string} ref        'Sheet'!$C$2:$C$40
 * @property {(h:string)=>string} totalRef   'Sheet'!$C$41
 * @property {(h:string)=>number} sum        the cached total we wrote
 */

/**
 * Write one header row, the body, and (when any column asks for it) a totals
 * row of SUM formulas with their results.
 *
 * @param {any} ws
 * @param {Col[]} cols
 * @param {any[][]} rows
 * @param {{startRow?:number, zebra?:boolean, filter?:boolean, freeze?:boolean,
 *          totalsLabel?:string, rowFill?:(row:any[], i:number)=>string|null,
 *          empty?:string, countedCol?:string}} [opts]
 * @returns {TableHandle}
 */
function writeTable(ws, cols, rows, opts = {}) {
  const startRow = opts.startRow ?? 1;
  const widths = cols.map((c) => Math.max(String(c.h).length + 2, 9));

  const hr = ws.getRow(startRow);
  cols.forEach((c, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = c.h;
    cell.font = HEAD_FONT;
    cell.fill = solid(GREEN);
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: GOLD } } };
  });
  hr.height = 26;

  // An empty section says so, in one row, rather than leaving a bare header.
  const body = rows.length ? rows : [[opts.empty ?? 'none this month']];
  const isEmpty = rows.length === 0;

  body.forEach((r, ri) => {
    const rowNo = startRow + 1 + ri;
    const fill = isEmpty ? null : (opts.rowFill?.(r, ri) ?? (opts.zebra && ri % 2 ? ZEBRA_FILL : null));
    for (let ci = 0; ci < cols.length; ci++) {
      const cell = ws.getRow(rowNo).getCell(ci + 1);
      const shown = put(cell, r[ci], cols[ci], fill);
      if (shown.length + 2 > widths[ci]) widths[ci] = shown.length + 2;
    }
  });

  const first = startRow + 1;
  const last = startRow + body.length;
  /*
   * THE ENGINE'S RULE, IN EXCEL. Only a COMPLETE row contributes to a total:
   * an order whose freight we could not read would otherwise put its revenue
   * in the total and leave its cost out, and the month would read richer than
   * it was. countedCol names a 1/0 column, every total becomes a SUMIF over
   * it, and the cached result sums the same rows the formula does. The
   * incomplete row stays on the sheet, with its amber cells, out of the total.
   */
  const flagIdx = opts.countedCol ? cols.findIndex((c) => c.h === opts.countedCol) : -1;
  const flagL = flagIdx >= 0 ? colLetter(flagIdx + 1) : null;
  const flagRange = flagL ? `$${flagL}$${first}:$${flagL}$${last}` : null;
  const numOf = (v) =>
    typeof v === 'number' ? v : typeof v?.result === 'number' ? v.result : typeof v?._v === 'number' ? v._v : 0;
  const inTotal = (r) => flagIdx < 0 || numOf(r[flagIdx]) === 1;
  let totals = null;
  const handle = {
    header: startRow,
    first,
    last,
    totals: /** @type {number|null} */ (null),
    letter: (h) => colLetter(cols.findIndex((c) => c.h === h) + 1),
    ref: (h) => {
      const L = handle.letter(h);
      return `'${ws.name}'!$${L}$${first}:$${L}$${last}`;
    },
    totalRef: (h) => `'${ws.name}'!$${handle.letter(h)}$${totals ?? last}`,
    sum: (h) => cachedSums[h] ?? 0,
    /*
     * The cross-sheet total of one column, as a formula string, counted-aware.
     * The Summary builds its statement out of these so a statement line and the
     * sheet it came from can never disagree.
     */
    sumOf: (h) =>
      flagRange
        ? `SUMIF('${ws.name}'!${flagRange},1,${handle.ref(h)})`
        : `SUM(${handle.ref(h)})`,
    countedRef: () => (flagRange ? `SUM('${ws.name}'!${flagRange})` : String(body.length)),
    flagRange: () => (flagRange ? `'${ws.name}'!${flagRange}` : null),
  };

  /** @type {Record<string, number>} */
  const cachedSums = {};
  for (const c of cols) {
    if (!c.total) continue;
    const i = cols.indexOf(c);
    cachedSums[c.h] = isEmpty
      ? 0
      : round2(body.reduce((a, r) => (i !== flagIdx && !inTotal(r) ? a : a + numOf(r[i])), 0));
  }

  if (cols.some((c) => c.total)) {
    totals = last + 1;
    handle.totals = totals;
    const tr = ws.getRow(totals);
    cols.forEach((c, i) => {
      const cell = tr.getCell(i + 1);
      if (i === 0) cell.value = opts.totalsLabel ?? 'TOTAL';
      else if (c.total === 'sum') {
        const L = colLetter(i + 1);
        const range = `${L}${first}:${L}${last}`;
        cell.value = fx(
          flagRange && i !== flagIdx ? `SUMIF(${flagRange},1,${range})` : `SUM(${range})`,
          cachedSums[c.h],
        );
      } else if (typeof c.total === 'function') cell.value = c.total(handle);
      cell.font = BODY_B;
      cell.fill = solid(GOLD);
      cell.numFmt = c.fmt;
      cell.border = { top: { style: 'thin', color: { argb: GREEN } } };
    });
  }

  if (opts.filter !== false) {
    ws.autoFilter = {
      from: { row: startRow, column: 1 },
      to: { row: last, column: cols.length },
    };
  }
  if (opts.freeze !== false) {
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: startRow }];
  }
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    const want = c.w ?? Math.min(widths[i], 45);
    if (!col.width || col.width < want) col.width = Math.min(want, 45);
  });
  return handle;
}

/**
 * Put one descriptor in one cell. Returns the text it will occupy, for sizing.
 * @param {any} cell
 * @param {any} v
 * @param {{fmt?:string, wrap?:boolean}} [col]
 * @param {string|null} [fill]
 * @returns {string}
 */
function put(cell, v, col = {}, fill = null) {
  let font = BODY;
  let numFmt = col.fmt;
  let shown = '';
  if (v == null || v === '') {
    cell.value = null;
  } else if (typeof v === 'object' && '_miss' in v) {
    cell.value = 'MISSING';
    cell.fill = solid(AMBER_FILL);
    cell.note = String(v._miss);
    numFmt = undefined;
    shown = 'MISSING';
  } else if (typeof v === 'object' && 'formula' in v) {
    cell.value = v;
    if (v.fmt) numFmt = v.fmt;
    shown = String(v.result ?? '');
  } else if (typeof v === 'object' && 'hyperlink' in v) {
    cell.value = v;
    font = { ...BODY, color: { argb: 'FF1155CC' }, underline: true };
    shown = v.text;
  } else if (typeof v === 'object' && '_v' in v) {
    cell.value = v._v;
    if (v.fmt) numFmt = v.fmt;
    if (v.italic) font = { ...BODY, italic: true };
    if (v.note) cell.note = String(v.note);
    shown = v._v instanceof Date ? '00-aaa-0000' : String(v._v ?? '');
  } else {
    cell.value = v;
    shown = v instanceof Date ? '00-aaa-0000' : String(v);
  }
  cell.font = font;
  if (numFmt) cell.numFmt = numFmt;
  if (fill && !cell.fill) cell.fill = solid(fill);
  if (col.wrap) cell.alignment = { wrapText: true, vertical: 'top' };
  return shown;
}

/** Landscape, one page wide, header repeated, page number in the footer. */
function printSetup(ws, headerRow = 1) {
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${headerRow}:${headerRow}`,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  ws.headerFooter = { oddFooter: '&L&"Calibri,Italic"&8Morpaankh P&&L&CPage &P of &N' };
}

// ---------------------------------------------------------------------------
// Resolving a row.
//
// One rule, applied everywhere: THE WORKBOOK TOTALS WHAT THE WORKBOOK RENDERS.
// A cell that carries a formula over a named input (packing, gateway %) is
// rendered from that input, so the cached result and the live formula can never
// disagree. Where that differs from the figure the engine sent, Data Checks
// says so out loud instead of the sheet quietly contradicting itself.

/** Percentages reach us as either 18 or 0.18. Treat anything above 1 as percent. */
const frac = (x) => (x == null ? 0 : Number(x) > 1 ? Number(x) / 100 : Number(x));

const CFG_DEFAULTS = {
  packingCostPerOrderPaise: 0,
  gatewayFeePct: 0,
  gatewayGstPct: 0,
  metaGstPct: 0,
  gstInputCreditClaimed: false,
  ruleOfThumbPrepaidPaise: 11000,
  ruleOfThumbCodPaise: 17000,
  fixedMonthlyCosts: /** @type {{label:string, amountPaise:number}[]} */ ([]),
};

const PAY_LABEL = { cod: 'COD', prepaid: 'Prepaid', partial: 'Partial' };

/*
 * The engine blocks a row from every total when anything it needs is null
 * (engine.mjs: `ok = rs.filter(r => r.complete)`), because a row that brings
 * its revenue but not its freight makes the month read richer than it was.
 * The workbook has to block exactly the same rows or its totals disagree with
 * the engine's, which is what the Data Checks cross-check caught in October.
 *
 * `complete !== false` rather than `=== true`: a report that never set the flag
 * counts everything, which is the old behaviour.
 */
const counted = (r) => r.complete !== false;
const whyBlocked = (r) =>
  `Excluded from every total: ${(r.missing ?? []).join(', ') || 'the row is incomplete'}. ` +
  'The amounts are shown so you can see the order and fix it.';
const isAssumed = (r, what) => (r.assumed ?? []).some((a) => String(a).includes(what));

/**
 * Delhivery has never returned a weighed figure on this account: ChargedWeight
 * is null on every shipment, and the charges API echoes back the cgm we sent.
 * So a weight is "assumed" unless the charge line explicitly says otherwise.
 */
const WEIGHT_NOTE =
  'This is the weight we SENT to Delhivery, not a weight anyone measured. ' +
  'Delhivery returns no charged weight on this account, and its charges API echoes back ' +
  'the value we pass it, so every freight figure on this report rests on this assumption. ' +
  'Upload the Delhivery charge ledger to replace it with actuals.';
const weightAssumed = (l) =>
  l.charge?.weightAssumed !== false &&
  (l.charge?.weightAssumed === true || l.ship?.chargedWeightGrams == null);
const unitsOf = (r) => (r.order.lines ?? []).reduce((a, l) => a + (l.currentQuantity ?? 0), 0);
const itemsOf = (r) =>
  (r.order.lines ?? [])
    .filter((l) => (l.currentQuantity ?? 0) > 0)
    .map((l) => `${l.currentQuantity} x ${l.title}`)
    .join(', ');
const rtoReason = (r) =>
  (r.order.tags ?? []).filter((t) => /^rto-reason-/.test(t)).map((t) => t.replace(/^rto-reason-/, '')).join(', ') || null;

/**
 * Everything a money cell on a per-order sheet needs, in paise, already
 * reconciled with the formulas we are about to write.
 */
function resolve(r, cfg) {
  const share = r.parcelShare == null ? 1 : r.parcelShare;
  const gross = r.order.currentTotalPaise ?? 0;
  const refunds = r.order.refundedPaise ?? 0;
  /*
   * PACKING COMES FROM THE ENGINE, not from a share recomputed here.
   *
   * The engine splits one parcel's packing across the orders in it with a
   * remainder-preserving split, and an order that shipped in two parcels pays
   * for two. Recomputing `config x parcelShare` with Math.round got both of
   * those wrong, which is where October's Rs 47.06 RTO-loss disagreement came
   * from. The cell still has to recalculate when the packing input is edited,
   * so it carries `pnl_packing_per_order * factor`, where the factor is this
   * order's multiple of one packing unit as the engine worked it out.
   */
  const base = cfg.packingCostPerOrderPaise ?? 0;
  const packing = r.packingPaise ?? Math.round(base * share);
  const packingFactor = base ? Math.round((packing / base) * 1e6) / 1e6 : 0;
  /*
   * GATEWAY FEE COMES FROM THE ENGINE, not from a recompute on the order total.
   *
   * A fee is only charged where money actually moved through a gateway: a
   * prepaid order on its full total less refunds, a PARTIAL order on the
   * deposit alone, and a COD order never. Recomputing from
   * `order.currentTotalPaise` charged a partial order on money that never
   * reached a gateway, which is where October's Rs 71.52 on the delivered
   * gateway line and Rs 47.06 on the RTO line both came from (RTO loss carries
   * the gateway fee too).
   *
   * `onlinePaise` mirrors the engine's own base so the cell's formula, which
   * has to stay live on the gateway inputs, recalculates to the same figure.
   */
  const onlinePaise =
    r.order.paymentType === 'prepaid'
      ? Math.max(0, gross - refunds)
      : r.order.paymentType === 'partial'
        ? (r.order.prepaidReceivedPaise ?? 0)
        : 0;
  const gatewayAssumed = isAssumed(r, 'gateway') && onlinePaise > 0;
  const gateway = r.gatewayFeePaise;
  const cogs = r.cogsPaise;
  const fwd = r.forwardFreightPaise;
  const rto = r.rtoFreightPaise;
  const cod = r.codChargePaise;
  const gst = r.outputGstPaise;
  const netRev = gross - refunds - (gst ?? 0);
  const cost = (cogs ?? 0) + (fwd ?? 0) + (cod ?? 0) + packing + (gateway ?? 0);
  const advance = r.advanceKeptPaise ?? 0;
  return {
    share, gross, refunds, gst, netRev, cogs, fwd, rto, cod, packing, packingFactor,
    gateway, gatewayAssumed, onlinePaise,
    cost,
    contribution: netRev - cost,
    advance,
    rtoLoss: (fwd ?? 0) + (rto ?? 0) + (cod ?? 0) + packing + (gateway ?? 0) - advance,
  };
}

/** Group rows by outcome, then total the statement from the resolved values. */
function aggregate(rows, cfg, metaDays, repl, ledger) {
  /** @type {Record<string, any[]>} */
  const by = { DELIVERED: [], RTO: [], PENDING: [], LOST: [], CANCELLED: [], EXCLUDED: [] };
  for (const r of rows) (by[r.outcome] ??= []).push(r);
  const res = new Map(rows.map((r) => [r.order.name, resolve(r, cfg)]));
  const R = (r) => res.get(r.order.name);

  // Only COMPLETE rows reach a total; the funnel still counts every order.
  const d = (by.DELIVERED ?? []).filter(counted);
  const t = (by.RTO ?? []).filter(counted);
  const blocked = {
    delivered: (by.DELIVERED ?? []).filter((r) => !counted(r)),
    rto: (by.RTO ?? []).filter((r) => !counted(r)),
    cancelled: (by.CANCELLED ?? []).filter((r) => !counted(r)),
    lost: (by.LOST ?? []).filter((r) => !counted(r)),
  };
  const del = {
    count: (by.DELIVERED ?? []).length,
    counted: d.length,
    gross: sumP(d, (r) => R(r).gross),
    refunds: sumP(d, (r) => R(r).refunds),
    gst: sumP(d, (r) => R(r).gst),
    cogs: sumP(d, (r) => R(r).cogs),
    fwd: sumP(d, (r) => R(r).fwd),
    cod: sumP(d, (r) => R(r).cod),
    packing: sumP(d, (r) => R(r).packing),
    gateway: sumP(d, (r) => R(r).gateway),
  };
  del.netRev = del.gross - del.refunds - del.gst;
  del.contribution = del.netRev - del.cogs - del.fwd - del.cod - del.packing - del.gateway;

  const rto = {
    count: (by.RTO ?? []).length,
    counted: t.length,
    fwd: sumP(t, (r) => R(r).fwd),
    ret: sumP(t, (r) => R(r).rto),
    cod: sumP(t, (r) => R(r).cod),
    packing: sumP(t, (r) => R(r).packing),
    gateway: sumP(t, (r) => R(r).gateway),
    advance: sumP(t, (r) => R(r).advance),
  };
  rto.loss = rto.fwd + rto.ret + rto.cod + rto.packing + rto.gateway - rto.advance;

  const cancelled = sumP((by.CANCELLED ?? []).filter(counted), (r) => r.totalCostPaise);
  // The engine adds a LOST line the brief's statement does not have, because a
  // lost parcel really loses both the garment and the freight.
  const lost = sumP((by.LOST ?? []).filter(counted), (r) => r.totalCostPaise);
  const chargeByAwb = new Map((ledger ?? []).map((l) => [String(l.charge.awb), l.charge]));
  const replNet = repl.reduce((a, j) => a + replacementCost(j, cfg, (awb) => chargeByAwb.get(awb)).net, 0);
  const otherCourier = ledger.filter((l) => l.bucket === 'other').reduce((a, l) => a + (l.charge.totalPaise ?? 0), 0);

  const metaSales = metaDays.filter((m) => m.type === 'sales').reduce((a, m) => a + (m.spendPaise ?? 0), 0);
  const metaOther = metaDays.filter((m) => m.type !== 'sales').reduce((a, m) => a + (m.spendPaise ?? 0), 0);
  const metaGst = cfg.gstInputCreditClaimed ? 0 : Math.round((metaSales + metaOther) * frac(cfg.metaGstPct));
  const fixed = (cfg.fixedMonthlyCosts ?? []).reduce((a, f) => a + (f.amountPaise ?? 0), 0);

  const contribAfterRto = del.contribution - rto.loss - cancelled - replNet - otherCourier - lost;
  const meta = metaSales + metaOther + metaGst;
  return {
    by, res: R, del, rto, cancelled, lost, replNet, otherCourier, blocked,
    metaSales, metaOther, metaGst, meta, fixed,
    contribAfterRto,
    profitBeforeFixed: contribAfterRto - meta,
    net: contribAfterRto - meta - fixed,
  };
}

/**
 * A replacement job's cost to us, and what part of it the P&L carries. This
 * mirrors engine.mjs replacementTotals() line for line, because the statement
 * line is the engine's number.
 *
 * A CANCELLED job is NOT COSTED. October's only replacement was test order
 * #1222, cancelled, on an order excluded by tag, with neither parcel ever
 * collected. The engine skipped it and this sheet charged Rs 99.02 for it.
 *
 * Each leg is the LEDGER charge where Delhivery billed one, and only falls back
 * to the quote when it did not. Reimbursement counts only when the customer is
 * the one paying and the money is actually recorded.
 *
 * @param {any} j
 * @param {any} cfg
 * @param {(awb: string) => any} [chargeFor] ledger lookup by AWB
 */
function replacementCost(j, cfg, chargeFor) {
  const cancelled = String(j.state).toUpperCase() === 'CANCELLED';
  const leg = (awb, quote) => {
    if (!awb) return { paise: 0, billed: false };
    const total = chargeFor?.(String(awb))?.totalPaise;
    if (total != null) return { paise: Number(total), billed: true };
    return { paise: quote == null ? 0 : Number(quote), billed: false, quoted: quote != null };
  };
  const fwd = leg(j.forwardAwb, j.quoteForwardPaise);
  const ret = leg(j.returnAwb, j.quoteReturnPaise);
  const packing = cancelled || !j.forwardAwb ? 0 : (cfg.packingCostPerOrderPaise ?? 0);
  const reimbursed =
    j.pays === 'customer' && j.reimbursementReceived
      ? (j.quoteForwardPaise ?? 0) + (j.quoteReturnPaise ?? 0)
      : 0;
  return {
    cancelled,
    fwd,
    ret,
    packing,
    freight: fwd.paise + ret.paise,
    reimbursed,
    // Cancelled: the engine costs nothing, so neither does the statement.
    net: cancelled ? 0 : fwd.paise + ret.paise + packing - reimbursed,
  };
}

/**
 * Every AWB we know about, with the bucket that decides whether its charge is
 * already inside one of the order sheets or has to come in as "other".
 */
function buildLedger(report) {
  const charges = report.charges ?? report.inputs?.charges ?? [];
  const shipList = report.shipments ?? report.inputs?.shipments ?? [];
  const ships = new Map(shipList.map((s) => [s.awb, s]));
  /** @type {Map<string, {orders:string[], outcome:string|null, payment:string|null}>} */
  const owners = new Map();
  for (const r of report.rows ?? []) {
    for (const awb of r.awbs ?? []) {
      const o = owners.get(awb) ?? { orders: [], outcome: null, payment: null };
      o.orders.push(r.order.name);
      o.outcome = r.outcome;
      o.payment = r.order.paymentType;
      owners.set(awb, o);
    }
  }
  /*
   * Only a job the statement actually costs claims its AWBs. The engine pushes
   * nothing onto repl.awbs for a CANCELLED job, so if Delhivery did bill one of
   * its parcels the charge belongs under "Other courier charges", not here.
   */
  const replAwbs = new Set(
    (report.replacements ?? report.inputs?.replacements ?? [])
      .filter((j) => String(j.state).toUpperCase() !== 'CANCELLED')
      .flatMap((j) => [j.forwardAwb, j.returnAwb])
      .filter(Boolean),
  );
  const seen = new Set();
  const out = [];
  for (const charge of charges) {
    seen.add(charge.awb);
    const own = owners.get(charge.awb);
    const bucket = replAwbs.has(charge.awb)
      ? 'replacement'
      : own
        ? own.outcome === 'DELIVERED' ? 'delivered'
          : own.outcome === 'RTO' ? 'rto'
            : own.outcome === 'CANCELLED' ? 'cancelled'
              : 'not in P&L'
        : 'other';
    out.push({ charge, ship: ships.get(charge.awb) ?? null, own: own ?? null, bucket });
  }
  // A parcel Delhivery tracked but never billed still belongs on the ledger.
  for (const s of shipList) {
    if (seen.has(s.awb)) continue;
    const own = owners.get(s.awb);
    out.push({
      charge: { awb: s.awb, source: 'missing', forwardPaise: null, rtoPaise: null, codChargePaise: null, gstPaise: null, totalPaise: null, zone: null, chargedWeightGrams: null, variancePaise: null, flags: ['no charge on record'] },
      ship: s,
      own: own ?? null,
      bucket: own ? 'not in P&L' : 'other',
    });
  }
  return out.sort((a, b) => String(a.charge.awb).localeCompare(String(b.charge.awb)));
}

// ---------------------------------------------------------------------------
// The sheets.

/** Tab colours the brief pins down; everything else keeps Excel's default. */
const TABS = {
  Summary: GREEN,
  Delivered: GREEN,
  RTO: RED_TAB,
  'Not Delivered': AMBER_TAB,
  'Data Checks': GREY_TAB,
  Assumptions: GREY_TAB,
};
const SHEETS = [
  'Summary', 'Daily', 'Delivered', 'RTO', 'Not Delivered', 'Excluded', 'Replacements',
  'By Product', 'Meta Ads', 'Courier Ledger', 'Last Month Update', 'Data Checks', 'Assumptions',
];

/**
 * Render one month's report.
 *
 * @param {{rows: ReportRow[], funnel?: any, totals?: any, ratios?: any, flags?: any[],
 *          reconciliations?: any[], assumptions?: any[], config?: any,
 *          meta?: any[]|{rows?: any[]},
 *          charges?: any[], shipments?: any[], replacements?: any[],
 *          lastMonthUpdate?: any[], previousMonth?: any,
 *          inputs?: {meta?: any[]|{rows?: any[]}, charges?: any[], shipments?: any[],
 *                    replacements?: any[], config?: any}}} report
 * @param {{month: string, monthLabel?: string, provisional?: boolean, generatedAtIST?: string,
 *          trigger?: string, courierChargeBasis?: string, incomplete?: boolean,
 *          adminOrderUrlBase?: string}} meta
 * @returns {Promise<Buffer>}
 */
export async function buildWorkbook(report, meta) {
  const ExcelJS = await exceljs();
  const cfg = { ...CFG_DEFAULTS, ...(report.config ?? report.inputs?.config ?? {}) };
  const rows = report.rows ?? [];
  // The engine wraps its Meta days as {rows, salesPaise, ...}; an adapter hands
  // the bare array. Take either.
  const metaRaw = report.meta ?? report.inputs?.meta ?? [];
  const metaDays = Array.isArray(metaRaw) ? metaRaw : (metaRaw.rows ?? []);
  const repl = report.replacements ?? report.inputs?.replacements ?? [];
  const ledger = buildLedger(report);
  const a = aggregate(rows, cfg, metaDays, repl, ledger);
  const month = meta.month ?? '2000-01';
  const hasLastMonth = Array.isArray(report.lastMonthUpdate) && report.lastMonthUpdate.length > 0;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Morpaankh P&L';
  wb.lastModifiedBy = 'Morpaankh P&L';
  // Derived from the month, never from the clock: the same report has to produce
  // the same bytes, and exceljs stamps created/modified into docProps.
  const stamp = new Date(Date.parse(`${month}-01T00:00:00Z`));
  wb.created = stamp;
  wb.modified = stamp;

  /** @type {Record<string, any>} */
  const ws = {};
  for (const name of SHEETS) {
    if (name === 'Last Month Update' && !hasLastMonth) continue;
    ws[name] = wb.addWorksheet(name, TABS[name] ? { properties: { tabColor: { argb: TABS[name] } } } : undefined);
  }

  const ctx = { wb, ws, report, meta, cfg, rows, metaDays, repl, ledger, a, month, issues: [], notes: [] };

  // Assumptions first: its named ranges are what the other sheets' formulas point at.
  const inputs = sheetAssumptions(ctx);
  ctx.inputs = inputs;
  const MA = sheetMetaAds(ctx);
  const CL = sheetCourierLedger(ctx);
  const D = sheetDelivered(ctx);
  const T = sheetRto(ctx);
  const ND = sheetNotDelivered(ctx);
  sheetExcluded(ctx);
  const RP = sheetReplacements(ctx);
  sheetByProduct(ctx);
  if (hasLastMonth) sheetLastMonth(ctx);
  const DY = sheetDaily(ctx);
  const S = sheetSummary(ctx, { D, T, ND, RP, CL, MA, DY });
  sheetDataChecks(ctx, { D, T, CL, MA, DY, S });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- 13. Assumptions -------------------------------------------------------

/**
 * Every config value with its source, and the five cells the rest of the
 * workbook is allowed to depend on. Those five get a pale yellow fill and a
 * named range; every formula that uses them uses the name, so editing one here
 * recalculates the workbook.
 */
function sheetAssumptions(ctx) {
  const ws = ctx.ws['Assumptions'];
  const cfg = ctx.cfg;
  const INPUTS = [
    { name: 'pnl_packing_per_order', label: 'Packing cost per order', value: rup(cfg.packingCostPerOrderPaise ?? 0), fmt: FMT.money, note: 'Drives the Packing column on Delivered and RTO.' },
    { name: 'pnl_gst_input_credit', label: 'GST input credit claimed (1 = yes, 0 = no)', value: cfg.gstInputCreditClaimed ? 1 : 0, fmt: FMT.int, note: 'When 0, GST on Meta spend is its own P&L line.' },
    { name: 'pnl_meta_gst_pct', label: 'GST on Meta spend', value: frac(cfg.metaGstPct), fmt: FMT.pct, note: 'Applied to total Meta spend when no input credit is claimed.' },
    { name: 'pnl_gateway_fee_pct', label: 'Payment gateway fee', value: frac(cfg.gatewayFeePct), fmt: FMT.pct, note: 'Used only where the real gateway fee was not read.' },
    { name: 'pnl_gateway_gst_pct', label: 'GST on gateway fee', value: frac(cfg.gatewayGstPct), fmt: FMT.pct, note: 'Added on top of the gateway fee.' },
  ];

  put(ws.getCell('A1'), 'ASSUMPTIONS AND INPUTS');
  ws.getCell('A1').font = { name: 'Calibri', size: TITLE_SIZE, bold: true, color: { argb: GOLD } };
  /*
   * SAY WHAT AN EDIT CAN AND CANNOT REACH.
   *
   * "Edit one and the workbook recalculates" was true of the statement and
   * read as true of everything. It is not: a courier charge, a COGS and an
   * output GST are figures that came from an API or a slab at build time, and
   * no cell can re-quote Delhivery. The Daily sheet's own packing and gateway
   * columns are written per day and do not follow either, which is why the
   * Daily-versus-Summary tripwire turns red after an edit and why its note
   * says so.
   */
  put(ws.getCell('A2'), 'The pale yellow cells are inputs. Edit one and the statement, the Delivered and RTO rows and the net all recalculate.');
  ws.getCell('A2').font = { ...BODY, italic: true };
  put(
    ws.getCell('A3'),
    'Everything below the inputs is a record of what this run used, not a control. Courier charges, COGS and output GST were read or computed when the report was built, so editing a rate here cannot re-quote them: for those, change the config and run /pnl again.',
  );
  ws.getCell('A3').font = { ...BODY, italic: true };

  const cols = [
    { h: 'Setting', w: 42, wrap: true },
    { h: 'Value', w: 14 },
    { h: 'Source', w: 11 },
    { h: 'Named range', w: 22 },
    { h: 'Note', w: 45, wrap: true },
  ];
  const body = INPUTS.map((i) => [i.label, { _v: i.value, fmt: i.fmt }, 'CONFIG', i.name, i.note]);
  const h = writeTable(ws, cols, body, { startRow: 4, zebra: true, filter: false, freeze: false });
  INPUTS.forEach((i, idx) => {
    const cell = ws.getCell(`B${h.first + idx}`);
    cell.fill = solid(INPUT_FILL);
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    ctx.wb.definedNames.add(`Assumptions!$B$${h.first + idx}`, i.name);
  });

  // Fixed monthly costs: their own block, because the P&L line is their SUM.
  let r = h.last + 2;
  put(ws.getCell(`A${r}`), 'FIXED MONTHLY COSTS');
  ws.getCell(`A${r}`).font = BODY_B;
  const fixed = (ctx.cfg.fixedMonthlyCosts ?? []).length
    ? ctx.cfg.fixedMonthlyCosts
    : [{ label: '(none configured)', amountPaise: 0 }];
  const fh = writeTable(
    ws,
    [{ h: 'Cost', w: 42 }, { h: 'Per month', fmt: FMT.money, w: 14, total: 'sum' }, { h: 'Source', w: 11 }, { h: 'Named range', w: 22 }, { h: 'Note', w: 45, wrap: true }],
    fixed.map((f) => [f.label, rup(f.amountPaise ?? 0), 'CONFIG', '', 'Charged whole to the month, not per order.']),
    { startRow: r + 1, zebra: true, filter: false, freeze: false, totalsLabel: 'FIXED COSTS TOTAL' },
  );
  for (let i = 0; i < fixed.length; i++) ws.getCell(`B${fh.first + i}`).fill = solid(INPUT_FILL);
  const fixedTotalRow = fh.totals ?? fh.last; // the block always has a totals row
  ctx.wb.definedNames.add(`Assumptions!$B$${fixedTotalRow}`, 'pnl_fixed_costs');
  ws.getCell(`D${fixedTotalRow}`).value = 'pnl_fixed_costs';
  ws.getCell(`D${fixedTotalRow}`).font = BODY_B;

  // Everything else the engine wants on record.
  r = fixedTotalRow + 2;
  put(ws.getCell(`A${r}`), 'EVERY OTHER VALUE AND RATE');
  ws.getCell(`A${r}`).font = BODY_B;
  const rest = (ctx.report.assumptions ?? []).map((x) => [
    x.label ?? x.key ?? '',
    typeof x.value === 'number' ? { _v: x.value, fmt: x.fmt } : String(x.value ?? ''),
    x.source ?? 'CONFIG',
    x.namedRange ?? '',
    x.note ?? '',
  ]);
  writeTable(ws, cols, rest, {
    startRow: r + 1, zebra: true, filter: false, freeze: false,
    empty: 'the engine sent no assumptions list',
  });

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];
  printSetup(ws, 4);
  return { names: INPUTS.map((i) => i.name).concat('pnl_fixed_costs') };
}

// --- 9. Meta Ads -----------------------------------------------------------

function sheetMetaAds(ctx) {
  const ws = ctx.ws['Meta Ads'];
  const days = [...ctx.metaDays].sort(
    (x, y) => String(x.date).localeCompare(String(y.date)) || String(x.campaignId).localeCompare(String(y.campaignId)),
  );
  const cols = [
    { h: 'Date', fmt: FMT.date, w: 13 },
    { h: 'Campaign ID', w: 20 },
    { h: 'Campaign', w: 40, wrap: true },
    { h: 'Objective', w: 20 },
    { h: 'Type', w: 10 },
    { h: 'Spend', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Impressions', fmt: FMT.int, w: 13, total: 'sum' },
    { h: 'Clicks', fmt: FMT.int, w: 10, total: 'sum' },
  ];
  const h = writeTable(
    ws,
    cols,
    days.map((m) => [
      dateCell(`${m.date}T00:00:00Z`),
      String(m.campaignId ?? ''),
      String(m.campaignName ?? ''),
      String(m.objective ?? ''),
      String(m.type ?? 'other'),
      rup(m.spendPaise ?? 0),
      m.impressions ?? 0,
      m.clicks ?? 0,
    ]),
    { zebra: true, totalsLabel: 'MONTH TOTAL', empty: 'no Meta spend on record this month' },
  );

  // Month total per campaign, below the daily table.
  const byCampaign = new Map();
  for (const m of days) {
    const k = `${m.campaignId}`;
    const c = byCampaign.get(k) ?? { id: k, name: m.campaignName, type: m.type, spend: 0, imp: 0, clicks: 0 };
    c.spend += m.spendPaise ?? 0;
    c.imp += m.impressions ?? 0;
    c.clicks += m.clicks ?? 0;
    byCampaign.set(k, c);
  }
  const start = (h.totals ?? h.last) + 2;
  put(ws.getCell(`A${start}`), 'MONTH TOTAL PER CAMPAIGN');
  ws.getCell(`A${start}`).font = BODY_B;
  const list = [...byCampaign.values()].sort((x, y) => y.spend - x.spend || x.id.localeCompare(y.id));
  const byCampaign2 = writeTable(
    ws,
    [
      { h: 'Campaign', w: 40, wrap: true },
      { h: 'Campaign ID ', w: 20 },
      { h: 'Type ', w: 10 },
      { h: 'Spend ', fmt: FMT.money, w: 13, total: 'sum' },
      { h: 'Impressions ', fmt: FMT.int, w: 13, total: 'sum' },
      { h: 'Clicks ', fmt: FMT.int, w: 10, total: 'sum' },
      { h: 'CTR', fmt: FMT.pct, w: 10 },
    ],
    list.map((c) => [c.name ?? c.id, c.id, c.type ?? 'other', rup(c.spend), c.imp, c.clicks, c.imp ? c.clicks / c.imp : 0]),
    { startRow: start + 1, zebra: true, filter: false, freeze: false, totalsLabel: 'ALL CAMPAIGNS' },
  );

  /*
   * WHY THIS SHEET AND THE SUMMARY SHOW DIFFERENT NUMBERS.
   *
   * Every total on this sheet is what Meta billed for the ads. The
   * statement's Meta line is bigger, because GST on advertising is a cost we
   * pay and no input credit is claimed, so the P&L carries it as its own
   * line: October read 39,161.21 here and 46,210.23 there. The owner read
   * that as the two sheets disagreeing, which is fair, because the same word
   * "spend" sat over two different quantities and nothing on this sheet
   * mentioned the tax.
   *
   * The bridge is built from the daily table's own month total and the same
   * named input the Summary uses, so the two surfaces cannot drift apart. It
   * reads the DAILY total rather than the per-campaign one on purpose: that
   * is the range the Summary sums, so if the two tables ever disagreed the
   * difference would show up here instead of hiding.
   */
  const spendCol = colLetter(cols.findIndex((c) => c.h === 'Spend') + 1);
  const monthSpend = `${spendCol}${h.totals ?? h.last}`;
  const vCol = colLetter(4); // the Spend column of the per-campaign table
  const bridge = (byCampaign2.totals ?? byCampaign2.last) + 2;
  put(ws.getCell(`A${bridge}`), 'FROM META SPEND TO THE P&L LINE');
  ws.getCell(`A${bridge}`).font = BODY_B;
  const gstRow = bridge + 2;
  const lines = [
    ['Meta spend as billed, the month total above', `${monthSpend}`, ctx.a.meta - ctx.a.metaGst],
    [
      'GST on Meta spend (none when the input credit is claimed)',
      `IF(pnl_gst_input_credit=1,0,${monthSpend}*pnl_meta_gst_pct)`,
      ctx.a.metaGst,
    ],
    ['TOTAL META IN THE P&L, the Summary line and the headline tile', `SUM(${vCol}${bridge + 1}:${vCol}${gstRow})`, ctx.a.meta],
  ];
  lines.forEach(([label, formula, paise], i) => {
    const r = bridge + 1 + i;
    put(ws.getCell(`A${r}`), label);
    ws.getCell(`A${r}`).font = i === lines.length - 1 ? BODY_B : { ...BODY, italic: true };
    put(ws.getCell(`${vCol}${r}`), fx(formula, rup(paise)), { fmt: FMT.money });
    if (i === lines.length - 1) ws.getCell(`${vCol}${r}`).font = BODY_B;
  });

  printSetup(ws, 1);
  return h;
}

// --- 10. Courier Ledger ----------------------------------------------------

function sheetCourierLedger(ctx) {
  const ws = ctx.ws['Courier Ledger'];
  const cols = [
    { h: 'AWB', w: 18 },
    { h: 'Order(s)', w: 16 },
    { h: 'Leg', w: 12 },
    { h: 'Status', w: 22, wrap: true },
    { h: 'Weight used (g)', fmt: FMT.int, w: 12 },
    { h: 'Zone', w: 8 },
    { h: 'Payment', w: 10 },
    { h: 'Forward', fmt: FMT.money2, w: 13, total: 'sum' },
    { h: 'RTO', fmt: FMT.money2, w: 13, total: 'sum' },
    { h: 'COD charge', fmt: FMT.money2, w: 13, total: 'sum' },
    { h: 'GST', fmt: FMT.money2, w: 12, total: 'sum' },
    { h: 'Total', fmt: FMT.money2, w: 13, total: 'sum' },
    { h: 'Source', w: 11 },
    { h: 'Ledger vs computed', fmt: FMT.money2, w: 14, total: 'sum' },
    { h: 'In P&L as', w: 13 },
    { h: 'Flags', w: 40, wrap: true },
  ];
  const body = ctx.ledger.map((l) => {
    const c = l.charge;
    const leg = c.rtoPaise ? 'forward + RTO' : c.dtoPaise ? 'reverse pickup' : 'forward';
    const weight = c.chargedWeightGrams ?? l.ship?.chargedWeightGrams ?? null;
    return [
      String(c.awb),
      l.own?.orders?.join(', ') ?? '',
      leg,
      l.ship ? String(l.ship.rawStatus ?? l.ship.state ?? '') : miss('Delhivery had no record of this AWB'),
      /*
       * NOT A SCANNED FACT. Delhivery returns ChargedWeight null on every
       * shipment this account has ever had, and the charges API echoes back
       * the cgm we sent it, so a bare 500 in this column read as measured.
       * Anything not actually weighed is italic with the reason on the cell.
       */
      weightAssumed(l)
        ? inferred(weight ?? ctx.cfg.assumedWeightGrams ?? 0, WEIGHT_NOTE)
        : weight,
      c.zone ?? miss('zone not on the ledger line'),
      l.ship?.orderType ? PAY_LABEL[l.ship.orderType] ?? l.ship.orderType : (l.own?.payment ? PAY_LABEL[l.own.payment] : ''),
      money(c.forwardPaise, 'forward leg not billed and not computable'),
      c.rtoPaise == null ? 0 : rup(c.rtoPaise),
      c.codChargePaise == null ? 0 : rup(c.codChargePaise),
      money(c.gstPaise, 'GST not split out on this line'),
      money(c.totalPaise, 'no charge on record for this AWB'),
      String(c.source ?? 'missing'),
      c.variancePaise == null ? 0 : rup(c.variancePaise),
      l.bucket,
      (c.flags ?? []).join('; '),
    ];
  });
  const h = writeTable(ws, cols, body, {
    zebra: true,
    totalsLabel: 'ALL AWBs',
    empty: 'no courier charges on record this month',
    rowFill: (r) => (r[14] === 'other' ? LOSS_FILL : null),
  });
  ws.getRow(1).getCell(cols.findIndex((c) => c.h === 'Weight used (g)') + 1).note = WEIGHT_NOTE;
  printSetup(ws, 1);
  return h;
}

// --- 3. Delivered ----------------------------------------------------------

/** The admin link, or null when we were not told which store this is. */
const adminLink = (ctx, r) =>
  ctx.meta.adminOrderUrlBase
    ? link(r.order.name, `${String(ctx.meta.adminOrderUrlBase).replace(/\/$/, '')}/${r.order.numericId}`)
    : r.order.name;
const awbLink = (awbs) => (awbs?.length ? link(awbs.join(', '), `${DELHIVERY_TRACK}${awbs[0]}`) : miss('no AWB on this order'));
const shipOf = (ctx, r) => {
  const m = new Map((ctx.report.shipments ?? ctx.report.inputs?.shipments ?? []).map((s) => [s.awb, s]));
  for (const awb of r.awbs ?? []) if (m.has(awb)) return m.get(awb);
  return null;
};
/**
 * Forward freight, with a note when the figure rests on the assumed weight
 * rather than on anything Delhivery weighed or billed.
 */
const freightCell = (ctx, r, v) => {
  if (v.fwd == null) return miss('forward freight neither billed nor computable');
  const charge = chargeOf(ctx, r.awbs);
  const assumed = charge ? charge.weightAssumed !== false : true;
  return assumed && charge?.source !== 'ledger'
    ? inferred(rup(v.fwd), `Computed from the rate card at an ASSUMED weight. ${WEIGHT_NOTE}`)
    : rup(v.fwd);
};

/**
 * Output GST, with the base stated on any order carrying a COD fee.
 *
 * Two figures with the word "slab" near them sit on each delivered COD row and
 * they are 2.38 apart: this cell backs the slab out of the FULL current total
 * including the fee, while the engine's "Shopify GST x vs slab y" flag in the
 * Flags column compares against the product lines alone, because gst.mjs
 * excludes the fee on purpose. Both are right; neither said which base it used.
 */
const gstCell = (r, v) => {
  if (v.gst == null) return miss('output GST could not be computed');
  const fee = r.order.codFeePaise ?? 0;
  if (fee <= 0) return rup(v.gst);
  return noted(
    rup(v.gst),
    `BASE: the full current total, INCLUDING the ₹${rup(fee)} COD fee, which carries the ` +
      `order's highest line rate. The "Shopify GST ... vs slab ..." flag on this row uses a ` +
      `different base, the product lines alone with the fee excluded, so the two differ by the ` +
      `GST on the fee. Both are intended; this cell is the one the P&L uses.`,
  );
};

const chargeOf = (ctx, awbs) => {
  const m = new Map((ctx.report.charges ?? ctx.report.inputs?.charges ?? []).map((c) => [c.awb, c]));
  for (const awb of awbs ?? []) if (m.has(awb)) return m.get(awb);
  return null;
};

function sheetDelivered(ctx) {
  const ws = ctx.ws['Delivered'];
  const cols = [
    { h: 'Order #', w: 11 }, { h: 'Order date', fmt: FMT.date, w: 13 }, { h: 'Delivered date', fmt: FMT.date, w: 13 },
    { h: 'Days to deliver', fmt: FMT.num1, w: 10 }, { h: 'Customer', w: 24 }, { h: 'City', w: 16 }, { h: 'State', w: 8 },
    { h: 'Channel', w: 16 }, { h: 'Payment', w: 10 }, { h: 'Items', w: 45, wrap: true }, { h: 'Units', fmt: FMT.int, w: 8, total: 'sum' },
    { h: 'AWB', w: 18 }, { h: 'Delhivery status', w: 22, wrap: true }, { h: 'Delhivery date', fmt: FMT.date, w: 13 },
    { h: 'Gross sale', fmt: FMT.money, w: 13, total: 'sum' }, { h: 'Discount', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'COD fee', fmt: FMT.money, w: 11, total: 'sum' }, { h: 'Refunds', fmt: FMT.money, w: 11, total: 'sum' },
    { h: 'Output GST', fmt: FMT.money, w: 12, total: 'sum' }, { h: 'Net revenue', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'COGS', fmt: FMT.money, w: 12, total: 'sum' }, { h: 'Forward freight', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'COD charge', fmt: FMT.money, w: 12, total: 'sum' }, { h: 'Packing', fmt: FMT.money, w: 11, total: 'sum' },
    { h: 'Gateway fee', fmt: FMT.money, w: 12, total: 'sum' }, { h: 'Total cost', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Contribution', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Contribution %', fmt: FMT.pct, w: 11, total: (h) => fx(`IF(SUM(${h.totalRef('Net revenue')})=0,0,${h.totalRef('Contribution')}/${h.totalRef('Net revenue')})`, ctx.a.del.netRev ? round2(ctx.a.del.contribution / ctx.a.del.netRev * 1e4) / 1e4 : 0) },
    { h: 'Charge source', w: 12 }, { h: 'Flags', w: 45, wrap: true },
    { h: 'In totals', fmt: FMT.int, w: 9, total: 'sum' },
  ];
  const C = (h) => colLetter(cols.findIndex((c) => c.h === h) + 1);
  const d = [...ctx.a.by.DELIVERED].sort((x, y) => String(x.order.createdAt).localeCompare(String(y.order.createdAt)) || x.order.name.localeCompare(y.order.name));
  const body = d.map((r, i) => {
    const v = ctx.a.res(r);
    const rn = 2 + i;
    const ship = shipOf(ctx, r);
    const delivered = ship?.deliveredAt ?? r.order.fulfillments?.find((f) => f.deliveredAt)?.deliveredAt ?? null;
    return [
      adminLink(ctx, r), dateCell(r.order.createdAt), dateCell(delivered),
      daysBetween(r.order.createdAt, delivered), r.order.customerName ?? '', r.order.city ?? '', r.order.state ?? '',
      r.order.channel ?? '', PAY_LABEL[r.order.paymentType] ?? r.order.paymentType, itemsOf(r), unitsOf(r),
      awbLink(r.awbs), ship ? String(ship.rawStatus ?? ship.state) : inferred(r.order.fulfillments?.[0]?.displayStatus ?? 'no Delhivery record', 'Delhivery had no record; Shopify was used'),
      dateCell(ship?.statusAt ?? delivered),
      rup(v.gross), rup(r.order.discountsPaise ?? 0), rup(r.order.codFeePaise ?? 0), rup(v.refunds),
      gstCell(r, v),
      fx(`SUM(${C('Gross sale')}${rn})-SUM(${C('Refunds')}${rn})-SUM(${C('Output GST')}${rn})`, rup(v.netRev)),
      money(v.cogs, 'a line on this order has no unit cost'),
      freightCell(ctx, r, v),
      v.cod == null ? 0 : rup(v.cod),
      fx(`pnl_packing_per_order*${v.packingFactor}`, rup(v.packing)),
      v.gatewayAssumed
        ? fx(
            `${rup(v.onlinePaise)}*pnl_gateway_fee_pct*(1+IF(pnl_gst_input_credit=1,0,pnl_gateway_gst_pct))`,
            rup(v.gateway),
          )
        : money(v.gateway, 'gateway fee not read from the gateway'),
      fx(`SUM(${C('COGS')}${rn}:${C('Gateway fee')}${rn})`, rup(v.cost)),
      fx(`SUM(${C('Net revenue')}${rn})-SUM(${C('Total cost')}${rn})`, rup(v.contribution)),
      fx(`IF(SUM(${C('Net revenue')}${rn})=0,0,${C('Contribution')}${rn}/SUM(${C('Net revenue')}${rn}))`, v.netRev ? round2((v.contribution / v.netRev) * 1e4) / 1e4 : 0),
      String(r.chargeSource ?? ''), (r.flags ?? []).join('; '),
      counted(r) ? 1 : noted(0, whyBlocked(r)),
    ];
  });
  const h = writeTable(ws, cols, body, {
    zebra: true, totalsLabel: 'DELIVERED TOTAL', empty: 'no delivered orders this month',
    countedCol: 'In totals',
    rowFill: (row) =>
      row[30]?._v === 0 ? AMBER_FILL : typeof row[26]?.result === 'number' && row[26].result < 0 ? LOSS_FILL : null,
  });
  printSetup(ws, 1);
  return h;
}

// --- 4. RTO ----------------------------------------------------------------

function sheetRto(ctx) {
  const ws = ctx.ws['RTO'];
  const cols = [
    { h: 'Order #', w: 11 }, { h: 'Order date', fmt: FMT.date, w: 13 }, { h: 'Customer', w: 24 }, { h: 'City', w: 16 },
    { h: 'Payment', w: 10 }, { h: 'Items', w: 45, wrap: true }, { h: 'Order value', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'AWB', w: 18 }, { h: 'RTO reason', w: 20, wrap: true }, { h: 'Delhivery status', w: 22, wrap: true },
    { h: 'RTO start date', fmt: FMT.date, w: 13 }, { h: 'Returned date', fmt: FMT.date, w: 13 },
    { h: 'Forward freight', fmt: FMT.money, w: 12, total: 'sum' }, { h: 'Return freight', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'COD charge', fmt: FMT.money, w: 12, total: 'sum' }, { h: 'Packing', fmt: FMT.money, w: 11, total: 'sum' },
    { h: 'Gateway fee', fmt: FMT.money, w: 12, total: 'sum' }, { h: 'Advance kept', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'Total RTO loss', fmt: FMT.money, w: 13, total: 'sum' }, { h: 'Return leg', w: 13 }, { h: 'Flags', w: 45, wrap: true },
    { h: 'In totals', fmt: FMT.int, w: 9, total: 'sum' },
  ];
  const C = (h) => colLetter(cols.findIndex((c) => c.h === h) + 1);
  const t = [...ctx.a.by.RTO].sort((x, y) => String(x.order.createdAt).localeCompare(String(y.order.createdAt)) || x.order.name.localeCompare(y.order.name));
  const body = t.map((r, i) => {
    const v = ctx.a.res(r);
    const rn = 2 + i;
    const ship = shipOf(ctx, r);
    const charge = chargeOf(ctx, r.awbs);
    return [
      adminLink(ctx, r), dateCell(r.order.createdAt), r.order.customerName ?? '', r.order.city ?? '',
      PAY_LABEL[r.order.paymentType] ?? r.order.paymentType, itemsOf(r), rup(v.gross), awbLink(r.awbs),
      rtoReason(r) ?? miss('no rto-reason-* tag on this order'),
      ship ? String(ship.rawStatus ?? ship.state) : inferred('no Delhivery record', 'Delhivery had no record; the outcome was inferred'),
      dateCell(ship?.rtoStartedAt), dateCell(ship?.returnedAt ?? ship?.deliveredAt),
      freightCell(ctx, r, v),
      money(v.rto, 'return leg neither billed nor computable'),
      v.cod == null ? 0 : rup(v.cod),
      fx(`pnl_packing_per_order*${v.packingFactor}`, rup(v.packing)),
      v.gateway == null ? 0 : rup(v.gateway),
      rup(v.advance),
      fx(`SUM(${C('Forward freight')}${rn}:${C('Gateway fee')}${rn})-SUM(${C('Advance kept')}${rn})`, rup(v.rtoLoss)),
      charge?.source === 'ledger' ? 'billed' : inferred('computed', 'Delhivery has not billed the return leg yet; the ss=RTO quote was used'),
      (r.flags ?? []).join('; '),
      counted(r) ? 1 : noted(0, whyBlocked(r)),
    ];
  });
  const h = writeTable(ws, cols, body, {
    zebra: true, totalsLabel: 'RTO TOTAL', empty: 'no RTO this month',
    countedCol: 'In totals',
    rowFill: (row) => (row[21]?._v === 0 ? AMBER_FILL : LOSS_FILL),
  });
  printSetup(ws, 1);
  return h;
}

// --- 5. Not Delivered ------------------------------------------------------

function sheetNotDelivered(ctx) {
  const ws = ctx.ws['Not Delivered'];
  put(ws.getCell('A1'), 'Pending, cancelled and lost orders. Nothing here is in the P&L except the "Charge in P&L" column: charges Delhivery billed on a manifested shipment that was cancelled, and the whole loss on a parcel that was lost. An incomplete row reads 0 there and says so, the same way the engine leaves it out.');
  ws.getCell('A1').font = { ...BODY, italic: true };
  const cols = [
    { h: 'Order #', w: 11 }, { h: 'Order date', fmt: FMT.date, w: 13 }, { h: 'Outcome', w: 11 }, { h: 'Customer', w: 24 },
    { h: 'Payment', w: 10 }, { h: 'Status', w: 22, wrap: true }, { h: 'Status date', fmt: FMT.date, w: 13 },
    { h: 'AWB', w: 18 }, { h: 'Order value', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Charges so far', fmt: FMT.money, w: 13, total: 'sum' }, { h: 'Charge in P&L', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'In P&L?', w: 9 }, { h: 'Reason', w: 30, wrap: true }, { h: 'Flags', w: 40, wrap: true },
  ];
  const list = ['PENDING', 'CANCELLED', 'LOST'].flatMap((o) =>
    [...(ctx.a.by[o] ?? [])].sort((x, y) => x.order.name.localeCompare(y.order.name)),
  );
  const body = list.map((r) => {
    const v = ctx.a.res(r);
    const ship = shipOf(ctx, r);
    const charge = chargeOf(ctx, r.awbs);
    const charged = r.outcome === 'CANCELLED' || r.outcome === 'LOST';
    const inPnl = charged && counted(r) ? (r.totalCostPaise ?? 0) : 0;
    return [
      adminLink(ctx, r), dateCell(r.order.createdAt), r.outcome, r.order.customerName ?? '',
      PAY_LABEL[r.order.paymentType] ?? r.order.paymentType,
      ship ? String(ship.rawStatus ?? ship.state) : (r.awbs?.length ? miss('Delhivery had no record of this AWB') : 'not shipped'),
      dateCell(ship?.statusAt ?? r.order.cancelledAt), r.awbs?.length ? awbLink(r.awbs) : 'none',
      rup(v.gross), charge?.totalPaise == null ? 0 : rup(charge.totalPaise),
      charged && !counted(r) ? noted(0, whyBlocked(r)) : rup(inPnl),
      inPnl ? 'yes' : charged && !counted(r) ? 'no (incomplete)' : 'no',
      r.outcomeReason ?? r.order.cancelReason ?? '', (r.flags ?? []).join('; '),
    ];
  });
  const h = writeTable(ws, cols, body, {
    startRow: 2, zebra: true, totalsLabel: 'NOT DELIVERED TOTAL', empty: 'nothing pending, cancelled or lost this month',
  });
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];
  printSetup(ws, 2);
  return h;
}

// --- 6. Excluded -----------------------------------------------------------

function sheetExcluded(ctx) {
  const ws = ctx.ws['Excluded'];
  put(ws.getCell('A1'), 'Tests and founder or family orders. These are out of every number in this report.');
  ws.getCell('A1').font = { ...BODY, italic: true };
  const cols = [
    { h: 'Order #', w: 11 }, { h: 'Order date', fmt: FMT.date, w: 13 }, { h: 'Customer', w: 24 },
    { h: 'Channel', w: 16 }, { h: 'Order value', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Reason', w: 38, wrap: true }, { h: 'Tags', w: 40, wrap: true },
  ];
  const body = [...(ctx.a.by.EXCLUDED ?? [])]
    .sort((x, y) => x.order.name.localeCompare(y.order.name))
    .map((r) => [
      adminLink(ctx, r), dateCell(r.order.createdAt), r.order.customerName ?? '', r.order.channel ?? '',
      rup(r.order.currentTotalPaise ?? 0), r.outcomeReason ?? '', (r.order.tags ?? []).join(', '),
    ]);
  const h = writeTable(ws, cols, body, { startRow: 2, zebra: true, totalsLabel: 'EXCLUDED TOTAL', empty: 'nothing was excluded this month' });
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];
  printSetup(ws, 2);
  return h;
}

// --- 7. Replacements -------------------------------------------------------

function sheetReplacements(ctx) {
  const ws = ctx.ws['Replacements'];
  const cols = [
    { h: 'Order #', w: 11 }, { h: 'Job #', fmt: FMT.int, w: 7 }, { h: 'State', w: 16 }, { h: 'Reason', w: 28, wrap: true },
    { h: 'Who pays', w: 11 }, { h: 'Forward AWB', w: 18 }, { h: 'Return AWB', w: 18 },
    { h: 'Forward leg (billed or quoted)', fmt: FMT.money, w: 13, total: 'sum', wrap: true },
    { h: 'Return leg (billed or quoted)', fmt: FMT.money, w: 13, total: 'sum', wrap: true },
    { h: 'Packing', fmt: FMT.money, w: 11, total: 'sum' }, { h: 'Reimbursed', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'Cost in P&L', fmt: FMT.money, w: 13, total: 'sum' }, { h: 'Reimbursement status', w: 26, wrap: true },
    { h: 'Created', fmt: FMT.date, w: 13 },
  ];
  const C = (h) => colLetter(cols.findIndex((c) => c.h === h) + 1);
  const chargeByAwb = new Map((ctx.ledger ?? []).map((l) => [String(l.charge.awb), l.charge]));
  const jobs = [...ctx.repl].sort((x, y) => String(x.orderName).localeCompare(String(y.orderName)) || (x.seq ?? 0) - (y.seq ?? 0));
  const body = jobs.map((j, i) => {
    const c = replacementCost(j, ctx.cfg, (awb) => chargeByAwb.get(awb));
    const rn = 2 + i;
    const legCell = (awb, side) =>
      !awb
        ? 0
        : side.billed
          ? noted(rup(side.paise), 'billed by Delhivery, taken from the ledger')
          : side.quoted
            ? inferred(
                rup(side.paise),
                'A PREVIEW QUOTE, not a charge. It was written when /replace was asked for and ' +
                  'no charges call has confirmed it. A return leg is quoted at the FORWARD rate, ' +
                  'so the real reverse-pickup rate for the same pin pair will differ.',
              )
            : miss('neither billed nor quoted');
    return [
      String(j.orderName ?? ''), j.seq ?? 1, String(j.state ?? ''), j.reason ?? '',
      j.pays === 'us' ? 'Morpaankh' : j.pays === 'customer' ? 'customer' : miss('nobody was recorded as paying'),
      j.forwardAwb ?? miss('no forward AWB yet'), j.returnAwb ?? 'none',
      legCell(j.forwardAwb, c.fwd), legCell(j.returnAwb, c.ret),
      c.packing ? fx('pnl_packing_per_order', rup(c.packing)) : 0,
      rup(c.reimbursed),
      // A cancelled job is not costed, so the P&L takes nothing from it, and the
      // cell says why rather than quietly reading 0.
      c.cancelled
        ? noted(0, 'The job was cancelled, so the engine does not cost it and neither does the P&L. The legs above are what it would have cost.')
        : fx(
            `SUM(${C('Forward leg (billed or quoted)')}${rn}:${C('Packing')}${rn})-SUM(${C('Reimbursed')}${rn})`,
            rup(c.net),
          ),
      c.cancelled
        ? 'not applicable, job cancelled'
        : j.reimbursementReceived
          ? 'received, recorded in Shopify'
          : j.pays === 'customer'
            ? 'expected, not verified'
            : 'not applicable',
      dateCell(j.createdAt),
    ];
  });
  const h = writeTable(ws, cols, body, { zebra: true, totalsLabel: 'REPLACEMENTS TOTAL', empty: 'no replacement shipments this month' });
  printSetup(ws, 1);
  return h;
}

// --- 8. By Product ---------------------------------------------------------

function sheetByProduct(ctx) {
  const ws = ctx.ws['By Product'];
  /** @type {Map<string, any>} */
  const agg = new Map();
  const touch = (l) => {
    const key = l.sku || l.title || '(unnamed)';
    let p = agg.get(key);
    if (!p) agg.set(key, (p = { title: l.title ?? key, sku: l.sku ?? null, units: 0, netRev: 0, cogs: 0, cogsMissing: 0, rtoUnits: 0, rtoLoss: 0, contrib: 0 }));
    return p;
  };
  const shareOf = (r) => {
    const lines = (r.order.lines ?? []).filter((l) => (l.currentQuantity ?? 0) > 0);
    const total = lines.reduce((a, l) => a + l.discountedUnitPaise * l.currentQuantity, 0);
    return lines.map((l) => ({ l, w: total ? (l.discountedUnitPaise * l.currentQuantity) / total : 1 / (lines.length || 1) }));
  };
  for (const r of (ctx.a.by.DELIVERED ?? []).filter(counted)) {
    const v = ctx.a.res(r);
    for (const { l, w } of shareOf(r)) {
      const p = touch(l);
      p.units += l.currentQuantity;
      p.netRev += Math.round(v.netRev * w);
      if (l.unitCostPaise == null) p.cogsMissing += 1;
      else p.cogs += l.unitCostPaise * l.currentQuantity;
      p.contrib += Math.round(v.contribution * w);
    }
  }
  for (const r of (ctx.a.by.RTO ?? []).filter(counted)) {
    const v = ctx.a.res(r);
    for (const { l, w } of shareOf(r)) {
      const p = touch(l);
      p.rtoUnits += l.currentQuantity;
      p.rtoLoss += Math.round(v.rtoLoss * w);
    }
  }
  const cols = [
    { h: 'Product', w: 42, wrap: true }, { h: 'SKU', w: 18 }, { h: 'Units delivered', fmt: FMT.int, w: 10, total: 'sum' },
    { h: 'Net revenue', fmt: FMT.money, w: 13, total: 'sum' }, { h: 'COGS', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Gross margin %', fmt: FMT.pct, w: 11 }, { h: 'RTO units', fmt: FMT.int, w: 10, total: 'sum' },
    { h: 'RTO loss', fmt: FMT.money, w: 13, total: 'sum' }, { h: 'Contribution before ads', fmt: FMT.money, w: 14, total: 'sum' },
  ];
  const C = (h) => colLetter(cols.findIndex((c) => c.h === h) + 1);
  const list = [...agg.values()].sort((x, y) => y.netRev - x.netRev || x.title.localeCompare(y.title));
  const body = list.map((p, i) => {
    const rn = 2 + i;
    return [
      p.title, p.sku ?? '', p.units, rup(p.netRev),
      p.cogsMissing ? noted(rup(p.cogs), `${p.cogsMissing} line(s) had no unit cost, so this is short`) : rup(p.cogs),
      fx(`IF(SUM(${C('Net revenue')}${rn})=0,0,(SUM(${C('Net revenue')}${rn})-SUM(${C('COGS')}${rn}))/SUM(${C('Net revenue')}${rn}))`,
        p.netRev ? round2(((p.netRev - p.cogs) / p.netRev) * 1e4) / 1e4 : 0),
      p.rtoUnits, rup(p.rtoLoss), rup(p.contrib),
    ];
  });
  const h = writeTable(ws, cols, body, { zebra: true, totalsLabel: 'ALL PRODUCTS', empty: 'nothing was delivered or returned this month' });
  printSetup(ws, 1);
  return h;
}

// --- 11. Last Month Update -------------------------------------------------

function sheetLastMonth(ctx) {
  const ws = ctx.ws['Last Month Update'];
  put(ws.getCell('A1'), 'Orders from the previous month that were still pending in its report and have settled since. Last month’s figures are not restated here; this is what changed.');
  ws.getCell('A1').font = { ...BODY, italic: true };
  const cols = [
    { h: 'Order #', w: 11 }, { h: 'Was', w: 12 }, { h: 'Now', w: 12 }, { h: 'Settled on', fmt: FMT.date, w: 13 },
    { h: 'Change', fmt: FMT.money, w: 13, total: 'sum' }, { h: 'Note', w: 45, wrap: true },
  ];
  const body = (ctx.report.lastMonthUpdate ?? []).map((u) => [
    String(u.orderName ?? ''), String(u.was ?? u.wasOutcome ?? ''), String(u.now ?? u.nowOutcome ?? ''),
    dateCell(u.at ?? u.settledAt), u.deltaPaise == null ? 0 : rup(u.deltaPaise), u.note ?? '',
  ]);
  const h = writeTable(ws, cols, body, { startRow: 2, zebra: true, totalsLabel: 'NET CHANGE', empty: 'nothing from last month has settled since' });
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];
  printSetup(ws, 2);
  return h;
}

// --- 2. Daily --------------------------------------------------------------

/**
 * Every day of the month by ORDER date, then the four monthly lines that have
 * no order date at all. The bottom line here is the same number as the bottom
 * line of the Summary statement, by construction.
 */
function sheetDaily(ctx) {
  const ws = ctx.ws['Daily'];
  const n = daysInMonth(ctx.month);
  /** @type {Map<string, any>} */
  const days = new Map();
  for (let i = 1; i <= n; i++) {
    const key = `${ctx.month}-${String(i).padStart(2, '0')}`;
    days.set(key, { key, placed: 0, delivered: 0, rto: 0, pending: 0, cancelled: 0, netRev: 0, cogs: 0, freight: 0, rtoLoss: 0, packing: 0, gateway: 0, meta: 0 });
  }
  const bucket = (key) => days.get(key) ?? null;
  for (const r of ctx.rows) {
    if (r.outcome === 'EXCLUDED') continue;
    const day = bucket(istDay(r.order.createdAt));
    if (!day) continue;
    const v = ctx.a.res(r);
    day.placed += 1;
    // An incomplete row is counted as an order and left out of every amount,
    // exactly as the engine does and as the order sheets' SUMIFs do.
    const inTotal = counted(r);
    if (r.outcome === 'DELIVERED') {
      day.delivered += 1;
      if (inTotal) {
        day.netRev += v.netRev;
        day.cogs += v.cogs ?? 0;
        day.freight += (v.fwd ?? 0) + (v.cod ?? 0);
        day.packing += v.packing;
        day.gateway += v.gateway ?? 0;
      }
    } else if (r.outcome === 'RTO') {
      day.rto += 1;
      if (inTotal) day.rtoLoss += v.rtoLoss;
    } else if (r.outcome === 'CANCELLED') day.cancelled += 1;
    else day.pending += 1;
  }
  for (const m of ctx.metaDays) {
    const day = bucket(m.date);
    if (day) day.meta += m.spendPaise ?? 0;
  }

  const cols = [
    { h: 'Date', fmt: FMT.date, w: 13 },
    { h: 'Orders placed', fmt: FMT.int, w: 9, total: 'sum' },
    { h: 'Delivered', fmt: FMT.int, w: 9, total: 'sum' },
    { h: 'RTO', fmt: FMT.int, w: 7, total: 'sum' },
    { h: 'Pending', fmt: FMT.int, w: 8, total: 'sum' },
    { h: 'Cancelled', fmt: FMT.int, w: 9, total: 'sum' },
    { h: 'Net revenue', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'COGS', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'Freight + COD charges', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'RTO loss', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'Packing', fmt: FMT.money, w: 11, total: 'sum' },
    { h: 'Gateway fees', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'Meta spend', fmt: FMT.money, w: 12, total: 'sum' },
    { h: 'Contribution', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Net', fmt: FMT.money, w: 13, total: 'sum' },
    { h: 'Cumulative net', fmt: FMT.money, w: 14 },
  ];
  const C = (h) => colLetter(cols.findIndex((c) => c.h === h) + 1);
  let cum = 0;
  const body = [...days.values()].map((d, i) => {
    const rn = 2 + i;
    const contribution = d.netRev - d.cogs - d.freight - d.packing - d.gateway;
    const net = contribution - d.rtoLoss - d.meta;
    cum += net;
    return [
      new Date(`${d.key}T00:00:00Z`), d.placed, d.delivered, d.rto, d.pending, d.cancelled,
      rup(d.netRev), rup(d.cogs), rup(d.freight), rup(d.rtoLoss), rup(d.packing), rup(d.gateway), rup(d.meta),
      fx(`SUM(${C('Net revenue')}${rn})-SUM(${C('COGS')}${rn})-SUM(${C('Freight + COD charges')}${rn})-SUM(${C('Packing')}${rn})-SUM(${C('Gateway fees')}${rn})`, rup(contribution)),
      fx(`${C('Contribution')}${rn}-SUM(${C('RTO loss')}${rn})-SUM(${C('Meta spend')}${rn})`, rup(net)),
      fx(i === 0 ? `${C('Net')}${rn}` : `${C('Cumulative net')}${rn - 1}+${C('Net')}${rn}`, rup(cum)),
    ];
  });
  const h = writeTable(ws, cols, body, {
    zebra: true, totalsLabel: 'MONTH TOTAL',
    rowFill: (r) => (typeof r[14]?.result === 'number' && r[14].result < 0 ? LOSS_FILL : null),
  });
  // Data bars carry the trend: exceljs cannot write a native chart.
  ws.addConditionalFormatting({
    ref: `${C('Net')}${h.first}:${C('Net')}${h.last}`,
    // gradient: true keeps this a classic dataBar. The x14 "ext" variant is the
    // one exceljs stamps a fresh UUID into on every write, which would make the
    // same report produce different bytes each run.
    rules: [{ type: 'dataBar', gradient: true, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: GREEN } }],
  });

  // The lines no order date can carry. The day table always has a totals row.
  const totalsRow = h.totals ?? h.last;
  const netCol = C('Net');
  const metaCol = C('Meta spend');
  const extras = [
    ['Cancelled-shipment charges (no delivery date)', -ctx.a.cancelled, null],
    ['Replacement shipments, net of reimbursements received', -ctx.a.replNet, null],
    ['Other courier charges not tied to an order', -ctx.a.otherCourier, null],
    ['Lost shipments (product and freight)', -ctx.a.lost, null],
    ['GST on Meta spend (none when the input credit is claimed)', -ctx.a.metaGst,
      `IF(pnl_gst_input_credit=1,0,-SUM(${metaCol}${h.first}:${metaCol}${h.last})*pnl_meta_gst_pct)`],
    ['Fixed costs for the month', -ctx.a.fixed, '-pnl_fixed_costs'],
  ];
  let r = totalsRow;
  extras.forEach(([label, paise, formula], i) => {
    r = totalsRow + 1 + i;
    put(ws.getCell(`A${r}`), label);
    ws.getCell(`A${r}`).font = { ...BODY, italic: true };
    put(ws.getCell(`${netCol}${r}`), formula ? fx(formula, rup(paise)) : rup(paise), { fmt: FMT.money });
  });
  const monthRow = r + 1;
  const dayTotal = body.reduce((acc, row) => acc + Math.round(row[14].result * 100), 0);
  const monthNet =
    dayTotal - ctx.a.cancelled - ctx.a.replNet - ctx.a.otherCourier - ctx.a.lost - ctx.a.metaGst - ctx.a.fixed;
  put(ws.getCell(`A${monthRow}`), 'NET FOR THE MONTH');
  ws.getCell(`A${monthRow}`).font = BODY_B;
  const mc = ws.getCell(`${netCol}${monthRow}`);
  put(mc, fx(`${netCol}${totalsRow}+SUM(${netCol}${totalsRow + 1}:${netCol}${r})`, rup(monthNet)), { fmt: FMT.money });
  mc.font = BODY_B;
  mc.fill = solid(GOLD);
  printSetup(ws, 1);
  return { h, monthRow, monthNet, netCol, ref: `'Daily'!$${netCol}$${monthRow}` };
}

// --- 1. Summary ------------------------------------------------------------

const ALWAYS_NOTE = 'Offline sales not recorded in Shopify are not included. Boost spend is included.';

function sheetSummary(ctx, t) {
  const ws = ctx.ws['Summary'];
  const { D, T, ND, RP, CL, MA, DY } = t;
  const a = ctx.a;
  const pay = (x) => `"${x}"`;

  put(ws.getCell('A1'), 'MORPAANKH P&L');
  ws.getCell('A1').font = { name: 'Calibri', size: TITLE_SIZE, bold: true, color: { argb: GOLD } };
  put(
    ws.getCell('A2'),
    [
      ctx.meta.monthLabel ?? ctx.month,
      ctx.meta.provisional === false ? 'FINAL' : 'PROVISIONAL',
      `generated ${ctx.meta.generatedAtIST ?? 'unknown'} IST`,
      `trigger: ${ctx.meta.trigger ?? 'unknown'}`,
      `courier charges: ${ctx.meta.courierChargeBasis ?? 'unknown'}`,
    ].join('  ·  '),
  );
  ws.getCell('A2').font = BODY_B;
  const banner = ws.getCell('A3');
  if (ctx.meta.incomplete) {
    put(banner, 'INCOMPLETE: at least one source failed, so figures below are understated. See Data Checks.');
    banner.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    banner.fill = solid(RED_TAB);
  } else {
    put(banner, 'All sources answered for this month.');
    banner.font = { ...BODY, italic: true };
  }
  put(ws.getCell('A4'), ALWAYS_NOTE);
  ws.getCell('A4').font = { ...BODY, italic: true };

  // ---- the statement. Addresses first, so a line can reference any other.
  const s0 = 9;
  /** @type {[string,string,number,('head'|'sub'|'net'|null)][]} */
  const spec = [
    ['gross', 'Gross sales (delivered, incl. GST)', a.del.gross, null],
    ['refunds', '  less refunds', -a.del.refunds, null],
    ['gst', '  less output GST', -a.del.gst, null],
    ['netRev', 'NET REVENUE', a.del.netRev, 'sub'],
    ['cogs', '  Product cost (COGS)', -a.del.cogs, null],
    ['fwd', '  Forward freight (delivered)', -a.del.fwd, null],
    ['cod', '  COD charges', -a.del.cod, null],
    ['packing', '  Packing', -a.del.packing, null],
    ['gateway', '  Payment gateway fees', -a.del.gateway, null],
    ['contrib1', 'CONTRIBUTION BEFORE RTO AND ADS', a.del.contribution, 'sub'],
    ['rtoFwd', '  RTO forward freight', -a.rto.fwd, null],
    ['rtoRet', '  RTO return freight', -a.rto.ret, null],
    ['rtoRest', '  RTO packing and gateway fees (and any COD charge billed)', -(a.rto.packing + a.rto.gateway + a.rto.cod), null],
    ['advance', '  less advance kept on RTO', a.rto.advance, null],
    ['rtoLoss', 'RTO LOSS (BOTH WAYS)', -a.rto.loss, 'sub'],
    ['cancelled', '  Cancelled-shipment charges', -a.cancelled, null],
    ['repl', '  Replacement shipments (net of reimbursements received)', -a.replNet, null],
    ['otherCourier', '  Other courier charges', -a.otherCourier, null],
    ['lost', '  Lost shipments (product and freight)', -a.lost, null],
    ['contrib2', 'CONTRIBUTION AFTER RTO', a.contribAfterRto, 'sub'],
    ['metaSales', '  Meta ads: sales campaigns', -a.metaSales, null],
    ['metaBoost', '  Meta ads: boosts and other', -a.metaOther, null],
    ['metaGst', '  GST on Meta (if no input credit)', -a.metaGst, null],
    ['metaTotal', 'TOTAL META', -a.meta, 'sub'],
    ['profit1', 'PROFIT BEFORE FIXED COSTS', a.profitBeforeFixed, 'sub'],
    ['fixed', '  Fixed costs', -a.fixed, null],
    ['net', 'NET PROFIT / LOSS', a.net, 'net'],
  ];
  /** @type {Record<string,string>} */
  const at = {};
  spec.forEach(([key], i) => (at[key] = `B${s0 + 1 + i}`));
  // Every one of these is a counted-aware total of a column on another sheet,
  // so a statement line, its cached value and the sheet it came from are the
  // same number by construction.
  const F = {
    gross: D.sumOf('Gross sale'),
    refunds: `-${D.sumOf('Refunds')}`,
    gst: `-${D.sumOf('Output GST')}`,
    netRev: `SUM(${at.gross}:${at.gst})`,
    cogs: `-${D.sumOf('COGS')}`,
    fwd: `-${D.sumOf('Forward freight')}`,
    cod: `-${D.sumOf('COD charge')}`,
    packing: `-${D.sumOf('Packing')}`,
    gateway: `-${D.sumOf('Gateway fee')}`,
    contrib1: `SUM(${at.netRev}:${at.gateway})`,
    rtoFwd: `-${T.sumOf('Forward freight')}`,
    rtoRet: `-${T.sumOf('Return freight')}`,
    rtoRest: `-(${T.sumOf('Packing')}+${T.sumOf('Gateway fee')}+${T.sumOf('COD charge')})`,
    advance: T.sumOf('Advance kept'),
    rtoLoss: `SUM(${at.rtoFwd}:${at.advance})`,
    cancelled: `-SUMIF(${ND.ref('Outcome')},"CANCELLED",${ND.ref('Charge in P&L')})`,
    repl: `-SUM(${RP.ref('Cost in P&L')})`,
    otherCourier: `-SUMIF(${CL.ref('In P&L as')},"other",${CL.ref('Total')})`,
    lost: `-SUMIF(${ND.ref('Outcome')},"LOST",${ND.ref('Charge in P&L')})`,
    contrib2: `${at.contrib1}+${at.rtoLoss}+SUM(${at.cancelled}:${at.lost})`,
    metaSales: `-SUMIF(${MA.ref('Type')},"sales",${MA.ref('Spend')})`,
    metaBoost: `-SUMIF(${MA.ref('Type')},"<>sales",${MA.ref('Spend')})`,
    metaGst: `IF(pnl_gst_input_credit=1,0,(${at.metaSales}+${at.metaBoost})*pnl_meta_gst_pct)`,
    metaTotal: `SUM(${at.metaSales}:${at.metaGst})`,
    profit1: `${at.contrib2}+${at.metaTotal}`,
    fixed: `-pnl_fixed_costs`,
    net: `${at.profit1}+${at.fixed}`,
  };

  const stmtCols = [{ h: 'PROFIT AND LOSS', w: 48, wrap: true }, { h: '₹', fmt: FMT.money, w: 16 }, { h: '% of net revenue', fmt: FMT.pct, w: 13 }];
  const stmtBody = spec.map(([key, label, paise]) => [
    label,
    fx(F[key], rup(paise)),
    fx(`IF(${at.netRev}=0,0,${at[key]}/${at.netRev})`, a.del.netRev ? round2((paise / a.del.netRev) * 1e4) / 1e4 : 0),
  ]);
  writeTable(ws, stmtCols, stmtBody, { startRow: s0, filter: false, freeze: false });
  spec.forEach(([key, , , style], i) => {
    if (!style) return;
    const row = ws.getRow(s0 + 1 + i);
    for (let c = 1; c <= 3; c++) {
      row.getCell(c).font = style === 'net' ? { ...BODY_B, size: 11 } : BODY_B;
      row.getCell(c).fill = solid(style === 'net' ? GOLD : ZEBRA_FILL);
    }
  });
  if (a.net < 0) for (let c = 1; c <= 3; c++) ws.getRow(s0 + 1 + spec.length - 1).getCell(c).fill = solid(LOSS_FILL);

  // ---- KPI tiles, above the statement, pointing into it.
  const fn = ctx.report.funnel ?? null;
  const delivered = fn?.delivered ?? a.del.count;
  const nRto = fn?.rto ?? a.rto.count;
  // Per-order figures divide by the orders actually IN the totals, the way the
  // engine's ratios do. countedRef() is live, so it follows the sheet.
  const nCounted = a.del.counted;
  const countedDiv = D.countedRef();
  const rtoRate = delivered + nRto ? nRto / (delivered + nRto) : 0;
  const kpis = [
    ['Net profit / loss', fx(at.net, rup(a.net)), FMT.money],
    ['Net margin %', fx(`IF(${at.netRev}=0,0,${at.net}/${at.netRev})`, a.del.netRev ? round2((a.net / a.del.netRev) * 1e4) / 1e4 : 0), FMT.pct],
    ['Delivered orders', delivered, FMT.int],
    ['RTO rate', round2(rtoRate * 1e4) / 1e4, FMT.pct],
    // The tile is the P&L line, which carries the GST while no input credit is
    // claimed. Labelling it "Meta spend" put it beside a Meta Ads sheet
    // totalling the spend alone and made the report look like it disagreed
    // with itself.
    [ctx.cfg.gstInputCreditClaimed ? 'Meta spend' : 'Meta spend incl GST', fx(`-${at.metaTotal}`, rup(a.meta)), FMT.money],
    ['Net per delivered order', nCounted ? fx(`${at.net}/${countedDiv}`, rup(Math.round(a.net / nCounted))) : miss('no delivered order is complete enough to count'), FMT.money],
  ];
  kpis.forEach(([label, value, fmt], i) => {
    const lc = ws.getRow(6).getCell(i + 1);
    put(lc, label);
    lc.font = HEAD_FONT;
    lc.fill = solid(GREEN);
    lc.alignment = { wrapText: true, vertical: 'middle' };
    const vc = ws.getRow(7).getCell(i + 1);
    put(vc, value, { fmt });
    vc.font = { name: 'Calibri', size: 12, bold: true, color: { argb: GREEN } };
    if (!vc.fill) vc.fill = solid(ZEBRA_FILL);
  });
  ws.getRow(6).height = 26;

  // ---- the settlement cut: this month is the orders PLACED in it
  let r = s0 + spec.length + 2;
  const st = ctx.report.settlement ?? null;
  if (st) {
    put(ws.getCell(`A${r}`), String(st.note ?? ''));
    ws.getCell(`A${r}`).font = { ...BODY, italic: true };
    ws.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
    r += 1;
    const names = (list) => (list?.length ? list.join(', ') : null);
    const pctCell =
      st.netRevenueAfterMonthEndPct == null
        ? noted('unknown', 'No charge data is loaded, so the share of net revenue cannot be worked out.')
        : { _v: round2(Number(st.netRevenueAfterMonthEndPct) / 100 * 1e4) / 1e4, fmt: FMT.pct };
    const srows = [
      ['What this month counts', String(st.cohortBasis ?? '')],
      ['Delivered orders in the cohort', { _v: st.deliveredTotal ?? 0, fmt: FMT.int }],
      [
        'Delivered AFTER the month closed',
        names(st.orders?.map((o) => o.name))
          ? noted(st.deliveredAfterMonthEnd ?? 0, `${names(st.orders.map((o) => o.name))}`)
          : { _v: st.deliveredAfterMonthEnd ?? 0, fmt: FMT.int },
      ],
      ['  of those, counted in the statement', { _v: st.deliveredAfterMonthEndCounted ?? 0, fmt: FMT.int }],
      ['Net revenue delivered after the month closed', money(st.netRevenueAfterMonthEndPaise ?? 0)],
      ['  as a share of net revenue', pctCell],
      [
        'RTO legs not final at the month end',
        names(st.rtoLegsNotFinalOrders)
          ? noted(st.rtoLegsNotFinal ?? 0, names(st.rtoLegsNotFinalOrders))
          : { _v: st.rtoLegsNotFinal ?? 0, fmt: FMT.int },
      ],
      [
        'RTO started after the month closed',
        names(st.rtoStartedAfterMonthEndOrders)
          ? noted(st.rtoStartedAfterMonthEndOrders.length, names(st.rtoStartedAfterMonthEndOrders))
          : { _v: (st.rtoStartedAfterMonthEndOrders ?? []).length, fmt: FMT.int },
      ],
    ];
    const sh = writeTable(
      ws,
      [{ h: 'SETTLEMENT CUT', w: 48, wrap: true }, { h: 'As at the month end', w: 16 }],
      srows,
      { startRow: r, filter: false, freeze: false, zebra: true },
    );
    r = sh.last + 2;
  }

  /*
   * The engine's funnel verbatim where it sent one. Recomputing "shipped" read
   * 49 against the engine's 51 in October: the engine counts an order with a
   * FULFILLMENT, this counted one with an AWB, and two parcels had the first
   * without the second. One definition, and it is the engine's.
   */
  const funnel = [
    ['Orders on record', fn?.onRecord ?? ctx.rows.length],
    ['Excluded (tests, founder and family)', fn?.excluded ?? (a.by.EXCLUDED ?? []).length],
    ['Cancelled', fn?.cancelled ?? (a.by.CANCELLED ?? []).length],
    ['Shipped', fn?.shipped ?? ctx.rows.filter((x) => x.outcome !== 'EXCLUDED' && (x.order.fulfillments ?? []).length > 0).length],
    ['Delivered', delivered],
    ['RTO', nRto],
    ['Pending', fn?.pending ?? (a.by.PENDING ?? []).length],
    ['Lost', fn?.lost ?? (a.by.LOST ?? []).length],
  ];
  const fh = writeTable(ws, [{ h: 'ORDER FUNNEL', w: 48 }, { h: 'Orders', fmt: FMT.int, w: 16 }], funnel, { startRow: r, filter: false, freeze: false, zebra: true });

  // ---- unit economics per delivered order
  r = fh.last + 2;
  const per = (paise) => (nCounted ? rup(Math.round(paise / nCounted)) : 0);
  const unit = [
    ['Net revenue', 'netRev'], ['Product cost (COGS)', 'cogs'], ['Freight and COD charges', null],
    ['Packing', 'packing'], ['Gateway fee', 'gateway'], ['Contribution before RTO and ads', 'contrib1'],
    ['RTO loss', 'rtoLoss'], ['Meta', 'metaTotal'], ['Net', 'net'],
  ];
  const linePaise = (key) => spec.find(([k]) => k === key)?.[2] ?? 0;
  const unitRows = unit.map(([label, key]) => {
    const formula = key ? `${at[key]}/${countedDiv}` : `(${at.fwd}+${at.cod})/${countedDiv}`;
    const paise = key ? linePaise(key) : -(a.del.fwd + a.del.cod);
    return [label, nCounted ? fx(formula, per(paise)) : miss('no delivered order is complete enough to count')];
  });
  const uh = writeTable(
    ws,
    [{ h: `PER DELIVERED ORDER (over ${nCounted} counted in the totals)`, w: 48, wrap: true }, { h: '₹', fmt: FMT.money, w: 16 }],
    unitRows,
    { startRow: r, filter: false, freeze: false, zebra: true },
  );

  // ---- by payment type
  r = uh.last + 2;
  const payRows = ['cod', 'prepaid', 'partial'].map((p) => {
    const all = ctx.rows.filter((x) => x.order.paymentType === p && x.outcome !== 'EXCLUDED');
    const del = all.filter((x) => x.outcome === 'DELIVERED');
    const rt = all.filter((x) => x.outcome === 'RTO');
    const contrib =
      sumP(del.filter(counted), (x) => ctx.a.res(x).contribution) -
      sumP(rt.filter(counted), (x) => ctx.a.res(x).rtoLoss);
    const label = PAY_LABEL[p];
    return [
      label, all.length, del.length,
      del.length + rt.length ? round2((rt.length / (del.length + rt.length)) * 1e4) / 1e4 : 0,
      fx(
        `SUMIFS(${D.ref('Contribution')},${D.ref('Payment')},${pay(label)},${D.flagRange()},1)` +
          `-SUMIFS(${T.ref('Total RTO loss')},${T.ref('Payment')},${pay(label)},${T.flagRange()},1)`,
        rup(contrib),
      ),
    ];
  });
  const ph = writeTable(
    ws,
    [{ h: 'BY PAYMENT TYPE', w: 48 }, { h: 'Orders', fmt: FMT.int, w: 16 }, { h: 'Delivered', fmt: FMT.int, w: 13 }, { h: 'RTO %', fmt: FMT.pct, w: 10 }, { h: 'Contribution', fmt: FMT.money, w: 14 }],
    payRows,
    { startRow: r, filter: false, freeze: false, zebra: true, totalsLabel: 'ALL PAYMENT TYPES' },
  );

  // ---- previous month, re-pulled today against what we said last time
  r = ph.last + 2;
  const pm = ctx.report.previousMonth ?? null;
  const keys = pm ? [...new Set([...Object.keys(pm.reported ?? {}), ...Object.keys(pm.restated ?? {})])] : [];
  const fmtFor = (k) => (/Paise$/.test(k) ? FMT.money : /Pct|Rate|Share|Margin/i.test(k) ? FMT.pct : FMT.int);
  const val = (v, k) => (v == null ? miss('not in the stored snapshot') : { _v: /Paise$/.test(k) ? rup(v) : v, fmt: fmtFor(k) });
  const pmRows = keys.map((k) => {
    const was = pm.reported?.[k], now = pm.restated?.[k];
    return [
      k.replace(/Paise$/, '').replace(/([A-Z])/g, ' $1').trim(),
      val(was, k), val(now, k),
      was == null || now == null ? miss('one side is missing') : { _v: /Paise$/.test(k) ? rup(now - was) : now - was, fmt: fmtFor(k) },
    ];
  });
  const mh = writeTable(
    ws,
    [{ h: `PREVIOUS MONTH${pm?.label ? ` (${pm.label})` : ''}`, w: 48 }, { h: 'As last reported', w: 16 }, { h: 'Re-pulled today', w: 16 }, { h: 'Change', w: 14 }],
    pmRows,
    { startRow: r, filter: false, freeze: false, zebra: true, empty: 'no previous snapshot to compare against' },
  );

  // ---- data-quality flags
  r = mh.last + 2;
  const flags = normaliseFlags(ctx);
  writeTable(
    ws,
    [{ h: 'DATA QUALITY', w: 48, wrap: true }, { h: 'Orders affected', fmt: FMT.int, w: 16 }, { h: 'Note', w: 45, wrap: true }],
    flags.map((f) => [f.label, f.count, f.note ?? '']),
    { startRow: r, filter: false, freeze: false, zebra: true, empty: 'no data-quality flags this month' },
  );

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];
  printSetup(ws, 9);
  return { at, netCell: at.net, netRevCell: at.netRev, countedDiv };
}

/**
 * The engine's flags, plus what the rows give away, plus the one line the brief
 * asks for and the Summary had been missing: how many orders are out of every
 * total and how much money they are. Without it the Summary under-reports and
 * nothing on the page says why.
 */
function normaliseFlags(ctx) {
  const out = [];
  for (const [bucket, label] of [['delivered', 'delivered order'], ['rto', 'RTO order'], ['cancelled', 'cancelled order'], ['lost', 'lost order']]) {
    const rows = ctx.a.blocked[bucket] ?? [];
    if (!rows.length) continue;
    const gross = sumP(rows, (r) => r.order.currentTotalPaise);
    const why = [...new Set(rows.flatMap((r) => r.missing ?? []))].map((m) => m.replace(/_/g, ' ')).join(', ');
    out.push({
      label:
        `${rows.length} ${label}${rows.length === 1 ? ' is' : 's are'} EXCLUDED FROM EVERY TOTAL because the cost is incomplete ` +
        `(₹${rup(gross).toLocaleString('en-IN')} of gross sales): ${rows.map((r) => r.order.name).join(', ')}`,
      count: rows.length,
      note: `Missing ${why || 'cost data'}. The orders are on their sheet with the amounts shown and "In totals" reading 0, so you can see them and fix them. This is the engine's rule: a row that brings its revenue but not its freight would make the month read richer than it was.`,
    });
  }
  for (const f of ctx.report.flags ?? []) {
    if (typeof f === 'string') out.push({ label: f, count: 1 });
    else out.push({ label: f.label ?? f.code ?? 'flag', count: f.count ?? 1, note: f.note ?? f.severity });
  }
  /** @type {Map<string, number>} */
  const missing = new Map();
  for (const r of ctx.rows) for (const m of r.missing ?? []) missing.set(m, (missing.get(m) ?? 0) + 1);
  for (const [code, count] of [...missing].sort((x, y) => x[0].localeCompare(y[0]))) {
    out.push({ label: `Missing: ${code.replace(/_/g, ' ')}`, count, note: 'The affected cells read MISSING, and that cost is out of the totals.' });
  }
  const inferredCount = ctx.rows.filter((r) => r.outcomeInferred).length;
  if (inferredCount) out.push({ label: 'Outcome inferred, Delhivery had no record', count: inferredCount, note: 'Shown in italics on the order sheets.' });
  /*
   * An unrefunded deposit is no longer booked as income unless Delhivery says
   * the garment is actually back. The money has to stay VISIBLE as an open
   * question rather than quietly leave the report, so the total gets its own
   * line and every order is listed under "orders worth a look".
   */
  const open = ctx.report.openQuestions ?? [];
  const unverified = ctx.report.totals?.advanceUnverifiedPaise ?? open.reduce((x, q) => x + (q.amountPaise ?? 0), 0);
  if (open.length || unverified) {
    out.push({
      label:
        `₹${rup(unverified).toLocaleString('en-IN')} of unrefunded deposits is NOT booked as income ` +
        `and is an open question on ${open.length} order${open.length === 1 ? '' : 's'}`,
      count: open.length,
      note:
        'A deposit is only income once Delhivery says the garment is back. Until then it is asked ' +
        'about rather than claimed, so the statement is short by this much and deliberately so. ' +
        'Every order is listed under ORDERS WORTH A LOOK on Data Checks.',
    });
  }
  return out;
}

// --- 12. Data Checks -------------------------------------------------------

function sheetDataChecks(ctx, t) {
  const ws = ctx.ws['Data Checks'];
  const { D, CL, MA, DY, S } = t;
  const a = ctx.a;
  const m = (paise) => ({ _v: rup(paise), fmt: FMT.money });
  const ok = (cond) => (cond ? 'ok' : 'MISMATCH');

  put(ws.getCell('A1'), 'DATA CHECKS');
  ws.getCell('A1').font = { name: 'Calibri', size: TITLE_SIZE, bold: true, color: { argb: GOLD } };

  const shipByAwb = new Map(
    (ctx.report.shipments ?? ctx.report.inputs?.shipments ?? []).map((sh) => [String(sh.awb), sh]),
  );
  /** Every shipment this order's waybills resolve to. Empty means Delhivery has no record. */
  const shipmentsFor = (x) => (x.awbs ?? []).map((awb) => shipByAwb.get(String(awb))).filter(Boolean);

  const fn = ctx.report.funnel ?? null;
  const onRecord = fn?.onRecord ?? ctx.rows.length;
  const funnelSum = fn
    ? fn.excluded + fn.cancelled + fn.delivered + fn.rto + fn.pending + fn.lost
    : (a.by.EXCLUDED ?? []).length + (a.by.CANCELLED ?? []).length + a.del.count + a.rto.count +
      (a.by.PENDING ?? []).length + (a.by.LOST ?? []).length;
  const rowNetRev = sumP((a.by.DELIVERED ?? []).filter(counted), (r) => r.netRevenuePaise);
  const engineKeys = new Set((ctx.report.reconciliations ?? []).map((x) => String(x.key ?? '')));

  /*
   * EVERY STATUS IS A LIVE COMPARISON OF THE TWO CELLS BESIDE IT.
   *
   * Two rows used to take their status from a literal `ok(true)`: they printed
   * "ok" whatever the cells held, including after exactly the hand edit one of
   * their own notes said the check existed to catch. A tripwire that cannot
   * trip is worse than no tripwire, because it is read as reassurance. Those
   * two compared a number against a sum of the same number, so they are gone
   * rather than patched; the engine's own meta and courier reconciliations say
   * the same thing further down and say it against independently derived
   * figures. What is left gets `IF(ROUND(B-C,2)=0,...)` over its own cells, so
   * editing either side flips the verdict in front of you.
   */
  const CHECK_ROW_1 = 4; // the table's header sits on row 3
  const liveStatus = (expected, actual, agree, index) => {
    const bothNumeric = typeof expected === 'number' || typeof actual === 'number';
    if (!bothNumeric) return agree === null ? '' : ok(agree);
    const rn = CHECK_ROW_1 + index;
    return fx(`IF(ROUND(B${rn}-C${rn},2)=0,"ok","MISMATCH")`, ok(agree));
  };
  /** @type {any[][]} */
  const checks = [];
  // The brief names this one, so it is here whenever the engine did not send it.
  if (!engineKeys.has('funnel')) {
    checks.push([
      'On record = excluded + cancelled + delivered + RTO + pending + lost',
      onRecord, funnelSum, liveStatus(onRecord, funnelSum, onRecord === funnelSum, 0),
      'Every order lands in exactly one bucket.',
    ]);
  }
  checks.push(
    ['Net revenue: statement chain against the Delivered column', m(a.del.netRev), m(rowNetRev), liveStatus(a.del.netRev, rowNetRev, Math.abs(a.del.netRev - rowNetRev) <= 1, checks.length), 'The statement computes gross less refunds less output GST. This compares it with the engine\u2019s own net revenue per order.'],
    ['Daily net for the month = Summary net profit / loss', fx(DY.ref, rup(DY.monthNet)), fx(`Summary!${S.netCell}`, rup(a.net)), fx(`IF(ROUND(${DY.ref}-Summary!${S.netCell},2)=0,"ok","MISMATCH")`, ok(DY.monthNet === a.net)), 'Both sides are live references, and the Daily sheet carries the monthly lines no order date can hold. Editing an input on Assumptions moves the Summary but not the Daily sheet\u2019s own packing and gateway columns, so a mismatch here right after an edit is that, and not a broken report.'],
  );
  /*
   * THE TRIPWIRE. These rows are why the October run caught the workbook
   * totalling rows the engine had blocked, so they stay even when green, and
   * the key names are the engine's real ones: `netPaise` and `metaPaise` did
   * not exist, so those two comparisons had been silently skipping.
   */
  const ENGINE = [
    ['Net profit / loss', 'netProfitPaise', a.net],
    ['Gross sales', 'grossSalesPaise', a.del.gross],
    ['Net revenue', 'netRevenuePaise', a.del.netRev],
    ['COGS', 'cogsPaise', a.del.cogs],
    ['Forward freight', 'forwardFreightPaise', a.del.fwd],
    ['Packing', 'packingPaise', a.del.packing],
    ['Gateway fees', 'gatewayFeesPaise', a.del.gateway],
    ['Contribution before RTO and ads', 'contributionBeforeRtoAndAdsPaise', a.del.contribution],
    ['RTO loss', 'rtoLossPaise', a.rto.loss],
    ['Cancelled-shipment charges', 'cancelledShipmentChargesPaise', a.cancelled],
    ['Replacement shipments', 'replacementShipmentsPaise', a.replNet],
    ['Other courier charges', 'otherCourierChargesPaise', a.otherCourier],
    ['Lost shipments', 'lostShipmentsPaise', a.lost],
    ['Contribution after RTO', 'contributionAfterRtoPaise', a.contribAfterRto],
    ['Total Meta', 'totalMetaPaise', a.meta],
    ['Fixed costs', 'fixedCostsPaise', a.fixed],
    ['Delivered orders counted in the totals', 'countedDelivered', a.del.counted],
    ['RTO orders counted in the totals', 'countedRto', a.rto.counted],
    ['Delivered orders blocked from the totals', 'blockedDelivered', a.blocked.delivered.length],
    ['RTO orders blocked from the totals', 'blockedRto', a.blocked.rto.length],
  ];
  const isCount = (key) => /^counted|^blocked/.test(key);
  for (const [label, key, mine] of ENGINE) {
    const theirs = ctx.report.totals?.[key];
    if (theirs == null) continue;
    const show = isCount(key) ? (v) => v : m;
    checks.push([
      `Engine total against this workbook: ${label}`,
      show(theirs), show(mine),
      liveStatus(theirs, mine, Math.abs(theirs - mine) <= 1, checks.length),
      'The workbook totals what it renders, and only the rows the engine counted. A mismatch means the engine and the sheets disagree, and the sheets are what you are reading.',
    ]);
  }
  /*
   * The engine sends {key, label, a, b, agree}. Reading `name`/`expected`/
   * `actual` found none of them, so its three reconciliations rendered as a
   * bare "check" with two empty cells. Both spellings are read now.
   */
  for (const rec of ctx.report.reconciliations ?? []) {
    const exp = rec.a ?? rec.expected;
    const act = rec.b ?? rec.actual;
    const agree = rec.agree ?? rec.ok;
    const label = String(rec.label ?? rec.name ?? rec.check ?? rec.key ?? 'check');
    /*
     * The engine's reconciliations carry no unit, and its funnel one counts
     * ORDERS. Rupee-formatting that turned "71 orders" into 0.71, which reads
     * like a rounding error in a sheet whose whole job is to be trusted.
     */
    const isOrders = /funnel|orders|count/i.test(`${rec.key ?? ''} ${label}`);
    const show = (v) => (typeof v !== 'number' ? String(v ?? '') : isOrders ? v : m(v));
    const shown = [show(exp), show(act)];
    checks.push([
      label, shown[0], shown[1],
      liveStatus(exp, act, agree === undefined ? null : agree !== false, checks.length),
      rec.note ?? '',
    ]);
  }
  const h = writeTable(
    ws,
    [{ h: 'Reconciliation', w: 45, wrap: true }, { h: 'Expected', w: 16 }, { h: 'Actual', w: 16 }, { h: 'Status', w: 11 }, { h: 'Note', w: 45, wrap: true }],
    checks,
    { startRow: 3, zebra: true, rowFill: (r) => (r[3] === 'MISMATCH' ? LOSS_FILL : null) },
  );

  // Soft check: does the real cost of getting a parcel out match the rule of thumb?
  let r = h.last + 2;
  put(ws.getCell(`A${r}`), 'SOFT CHECK: DELIVERY AND PACKING PER ORDER AGAINST THE RULE OF THUMB');
  ws.getCell(`A${r}`).font = BODY_B;
  /*
   * ONE DEFINITION, the engine's (engine.mjs, "the owner's rule of thumb").
   *
   * This block used to group prepaid WITH partial and read the resolved COD
   * charge, which gave 79.87 and "within 30%", while the engine's own flag on
   * the Summary gave 71.57 over the 12 prepaid orders alone and "off by 35%".
   * The owner cannot be shown both answers to one question. The engine groups
   * by exact payment type over the orders that are IN the totals and sums each
   * row's own forward freight, COD charge and packing, so that is what this
   * does, and the two surfaces now print the same number.
   *
   * Config sets no rule of thumb for a partial order, so partials are listed
   * for information with no verdict rather than folded into prepaid.
   */
  const softRow = (pt, thumb) => {
    const rs = (a.by.DELIVERED ?? []).filter(counted).filter((x) => x.order.paymentType === pt);
    const spend = sumP(rs, (x) => (x.forwardFreightPaise ?? 0) + (x.codChargePaise ?? 0) + (x.packingPaise ?? 0));
    const avg = rs.length ? spend / rs.length : 0;
    const off = thumb && rs.length ? Math.abs(avg - thumb) / thumb : 0;
    return [
      pt === 'cod' ? 'COD orders' : pt === 'prepaid' ? 'Prepaid orders' : 'Partial orders',
      rs.length,
      thumb ? m(thumb) : 'no rule of thumb',
      rs.length ? m(Math.round(avg)) : '',
      thumb && rs.length ? round2(off * 1e4) / 1e4 : '',
      rs.length === 0
        ? 'nothing delivered on this payment type'
        : !thumb
          ? 'listed for information: config sets no rule of thumb for a partial order'
          : off > 0.3
            ? /*
               * NAME THE SUSPECT. "Check the courier charges" sent the owner
               * looking at the rate card when the gap was the weight: a
               * computed charge is quoted at an assumed dead weight and
               * Delhivery bills the greater of dead and volumetric, so a
               * computed average can only ever sit BELOW the invoice.
               */
              ctx.meta.courierChargeBasis === 'ledger'
              ? 'OFF BY MORE THAN 30%: these are billed actuals, so check the rule of thumb itself and the packing input'
              : 'OFF BY MORE THAN 30% and the charges are computed, not billed. First suspect is the assumed parcel weight on Assumptions: it is a floor, so this average sits below the invoice. Upload the Delhivery billing export to replace it with actuals.'
            : 'within 30% of the rule of thumb',
    ];
  };
  const soft = [
    softRow('prepaid', ctx.cfg.ruleOfThumbPrepaidPaise),
    softRow('cod', ctx.cfg.ruleOfThumbCodPaise),
    softRow('partial', 0),
  ];
  const sh = writeTable(
    ws,
    [{ h: 'Payment type', w: 45 }, { h: 'Delivered orders counted', fmt: FMT.int, w: 16 }, { h: 'Rule of thumb', w: 16 }, { h: 'Actual average', w: 16 }, { h: 'Off by', fmt: FMT.pct, w: 11 }, { h: 'Verdict', w: 45, wrap: true }],
    soft,
    { startRow: r + 1, zebra: true, filter: false, freeze: false, rowFill: (x) => (typeof x[4] === 'number' && x[4] > 0.3 ? LOSS_FILL : null) },
  );

  // Order-level problems worth a human eye.
  r = sh.last + 2;
  put(ws.getCell(`A${r}`), 'ORDERS WORTH A LOOK');
  ws.getCell(`A${r}`).font = BODY_B;
  const issues = [];
  /*
   * No duplicate detection here any more. The key was
   * `customerName|currentTotalPaise`, and the excluded automation tests all
   * key as `null|0`, so eight of them were listed as duplicates of each other
   * and a fifth of this table was noise. The engine's detector keys on the
   * same customer on the same day, which is the right question, and its flags
   * already appear under DATA QUALITY on the Summary.
   */
  for (const x of ctx.rows) {
    for (const code of x.missing ?? []) issues.push([x.order.name, 'missing cost', code.replace(/_/g, ' ')]);
    if (x.outcomeInferred) issues.push([x.order.name, 'inferred outcome', x.outcomeReason ?? 'Delhivery had no record of this parcel']);
    /*
     * ASK THE DOMAIN, DO NOT RE-DERIVE IT.
     *
     * This used to re-implement the conflict test and got #1205 backwards:
     * it printed "Delhivery says delivered, Shopify never marked it" when
     * Delhivery had no record of the parcel at all and Shopify HAD marked it
     * fulfilled. Two mistakes in one line. It tested
     * `displayStatus === 'DELIVERED'` where Shopify's value is FULFILLED, and
     * it had no equivalent of shopifyConflict()'s first guard: with no
     * shipment there is nothing to disagree with, so there is no conflict.
     * Getting provenance backwards on the source this report calls
     * authoritative is the worst line on the sheet to invent.
     */
    const conflict = shopifyConflict(x.order, shipmentsFor(x), x.outcome);
    if (conflict) issues.push([x.order.name, 'Shopify vs Delhivery', conflict]);
    /*
     * No GST comparison here. This compared Shopify's tax lines against the
     * row's Output GST, which backs the slab out of the FULL total including
     * the COD fee, while the engine's own "Shopify GST x vs slab y" flag
     * compares against the product lines alone, with the fee deliberately
     * excluded (gst.mjs says why). Two different bases, so this row disagreed
     * with the engine's by the GST on the fee and called it a mismatch. The
     * engine's flag is the right comparison and is already on the row.
     */
  }
  for (const q of ctx.report.openQuestions ?? []) {
    issues.push([
      String(q.orderName ?? ''),
      'open question',
      `₹${rup(q.amountPaise ?? 0)} (${q.outcome ?? ''}): ${q.note ?? ''}`,
    ]);
  }
  issues.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]) || x[2].localeCompare(y[2]));
  writeTable(
    ws,
    [{ h: 'Order #', w: 12 }, { h: 'Kind', w: 22 }, { h: 'Detail', w: 60, wrap: true }],
    issues,
    { startRow: r + 1, zebra: true, filter: false, freeze: false, empty: 'nothing on any order needs a second look' },
  );

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
  printSetup(ws, 3);
  return h;
}
