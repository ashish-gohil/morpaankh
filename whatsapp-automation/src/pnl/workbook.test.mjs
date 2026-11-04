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
  /*
   * #1176 is October's #1205: delivered, but with no AWB at all, so its freight
   * is unknowable. The engine blocks it from every total. The workbook used to
   * SUM it anyway, which put its revenue in and left its freight out, and the
   * month read about Rs 2,046 richer than it was.
   */
  const b1 = order('#1176', {
    createdAt: '2026-10-25T06:30:00Z',
    // A fulfillment but NO AWB. This is also why the engine's `shipped` (which
    // counts fulfillments) read 51 against a recount of AWBs that read 49.
    awbs: [],
    fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: '2026-10-26T06:00:00Z', deliveredAt: '2026-10-28T09:00:00Z', awb: null, company: null }],
    customerName: 'F Customer',
    currentTotalPaise: PAISE(2046),
  });

  // A parcel that was lost: the engine gives it its own statement line, because
  // it loses both the garment and the freight.
  const l1 = order('#1177', {
    createdAt: '2026-10-18T06:30:00Z', awbs: ['666'], customerName: 'G Customer',
    currentTotalPaise: PAISE(1800),
    fulfillments: [{ status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: '2026-10-19T06:00:00Z', deliveredAt: null, awb: '666', company: 'Delhivery' }],
  });
  // A cancelled parcel whose charge we could not read: the charge must NOT be
  // in the P&L, the same way the engine leaves it out.
  const c2 = order('#1178', {
    createdAt: '2026-10-27T06:30:00Z', cancelledAt: '2026-10-28T06:30:00Z', cancelReason: 'DECLINED',
    awbs: ['888'], customerName: 'H Customer', currentTotalPaise: PAISE(900),
    fulfillments: [{ status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: '2026-10-27T10:00:00Z', deliveredAt: null, awb: '888', company: 'Delhivery' }],
  });

  const rows = [
    // Prepaid, and the fee was not read from the gateway, so the cell has to
    // recalculate from the config. Base: the full total.
    row(d1, 'DELIVERED', { assumed: ['gateway_rate'] }),
    // The engine sets complete:false whenever `missing` is non-empty, so a row
    // with no unit cost is out of the totals too. The fixture has to say so or
    // it would be describing a report the engine never produces.
    row(d2, 'DELIVERED', {
      cogsPaise: null,
      missing: ['unit_cost'],
      complete: false,
      gatewayFeePaise: 0, // COD: no money went through a gateway
      codChargePaise: PAISE(35),
      flags: ['no unit cost on the Taana line'],
    }),
    row(b1, 'DELIVERED', {
      forwardFreightPaise: null,
      codChargePaise: null,
      missing: ['freight', 'awb'],
      complete: false,
      flags: ['no AWB on this order, so its freight is unknowable'],
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
    row(l1, 'LOST', { totalCostPaise: PAISE(1200), outcomeReason: 'Delhivery marked it lost' }),
    row(c2, 'CANCELLED', {
      totalCostPaise: PAISE(76),
      missing: ['freight'],
      complete: false,
      flags: ['cancelled after manifest, charge not on the ledger'],
    }),
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
      ship('666', 'LOST', { statusType: 'UD', deliveredAt: null }),
      ship('888', 'MANIFESTED', { statusType: 'UD', deliveredAt: null }),
    ],
    charges: [
      charge('111'),
      charge('222', { codChargePaise: PAISE(35), totalPaise: PAISE(111) }),
      charge('333', { source: 'computed', rtoPaise: PAISE(76), totalPaise: PAISE(152), variancePaise: null, flags: ['return leg computed'] }),
      charge('555', { totalPaise: PAISE(76) }),
      charge('666', { totalPaise: PAISE(76) }),
      // Delhivery billed the forward leg before the order was cancelled.
      charge('888', { totalPaise: PAISE(76) }),
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
    /*
     * The engine's funnel, taken verbatim. `shipped` is 6 because six orders
     * have a fulfillment; counting AWBs here gives 5, since #1176 has none.
     */
    funnel: { onRecord: 9, excluded: 1, cancelled: 2, shipped: 8, delivered: 3, rto: 1, pending: 1, lost: 1 },
    flags: [{ code: 'ses_sandbox', label: 'Delhivery charge ledger was not uploaded', count: 3, note: 'Charges fell back to the computed rate card.' }],
    // The engine's shape: {key, label, a, b, agree}. Reading name/expected/
    // actual/ok found none of them and rendered a bare "check" with empty cells.
    reconciliations: [
      { key: 'courier', label: 'Courier total = sum of the courier ledger (plus any hand-entered cost)', a: PAISE(491), b: PAISE(491), agree: true },
    ],
    assumptions: [{ key: 'originPin', label: 'Origin PIN', value: '395003', source: 'VERIFIED', note: 'Surat pickup' }],
    // The engine's real key names. The count keys are exact and easy to read;
    // the money keys get their own assertions in the blocked-row suite.
    totals: { lostShipmentsPaise: PAISE(1200), countedDelivered: 1, countedRto: 1, blockedDelivered: 2, blockedRto: 0 },
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

/**
 * The row a Summary statement line sits on, found by its label.
 *
 * These were hardcoded (B35 for the net, B32 for TOTAL META) until the engine's
 * LOST line shifted every row by one and five tests failed for no reason worth
 * failing for. A label is the thing being asserted; the row number never was.
 */
function rowOf(ws, label) {
  let n = 0;
  // The FIRST match: the statement comes before the per-delivered-order block,
  // and the two share labels like "Product cost (COGS)".
  ws.eachRow((r) => {
    if (!n && String(r.getCell(1).value ?? '').trim() === label.trim()) n = r.number;
  });
  expect(n, `no row labelled "${label}"`).toBeGreaterThan(0);
  return n;
}
const cellOf = (ws, label) => ws.getCell(`B${rowOf(ws, label)}`);

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
    expect(cellOf(wb.getWorksheet('Summary'), 'Gross sales (delivered, incl. GST)').numFmt).toBe('₹#,##0;[Red]-₹#,##0');
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

    const summaryNet = p(cellOf(S, 'NET PROFIT / LOSS'));
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

  it('keeps the Summary statement in the brief’s order, with the engine’s LOST line', () => {
    const S = wb.getWorksheet('Summary');
    const labels = [];
    for (let r = rowOf(S, 'Gross sales (delivered, incl. GST)'); r <= rowOf(S, 'NET PROFIT / LOSS'); r++) {
      labels.push(String(S.getCell(`A${r}`).value));
    }
    expect(labels).toEqual([
      'Gross sales (delivered, incl. GST)',
      '  less refunds',
      '  less output GST',
      'NET REVENUE',
      '  Product cost (COGS)',
      '  Forward freight (delivered)',
      '  COD charges',
      '  Packing',
      '  Payment gateway fees',
      'CONTRIBUTION BEFORE RTO AND ADS',
      '  RTO forward freight',
      '  RTO return freight',
      '  RTO packing and gateway fees (and any COD charge billed)',
      '  less advance kept on RTO',
      'RTO LOSS (BOTH WAYS)',
      '  Cancelled-shipment charges',
      '  Replacement shipments (net of reimbursements received)',
      '  Other courier charges',
      '  Lost shipments (product and freight)',
      'CONTRIBUTION AFTER RTO',
      '  Meta ads: sales campaigns',
      '  Meta ads: boosts and other',
      '  GST on Meta (if no input credit)',
      'TOTAL META',
      'PROFIT BEFORE FIXED COSTS',
      '  Fixed costs',
      'NET PROFIT / LOSS',
    ]);
  });

  it('always carries the offline-sales note and the six KPI tiles', () => {
    const S = wb.getWorksheet('Summary');
    expect(S.getCell('A4').value).toBe('Offline sales not recorded in Shopify are not included. Boost spend is included.');
    expect([1, 2, 3, 4, 5, 6].map((c) => S.getRow(6).getCell(c).value)).toEqual([
      'Net profit / loss', 'Net margin %', 'Delivered orders', 'RTO rate', 'Meta spend', 'Net per delivered order',
    ]);
    expect(S.getRow(7).getCell(3).value).toBe(3); // three delivered; only one complete enough to count
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
    const S = wb.getWorksheet('Summary');
    expect(cellOf(S, 'GST on Meta (if no input credit)').value.formula).toContain('pnl_gst_input_credit');
    expect(cellOf(S, 'GST on Meta (if no input credit)').value.formula).toContain('pnl_meta_gst_pct');
    expect(cellOf(S, 'Fixed costs').value.formula).toContain('pnl_fixed_costs');
    expect(wb.getWorksheet('Delivered').getCell('Y2').value.formula).toContain('pnl_gateway_fee_pct');
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
    // The counted/blocked cross-checks agree, and counts are not money-formatted.
    const engineRows = [];
    DC.eachRow((r) => {
      const a = String(r.getCell(1).value ?? '');
      if (a.startsWith('Engine total against this workbook:')) engineRows.push([a.split(': ')[1], r.getCell(2).value, r.getCell(4).value]);
    });
    expect(engineRows).toEqual([
      ['Lost shipments', 1200, 'ok'],
      ['Delivered orders counted in the totals', 1, 'ok'],
      ['RTO orders counted in the totals', 1, 'ok'],
      ['Delivered orders blocked from the totals', 2, 'ok'],
      ['RTO orders blocked from the totals', 0, 'ok'],
    ]);
  });

  /*
   * DETERMINISM, in the only form this stack can actually deliver.
   *
   * Raw byte-identity is not achievable and the assertion that claimed it was
   * passing by luck: exceljs zips through archiver, which stamps every entry's
   * local header with the wall clock (the first differing byte is 10, the DOS
   * time field). Two builds match only when they land in the same second, so
   * that test went green ~95% of runs and red the rest, which is worse than no
   * test. exceljs exposes no hook for the entry date.
   *
   * What matters is that the same report produces the same WORKBOOK, so this
   * compares the content of every entry in the archive, which is deterministic,
   * and the docProps stamp is pinned to the month by the test below.
   */
  it('builds twice to the same content, entry for entry', async () => {
    const again = await buildWorkbook(fixture(), META);
    const [a, b] = await Promise.all([JSZip.loadAsync(buf), JSZip.loadAsync(again)]);
    expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
    for (const name of Object.keys(a.files).sort()) {
      if (a.files[name].dir) continue;
      const [x, y] = await Promise.all([a.file(name).async('uint8array'), b.file(name).async('uint8array')]);
      expect(Buffer.from(y).equals(Buffer.from(x)), name).toBe(true);
    }
  });

  // Byte-identity alone would pass by luck: exceljs stamps docProps to the
  // second, so two builds in the same second match even if the stamp came from
  // the clock. This pins it to the month instead.
  it('stamps the file from the month, not from the clock', async () => {
    const zip = await JSZip.loadAsync(buf);
    const core = await zip.file('docProps/core.xml').async('string');
    expect(core).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-01T00:00:00Z</dcterms:created>');
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-01T00:00:00Z</dcterms:modified>');
    // A different month is a different stamp, so the pin is real and not a constant.
    const nov = await JSZip.loadAsync(await buildWorkbook(fixture(), { ...META, month: '2026-11' }));
    expect(await nov.file('docProps/core.xml').async('string')).toContain('2026-11-01T00:00:00Z');
  });

  // The engine wraps its Meta days as {rows, salesPaise, ...} and keeps charges,
  // shipments and replacements out of the Report entirely. Both of those would
  // silently empty three sheets, so both shapes are read.
  it('reads the engine\u2019s own Meta wrapper as well as a bare array', async () => {
    const f = fixture();
    const bare = f.meta;
    f.meta = { rows: bare, salesPaise: PAISE(2100), boostPaise: PAISE(300), otherPaise: 0, gstPaise: PAISE(432), totalPaise: PAISE(2832) };
    const w = await reopen(await buildWorkbook(f, META));
    expect(w.getWorksheet('Meta Ads').getCell('C2').value).toBe('Festive sales');
    expect(cellOf(w.getWorksheet('Summary'), 'TOTAL META').value.result).toBe(-2832);
  });

  it('finds charges, shipments and replacements on report.inputs too', async () => {
    const f = fixture();
    const inputs = { charges: f.charges, shipments: f.shipments, replacements: f.replacements, meta: f.meta, config: f.config };
    const w = await reopen(await buildWorkbook({ rows: f.rows, inputs }, META));
    const CL = w.getWorksheet('Courier Ledger');
    expect(CL.getCell('A2').value).toBe('111');
    expect(CL.getCell('L2').value).toBe(76); // the charge itself, not a MISSING placeholder
    expect(w.getWorksheet('Replacements').getCell('A2').value).toBe('#1170');
    expect(w.getWorksheet('Meta Ads').getCell('C2').value).toBe('Festive sales');
  });

  /*
   * THE OCTOBER REGRESSION.
   *
   * The engine blocks a row from every total when anything it needs is null.
   * This workbook SUMmed every rendered row, so #1205's revenue and COGS landed
   * in the totals while its freight did not, and Data Checks correctly read
   * MISMATCH on net revenue, COGS and RTO loss. These assertions fail if an
   * incomplete row ever gets back into a total.
   */
  describe('a row the engine blocked', () => {
    const colOf = (ws, header, headerRow = 1) => {
      let n = 0;
      ws.getRow(headerRow).eachCell((c, i) => { if (c.value === header) n = i; });
      expect(n, header).toBeGreaterThan(0);
      return n;
    };
    // Column A is a hyperlink object on the order sheets, so read its text.
    const textOf = (v) => String((v && typeof v === 'object' ? (v.text ?? v.result ?? '') : v) ?? '');
    const totalRowOf = (ws, label) => {
      let n = 0;
      ws.eachRow((r) => { if (textOf(r.getCell(1).value) === label) n = r.number; });
      expect(n, label).toBeGreaterThan(0);
      return n;
    };

    it('stays visible on the sheet, with its real amounts', () => {
      const D = wb.getWorksheet('Delivered');
      const row = totalRowOf(D, '#1176');
      expect(row).toBe(4);
      expect(D.getCell(row, colOf(D, 'Gross sale')).value).toBe(2046); // shown, not hidden
      expect(D.getCell(row, colOf(D, 'Forward freight')).value).toBe('MISSING');
    });

    it('is flagged out of the totals, in amber, with the reason', () => {
      const D = wb.getWorksheet('Delivered');
      const c = D.getCell(4, colOf(D, 'In totals'));
      expect(c.value).toBe(0);
      expect(c.fill.fgColor.argb).toBe('FFFFE0A3');
      expect(String(c.note)).toContain('Excluded from every total');
      expect(String(c.note)).toContain('freight');
      // and the complete row is in
      expect(D.getCell(2, colOf(D, 'In totals')).value).toBe(1);
    });

    it('is left out of the sheet total, by a SUMIF and not by a bare SUM', () => {
      const D = wb.getWorksheet('Delivered');
      const tr = totalRowOf(D, 'DELIVERED TOTAL');
      const gross = D.getCell(tr, colOf(D, 'Gross sale'));
      // Only #1170 counts: 2000, not 2000 + 1550 + 2046.
      expect(gross.value.result).toBe(2000);
      expect(gross.value.formula).toMatch(/^SUMIF\(/);
      expect(gross.value.formula).toContain('$AE$2:$AE$4'); // the In totals column
      expect(D.getCell(tr, colOf(D, 'COGS')).value.result).toBe(900);
      expect(D.getCell(tr, colOf(D, 'In totals')).value.result).toBe(1); // one counted
    });

    it('never reaches the Summary statement', () => {
      const S = wb.getWorksheet('Summary');
      expect(cellOf(S, 'Gross sales (delivered, incl. GST)').value.result).toBe(2000);
      expect(cellOf(S, '  Product cost (COGS)').value.result).toBe(-900);
      expect(cellOf(S, 'NET REVENUE').value.result).toBe(2000 - 95.24);
    });

    it('is named on Summary with its count and its money', () => {
      const S = wb.getWorksheet('Summary');
      const text = [];
      S.eachRow((r) => r.eachCell((c) => text.push(String(c.value ?? ''))));
      const line = text.find((t) => t.includes('EXCLUDED FROM EVERY TOTAL'));
      expect(line, 'Summary says nothing about the orders it left out').toBeTruthy();
      expect(line).toContain('2 delivered orders are');
      expect(line).toContain('3,596'); // 1550 + 2046 of gross sales
      expect(line).toContain('#1171');
      expect(line).toContain('#1176');
    });

    it('makes the engine cross-check read ok, and still MISMATCH when it should', async () => {
      const gst1170 = Math.round(PAISE(2000) * (5 / 105));
      const counted = {
        netRevenuePaise: PAISE(2000) - gst1170,
        cogsPaise: PAISE(900),
        rtoLossPaise: PAISE(76) + PAISE(76) + PAISE(25) + PAISE(47.2) - PAISE(130),
      };
      const statuses = async (totals) => {
        const w = await reopen(await buildWorkbook({ ...fixture(), totals }, META));
        const DC = w.getWorksheet('Data Checks');
        const out = [];
        DC.eachRow((r) => {
          if (String(r.getCell(1).value ?? '').startsWith('Engine total against this workbook:')) {
            out.push([String(r.getCell(1).value).replace('Engine total against this workbook: ', ''), r.getCell(4).value]);
          }
        });
        return out;
      };
      // The engine's counted figures: the workbook agrees with all three.
      expect(await statuses(counted)).toEqual([
        ['Net revenue', 'ok'], ['COGS', 'ok'], ['RTO loss', 'ok'],
      ]);
      // The pre-fix figures, which included the blocked rows: the tripwire fires.
      const naive = {
        netRevenuePaise: counted.netRevenuePaise + PAISE(1550) - Math.round(PAISE(1550) * (5 / 105)) + PAISE(2046) - Math.round(PAISE(2046) * (5 / 105)),
        cogsPaise: counted.cogsPaise,
        rtoLossPaise: counted.rtoLossPaise + PAISE(50), // a paisa is inside the rounding tolerance; fifty rupees is not
      };
      expect(await statuses(naive)).toEqual([
        ['Net revenue', 'MISMATCH'], ['COGS', 'ok'], ['RTO loss', 'MISMATCH'],
      ]);
    });

    it('keeps a blocked cancelled charge out of the P&L column', () => {
      const ND = wb.getWorksheet('Not Delivered');
      const inPnl = colOf(ND, 'Charge in P&L', 2);
      const row = totalRowOf(ND, '#1178');
      expect(ND.getCell(row, colOf(ND, 'Charges so far', 2)).value).toBe(76); // what Delhivery shows
      expect(ND.getCell(row, inPnl).value).toBe(0); // what the P&L takes
      expect(String(ND.getCell(row, inPnl).note)).toContain('Excluded from every total');
      expect(ND.getCell(row, colOf(ND, 'In P&L?', 2)).value).toBe('no (incomplete)');
      // the complete cancelled order's charge IS in
      expect(ND.getCell(totalRowOf(ND, '#1174'), inPnl).value).toBe(76);
    });

    it('gives a lost parcel its own statement line', () => {
      const S = wb.getWorksheet('Summary');
      expect(cellOf(S, '  Lost shipments (product and freight)').value.result).toBe(-1200);
      const ND = wb.getWorksheet('Not Delivered');
      expect(ND.getCell(totalRowOf(ND, '#1177'), colOf(ND, 'Charge in P&L', 2)).value).toBe(1200);
    });

    it('keeps the Daily and Summary bottom lines tied with a blocked row present', () => {
      const p = (c) => Math.round((typeof c.value === 'object' ? c.value.result : c.value) * 100);
      const Daily = wb.getWorksheet('Daily');
      let netRow = 0;
      Daily.eachRow((r) => { if (r.getCell(1).value === 'NET FOR THE MONTH') netRow = r.number; });
      expect(p(Daily.getCell(`O${netRow}`))).toBe(p(cellOf(wb.getWorksheet('Summary'), 'NET PROFIT / LOSS')));
    });
  });

  /*
   * The engine splits one parcel's packing across the orders in it with a
   * remainder-preserving split, and an order that shipped in two parcels pays
   * twice. Recomputing `config x parcelShare` with Math.round got both wrong,
   * and that was October's Rs 47.06 RTO-loss disagreement.
   */
  describe('packing', () => {
    const packingCell = (w) => {
      const D = w.getWorksheet('Delivered');
      let col = 0;
      D.getRow(1).eachCell((c, i) => { if (c.value === 'Packing') col = i; });
      return D.getCell(2, col);
    };

    it('charges an order that shipped in two parcels twice, as the engine did', async () => {
      const f = fixture();
      f.rows[0].packingPaise = PAISE(50);
      const w = await reopen(await buildWorkbook(f, META));
      expect(packingCell(w).value.result).toBe(50);
      expect(packingCell(w).value.formula).toBe('pnl_packing_per_order*2');
      expect(cellOf(w.getWorksheet('Summary'), '  Packing').value.result).toBe(-50);
    });

    it('keeps the odd paisa of a shared parcel exactly where the engine put it', async () => {
      const f = fixture();
      f.rows[0].parcelShare = 0.5;
      f.rows[0].packingPaise = 1251; // the engine's half of 25.00, remainder included
      const w = await reopen(await buildWorkbook(f, META));
      // config x share rounded would have said 12.50. The engine said 12.51.
      expect(packingCell(w).value.result).toBe(12.51);
      expect(packingCell(w).value.formula).toBe('pnl_packing_per_order*0.5004');
      expect(cellOf(w.getWorksheet('Summary'), '  Packing').value.result).toBe(-12.51);
    });

    it('still falls back to config x share when the engine sent no packing', async () => {
      const f = fixture();
      f.rows[0].packingPaise = null;
      f.rows[0].parcelShare = 0.5;
      const w = await reopen(await buildWorkbook(f, META));
      expect(packingCell(w).value.result).toBe(12.5);
    });
  });

  /*
   * A gateway fee is only charged where money actually moved through a gateway.
   * Recomputing it from the order total charged a PARTIAL order on money that
   * never reached one, which was October's Rs 71.52 on the delivered gateway
   * line and the same Rs 47.06 on the RTO line, since RTO loss carries the
   * gateway fee too.
   */
  describe('gateway fees', () => {
    const gatewayCell = (w, r = 2) => {
      const D = w.getWorksheet('Delivered');
      let col = 0;
      D.getRow(1).eachCell((c, i) => { if (c.value === 'Gateway fee') col = i; });
      return D.getCell(r, col);
    };

    it('charges a prepaid order on its full total', () => {
      const c = gatewayCell(wb);
      expect(c.value.result).toBe(47.2);
      expect(c.value.formula).toBe('2000*pnl_gateway_fee_pct*(1+IF(pnl_gst_input_credit=1,0,pnl_gateway_gst_pct))');
    });

    it('charges a partial order on the DEPOSIT, not the order total', async () => {
      const f = fixture();
      const o = f.rows[0].order;
      o.paymentType = 'partial';
      o.currentTotalPaise = PAISE(3000);
      o.prepaidReceivedPaise = PAISE(150); // the 5% deposit
      // What the engine computes: round(15000*2/100)=300, +round(300*18/100)=54.
      f.rows[0].gatewayFeePaise = 354;
      const w = await reopen(await buildWorkbook(f, META));
      const c = gatewayCell(w);
      // The old recompute used the 3000 total and said 70.80, a 20x overcharge.
      expect(c.value.result).toBe(3.54);
      expect(c.value.formula).toBe('150*pnl_gateway_fee_pct*(1+IF(pnl_gst_input_credit=1,0,pnl_gateway_gst_pct))');
      expect(cellOf(w.getWorksheet('Summary'), '  Payment gateway fees').value.result).toBe(-3.54);
    });

    it('never charges a COD order, and never writes it a formula', () => {
      // #1171 is COD. No money moved through a gateway, so there is nothing to
      // recalculate and nothing to charge.
      const c = gatewayCell(wb, 3);
      expect(c.value).toBe(0);
      expect(c.value?.formula).toBeUndefined();
    });

    it('leaves a fee the gateway really reported alone', async () => {
      const f = fixture();
      f.rows[0].assumed = [];          // read from Razorpay, not assumed
      f.rows[0].gatewayFeePaise = 5111;
      const w = await reopen(await buildWorkbook(f, META));
      const c = gatewayCell(w);
      expect(c.value).toBe(51.11);     // a plain number: editing the config must not move it
      expect(c.value?.formula).toBeUndefined();
    });

    it('carries the engine\u2019s gateway fee into RTO loss', async () => {
      const f = fixture();
      // The RTO order is partial. Its fee is on the deposit of 130.
      const rto = f.rows.find((r) => r.outcome === 'RTO');
      rto.gatewayFeePaise = 307;
      const w = await reopen(await buildWorkbook(f, META));
      const T = w.getWorksheet('RTO');
      let col = 0;
      T.getRow(1).eachCell((c, i) => { if (c.value === 'Gateway fee') col = i; });
      expect(T.getCell(2, col).value).toBe(3.07);
      // 76 + 76 + 0 + 25 + 3.07 - 130 = 50.07
      expect(cellOf(w.getWorksheet('Summary'), 'RTO LOSS (BOTH WAYS)').value.result).toBe(-50.07);
    });
  });

  /*
   * October's only replacement was test order #1222: CANCELLED, on an order
   * excluded by tag, with neither parcel ever collected. The engine does not
   * cost a cancelled job; this sheet charged Rs 99.02 for it.
   */
  describe('a cancelled replacement job', () => {
    const cellIn = (w, header) => {
      const R = w.getWorksheet('Replacements');
      let col = 0;
      R.getRow(1).eachCell((c, i) => { if (c.value === header) col = i; });
      expect(col, header).toBeGreaterThan(0);
      return R.getCell(2, col);
    };
    const cancelledFixture = () => {
      const f = fixture();
      f.replacements[0] = { ...f.replacements[0], state: 'CANCELLED' };
      return f;
    };

    it('costs the P&L nothing, and says why', async () => {
      const w = await reopen(await buildWorkbook(cancelledFixture(), META));
      expect(cellIn(w, 'Cost in P&L').value).toBe(0);
      expect(String(cellIn(w, 'Cost in P&L').note)).toContain('cancelled');
      expect(cellIn(w, 'Packing').value).toBe(0); // never packed
      // exceljs's loader drops a zero result; the file carries <v>0</v>.
      expect(cellOf(w.getWorksheet('Summary'), '  Replacement shipments (net of reimbursements received)').value.result ?? 0).toBe(0);
    });

    it('stays on the sheet with the legs it would have cost', async () => {
      const w = await reopen(await buildWorkbook(cancelledFixture(), META));
      expect(cellIn(w, 'State').value).toBe('CANCELLED');
      expect(cellIn(w, 'Forward leg').value).toBe(76);
      expect(cellIn(w, 'Reimbursement status').value).toBe('not applicable, job cancelled');
    });

    it('releases its AWBs, so a charge Delhivery really billed is not lost', async () => {
      const f = cancelledFixture();
      // Delhivery billed the forward parcel even though the job was cancelled.
      f.charges.push({ ...f.charges[0], awb: '777', totalPaise: PAISE(76), flags: [] });
      const w = await reopen(await buildWorkbook(f, META));
      const CL = w.getWorksheet('Courier Ledger');
      const found = [];
      CL.eachRow((r) => found.push([r.getCell(1).value, r.getCell(15).value]));
      expect(found).toContainEqual(['777', 'other']); // not "replacement"
      expect(cellOf(w.getWorksheet('Summary'), '  Other courier charges').value.result).toBe(-152);
    });

    it('still costs a live job, preferring the ledger over the quote', async () => {
      const f = fixture();
      f.charges.push({ ...f.charges[0], awb: '777', totalPaise: PAISE(90), flags: [] });
      const w = await reopen(await buildWorkbook(f, META));
      expect(cellIn(w, 'Forward leg').value).toBe(90); // billed, not the 76 quote
      expect(String(cellIn(w, 'Forward leg').note)).toContain('ledger');
      expect(cellIn(w, 'Cost in P&L').value.result).toBe(90 + 76 + 25);
    });

    it('only credits a reimbursement the customer actually paid', async () => {
      const f = fixture();
      f.replacements[0] = { ...f.replacements[0], pays: 'us', reimbursementReceived: true };
      const w = await reopen(await buildWorkbook(f, META));
      // pays === 'us', so a recorded reimbursement is not ours to credit.
      expect(cellIn(w, 'Reimbursed').value).toBe(0);
    });
  });

  it('builds the statement out of counted-aware sums, not bare SUMs', () => {
    // A bare SUM here would show the right cached number with a formula that
    // recalculates to a different one, which is the whole failure this fix is
    // about: a cell that disagrees with its own formula the moment Excel opens.
    const S = wb.getWorksheet('Summary');
    const D = wb.getWorksheet('Delivered');
    let flag = 0;
    D.getRow(1).eachCell((c, i) => { if (c.value === 'In totals') flag = i; });
    const flagL = D.getColumn(flag).letter;
    for (const label of [
      'Gross sales (delivered, incl. GST)', '  less refunds', '  less output GST',
      '  Product cost (COGS)', '  Forward freight (delivered)', '  COD charges',
      '  Packing', '  Payment gateway fees',
    ]) {
      const f = cellOf(S, label).value.formula;
      expect(f, label).toContain("SUMIF('Delivered'!");
      expect(f, label).toContain(`$${flagL}$`);
      expect(f, label).toMatch(/,1,/);
    }
    for (const label of ['  RTO forward freight', '  RTO return freight', '  less advance kept on RTO']) {
      expect(cellOf(S, label).value.formula, label).toContain("SUMIF('RTO'!");
    }
    // and by-payment-type contribution has to exclude them too (column E)
    expect(S.getCell(rowOf(S, 'COD'), 5).value.formula).toContain('SUMIFS(');
  });

  it('takes the funnel from the engine rather than recounting it', () => {
    const S = wb.getWorksheet('Summary');
    // Six orders have a fulfillment; only five have an AWB. The engine counts
    // fulfillments, and the sheet has to agree with the engine.
    expect(cellOf(S, 'Shipped').value).toBe(8);
    expect(cellOf(S, 'Orders on record').value).toBe(9);
    expect(cellOf(S, 'Delivered').value).toBe(3);
  });

  it('renders the engine\u2019s own reconciliations with their numbers', () => {
    const DC = wb.getWorksheet('Data Checks');
    let row = 0;
    DC.eachRow((r) => { if (String(r.getCell(1).value ?? '').startsWith('Courier total = sum of')) row = r.number; });
    expect(row, 'the engine reconciliation did not render').toBeGreaterThan(0);
    expect(DC.getCell(row, 2).value).toBe(491); // a, not an empty cell
    expect(DC.getCell(row, 3).value).toBe(491); // b
    expect(DC.getCell(row, 4).value).toBe('ok'); // agree
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
    const S = w.getWorksheet('Summary');
    const net = cellOf(S, 'NET PROFIT / LOSS').value;
    expect(net.formula).toBe(`B${rowOf(S, 'PROFIT BEFORE FIXED COSTS')}+B${rowOf(S, 'Fixed costs')}`);
    expect(net.result ?? 0).toBe(0); // exceljs's loader drops a zero result; the file has <v>0</v>
  });
});
