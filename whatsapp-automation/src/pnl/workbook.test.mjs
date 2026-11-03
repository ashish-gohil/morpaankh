/*
 * workbook.test.mjs — the golden test for the P&L workbook.
 *
 * The engine is being written in parallel, so the fixture below IS the contract:
 * it is the smallest Report that still exercises every branch the sheets have
 * (a delivered order with an assumed gateway fee, a delivered order with no
 * unit cost so a cell has to read MISSING, an RTO with an advance kept and an
 * unbilled return leg, a pending order, a cancelled order with a real charge,
 * an excluded order, a replacement, Meta days of both types, and an AWB tied to
 * nothing).
 *
 * The test builds, writes to a Buffer, REOPENS it with exceljs and then asserts
 * on what Excel would actually see. Asserting on the in-memory workbook would
 * pass while the file on disk was broken.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { buildWorkbook } from './workbook.mjs';

const PAISE = (rupees) => Math.round(rupees * 100);

/** One order, with only what the sheets read. */
function order(name, over = {}) {
  return {
    name,
    gid: `gid://shopify/Order/${name.slice(1)}`,
    numericId: name.slice(1),
    createdAt: '2026-10-05T06:30:00Z',
    cancelledAt: null,
    cancelReason: null,
    sourceName: 'web',
    appName: null,
    tags: [],
    customerName: 'A Customer',
    city: 'Surat',
    state: 'GJ',
    pin: '395003',
    financialStatus: 'PAID',
    fulfillmentStatus: 'FULFILLED',
    gateways: ['razorpay'],
    taxesIncluded: true,
    paymentType: 'prepaid',
    channel: 'Online Store',
    currentTotalPaise: PAISE(2000),
    totalPaise: PAISE(2000),
    discountsPaise: PAISE(200),
    refundedPaise: 0,
    netPaymentPaise: PAISE(2000),
    outstandingPaise: 0,
    codFeePaise: 0,
    prepaidReceivedPaise: PAISE(2000),
    shopifyTaxLines: [{ title: 'IGST', ratePct: 5, pricePaise: PAISE(95.24) }],
    transactions: [],
    fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: '2026-10-06T06:00:00Z', deliveredAt: '2026-10-09T09:00:00Z', awb: '111', company: 'Delhivery' }],
    awbs: ['111'],
    utm: null,
    lines: [{ title: 'Bandhan Kurta Set', sku: 'BND-M', quantity: 1, currentQuantity: 1, originalUnitPaise: PAISE(2000), discountedUnitPaise: PAISE(2000), variantGid: 'gid://v/1', unitCostPaise: PAISE(900) }],
    ...over,
  };
}

/** One row of the engine's output. */
function row(o, outcome, over = {}) {
  const gst = Math.round(o.currentTotalPaise * (5 / 105));
  return {
    order: o,
    outcome,
    outcomeReason: outcome === 'DELIVERED' ? 'Delhivery DELIVERED' : outcome.toLowerCase(),
    outcomeInferred: false,
    awbs: o.awbs,
    parcelShare: 1,
    grossSalePaise: o.currentTotalPaise - o.refundedPaise,
    outputGstPaise: gst,
    netRevenuePaise: o.currentTotalPaise - o.refundedPaise - gst,
    cogsPaise: o.lines.reduce((a, l) => a + (l.unitCostPaise == null ? 0 : l.unitCostPaise * l.currentQuantity), 0),
    forwardFreightPaise: PAISE(76),
    rtoFreightPaise: null,
    codChargePaise: 0,
    packingPaise: PAISE(25),
    gatewayFeePaise: PAISE(47.2),
    advanceKeptPaise: null,
    totalCostPaise: null,
    contributionPaise: null,
    chargeSource: 'ledger',
    complete: true,
    missing: [],
    assumed: [],
    flags: [],
    ...over,
  };
}

