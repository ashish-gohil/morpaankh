/*
 * pnl/sources/ledger.mjs — the owner's Delhivery billing export.
 *
 * THIS IS THE ONLY EXACT SOURCE OF FREIGHT THERE IS. Delhivery publishes no
 * billing API on this account (six endpoints tried, all 404 behind an auth0
 * login page) and it never returns the weight it actually scanned, so every
 * other freight figure on the report is a rate-card computation against an
 * assumed 500 g. This file is what turns "about ₹113" into "₹113.18".
 *
 * PARSED BY HEADER NAME, NEVER BY COLUMN POSITION. A courier billing export is
 * a spreadsheet a human exports from a dashboard: the columns move, get
 * renamed, gain a logo row. Reading column 3 would mean the month a new column
 * appears in front of it, every parcel's cost silently becomes its pincode.
 *
 * NOTHING IS GUESSED. An AWB column it cannot find is a warning and no rows, a
 * row with no number is skipped and counted, and whether the amounts include
 * GST is `null` when the headers do not say. The owner reads the warnings and
 * fixes the file; the report does not quietly take an ex-GST figure as a
 * GST-inclusive one and understate every parcel by 18%.
 *
 * Pure: a buffer and a filename in, rows and warnings out. No network, no S3,
 * no clock.
 */

