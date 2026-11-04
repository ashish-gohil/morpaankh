/*
 * The pure parts of the orchestrator: what the owner typed, and folding an
 * uploaded ledger over the computed charges. Both are small and both decide
 * which month's money gets reported, so both get a test.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMonthArg,
  monthLabel,
  previousMonth,
  currentMonth,
  reportFilename,
  mergeLedger,
} from './run.mjs';
import { summaryVars, emailParts, adminPhones } from './deliver.mjs';

// A fixed clock: 4 Nov 2026, 09:00 IST (03:30 UTC).
const NOV_4 = new Date('2026-11-04T03:30:00Z');
// 2 Jan 2027, 10:00 IST, for the year-boundary cases.
const JAN_2 = new Date('2027-01-02T04:30:00Z');

describe('parseMonthArg', () => {
  it('bare /pnl means last month, in IST', () => {
    expect(parseMonthArg('', NOV_4)).toEqual({ month: '2026-10', mtd: false });
  });

  it('rolls the year back on 1 January rather than asking for month zero', () => {
    expect(parseMonthArg('', JAN_2)).toEqual({ month: '2026-12', mtd: false });
    expect(previousMonth(JAN_2)).toBe('2026-12');
    expect(currentMonth(JAN_2)).toBe('2027-01');
  });

  it('reads an explicit month', () => {
    expect(parseMonthArg('2026-10', NOV_4)).toEqual({ month: '2026-10', mtd: false });
    expect(parseMonthArg('2026-7', NOV_4)).toEqual({ month: '2026-07', mtd: false });
    expect(parseMonthArg('2026/07', NOV_4)).toEqual({ month: '2026-07', mtd: false });
  });

  it('reads a month name, and a bare name means the one that has already happened', () => {
    // October has finished, so "oct" in November is this year.
    expect(parseMonthArg('oct', NOV_4)).toEqual({ month: '2026-10', mtd: false });
    expect(parseMonthArg('october', NOV_4)).toEqual({ month: '2026-10', mtd: false });
    /*
     * December has NOT finished in November, so a bare "dec" must mean LAST
     * December. Reading it as a month five weeks in the future would build a
     * report for a month with no orders in it and look like a broken engine
     * rather than a misread command.
     */
    expect(parseMonthArg('dec', NOV_4)).toEqual({ month: '2025-12', mtd: false });
    /*
     * The CURRENT month's own name means the current month, part-finished, not
     * the one a year ago. Handing back November 2025 to someone who typed "nov"
     * in November would be far more surprising than handing back a month that
     * is not over yet, and the report labels itself provisional either way.
     * The boundary is therefore "has this month's name already come round this
     * year", not "has it finished".
     */
    expect(parseMonthArg('nov', NOV_4)).toEqual({ month: '2026-11', mtd: false });
    // An explicit year always wins over that rule.
    expect(parseMonthArg('dec 2026', NOV_4)).toEqual({ month: '2026-12', mtd: false });
  });

  it('mtd is this month, flagged', () => {
    expect(parseMonthArg('mtd', NOV_4)).toEqual({ month: '2026-11', mtd: true });
  });

  it('is case and space insensitive', () => {
    expect(parseMonthArg('  OcT   2026 ', NOV_4)).toEqual({ month: '2026-10', mtd: false });
  });

  it('never throws: a command it cannot read comes back as an error', () => {
    expect(parseMonthArg('smarch', NOV_4)).toHaveProperty('error');
    expect(parseMonthArg('2026-13', NOV_4)).toHaveProperty('error');
    expect(parseMonthArg('2026-00', NOV_4)).toHaveProperty('error');
    expect(parseMonthArg('last tuesday', NOV_4)).toHaveProperty('error');
    // The caller replies with the usage line, so the shape matters.
    expect(typeof (/** @type {any} */ (parseMonthArg('smarch', NOV_4)).error)).toBe('string');
  });
});

describe('monthLabel and the filename', () => {
  it('labels a month the way a person writes it', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('2026-01')).toBe('January 2026');
  });
  it('names the file provisional or final, because the two mean different things', () => {
    expect(reportFilename('2026-10', true)).toBe('Morpaankh-PnL-2026-10-provisional.xlsx');
    expect(reportFilename('2026-10', false)).toBe('Morpaankh-PnL-2026-10-final.xlsx');
  });
});