function fixture() {
  const d1 = order('#1170');
  const d2 = order('#1171', {
    paymentType: 'cod',
    codFeePaise: PAISE(50),
    currentTotalPaise: PAISE(1550),
    awbs: ['222'],
    customerName: 'B Customer',
    fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: '2026-10-11T06:00:00Z', deliveredAt: '2026-10-15T09:00:00Z', awb: '222', company: 'Delhivery' }],
    createdAt: '2026-10-10T06:30:00Z',
    // No unit cost on this line: the COGS cell has to read MISSING.
    lines: [{ title: 'Taana Co-ord Set', sku: 'TAA-L', quantity: 1, currentQuantity: 1, originalUnitPaise: PAISE(1500), discountedUnitPaise: PAISE(1500), variantGid: null, unitCostPaise: null }],
  });
  const t1 = order('#1172', {
    paymentType: 'partial',
    createdAt: '2026-10-12T06:30:00Z',
    awbs: ['333'],
    customerName: 'C Customer',
    tags: ['rto-reason-refused'],
    currentTotalPaise: PAISE(2600),
    prepaidReceivedPaise: PAISE(130),
    fulfillments: [{ status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: '2026-10-13T06:00:00Z', deliveredAt: null, awb: '333', company: 'Delhivery' }],
  });
  // Same customer and the same total as #1170: the duplicate check must see it.
  const p1 = order('#1173', { createdAt: '2026-10-28T06:30:00Z', awbs: ['444'], fulfillments: [] });
  const c1 = order('#1174', { createdAt: '2026-10-29T06:30:00Z', cancelledAt: '2026-10-30T06:30:00Z', cancelReason: 'CUSTOMER', awbs: ['555'], customerName: 'E Customer' });
  const x1 = order('#1175', { createdAt: '2026-10-30T06:30:00Z', customerName: 'Ashish Gohil', tags: ['test-order'], awbs: [] });

  const rows = [
    row(d1, 'DELIVERED'),
    row(d2, 'DELIVERED', {
      cogsPaise: null,
      missing: ['unit_cost'],
      assumed: ['gateway_fee'],
      codChargePaise: PAISE(35),
      flags: ['no unit cost on the Taana line'],
    }),
    row(t1, 'RTO', {
      outputGstPaise: null,
      netRevenuePaise: 0,
      grossSalePaise: 0,
      cogsPaise: null,
      rtoFreightPaise: PAISE(76),
      advanceKeptPaise: PAISE(130),
      chargeSource: 'computed',
      outcomeInferred: true,
    }),
    row(p1, 'PENDING', { forwardFreightPaise: PAISE(76), gatewayFeePaise: PAISE(47.2) }),
    row(c1, 'CANCELLED', { totalCostPaise: PAISE(76), forwardFreightPaise: PAISE(76) }),
    row(x1, 'EXCLUDED', { outcomeReason: 'tagged test-order' }),
  ];

  const ship = (awb, state, over = {}) => ({
    awb, state, rawStatus: state, statusType: 'DL', statusCode: 'EOD-38', statusAt: '2026-10-09T09:00:00Z',
    orderType: 'prepaid', codAmountPaise: 0, invoiceAmountPaise: PAISE(2000), destPin: '395003',
    originName: 'Surat', pickedUpAt: '2026-10-06T06:00:00Z', deliveredAt: '2026-10-09T09:00:00Z',
    rtoStartedAt: null, returnedAt: null, reverseInTransit: false, chargedWeightGrams: null, refs: [], ...over,
  });
  const charge = (awb, over = {}) => ({
    awb, source: 'ledger', forwardPaise: PAISE(76), rtoPaise: null, dtoPaise: null, codChargePaise: 0,
    gstPaise: PAISE(11.59), totalPaise: PAISE(76), zone: 'B', chargedWeightGrams: 500,
    weightAssumed: false, variancePaise: 0, flags: [], ...over,
  });

  return {
    rows,
    config: {
      packingCostPerOrderPaise: PAISE(25),
      gatewayFeePct: 2,
      gatewayGstPct: 18,
      metaGstPct: 18,
      gstInputCreditClaimed: false,
      assumedWeightGrams: 500,
      ruleOfThumbPrepaidPaise: PAISE(110),
      ruleOfThumbCodPaise: PAISE(170),
      fixedMonthlyCosts: [{ label: 'Shopify plan', amountPaise: PAISE(1994) }],
    },
    shipments: [
      ship('111', 'DELIVERED'),
      ship('222', 'DELIVERED', { orderType: 'cod', codAmountPaise: PAISE(1550) }),
      ship('333', 'RTO_DELIVERED', { statusType: 'RT', rtoStartedAt: '2026-10-16T06:00:00Z', returnedAt: '2026-10-22T06:00:00Z', deliveredAt: null }),
      ship('444', 'IN_TRANSIT', { statusType: 'UD', deliveredAt: null }),
      ship('555', 'MANIFESTED', { statusType: 'UD', deliveredAt: null }),
    ],
    charges: [
      charge('111'),
      charge('222', { codChargePaise: PAISE(35), totalPaise: PAISE(111) }),
      charge('333', { source: 'computed', rtoPaise: PAISE(76), totalPaise: PAISE(152), variancePaise: null, flags: ['return leg computed'] }),
      charge('555', { totalPaise: PAISE(76) }),
      charge('999', { totalPaise: PAISE(76), flags: ['AWB not tied to any order'] }),
    ],
    meta: [
      { date: '2026-10-05', campaignId: 'c1', campaignName: 'Festive sales', objective: 'OUTCOME_SALES', type: 'sales', spendPaise: PAISE(1200), impressions: 40000, clicks: 600 },
      { date: '2026-10-12', campaignId: 'c1', campaignName: 'Festive sales', objective: 'OUTCOME_SALES', type: 'sales', spendPaise: PAISE(900), impressions: 30000, clicks: 400 },
      { date: '2026-10-12', campaignId: 'c2', campaignName: 'Reel boost', objective: 'OUTCOME_ENGAGEMENT', type: 'boost', spendPaise: PAISE(300), impressions: 9000, clicks: 120 },
    ],
    replacements: [{
      orderName: '#1170', seq: 1, state: 'SHIPPED', reason: 'size swap', pays: 'customer',
      forwardAwb: '777', returnAwb: '778', quoteForwardPaise: PAISE(76), quoteReturnPaise: PAISE(76),
      reimbursementReceived: false, createdAt: '2026-10-20T06:30:00Z',
    }],
    flags: [{ code: 'ses_sandbox', label: 'Delhivery charge ledger was not uploaded', count: 3, note: 'Charges fell back to the computed rate card.' }],
    reconciliations: [{ name: 'Shopify page count', expected: 1, actual: 1, ok: true, note: 'single page of orders' }],
    assumptions: [{ key: 'originPin', label: 'Origin PIN', value: '395003', source: 'VERIFIED', note: 'Surat pickup' }],
    totals: { netPaise: null },
    lastMonthUpdate: [{ orderName: '#1140', was: 'PENDING', now: 'DELIVERED', at: '2026-10-03T06:00:00Z', deltaPaise: PAISE(820), note: 'settled after last month closed' }],
    previousMonth: { label: 'September 2026', reported: { netPaise: PAISE(-4000), deliveredOrders: 9 }, restated: { netPaise: PAISE(-3100), deliveredOrders: 10 } },
  };
}