/** Header -> field, by meaning rather than by position. */
const HEADERS = {
  awb: /^(awb|awb[ _-]?(no|num|number|#)|waybill|waybill[ _-]?(no|num|number)|tracking([ _-]?(no|number))?|consignment([ _-]?no)?)$/i,
  debit: /^(debit|debit[ _-]?amount|dr)$/i,
  credit: /^(credit|credit[ _-]?amount|cr)$/i,
  amount:
    /^(amount|amt|charge|charges|total|total[ _-]?amount|net[ _-]?amount|billed[ _-]?amount|gross[ _-]?amount|taxable([ _-]?(value|amount))?|freight([ _-]?charges?)?|shipping[ _-]?charges?)$/i,
  kind: /^(type|kind|narration|description|particulars|remarks?|charge[ _-]?type|charge[ _-]?head|head|transaction[ _-]?type|service[ _-]?type)$/i,
  gst: /^(gst|tax|total[ _-]?tax|igst|cgst|sgst|gst[ _-]?amount|tax[ _-]?amount)$/i,
};

/**
 * A charge head, read off whatever free text the export calls it. ORDER
 * MATTERS: "RTO Freight" is an RTO and not a forward leg, and "Reverse pickup
 * charges" is a DTO.
 */
const KINDS = [
  { re: /\brto\b|return[ _-]?to[ _-]?origin/i, kind: 'rto' },
  { re: /\bdto\b|reverse|pick[ _-]?up/i, kind: 'dto' },
  { re: /\bcod\b|cash[ _-]?on[ _-]?delivery/i, kind: 'cod' },
  { re: /forward|freight|delivered|delivery|shipping/i, kind: 'forward' },
];

/** Wording that makes a single-column amount a credit rather than a debit. */
const CREDIT_WORDS = /credit|reversal|reversed|refund|waiver|waived|adjustment[ _-]?cr|cr\b/i;

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/**
 * One line of a delimited file, respecting "quoted, fields" and "" escapes.
 * Hand-rolled because the alternative is a dependency for fifteen lines.
 */
function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Tab, semicolon or comma, whichever the header row actually uses. */
function delimiterOf(line) {
  const counts = [
    ['\t', (line.match(/\t/g) || []).length],
    [';', (line.match(/;/g) || []).length],
    [',', (line.match(/,/g) || []).length],
  ];
  counts.sort((a, b) => Number(b[1]) - Number(a[1]));
  return Number(counts[0][1]) > 0 ? String(counts[0][0]) : ',';
}

/** A money cell -> rupees. "₹1,129.59", "(50.00)" and "-50" all work. */
function toInr(cell) {
  const raw = norm(cell);
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw.replace(/[₹\s]/g, ''));
  const n = parseFloat(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Whether the amounts in this file already carry GST.
 *
 * Read off the column names and nothing else, because the only alternative is
 * to infer it from the numbers, and an 18% error on every parcel is exactly
 * the kind of thing an inference gets wrong quietly.
 */
function gstIncludedFrom(amountHeader, hasGstColumn) {
  const h = String(amountHeader || '');
  if (/incl|gross|with[ _-]?tax|total[ _-]?amount/i.test(h)) return true;
  if (/excl|taxable|before[ _-]?tax|net[ _-]?amount/i.test(h)) return false;
  // A tax column of its own means the amount beside it is the pre-tax figure.
  if (hasGstColumn) return false;
  return null;
}

const kindOf = (text) => {
  for (const k of KINDS) if (k.re.test(String(text || ''))) return k.kind;
  return 'other';
};

/**
 * Parse an uploaded Delhivery ledger.
 *
 * @param {Buffer|Uint8Array|string} buffer
 * @param {string} [filename]
 * @returns {{rows: {awb:string, chargeInr:number, kind:string, gstIncluded:boolean|null, raw:any[]}[],
 *            warnings: string[]}}
 */
export function parseLedger(buffer, filename = '') {
  /** @type {string[]} */
  const warnings = [];
  const text = typeof buffer === 'string' ? buffer : Buffer.from(buffer).toString('utf8');

  /*
   * XLSX IS NOT PARSED HERE, DELIBERATELY. exceljs can read one, but it only
   * exists in this service as a Lambda layer for writing the workbook, and
   * pulling it in would make this function async, I/O-shaped and untestable
   * without the layer present. A spreadsheet is three clicks from a CSV and the
   * message says which three.
   */
  const zip = text.charCodeAt(0) === 0x50 && text.charCodeAt(1) === 0x4b;
  if (/\.xlsx?$/i.test(filename) || zip || text.startsWith('ÐÏ')) {
    warnings.push(
      'This looks like an Excel file, which the report cannot read. Open it and use File > Save As > CSV, then upload that.',
    );
    return { rows: [], warnings };
  }

  const lines = text.split(/\r?\n/);
  /*
   * The header row is the first line that names a waybill column, not line 1:
   * a dashboard export routinely puts a title, the account name and a date
   * range above it.
   */
  const headerIdx = lines.findIndex((l) => /awb|waybill|tracking|consignment/i.test(l));
  if (headerIdx < 0) {
    warnings.push('No AWB column found. The file needs a column headed AWB, Waybill or Tracking Number.');
    return { rows: [], warnings };
  }
  if (headerIdx > 0) warnings.push(`Skipped ${headerIdx} line(s) above the header row.`);

  const delim = delimiterOf(lines[headerIdx]);
  const header = splitLine(lines[headerIdx], delim).map(norm);

  /** @type {Record<string, number>} */
  const col = {};
  header.forEach((h, i) => {
    for (const [field, re] of Object.entries(HEADERS)) {
      if (re.test(h) && col[field] === undefined) col[field] = i;
    }
  });
  if (col.awb === undefined) {
    warnings.push(`No AWB column found. Columns seen: ${header.filter(Boolean).join(', ')}`);
    return { rows: [], warnings };
  }

  const hasDebitCredit = col.debit !== undefined || col.credit !== undefined;
  if (!hasDebitCredit && col.amount === undefined) {
    warnings.push(
      `No amount column found. The file needs Amount, Charge, Total Amount or a Debit/Credit pair. Columns seen: ${header.filter(Boolean).join(', ')}`,
    );
    return { rows: [], warnings };
  }
  if (col.kind === undefined) {
    warnings.push('No charge-type column, so forward, RTO and COD charges cannot be told apart on this file.');
  }

  const amountHeader = hasDebitCredit
    ? [col.debit, col.credit].filter((i) => i !== undefined).map((i) => header[Number(i)]).join(' ')
    : header[col.amount];
  const gstIncluded = gstIncludedFrom(amountHeader, col.gst !== undefined);
  if (gstIncluded === null) {
    warnings.push(
      `Cannot tell from the column names whether "${amountHeader}" includes GST, so the variance against the computed cost may be out by the tax.`,
    );
  }

  /** @type {Map<string, {chargeInr:number, kinds:Set<string>, raw:any[]}>} */
  const byAwb = new Map();
  let skipped = 0;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const cells = splitLine(lines[i], delim);
    const awb = norm(cells[col.awb]).replace(/\.0$/, '');
    if (!/^\d{6,}$/.test(awb)) {
      skipped += 1;
      continue;
    }
    const kindText = col.kind === undefined ? '' : norm(cells[col.kind]);

    let inr;
    if (hasDebitCredit) {
      const debit = col.debit === undefined ? 0 : toInr(cells[col.debit]) || 0;
      const credit = col.credit === undefined ? 0 : toInr(cells[col.credit]) || 0;
      inr = debit - credit;
    } else {
      const amount = toInr(cells[col.amount]);
      if (amount == null) {
        skipped += 1;
        continue;
      }
      // A single-column export says "credit" in words instead of with a sign.
      inr = CREDIT_WORDS.test(kindText) ? -Math.abs(amount) : amount;
    }

    const row = byAwb.get(awb) || { chargeInr: 0, kinds: new Set(), raw: [] };
    row.chargeInr += inr;
    row.kinds.add(kindOf(kindText));
    row.raw.push(Object.fromEntries(header.map((h, j) => [h || `col${j}`, norm(cells[j])])));
    byAwb.set(awb, row);
  }
  if (skipped) warnings.push(`Skipped ${skipped} row(s) with no waybill number or no amount.`);
  if (!byAwb.size) warnings.push('The file parsed but held no waybill rows.');

  const rows = [...byAwb.entries()].map(([awb, r]) => ({
    awb,
    // Rounded to paise: a float sum of rupee cells drifts, and this number is
    // compared against an integer-paise computation.
    chargeInr: Math.round(r.chargeInr * 100) / 100,
    /*
     * Netted PER AWB, which is what the engine compares against a parcel's
     * computed cost. The heads are kept as a label ('forward+rto') rather than
     * split into rows, because a credit note names no leg and would otherwise
     * net against nothing.
     */
    kind: [...r.kinds].sort().join('+'),
    gstIncluded,
    raw: r.raw,
  }));
  return { rows, warnings };
}