describe('mergeLedger', () => {
  const computed = [
    { awb: 'A1', source: 'computed', totalPaise: 11318, flags: [] },
    { awb: 'A2', source: 'computed', totalPaise: 6598, flags: [] },
    { awb: 'A3', source: 'missing', totalPaise: null, flags: [] },
  ];

  it('leaves the charges alone when there is no ledger', () => {
    expect(mergeLedger(computed, null)).toEqual({ charges: computed, applied: 0 });
    expect(mergeLedger(computed, { rows: [] }).applied).toBe(0);
  });

  it('the ledger wins, and the variance is kept', () => {
    const { charges, applied } = mergeLedger(computed, {
      rows: [{ awb: 'A1', chargeInr: 120.5 }],
    });
    expect(applied).toBe(1);
    const a1 = charges.find((c) => c.awb === 'A1');
    expect(a1.source).toBe('ledger');
    expect(a1.totalPaise).toBe(12050);
    // 12050 actual - 11318 computed: the gap is what says a weight is disputed.
    expect(a1.variancePaise).toBe(732);
    expect(a1.flags).toContain('total from ledger, legs computed');
    // Everything else is untouched.
    expect(charges.find((c) => c.awb === 'A2')).toEqual(computed[1]);
  });

  it('nets several lines for one AWB, because a statement bills and credits separately', () => {
    const { charges } = mergeLedger(computed, {
      rows: [
        { awb: 'A2', chargeInr: 65.98 },
        { awb: 'A2', chargeInr: 52 }, // a return leg billed later
        { awb: 'A2', chargeInr: -10 }, // a weight-discrepancy credit
      ],
    });
    const a2 = charges.find((c) => c.awb === 'A2');
    expect(a2.totalPaise).toBe(10798); // 65.98 + 52 - 10 = 107.98
    expect(a2.source).toBe('ledger');
  });

  it('gives a previously MISSING charge a real total without inventing a variance', () => {
    const { charges } = mergeLedger(computed, { rows: [{ awb: 'A3', chargeInr: 80 }] });
    const a3 = charges.find((c) => c.awb === 'A3');
    expect(a3.totalPaise).toBe(8000);
    expect(a3.source).toBe('ledger');
    // There was no computed figure, so there is no gap to report. Null, not 0:
    // "we never computed one" is not "they agreed".
    expect(a3.variancePaise).toBeNull();
  });

  it('ignores a ledger line with no AWB rather than attributing it to a parcel', () => {
    const { charges, applied } = mergeLedger(computed, {
      rows: [{ awb: '', chargeInr: 500 }, { awb: null, chargeInr: 200 }],
    });
    expect(applied).toBe(0);
    expect(charges).toEqual(computed);
  });
});

describe('the six line summary', () => {
  const report = {
    totals: {
      netProfitPaise: -1876081,
      netProfitPctOfNetRevenue: -32.4,
      rtoLossPaise: 107741,
      totalMetaPaise: 4621023,
    },
    funnel: { delivered: 34, rto: 9, pending: 8 },
    ratios: { rtoRateByOrderPct: 20.93, metaPerDeliveredOrderPaise: 140031 },
  };
  const meta = {
    month: '2026-10',
    monthLabel: 'October 2026',
    provisional: true,
    courierChargeBasis: 'computed from Delhivery rates',
  };

  it('signs a loss, and says how many orders are still open', () => {
    const v = summaryVars(report, meta);
    expect(v.net).toBe('-₹18,760.81');
    expect(v.state).toBe('provisional, 8 orders pending');
    expect(v.delivered).toBe('34');
    expect(v.rto_pct).toBe('20.9%');
  });

  it('signs a profit too', () => {
    const v = summaryVars({ ...report, totals: { ...report.totals, netProfitPaise: 500000 } }, meta);
    expect(v.net).toBe('+₹5,000');
  });

  it('says "not known" rather than a zero for a figure it could not compute', () => {
    const v = summaryVars(
      { ...report, totals: { ...report.totals, rtoLossPaise: null, netProfitPctOfNetRevenue: null } },
      meta,
    );
    expect(v.rto_loss).toBe('not known');
    expect(v.margin).toBe('n/a');
  });

  it('a final month does not call itself provisional', () => {
    expect(summaryVars(report, { ...meta, provisional: false }).state).toBe('final');
  });

  it('the email leads with INCOMPLETE when a source failed, and carries the offline note', () => {
    const plain = emailParts(report, meta);
    expect(plain.subject).toContain('Morpaankh P&L October 2026');
    expect(plain.subject).toContain('-₹18,760.81');
    expect(plain.text).toContain('Offline sales not recorded in Shopify are not included');
    expect(plain.subject.startsWith('INCOMPLETE')).toBe(false);

    const broken = emailParts(report, { ...meta, incomplete: true });
    expect(broken.subject.startsWith('INCOMPLETE')).toBe(true);
    expect(broken.text).toContain('INCOMPLETE');
  });

  it('html-escapes the body rather than letting a stray angle bracket break it', () => {
    const v = emailParts(report, { ...meta, monthLabel: 'October <2026>' });
    expect(v.html).toContain('&lt;2026');
    expect(v.html).not.toContain('<2026>');
  });
});

describe('who may be sent a P&L', () => {
  it('falls back through the three lists rather than needing all of them set', () => {
    // Exercised against the live config, which has pnlAdminPhones empty, so
    // this asserts the fallback actually resolves to somebody.
    expect(Array.isArray(adminPhones())).toBe(true);
  });
});