const META = {
  month: '2026-10',
  monthLabel: 'October 2026',
  provisional: true,
  generatedAtIST: '03-Nov-2026 11:00',
  trigger: 'schedule',
  courierChargeBasis: 'Delhivery computed',
  incomplete: false,
  adminOrderUrlBase: 'https://admin.shopify.com/store/test-store/orders',
};

const reopen = async (buf) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
};
/**
 * The sheet XML as it actually sits in the file.
 *
 * The cached result of a formula has to be asserted here, not on the reloaded
 * workbook: exceljs WRITES <v>0</v> correctly but its own loader drops a falsy
 * result, so a reload-based check would report every zero total as naked.
 */
async function sheetXml(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = [];
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    out.push([name, await zip.file(name).async('string')]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

describe('buildWorkbook', () => {
  /** @type {Buffer} */ let buf;
  /** @type {ExcelJS.Workbook} */ let wb;
  beforeAll(async () => {
    buf = await buildWorkbook(fixture(), META);
    wb = await reopen(buf);
  });

  it('is a real xlsx', () => {
    expect(buf.length).toBeGreaterThan(5000);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });

  it('has the thirteen sheets in the brief’s order', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary', 'Daily', 'Delivered', 'RTO', 'Not Delivered', 'Excluded', 'Replacements',
      'By Product', 'Meta Ads', 'Courier Ledger', 'Last Month Update', 'Data Checks', 'Assumptions',
    ]);
  });

  it('drops Last Month Update when there is no previous snapshot', async () => {
    const f = fixture();
    delete f.lastMonthUpdate;
    const w = await reopen(await buildWorkbook(f, META));
    expect(w.worksheets.map((x) => x.name)).not.toContain('Last Month Update');
    expect(w.worksheets.length).toBe(12);
  });

  it('writes the header row of every table', () => {
    const headers = {
      Daily: ['Date', 'Orders placed', 'Delivered', 'RTO', 'Pending', 'Cancelled', 'Net revenue', 'COGS', 'Freight + COD charges', 'RTO loss', 'Packing', 'Gateway fees', 'Meta spend', 'Contribution', 'Net', 'Cumulative net'],
      Delivered: ['Order #', 'Order date', 'Delivered date', 'Days to deliver', 'Customer', 'City', 'State', 'Channel', 'Payment', 'Items', 'Units', 'AWB', 'Delhivery status', 'Delhivery date', 'Gross sale', 'Discount', 'COD fee', 'Refunds', 'Output GST', 'Net revenue', 'COGS', 'Forward freight', 'COD charge', 'Packing', 'Gateway fee', 'Total cost', 'Contribution', 'Contribution %', 'Charge source', 'Flags'],
      RTO: ['Order #', 'Order date', 'Customer', 'City', 'Payment', 'Items', 'Order value', 'AWB', 'RTO reason', 'Delhivery status', 'RTO start date', 'Returned date', 'Forward freight', 'Return freight', 'COD charge', 'Packing', 'Gateway fee', 'Advance kept', 'Total RTO loss', 'Return leg', 'Flags'],
      'Meta Ads': ['Date', 'Campaign ID', 'Campaign', 'Objective', 'Type', 'Spend', 'Impressions', 'Clicks'],
      'Courier Ledger': ['AWB', 'Order(s)', 'Leg', 'Status', 'Charged weight (g)', 'Zone', 'Payment', 'Forward', 'RTO', 'COD charge', 'GST', 'Total', 'Source', 'Ledger vs computed', 'In P&L as', 'Flags'],
      'By Product': ['Product', 'SKU', 'Units delivered', 'Net revenue', 'COGS', 'Gross margin %', 'RTO units', 'RTO loss', 'Contribution before ads'],
      Replacements: ['Order #', 'Job #', 'State', 'Reason', 'Who pays', 'Forward AWB', 'Return AWB', 'Forward leg', 'Return leg', 'Packing', 'Reimbursed', 'Cost in P&L', 'Reimbursement status', 'Created'],
    };
    const headerRows = { Summary: 9, 'Not Delivered': 2, Excluded: 2, 'Last Month Update': 2, 'Data Checks': 3, Assumptions: 4 };
    for (const [sheet, want] of Object.entries(headers)) {
      const got = want.map((_, i) => wb.getWorksheet(sheet).getRow(headerRows[sheet] ?? 1).getCell(i + 1).value);
      expect(got, sheet).toEqual(want);
    }
    expect(wb.getWorksheet('Summary').getCell('A9').value).toBe('PROFIT AND LOSS');
    expect(wb.getWorksheet('Not Delivered').getCell('A2').value).toBe('Order #');
    expect(wb.getWorksheet('Excluded').getCell('A2').value).toBe('Order #');
    expect(wb.getWorksheet('Data Checks').getCell('A3').value).toBe('Reconciliation');
    expect(wb.getWorksheet('Assumptions').getCell('A4').value).toBe('Setting');
  });

  it('styles header rows bold white on the brand green', () => {
    const h = wb.getWorksheet('Delivered').getRow(1).getCell(1);
    expect(h.font.bold).toBe(true);
    expect(h.font.color.argb).toBe('FFFFFFFF');
    expect(h.fill.fgColor.argb).toBe('FF2E4B3C');
    expect(h.font.name).toBe('Calibri');
  });

  it('writes the brief’s number formats', () => {
    const D = wb.getWorksheet('Delivered');
    expect(D.getCell('O2').numFmt).toBe('₹#,##0;[Red]-₹#,##0');
    expect(D.getCell('AB2').numFmt).toBe('0.0%');
    expect(D.getCell('B2').numFmt).toBe('dd-mmm-yyyy');
    expect(wb.getWorksheet('Courier Ledger').getCell('L2').numFmt).toBe('₹#,##0.00;[Red]-₹#,##0.00');
    expect(wb.getWorksheet('Summary').getCell('B10').numFmt).toBe('₹#,##0;[Red]-₹#,##0');
  });

  it('freezes the header row and the first column on every sheet', () => {
    for (const ws of wb.worksheets) {
      const v = ws.views[0];
      expect(v.state, ws.name).toBe('frozen');
      expect(v.xSplit, ws.name).toBe(1);
      expect(v.ySplit, ws.name).toBeGreaterThanOrEqual(1);
    }
  });

  it('auto-filters every order table', () => {
    for (const name of ['Daily', 'Delivered', 'RTO', 'Not Delivered', 'Excluded', 'Replacements', 'By Product', 'Meta Ads', 'Courier Ledger', 'Data Checks']) {
      expect(wb.getWorksheet(name).autoFilter, name).toBeTruthy();
    }
  });

  it('paints the tab colours the brief pins down', () => {
    const want = { Summary: 'FF2E4B3C', Delivered: 'FF2E4B3C', RTO: 'FFC0392B', 'Not Delivered': 'FFE1A94F', 'Data Checks': 'FF808080', Assumptions: 'FF808080' };
    for (const [sheet, argb] of Object.entries(want)) {
      expect(wb.getWorksheet(sheet).properties.tabColor?.argb, sheet).toBe(argb);
    }
  });

  it('prints landscape, one page wide, with a repeating header and a page number', () => {
    for (const ws of wb.worksheets) {
      expect(ws.pageSetup.orientation, ws.name).toBe('landscape');
      expect(ws.pageSetup.fitToWidth, ws.name).toBe(1);
      expect(ws.pageSetup.printTitlesRow, ws.name).toMatch(/^\d+:\d+$/);
      expect(ws.headerFooter.oddFooter, ws.name).toContain('&P');
    }
  });

  it('caps every column at width 45', () => {
    for (const ws of wb.worksheets) {
      for (const col of ws.columns ?? []) {
        if (col.width != null) expect(col.width, `${ws.name} ${col.letter}`).toBeLessThanOrEqual(45);
      }
    }
  });

  // The one that matters: a formula without a cached result is blank in Numbers,
  // in Google Sheets' first paint and in the WhatsApp document preview.
  it('gives EVERY formula cell a cached result', async () => {
    const naked = [];
    let formulas = 0;
    for (const [name, xml] of await sheetXml(buf)) {
      for (const chunk of xml.split('<c ')) {
        if (!chunk.includes('<f>')) continue;
        formulas += 1;
        if (!/<v>[^<]/.test(chunk)) naked.push(`${name} ${chunk.slice(0, 90)}`);
      }
    }
    expect(formulas).toBeGreaterThan(150);
    expect(naked).toEqual([]);
  });

  it('ties Summary net to the Daily month total and to the order sheets, to the paisa', () => {
    const p = (cell) => Math.round((typeof cell.value === 'object' ? cell.value.result : cell.value) * 100);
    const S = wb.getWorksheet('Summary');
    const Daily = wb.getWorksheet('Daily');
    const D = wb.getWorksheet('Delivered');
    const T = wb.getWorksheet('RTO');
    const ND = wb.getWorksheet('Not Delivered');
    const RP = wb.getWorksheet('Replacements');

    const summaryNet = p(S.getCell('B35'));
    // The Daily sheet's bottom line: the day rows plus the monthly lines no
    // order date can carry.
    let netRow = 0;
    Daily.eachRow((r) => { if (r.getCell(1).value === 'NET FOR THE MONTH') netRow = r.number; });
    expect(netRow).toBeGreaterThan(32);
    const dailyNet = p(Daily.getCell(`O${netRow}`));
    expect(dailyNet).toBe(summaryNet);

    // And the same number again, rebuilt from the per-order sheets.
    const totalRow = (ws, header) => {
      const hdr = ws.getRow(ws.name === 'Not Delivered' ? 2 : 1);
      let col = 0;
      hdr.eachCell((c, n) => { if (c.value === header) col = n; });
      expect(col, `${ws.name}.${header}`).toBeGreaterThan(0);
      let last = ws.rowCount;
      while (last > 1 && ws.getRow(last).getCell(1).value !== 'TOTAL' && !String(ws.getRow(last).getCell(1).value ?? '').includes('TOTAL')) last -= 1;
      return p(ws.getRow(last).getCell(col));
    };
    const fromSheets =
      totalRow(D, 'Contribution') -
      totalRow(T, 'Total RTO loss') -
      totalRow(ND, 'Charge in P&L') -
      totalRow(RP, 'Cost in P&L') -
      7600 - // the one AWB tied to no order at all
      Math.round((1200 + 900 + 300) * 1.18 * 100) - // Meta plus its GST
      199400; // fixed costs
    expect(fromSheets).toBe(summaryNet);
  });

  it('keeps the Summary statement in the brief’s order and labels the bottom line', () => {
    const S = wb.getWorksheet('Summary');
    expect(S.getCell('A10').value).toBe('Gross sales (delivered, incl. GST)');
    expect(S.getCell('A13').value).toBe('NET REVENUE');
    expect(S.getCell('A19').value).toBe('CONTRIBUTION BEFORE RTO AND ADS');
    expect(S.getCell('A24').value).toBe('RTO LOSS (BOTH WAYS)');
    expect(S.getCell('A28').value).toBe('CONTRIBUTION AFTER RTO');
    expect(S.getCell('A32').value).toBe('TOTAL META');
    expect(S.getCell('A33').value).toBe('PROFIT BEFORE FIXED COSTS');
    expect(S.getCell('A35').value).toBe('NET PROFIT / LOSS');
  });

  it('always carries the offline-sales note and the six KPI tiles', () => {
    const S = wb.getWorksheet('Summary');
    expect(S.getCell('A4').value).toBe('Offline sales not recorded in Shopify are not included. Boost spend is included.');
    expect([1, 2, 3, 4, 5, 6].map((c) => S.getRow(6).getCell(c).value)).toEqual([
      'Net profit / loss', 'Net margin %', 'Delivered orders', 'RTO rate', 'Meta spend', 'Net per delivered order',
    ]);
    expect(S.getRow(7).getCell(3).value).toBe(2);
  });

  it('shows a red INCOMPLETE banner only when a source failed', async () => {
    expect(wb.getWorksheet('Summary').getCell('A3').value).toBe('All sources answered for this month.');
    const w = await reopen(await buildWorkbook(fixture(), { ...META, incomplete: true }));
    const b = w.getWorksheet('Summary').getCell('A3');
    expect(String(b.value)).toContain('INCOMPLETE');
    expect(b.fill.fgColor.argb).toBe('FFC0392B');
  });

  it('names the input cells and points the dependent formulas at the names', () => {
    const names = wb.definedNames.model.map((n) => n.name).sort();
    expect(names).toEqual([
      'pnl_fixed_costs', 'pnl_gateway_fee_pct', 'pnl_gateway_gst_pct', 'pnl_gst_input_credit',
      'pnl_meta_gst_pct', 'pnl_packing_per_order',
    ]);
    // Every name resolves to a cell on Assumptions. The five editable ones are
    // pale yellow; pnl_fixed_costs names a totals cell, which is gold.
    const A = wb.getWorksheet('Assumptions');
    for (const n of names) {
      const [ref] = wb.definedNames.getRanges(n).ranges;
      expect(ref, n).toMatch(/^Assumptions!\$B\$\d+$/);
      const fill = A.getCell(ref.split('!')[1].replace(/\$/g, '')).fill.fgColor.argb;
      expect(fill, n).toBe(n === 'pnl_fixed_costs' ? 'FFB08D57' : 'FFFFF2CC');
    }
    // Packing on an order sheet, Meta GST and fixed costs on the Summary, and the
    // assumed gateway fee all recalculate from those cells.
    expect(wb.getWorksheet('Delivered').getCell('X2').value.formula).toContain('pnl_packing_per_order');
    expect(wb.getWorksheet('RTO').getCell('P2').value.formula).toContain('pnl_packing_per_order');
    expect(wb.getWorksheet('Replacements').getCell('J2').value.formula).toContain('pnl_packing_per_order');
    expect(wb.getWorksheet('Summary').getCell('B31').value.formula).toContain('pnl_gst_input_credit');
    expect(wb.getWorksheet('Summary').getCell('B31').value.formula).toContain('pnl_meta_gst_pct');
    expect(wb.getWorksheet('Summary').getCell('B34').value.formula).toContain('pnl_fixed_costs');
    expect(wb.getWorksheet('Delivered').getCell('Y3').value.formula).toContain('pnl_gateway_fee_pct');
  });

  it('marks a cost it could not read MISSING, in amber, with the reason as a note', () => {
    // #1171 has no unit cost on its only line.
    const c = wb.getWorksheet('Delivered').getCell('U3');
    expect(c.value).toBe('MISSING');
    expect(c.fill.fgColor.argb).toBe('FFFFE0A3');
    expect(String(c.note)).toContain('unit cost');
    // ... and a cost that is genuinely zero is still a number.
    expect(wb.getWorksheet('Delivered').getCell('W2').value).toBe(0);
  });

  it('italicises a value it inferred rather than read', () => {
    // #1172's return leg was never billed; the computed quote was used.
    expect(wb.getWorksheet('RTO').getCell('T2').value).toBe('computed');
    expect(wb.getWorksheet('RTO').getCell('T2').font.italic).toBe(true);
  });

  it('links the order to the Shopify admin and the AWB to Delhivery', () => {
    const D = wb.getWorksheet('Delivered');
    expect(D.getCell('A2').value.hyperlink).toBe('https://admin.shopify.com/store/test-store/orders/1170');
    expect(D.getCell('L2').value.hyperlink).toBe('https://www.delhivery.com/track/package/111');
  });

  it('leaves the order number as plain text when nobody said which store this is', async () => {
    const w = await reopen(await buildWorkbook(fixture(), { ...META, adminOrderUrlBase: undefined }));
    expect(w.getWorksheet('Delivered').getCell('A2').value).toBe('#1170');
  });

  it('puts data bars on the daily net', () => {
    const cf = wb.getWorksheet('Daily').conditionalFormattings;
    expect(cf.some((f) => f.rules.some((r) => r.type === 'dataBar'))).toBe(true);
  });

  it('gives every day of the month a row', () => {
    const Daily = wb.getWorksheet('Daily');
    expect(Daily.getCell('A2').value.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(Daily.getCell('A32').value.toISOString().slice(0, 10)).toBe('2026-10-31');
    expect(Daily.getCell('A33').value).toBe('MONTH TOTAL');
  });

  it('puts the AWB tied to no order on the ledger as "other"', () => {
    const CL = wb.getWorksheet('Courier Ledger');
    const found = [];
    CL.eachRow((r) => found.push([r.getCell(1).value, r.getCell(15).value]));
    expect(found).toContainEqual(['999', 'other']);
  });

  it('reconciles the funnel and runs the rule-of-thumb soft check', () => {
    const DC = wb.getWorksheet('Data Checks');
    const text = [];
    DC.eachRow((r) => r.eachCell((c) => text.push(String(typeof c.value === 'object' ? c.value?.result ?? c.value?.text ?? '' : c.value))));
    expect(text.join(' | ')).toContain('On record = excluded + cancelled + delivered + RTO + pending + lost');
    expect(text).toContain('ok');
    expect(text.join(' | ')).toContain('RULE OF THUMB');
    expect(text.join(' | ')).toContain('possible duplicate');
  });

  it('builds twice to the same bytes', async () => {
    const again = await buildWorkbook(fixture(), META);
    expect(again.equals(buf)).toBe(true);
  });

  it('renders a "none this month" row instead of throwing when a section is missing', async () => {
    const bare = { rows: fixture().rows.slice(0, 1) };
    const w = await reopen(await buildWorkbook(bare, { month: '2026-10' }));
    expect(w.getWorksheet('Meta Ads').getCell('A2').value).toBe('no Meta spend on record this month');
    expect(w.getWorksheet('Replacements').getCell('A2').value).toBe('no replacement shipments this month');
    expect(w.getWorksheet('RTO').getCell('A2').value).toBe('no RTO this month');
    expect(w.getWorksheet('Courier Ledger').getCell('A2').value).toBe('no courier charges on record this month');
    expect(w.getWorksheet('Summary').getCell('A3').value).toBe('All sources answered for this month.');
  });

  it('survives a month with no orders at all', async () => {
    const w = await reopen(await buildWorkbook({ rows: [] }, { month: '2026-10', monthLabel: 'October 2026' }));
    expect(w.getWorksheet('Delivered').getCell('A2').value).toBe('no delivered orders this month');
    const net = w.getWorksheet('Summary').getCell('B35').value;
    expect(net.formula).toBe('B33+B34');
    expect(net.result ?? 0).toBe(0); // exceljs's loader drops a zero result; the file has <v>0</v>
  });
});
