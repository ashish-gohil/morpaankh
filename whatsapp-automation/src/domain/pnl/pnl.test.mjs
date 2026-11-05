/*
 * pnl.test.mjs — the engine against the real October 2026 month.
 *
 * Every fixture is the live Shopify/Delhivery/Meta pull of 2026-11-03 with the
 * customer names replaced (fixtures.mjs). That is deliberate: the month was
 * reconciled against the owner's own snapshot before any engine code was
 * written, so the funnel below is a VERIFIED FACT. If the engine disagrees with
 * it, the engine is wrong.
 */
import { describe, it, expect } from 'vitest';
import { OCT_ORDERS, OCT_SHIPMENTS, OCT_META, order, shipmentsFor } from './fixtures.mjs';
import { monthWindow, classifyInclusion, istDateKey, inCohort, istWallToUtc } from './cohort.mjs';
import { deriveOutcome, customerDeliveredAt, shopifyConflict, rtoIsFinal } from './outcome.mjs';
import { lineGstPaise, backOutGst, pickSlabRatePct, nearSlabBoundary } from './gst.mjs';
import { toPnlConfig, pnlConfig, assumptionRows } from './config.mjs';
import { buildReport, parcelLegs, splitPaise, unrefundedAdvancePaise } from './engine.mjs';

const WINDOW = monthWindow('2026-10');

/** Delhivery's own verified arithmetic for a 500 g D1 parcel, in paise. */
const DELIVERED_COD_CHARGE = {
  source: 'computed',
  forwardPaise: 5200,
  rtoPaise: null,
  dtoPaise: null,
  codChargePaise: 4000,
  gstPaise: 1726,
  totalPaise: 11318,
  zone: 'D1',
  chargedWeightGrams: null,
  weightAssumed: true,
  variancePaise: null,
  flags: [],
};
const RTO_COD_CHARGE = {
  source: 'computed',
  forwardPaise: 5200,
  rtoPaise: 5200,
  dtoPaise: null,
  codChargePaise: null,
  gstPaise: 1976,
  totalPaise: 12959,
  zone: 'D1',
  chargedWeightGrams: null,
  weightAssumed: true,
  variancePaise: null,
  flags: [],
};
const PREPAID_CHARGE = {
  source: 'computed',
  forwardPaise: 5200,
  rtoPaise: null,
  dtoPaise: null,
  codChargePaise: null,
  gstPaise: 936,
  totalPaise: 6136,
  zone: 'D1',
  chargedWeightGrams: null,
  weightAssumed: true,
  variancePaise: null,
  flags: [],
};
const charge = (awb, shape) => ({ awb, ...shape });

function inputs(over = {}) {
  return {
    month: '2026-10',
    ...WINDOW,
    generatedAt: '2026-11-03T12:00:00Z',
    trigger: 'cli',
    orders: OCT_ORDERS,
    shipments: OCT_SHIPMENTS,
    charges: [],
    meta: OCT_META,
    gateway: [],
    replacements: [],
    config: pnlConfig,
    sourceStatus: {
      shopify: true,
      delhiveryTracking: true,
      delhiveryCharges: false,
      meta: true,
      gateway: false,
      courierChargeBasis: 'computed',
      failures: [],
    },
    previousSnapshot: null,
    ...over,
  };
}

const report = buildReport(inputs());
const row = (name) => {
  const r = report.rows.find((x) => x.order.name === name);
  if (!r) throw new Error(`no row ${name}`);
  return r;
};
const notes = (name) => report.flags.filter((f) => f.orderName === name).map((f) => f.note);
const outcomeOf = (name) => deriveOutcome(order(name), shipmentsFor(name));

// ----------------------------------------------------------------- cohort

describe('monthWindow', () => {
  it('is the IST calendar month, end exclusive', () => {
    expect(WINDOW).toEqual({ monthStartUtc: '2026-09-30T18:30:00Z', monthEndUtc: '2026-10-31T18:30:00Z' });
  });

  it('rolls December into the next January', () => {
    expect(monthWindow('2026-12')).toEqual({
      monthStartUtc: '2026-11-30T18:30:00Z',
      monthEndUtc: '2026-12-31T18:30:00Z',
    });
  });

  it('refuses anything that is not YYYY-MM', () => {
    expect(() => monthWindow('Oct 2026')).toThrow();
    expect(() => monthWindow('2026-13')).toThrow();
  });

  it('cuts the orders Shopify over-fetches: created_at ignores the time of day', () => {
    // #1168 (08:04Z) and #1169 (17:37Z) on 30 Sep are September in IST and come
    // back from a `created_at:>=2026-09-30T18:30:00Z` search anyway.
    const sep = { createdAt: '2026-09-30T17:37:00Z' };
    expect(inCohort(sep, WINDOW.monthStartUtc, WINDOW.monthEndUtc)).toBe(false);
    expect(inCohort(order('#1170'), WINDOW.monthStartUtc, WINDOW.monthEndUtc)).toBe(true);
  });

  it('keys the daily series on the IST date, not the UTC one', () => {
    // 31 Oct 19:30 IST is 14:00Z; 1 Nov 00:30 IST is 31 Oct 19:00Z.
    expect(istDateKey('2026-10-31T14:00:00Z')).toBe('2026-10-31');
    expect(istDateKey('2026-10-31T19:00:00Z')).toBe('2026-11-01');
  });
});

describe('classifyInclusion', () => {
  it('drops the automation-app test orders, which have no customer', () => {
    for (const n of ['#1189', '#1190', '#1191', '#1192', '#1193', '#1194', '#1195']) {
      const c = classifyInclusion(order(n), pnlConfig);
      expect(c.included).toBe(false);
      expect(c.reason).toMatch(/no customer/);
    }
  });

  it('drops the founder order by name', () => {
    const c = classifyInclusion(order('#1199'), pnlConfig);
    expect(c.included).toBe(false);
    expect(c.reason).toBe('excluded customer: Ashish Gohil');
  });

  it('drops the replace-payload test order', () => {
    expect(classifyInclusion(order('#1222'), pnlConfig).included).toBe(false);
  });

  it('drops an order whose surname is excluded, as a whole word', () => {
    const base = order('#1171');
    expect(classifyInclusion({ ...base, customerName: 'Riya Gohel' }, pnlConfig).reason).toBe(
      'excluded surname: Gohel',
    );
    // Contains it but is not it: kept, and flagged rather than decided silently.
    const amb = classifyInclusion({ ...base, customerName: 'Riya Gohilwala' }, pnlConfig);
    expect(amb.included).toBe(true);
    expect(amb.flags).toContain('possible family name (Gohil)');
  });

  it("matches excludeTags exactly, so 'test' does not catch 'wa-throwaway-variant-test'", () => {
    const o = { ...order('#1171'), tags: ['wa-throwaway-variant-test'] };
    expect(classifyInclusion(o, pnlConfig).included).toBe(true);
  });

  it('keeps a draft order and a Claude-connector order that have a real customer, flagged Manual', () => {
    for (const n of ['#1233', '#1188']) {
      const c = classifyInclusion(order(n), pnlConfig);
      expect(c.included).toBe(true);
      expect(order(n).channel).toBe('Manual');
      expect(c.flags).toContain('manual_channel_review');
    }
  });
});

// ---------------------------------------------------------------- outcome

describe('deriveOutcome: Delhivery is the truth', () => {
  it('never reads Shopify DELIVERED as delivered on an RTO parcel', () => {
    for (const n of ['#1170', '#1183', '#1203']) {
      const o = order(n);
      // Shopify really does claim all three were delivered, with a date.
      expect(o.fulfillments[0].displayStatus).toBe('DELIVERED');
      expect(o.fulfillments[0].deliveredAt).toBeTruthy();
      expect(outcomeOf(n).outcome).toBe('RTO');
      expect(shopifyConflict(o, shipmentsFor(n), 'RTO')).toMatch(/Shopify fulfilment says DELIVERED/);
    }
  });

  it("THE TRAP: an RTO parcel's deliveredAt is the return-accepted time, not a delivery", () => {
    const s = shipmentsFor('#1170')[0];
    // Identical to the "RETURN Accepted" scan, which is why nothing may read
    // this field without branching on the state first.
    expect(s.deliveredAt).toBe('2026-10-13T16:46:36.749');
    expect(s.statusAt).toBe(s.deliveredAt);
    expect(s.statusType).toBe('DL'); // a return that reaches us is a "delivery"
    expect(customerDeliveredAt(s)).toBeNull();
    expect(customerDeliveredAt(shipmentsFor('#1172')[0])).toBeTruthy();
  });

  it('is RTO on the tag while Delhivery still shows the parcel moving', () => {
    for (const n of ['#1220', '#1225', '#1227']) {
      expect(order(n).tags).toContain('RTO');
      expect(shipmentsFor(n)[0].rawStatus).toMatch(/In Transit/);
      expect(shipmentsFor(n)[0].statusType).toBe('RT');
      const o = outcomeOf(n);
      expect(o.outcome).toBe('RTO');
      // Delhivery said it, so this is not an inference.
      expect(o.inferred).toBe(false);
      expect(o.reason).toBe('Delhivery RTO in progress');
    }
  });

  it('infers delivery from COD cash collected after the fulfilment (#1205, no AWB at all)', () => {
    const o = order('#1205');
    expect(o.awbs).toEqual([]);
    const got = outcomeOf('#1205');
    expect(got).toEqual({
      outcome: 'DELIVERED',
      reason: 'COD cash collected after fulfilment',
      inferred: true,
    });
  });

  it('never treats a PAID status alone as delivery (#1233, draft paid at creation)', () => {
    const o = order('#1233');
    expect(o.financialStatus).toBe('PAID');
    expect(o.channel).toBe('Manual');
    expect(o.awbs).toEqual([]);
    // Its one SALE transaction is at creation, days before the fulfilment.
    expect(Date.parse(o.transactions[0].createdAt)).toBeLessThan(Date.parse(o.fulfillments[0].createdAt));
    expect(outcomeOf('#1233')).toEqual({
      outcome: 'PENDING',
      reason: 'fulfilled, no Delhivery record',
      inferred: false,
    });
  });

  it('is CANCELLED when Shopify cancelled it, whatever the parcel says', () => {
    expect(order('#1217').cancelledAt).toBeTruthy();
    expect(shipmentsFor('#1217')[0].rawStatus).toBe('Not Picked');
    expect(outcomeOf('#1217').outcome).toBe('CANCELLED');
    expect(outcomeOf('#1228').outcome).toBe('CANCELLED'); // cancelled, never shipped
  });

  it('is RTO from the tag only when Delhivery has no record, and says it inferred that', () => {
    const o = { ...order('#1170'), awbs: [], fulfillments: [] };
    expect(deriveOutcome(o, [])).toEqual({
      outcome: 'RTO',
      reason: 'tag RTO, no Delhivery record',
      inferred: true,
    });
  });

  it('is not fooled by the COD King risk tags, which say RTO on every order', () => {
    const o = { ...order('#1171'), awbs: [], fulfillments: [], tags: ['MEDIUM RTO Risk'], cancelledAt: null };
    expect(deriveOutcome(o, []).outcome).toBe('PENDING');
  });
});

// -------------------------------------------------------------------- GST

describe('GST', () => {
  const slabs = pnlConfig.gstSlabs;

  it('backs GST out of a GST-inclusive price', () => {
    expect(backOutGst(109900, 5)).toBe(5233); // 1099.00 -> 52.33
    expect(backOutGst(274900, 18)).toBe(41934); // 2749.00 -> 419.34
    expect(backOutGst(0, 5)).toBe(0);
  });

  it('picks the slab per line on the discounted unit price, boundary Rs 2,625', () => {
    expect(pickSlabRatePct(262500, slabs)).toBe(5);
    expect(pickSlabRatePct(262501, slabs)).toBe(18);
    expect(pickSlabRatePct(274900, slabs)).toBe(18);
  });

  it('is linear in quantity and rounds once on the line', () => {
    expect(lineGstPaise(109900, 3, slabs)).toEqual({ ratePct: 5, gstPaise: 15700, linePaise: 329700 });
    // An edited-away line pays no tax.
    expect(lineGstPaise(109900, 0, slabs).gstPaise).toBe(0);
  });

  it('flags a line sitting within Rs 100 of the boundary', () => {
    expect(nearSlabBoundary(262400, slabs, pnlConfig.gstThresholdFlagPaise)).toBe(true);
    expect(nearSlabBoundary(250000, slabs, pnlConfig.gstThresholdFlagPaise)).toBe(false);
  });

  it("records Shopify's Gujarat split bug and never computes from it (#1172, #1184, #1202)", () => {
    const split = report.flags.filter((f) => /split is wrong/.test(f.note)).map((f) => f.orderName);
    expect(split.sort()).toEqual(['#1172', '#1184', '#1202']);
    // #1172: Shopify billed CGST 2.5% + SGST 5% = 146.44 on a Rs 2,099 order.
    expect(order('#1172').shopifyTaxLines.map((t) => [t.title, t.ratePct])).toEqual([
      ['CGST', 2.5],
      ['SGST', 5],
    ]);
    expect(row('#1172').outputGstPaise).toBe(9995); // 2099 * 5/105, the slab answer
  });

  it('flags #1227: Rs 2,749 after discount, taxed 5% by Shopify where the slab says 18%', () => {
    const line = order('#1227').lines[0];
    expect(line.discountedUnitPaise).toBe(274900);
    expect(order('#1227').shopifyTaxLines[0].ratePct).toBe(5);
    expect(notes('#1227')).toContain('Shopify charged 5% where the slab says 18%');
  });

  it('does not compare tax on a voided order, whose lines all stand at quantity 0', () => {
    expect(notes('#1174').some((n) => /Shopify GST/.test(n))).toBe(false);
  });
});

// ----------------------------------------------------------- the real month

describe('the October 2026 funnel, reconciled against the live snapshot', () => {
  it('is 71 on record = 9 excluded + 11 cancelled + 34 delivered + 8 RTO + 9 pending + 0 lost', () => {
    expect(report.funnel).toMatchObject({
      onRecord: 71,
      excluded: 9,
      cancelled: 11,
      delivered: 34,
      rto: 8,
      pending: 9,
      lost: 0,
    });
  });

  it('is 8 RTO orders in 7 parcels, and 34 delivered in 33 (#1205 has no AWB)', () => {
    expect(report.funnel.rtoParcels).toBe(7);
    expect(report.funnel.deliveredParcels).toBe(33);
    expect(report.ratios.rtoRateByOrderPct).toBeCloseTo((8 / 42) * 100, 6);
    expect(report.ratios.rtoRateByParcelPct).toBeCloseTo((7 / 40) * 100, 6);
  });

  it('has #1205 as the ONLY inferred outcome in the month', () => {
    const inferred = report.rows.filter((r) => r.outcomeInferred).map((r) => r.order.name);
    expect(inferred).toEqual(['#1205']);
  });

  it('has exactly #1170, #1183 and #1203 as Shopify-vs-Delhivery conflicts', () => {
    const conflicts = report.flags
      .filter((f) => f.code === 'shopify_delhivery_conflict')
      .map((f) => f.orderName);
    expect(conflicts.sort()).toEqual(['#1170', '#1183', '#1203']);
  });

  it('has exactly two lines with no unit cost: #1174 Toran and #1233 Dupatta', () => {
    const missing = report.flags
      .filter((f) => /no unit cost on/.test(f.note))
      .map((f) => `${f.orderName} ${f.note.replace(/^no unit cost on: /, '').split(' (')[0]}`);
    expect(missing.sort()).toEqual(['#1174 Toran', '#1233 Dupatta']);
  });

  it('flags #1239 as a possible duplicate of #1238: same customer, same day', () => {
    expect(order('#1238').customerName).toBe(order('#1239').customerName);
    expect(istDateKey(order('#1238').createdAt)).toBe(istDateKey(order('#1239').createdAt));
    const dups = report.flags.filter((f) => f.code === 'possible_duplicate');
    expect(dups).toHaveLength(1);
    expect(dups[0].orderName).toBe('#1239');
  });

  it('reconciles the funnel and the Meta month total', () => {
    const r = Object.fromEntries(report.reconciliations.map((x) => [x.key, x]));
    expect(r.funnel.agree).toBe(true);
    expect(r.meta.agree).toBe(true);
    // 39,161.21 = sales 34,879.40 + boost 4,281.81, which is the owner's own snapshot.
    expect(report.meta.salesPaise).toBe(3487940);
    expect(report.meta.boostPaise).toBe(428181);
    expect(report.meta.otherPaise).toBe(0);
  });

  it('is the same report every time it is built', () => {
    expect(JSON.stringify(buildReport(inputs()))).toBe(JSON.stringify(buildReport(inputs())));
  });

  it('accounts for every paisa in the courier ledger, pending parcels included', () => {
    const everyAwb = [...new Set(OCT_ORDERS.flatMap((o) => o.awbs))];
    const full = buildReport(
      inputs({ charges: everyAwb.map((awb) => charge(awb, DELIVERED_COD_CHARGE)) }),
    );
    const courier = full.reconciliations.find((x) => x.key === 'courier');
    expect(courier.b).toBe(everyAwb.length * 11318);
    expect(courier.agree).toBe(true);
  });
});

describe('splitPaise', () => {
  it('splits by weight and the parts always add back to the whole', () => {
    expect(splitPaise(1500, [214900, 119900])).toEqual([963, 537]);
    const three = splitPaise(10000, [1, 1, 1]);
    expect(three.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(three).toEqual([3334, 3333, 3333]);
  });

  it('splits evenly when every order in the parcel is worth nothing', () => {
    expect(splitPaise(100, [0, 0])).toEqual([50, 50]);
  });

  it('never loses the remainder, whatever the weights', () => {
    for (const total of [1, 7, 1499, 12959]) {
      for (const w of [[1, 2], [5, 5, 5], [1000, 3, 7, 999]]) {
        expect(splitPaise(total, w).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});

// ------------------------------------------------------------- money rules

describe('settled orders only reach the P&L', () => {
  it('gives a pending order no revenue and no contribution, but keeps its charges so far', () => {
    const r = row('#1234');
    expect(r.outcome).toBe('PENDING');
    expect(r.grossSalePaise).toBeNull();
    expect(r.contributionPaise).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('counts nothing on a cancelled order but the charges actually billed (#1217, manifested)', () => {
    const r = row('#1217');
    expect(r.outcome).toBe('CANCELLED');
    expect(r.awbs).toHaveLength(1);
    expect(r.totalCostPaise).toBe(0);
    expect(r.flags).toContain('cancelled after the parcel was manifested: confirm whether Delhivery billed it');
  });

  it('charges a cancelled parcel only what Delhivery billed, when it did bill', () => {
    const only = buildReport(
      inputs({ charges: [charge(order('#1217').awbs[0], DELIVERED_COD_CHARGE)] }),
    );
    const r = only.rows.find((x) => x.order.name === '#1217');
    expect(r.totalCostPaise).toBe(11318 + pnlConfig.packingCostPerOrderPaise);
    expect(only.totals.cancelledShipmentChargesPaise).toBe(r.totalCostPaise);
  });

  it('books nothing from a cancelled order and asks about the deposit instead', () => {
    const r = row('#1228');
    expect(r.outcome).toBe('CANCELLED');
    expect(r.advanceKeptPaise).toBe(0);
    expect(r.flags.some((f) => /advance kept\? confirm/.test(f))).toBe(true);
  });
});

describe('an unrefunded deposit', () => {
  /*
   * #1225 and #1228 are the same 104.95 on the same partial-payment shape:
   * PARTIALLY_PAID, nothing refunded, and an outcome that never completed. The
   * engine used to book one as income (because it was an RTO) and ask about the
   * other (because it was cancelled), which moved the RTO loss 99.95 in the
   * favourable direction on an assumption nobody had verified.
   *
   * The discriminator is whether the GARMENT IS BACK, read off ReturnedDate,
   * not which bucket the order landed in.
   */
  it('is an open question on both #1225 and #1228, and income on neither', () => {
    for (const n of ['#1225', '#1228']) {
      expect(order(n).financialStatus).toBe('PARTIALLY_PAID');
      expect(unrefundedAdvancePaise(order(n))).toBe(10495);
      expect(row(n).advanceKeptPaise).toBe(0);
    }
    expect(report.openQuestions.map((q) => [q.orderName, q.amountPaise])).toEqual([
      ['#1225', 10495],
      ['#1228', 10495],
    ]);
    expect(report.totals.advanceUnverifiedPaise).toBe(20990);
    // Nothing unverified reaches the statement.
    expect(report.totals.advanceKeptOnRtoPaise).toBe(0);
  });

  it('is not booked while the parcel is still in reverse transit', () => {
    const s = shipmentsFor('#1225')[0];
    expect(s.returnedAt).toBeNull();
    expect(s.reverseInTransit).toBe(true);
    expect(rtoIsFinal([s])).toBe(false);
    expect(row('#1225').flags.some((f) => /parcel not back yet, nothing booked/.test(f))).toBe(true);
  });

  it('becomes other income net of GST once the parcel is back and still unrefunded', () => {
    const awb = order('#1225').awbs[0];
    const back = buildReport(
      inputs({
        shipments: OCT_SHIPMENTS.map((sh) =>
          sh.awb === awb ? { ...sh, returnedAt: '2026-11-04T11:00:00.000', reverseInTransit: false } : sh,
        ),
        charges: [charge(awb, RTO_COD_CHARGE)],
      }),
    );
    const k = back.rows.find((x) => x.order.name === '#1225');
    expect(rtoIsFinal([{ ...shipmentsFor('#1225')[0], returnedAt: '2026-11-04T11:00:00.000' }])).toBe(true);
    expect(k.outcomeReason).toBe('Delhivery RTO, returned to origin');
    expect(k.advanceKeptPaise).toBe(10495 - 500); // 5% backed out
    expect(back.totals.advanceKeptOnRtoPaise).toBe(9995);
    // The RTO loss line is 99.95 better than the same month with the parcel
    // still moving, and that 99.95 is now a fact rather than a hope.
    const open = buildReport(inputs({ charges: [charge(awb, RTO_COD_CHARGE)] }));
    expect(open.totals.rtoLossPaise - back.totals.rtoLossPaise).toBe(9995);
    expect(back.openQuestions.map((q) => q.orderName)).toEqual(['#1228']);
  });
});

describe('a delivered order, fully costed', () => {
  const r = buildReport(inputs({ charges: [charge(order('#1172').awbs[0], PREPAID_CHARGE)] }));
  const d = r.rows.find((x) => x.order.name === '#1172');

  it('earns the current total less refunds, with GST backed out', () => {
    expect(d.grossSalePaise).toBe(209900);
    expect(d.outputGstPaise).toBe(9995);
    expect(d.netRevenuePaise).toBe(199905);
  });

  it('costs COGS, freight incl. GST, packing and an assumed gateway fee', () => {
    expect(d.cogsPaise).toBe(78000);
    expect(d.forwardFreightPaise).toBe(6136); // total_amount, because no input credit is claimed
    expect(d.packingPaise).toBe(1500);
    expect(d.gatewayFeePaise).toBe(4954); // 2% of 2099 + 18% GST, ASSUMED
    expect(d.assumed).toContain('gateway_rate');
    expect(d.totalCostPaise).toBe(78000 + 6136 + 1500 + 4954);
    expect(d.contributionPaise).toBe(199905 - d.totalCostPaise);
    expect(d.complete).toBe(true);
  });

  it('books freight ex-GST when input credit is claimed', () => {
    const credit = buildReport(
      inputs({
        charges: [charge(order('#1172').awbs[0], PREPAID_CHARGE)],
        config: { ...pnlConfig, gstInputCreditClaimed: true },
      }),
    );
    const c = credit.rows.find((x) => x.order.name === '#1172');
    expect(c.forwardFreightPaise).toBe(6136 - 936);
    expect(credit.totals.metaGstPaise).toBe(0);
  });

  it('charges no gateway fee on a COD order', () => {
    expect(row('#1170').gatewayFeePaise).toBe(0);
  });

  it('never drops a return leg the ledger billed on a delivered parcel', () => {
    const odd = buildReport(
      inputs({ charges: [charge(order('#1172').awbs[0], { ...PREPAID_CHARGE, rtoPaise: 5200 })] }),
    );
    const d = odd.rows.find((x) => x.order.name === '#1172');
    const legs = parcelLegs(charge('x', { ...PREPAID_CHARGE, rtoPaise: 5200 }), pnlConfig);
    expect(d.forwardFreightPaise).toBe(legs.total);
    expect(d.rtoFreightPaise).toBe(0);
    expect(d.flags.some((f) => /return leg was billed on a delivered parcel/.test(f))).toBe(true);
  });
});

describe('an RTO order', () => {
  const r = buildReport(inputs({ charges: [charge(order('#1170').awbs[0], RTO_COD_CHARGE)] }));
  const d = r.rows.find((x) => x.order.name === '#1170');

  it('earns nothing and does not expense COGS: the garment comes back', () => {
    expect(d.grossSalePaise).toBeNull();
    expect(d.netRevenuePaise).toBeNull();
    expect(d.cogsPaise).toBe(0);
    expect(d.flags).toContain('RTO: COGS not expensed, the garment returns to stock');
  });

  it('charges both legs, which ss=RTO returns in one row', () => {
    // 52 + 52 + surcharges + GST = 129.59, split back over the two legs.
    expect(d.forwardFreightPaise + d.rtoFreightPaise).toBe(12959);
    expect(d.rtoFreightPaise).toBeGreaterThan(0);
    expect(d.totalCostPaise).toBe(12959 + 1500);
    expect(d.contributionPaise).toBe(-(12959 + 1500));
  });

  it('does not book an advance kept while the parcel has not reached us (#1225)', () => {
    const k = row('#1225');
    expect(k.order.paymentType).toBe('partial');
    expect(k.order.prepaidReceivedPaise).toBe(10495);
    expect(k.order.refundedPaise).toBe(0);
    expect(k.advanceKeptPaise).toBe(0);
  });
});

describe('two orders in one parcel (#1208 + #1209 on 59152210001584)', () => {
  const awb = '59152210001584';
  const r = buildReport(inputs({ charges: [charge(awb, RTO_COD_CHARGE)] }));
  const a = r.rows.find((x) => x.order.name === '#1208');
  const b = r.rows.find((x) => x.order.name === '#1209');

  it('is one parcel and therefore one outcome for both orders', () => {
    expect(order('#1208').awbs).toEqual([awb]);
    expect(order('#1209').awbs).toEqual([awb]);
    expect(a.outcome).toBe('RTO');
    expect(b.outcome).toBe('RTO');
  });

  it('splits freight and packing by order value, and the parts add back to the parcel', () => {
    const legs = parcelLegs(charge(awb, RTO_COD_CHARGE), pnlConfig);
    expect(a.parcelShare).toBeCloseTo(2149 / 3348, 6);
    expect(b.parcelShare).toBeCloseTo(1199 / 3348, 6);
    expect(a.forwardFreightPaise + b.forwardFreightPaise).toBe(legs.forward);
    expect(a.rtoFreightPaise + b.rtoFreightPaise).toBe(legs.rto);
    expect(a.packingPaise).toBe(963);
    expect(b.packingPaise).toBe(537);
    expect(a.packingPaise + b.packingPaise).toBe(pnlConfig.packingCostPerOrderPaise);
    expect(a.forwardFreightPaise).toBeGreaterThan(b.forwardFreightPaise);
  });

  it('does not bill the parcel twice', () => {
    expect(r.totals.rtoForwardFreightPaise + r.totals.rtoReturnFreightPaise).toBe(12959);
  });
});

describe('three orders in one parcel', () => {
  /*
   * October's only shared parcel is two orders whose values happen to round
   * cleanly, so it proves nothing about the allocation. This is the shape that
   * does: three orders of Rs 2,099 / Rs 2,099 / Rs 650 on one waybill. Those
   * weights are chosen because rounding each order's share on its own drifts a
   * paisa on EVERY head at once, the forward leg and the COD charge and the
   * packing. A paisa is not the problem; a Data Checks reconciliation that
   * fails every month and gets ignored is.
   */
  const awb = order('#1172').awbs[0];
  const base = order('#1172');
  const clones = [
    { ...base, name: '#9996', gid: 'gid://shopify/Order/9996', numericId: '9996', customerName: 'Clone One' },
    {
      ...base,
      name: '#9997',
      gid: 'gid://shopify/Order/9997',
      numericId: '9997',
      customerName: 'Clone Two',
      currentTotalPaise: 65000,
      totalPaise: 65000,
      lines: base.lines.map((l) => ({ ...l, originalUnitPaise: 65000, discountedUnitPaise: 65000 })),
    },
  ];
  const r = buildReport(inputs({ orders: [...OCT_ORDERS, ...clones], charges: [charge(awb, DELIVERED_COD_CHARGE)] }));
  const legs = parcelLegs(charge(awb, DELIVERED_COD_CHARGE), pnlConfig);
  const three = ['#1172', '#9996', '#9997'].map((n) => r.rows.find((x) => x.order.name === n));

  it('splits the freight so the parts add back to the parcel exactly', () => {
    expect(three.every((x) => x.outcome === 'DELIVERED')).toBe(true);
    expect(three.reduce((a, x) => a + x.forwardFreightPaise, 0)).toBe(legs.forward);
    expect(three.reduce((a, x) => a + x.codChargePaise, 0)).toBe(legs.cod);
  });

  it('splits the packing so the parts add back to one bag exactly', () => {
    expect(three.reduce((a, x) => a + x.packingPaise, 0)).toBe(pnlConfig.packingCostPerOrderPaise);
    // By value, so the Rs 650 order carries the smallest share of a cost that
    // was incurred once.
    expect(three[2].packingPaise).toBeLessThan(three[0].packingPaise);
  });

  it('still reconciles against the courier ledger', () => {
    expect(r.reconciliations.find((x) => x.key === 'courier').agree).toBe(true);
  });
});

describe("the adapter's CourierCharge invariants", () => {
  /*
   * The adapter folds Delhivery's surcharges (DPH, PEAK, FS, ROV) onto the leg
   * that moved the parcel outward, because CourierCharge has no field for them.
   * That makes forward + rto + dto + cod + gst === total_amount exactly, and
   * this engine has to hold to it or the statement stops tying to the ledger.
   */
  const exact = {
    awb: '59152210001315',
    source: 'computed',
    forwardPaise: 5392, // 52 DL + 1.92 DPH + 2 PEAK, the outward leg
    rtoPaise: 5200,
    dtoPaise: null,
    codChargePaise: 391,
    gstPaise: 1976,
    totalPaise: 12959,
    zone: 'D1',
    chargedWeightGrams: null,
    weightAssumed: true,
    variancePaise: null,
    flags: ['leg_not_final'],
  };

  it('holds the invariant: the legs plus GST are the total', () => {
    expect(exact.forwardPaise + exact.rtoPaise + exact.codChargePaise + exact.gstPaise).toBe(exact.totalPaise);
  });

  it('passes the legs straight through when input credit is claimed', () => {
    const legs = parcelLegs(exact, { ...pnlConfig, gstInputCreditClaimed: true });
    expect(legs).toEqual({ forward: 5392, rto: 5200, dto: 0, cod: 391, total: 10983 });
    expect(legs.total).toBe(exact.totalPaise - exact.gstPaise);
  });

  it('spreads the GST over the legs when it is not reclaimable, and still totals', () => {
    const legs = parcelLegs(exact, pnlConfig);
    expect(legs.forward + legs.rto + legs.dto + legs.cod).toBe(exact.totalPaise);
    expect(legs.total).toBe(exact.totalPaise);
  });

  it("carries the adapter's leg_not_final flag onto the row rather than swallowing it", () => {
    const r = buildReport(inputs({ charges: [exact] }));
    const d = r.rows.find((x) => x.order.name === '#1170');
    expect(d.outcome).toBe('RTO');
    expect(d.flags).toContain('59152210001315: leg_not_final');
    // A computed return leg is flagged, not withheld: it is the best number
    // there is, and the row says where it came from.
    expect(d.complete).toBe(true);
    expect(d.chargeSource).toBe('computed');
    expect(d.forwardFreightPaise + d.rtoFreightPaise + d.codChargePaise).toBe(exact.totalPaise);
  });

  it('reads RTO finality off ReturnedDate, because the state is always RTO_INITIATED', () => {
    // mapCourierStatus answers RTO_INITIATED for every RTO this account has
    // ever had: the status string is the bare word "RTO" at every stage.
    const returned = shipmentsFor('#1170')[0];
    expect(returned.state).toBe('RTO_INITIATED');
    expect(returned.returnedAt).toBeTruthy();
    expect(row('#1170').outcomeReason).toBe('Delhivery RTO, returned to origin');

    const moving = shipmentsFor('#1227')[0];
    expect(moving.state).toBe('RTO_INITIATED');
    expect(moving.returnedAt).toBeNull();
    expect(moving.reverseInTransit).toBe(true);
    expect(row('#1227').outcomeReason).toBe('Delhivery RTO in progress');
  });
});

describe('partial payment (COD King)', () => {
  it('earns the CURRENT TOTAL once Delhivery says delivered, not the net payment (#1197)', () => {
    const o = order('#1197');
    expect(o.financialStatus).toBe('PARTIALLY_PAID'); // still, after delivery
    expect(o.netPaymentPaise).toBe(6245);
    expect(o.currentTotalPaise).toBe(109900);
    const r = row('#1197');
    expect(r.outcome).toBe('DELIVERED');
    expect(r.grossSalePaise).toBe(109900);
    expect(r.outputGstPaise).toBe(5233);
  });

  it('costs COGS from current quantities only: the deposit line stands at 0', () => {
    const o = order('#1197');
    expect(o.lines.map((l) => [l.title, l.currentQuantity])).toEqual([
      ['Khili Dhoop', 0],
      ['Khili Dhoop', 1],
    ]);
    expect(row('#1197').cogsPaise).toBe(50000); // one unit, not two
    expect(row('#1197').missing).not.toContain('partial_payment_duplicate_lines');
    expect(row('#1224').cogsPaise).toBe(78000);
    expect(row('#1224').grossSalePaise).toBe(209900);
  });

  it('REFUSES the row when duplicate titles are both still live and there is a discount', () => {
    // The guard ported from finance/pnl.mjs. Nothing can tell which line is
    // real here, so the row is refused rather than halved or doubled.
    const o = order('#1197');
    const ambiguous = {
      ...o,
      name: '#9999',
      lines: o.lines.map((l) => ({ ...l, currentQuantity: 1 })),
    };
    const r = buildReport(inputs({ orders: [...OCT_ORDERS, ambiguous] }));
    const bad = r.rows.find((x) => x.order.name === '#9999');
    expect(bad.missing).toContain('partial_payment_duplicate_lines');
    expect(bad.complete).toBe(false);
  });
});

describe('edited orders', () => {
  it('reads current quantities, so a removed item costs nothing (#1182, #1196, #1214)', () => {
    for (const n of ['#1182', '#1196', '#1214']) {
      const o = order(n);
      // Shopify keeps the removed line forever at currentQuantity 0.
      expect(o.lines.filter((l) => l.currentQuantity === 0)).toHaveLength(1);
      const r = row(n);
      expect(r.outcome).toBe('DELIVERED');
      expect(r.grossSalePaise).toBe(o.currentTotalPaise);
      // One garment's cost, not two, and the duplicate-title guard stays quiet:
      // these are edits, not partial payments.
      expect(r.cogsPaise).toBe(o.lines.find((l) => l.currentQuantity > 0).unitCostPaise);
      expect(r.missing).not.toContain('partial_payment_duplicate_lines');
    }
  });
});

describe('a line with no variant or no unit cost', () => {
  it('blocks the row rather than costing the garment at zero (#1233 Dupatta)', () => {
    const d = order('#1233').lines.find((l) => l.title === 'Dupatta');
    expect(d.variantGid).toBeNull();
    expect(d.unitCostPaise).toBeNull();
    expect(notes('#1233').some((n) => /Dupatta.*Cost per item/.test(n))).toBe(true);
  });

  it('keeps #1174 Toran on the list even though the order was voided', () => {
    expect(order('#1174').lines[0].unitCostPaise).toBeNull();
    expect(notes('#1174').some((n) => /Toran/.test(n))).toBe(true);
  });

  it('leaves a delivered order with an unreadable cost out of the totals', () => {
    const broken = order('#1172');
    const r = buildReport(
      inputs({
        orders: OCT_ORDERS.map((o) =>
          o.name === '#1172' ? { ...o, lines: o.lines.map((l) => ({ ...l, unitCostPaise: null })) } : o,
        ),
        charges: [charge(broken.awbs[0], PREPAID_CHARGE)],
      }),
    );
    const d = r.rows.find((x) => x.order.name === '#1172');
    expect(d.missing).toContain('unit_cost');
    expect(d.complete).toBe(false);
    expect(d.cogsPaise).toBeNull();
    expect(r.totals.grossSalesPaise).toBe(0); // the only costed row is out
    expect(r.flags.some((f) => f.code === 'blocked_from_totals' && f.orderName === '#1172')).toBe(true);
  });
});

describe('fulfilled with no AWB', () => {
  it('names what is missing rather than guessing a freight cost (#1205)', () => {
    const r = row('#1205');
    expect(r.outcome).toBe('DELIVERED');
    expect(r.outcomeInferred).toBe(true);
    expect(r.missing).toEqual(expect.arrayContaining(['awb', 'freight']));
    expect(r.complete).toBe(false);
    expect(r.forwardFreightPaise).toBeNull();
    // It still went in a bag, so packing is charged.
    expect(r.packingPaise).toBe(1500);
  });

  it('still earns a parcel of packing on #1233, which was fulfilled with no AWB too', () => {
    expect(row('#1233').packingPaise).toBe(1500);
  });
});

// -------------------------------------------------------------- statement

describe('the P&L statement', () => {
  it('is in exactly the order section 7 fixes, with LOST added where it belongs', () => {
    expect(report.statement.map((s) => s.key)).toEqual([
      'grossSales',
      'refunds',
      'outputGst',
      'netRevenue',
      'cogs',
      'forwardFreight',
      'codCharges',
      'packing',
      'gatewayFees',
      'contributionBeforeRtoAndAds',
      'rtoForwardFreight',
      'rtoReturnFreight',
      'rtoPackingAndGateway',
      'advanceKeptOnRto',
      'rtoLoss',
      'cancelledShipmentCharges',
      'replacementShipments',
      'otherCourierCharges',
      'lostShipments',
      'contributionAfterRto',
      'metaSales',
      'metaBoost',
      'metaGst',
      'totalMeta',
      'profitBeforeFixedCosts',
      'fixedCosts',
      'netProfit',
    ]);
  });

  it('adds up', () => {
    const full = buildReport(
      inputs({
        charges: [
          charge(order('#1172').awbs[0], PREPAID_CHARGE),
          charge(order('#1170').awbs[0], RTO_COD_CHARGE),
        ],
      }),
    );
    const t = full.totals;
    expect(t.netRevenuePaise).toBe(t.grossSalesPaise - t.refundsPaise - t.outputGstPaise);
    expect(t.contributionBeforeRtoAndAdsPaise).toBe(
      t.netRevenuePaise - t.cogsPaise - t.forwardFreightPaise - t.codChargesPaise - t.packingPaise - t.gatewayFeesPaise,
    );
    expect(t.rtoLossPaise).toBe(
      t.rtoForwardFreightPaise +
        t.rtoReturnFreightPaise +
        t.rtoCodChargesPaise +
        t.rtoPackingAndGatewayPaise -
        t.advanceKeptOnRtoPaise,
    );
    expect(t.contributionAfterRtoPaise).toBe(
      t.contributionBeforeRtoAndAdsPaise -
        t.rtoLossPaise -
        t.cancelledShipmentChargesPaise -
        t.replacementShipmentsPaise -
        t.otherCourierChargesPaise -
        t.lostShipmentsPaise,
    );
    expect(t.totalMetaPaise).toBe(t.metaSalesPaise + t.metaBoostPaise + t.metaOtherPaise + t.metaGstPaise);
    expect(t.profitBeforeFixedCostsPaise).toBe(t.contributionAfterRtoPaise - t.totalMetaPaise);
    expect(t.netProfitPaise).toBe(t.profitBeforeFixedCostsPaise - t.fixedCostsPaise);
  });

  it('puts 18% GST on Meta on its own line while no input credit is claimed', () => {
    expect(pnlConfig.gstInputCreditClaimed).toBe(false);
    expect(report.totals.metaGstPaise).toBe(Math.round((3916121 * 18) / 100));
    expect(report.totals.totalMetaPaise).toBe(3916121 + report.totals.metaGstPaise);
  });

  it('says net profit is optimistic while no fixed costs are set', () => {
    expect(pnlConfig.fixedMonthlyCosts).toEqual([]);
    expect(report.totals.fixedCostsPaise).toBe(0);
    expect(report.totals.netProfitOptimistic).toBe(true);
    expect(report.flags.some((f) => f.code === 'fixed_costs_not_set')).toBe(true);
  });

  it('charges courier costs on an AWB with no settled order to Other courier charges', () => {
    const r = buildReport(inputs({ charges: [charge('59152299999999', DELIVERED_COD_CHARGE)] }));
    expect(r.totals.otherCourierChargesPaise).toBeGreaterThanOrEqual(11318);
    expect(r.flags.some((f) => f.code === 'other_courier_charge')).toBe(true);
  });

  it('runs a daily series over every day of the IST month, with a cumulative net', () => {
    expect(report.daily).toHaveLength(31);
    expect(report.daily[0].date).toBe('2026-10-01');
    expect(report.daily[30].date).toBe('2026-10-31');
    expect(report.daily.reduce((a, d) => a + d.ordersPlaced, 0)).toBe(71 - 9);
    const last = report.daily[30];
    expect(last.cumulativeNetPaise).toBe(report.daily.reduce((a, d) => a + d.netPaise, 0));
  });

  it('breaks down by payment type and by product', () => {
    const types = Object.fromEntries(report.byPaymentType.map((b) => [b.type, b]));
    expect(types.cod.orders + types.prepaid.orders + types.partial.orders).toBe(71 - 9);
    expect(types.partial.orders).toBe(4);
    expect(report.byProduct.every((p) => p.title)).toBe(true);
  });
});

// --------------------------------------------- the cases October did not have

describe('a lost parcel', () => {
  // October had none, so this is the one case built rather than observed.
  const lostAwb = order('#1172').awbs[0];
  const r = buildReport(
    inputs({
      shipments: OCT_SHIPMENTS.map((s) => (s.awb === lostAwb ? { ...s, state: 'LOST', rawStatus: 'Lost' } : s)),
      charges: [charge(lostAwb, PREPAID_CHARGE)],
    }),
  );
  const d = r.rows.find((x) => x.order.name === '#1172');

  it('expenses the garment as well as the freight, and asks for the claim', () => {
    expect(d.outcome).toBe('LOST');
    expect(d.cogsPaise).toBe(78000);
    expect(d.contributionPaise).toBe(-(78000 + 6136 + 1500 + 4954));
    expect(d.flags.some((f) => /claim pending/.test(f))).toBe(true);
    expect(r.totals.lostShipmentsPaise).toBe(78000 + 6136 + 1500 + 4954);
    expect(r.funnel.lost).toBe(1);
  });
});

describe('replacements', () => {
  const job = {
    orderName: '#1240',
    seq: 1,
    state: 'DONE',
    reason: 'wrong size sent',
    pays: 'us',
    forwardAwb: '59152288880001',
    returnAwb: '59152288880002',
    quoteForwardPaise: 9000,
    quoteReturnPaise: 9500,
    reimbursementReceived: false,
    createdAt: '2026-10-20T06:00:00Z',
  };

  it('costs both legs plus packing on the outgoing parcel', () => {
    const r = buildReport(inputs({ replacements: [job], charges: [charge(job.forwardAwb, PREPAID_CHARGE)] }));
    // The forward leg was billed, the return leg is still only a quote.
    expect(r.totals.replacementShipmentsPaise).toBe(6136 + 9500 + 1500);
    expect(r.flags.some((f) => /quoted, not billed/.test(f.note))).toBe(true);
  });

  it('does not cost a job we cancelled (October has only the test order)', () => {
    const r = buildReport(inputs({ replacements: [{ ...job, state: 'CANCELLED' }] }));
    expect(r.totals.replacementShipmentsPaise).toBe(0);
    expect(r.flags.some((f) => /is cancelled: not costed/.test(f.note))).toBe(true);
  });

  it('counts a reimbursement only when the money is recorded', () => {
    const paid = buildReport(inputs({ replacements: [{ ...job, pays: 'customer', reimbursementReceived: true }] }));
    const expected = buildReport(inputs({ replacements: [{ ...job, pays: 'customer' }] }));
    expect(paid.totals.replacementShipmentsPaise).toBeLessThan(expected.totals.replacementShipmentsPaise);
    expect(expected.flags.some((f) => /expected but not verified/.test(f.note))).toBe(true);
  });
});

describe('an excluded order that really shipped', () => {
  it('still charges its courier cost and its packing to Other courier charges', () => {
    const founder = order('#1199');
    const r = buildReport(
      inputs({
        orders: OCT_ORDERS.map((o) =>
          o.name === '#1199'
            ? { ...o, awbs: ['59152277770001'], fulfillments: [{ ...order('#1172').fulfillments[0], awb: '59152277770001' }] }
            : o,
        ),
        charges: [charge('59152277770001', DELIVERED_COD_CHARGE)],
      }),
    );
    expect(r.rows.find((x) => x.order.name === '#1199').outcome).toBe('EXCLUDED');
    expect(r.totals.otherCourierChargesPaise).toBe(11318 + pnlConfig.packingCostPerOrderPaise);
    expect(r.reconciliations.find((x) => x.key === 'courier').agree).toBe(true);
  });
});

describe('a parcel sent by another courier', () => {
  it('uses the hand-entered cost, says it is assumed, and still reconciles', () => {
    const awb = order('#1172').awbs[0];
    const r = buildReport(
      inputs({ config: { ...pnlConfig, manualCourierCostPaise: { [awb]: 14000 } } }),
    );
    const d = r.rows.find((x) => x.order.name === '#1172');
    expect(d.forwardFreightPaise).toBe(14000);
    expect(d.assumed).toContain('manual_courier_cost');
    expect(d.complete).toBe(true);
    expect(r.reconciliations.find((x) => x.key === 'courier').agree).toBe(true);
  });

  it('lets a real Delhivery charge win over the hand-entered one', () => {
    const awb = order('#1172').awbs[0];
    const r = buildReport(
      inputs({
        charges: [charge(awb, PREPAID_CHARGE)],
        config: { ...pnlConfig, manualCourierCostPaise: { [awb]: 14000 } },
      }),
    );
    expect(r.rows.find((x) => x.order.name === '#1172').forwardFreightPaise).toBe(6136);
  });
});

describe('trust', () => {
  it('warns when delivery plus packing drifts off the rule of thumb', () => {
    const r = buildReport(
      inputs({
        charges: [charge(order('#1172').awbs[0], PREPAID_CHARGE)],
        config: { ...pnlConfig, ruleOfThumbPrepaidPaise: 100 },
      }),
    );
    expect(r.flags.some((f) => f.code === 'rule_of_thumb_off' && /prepaid/.test(f.note))).toBe(true);
  });

  it('is provisional while anything is pending or blocked', () => {
    expect(report.provisional).toBe(true);
    expect(report.note).toMatch(/Offline sales not recorded in Shopify are not included/);
  });

  it('carries a source failure through to the flags rather than reading as a zero', () => {
    const r = buildReport(
      inputs({
        sourceStatus: { ...inputs().sourceStatus, meta: false, failures: ['Meta: insights call failed (rate limit)'] },
      }),
    );
    expect(r.flags.some((f) => f.code === 'source_failed')).toBe(true);
    expect(r.sourceStatus.meta).toBe(false);
  });
});

describe('the settlement cut', () => {
  /*
   * The cohort is orders PLACED in the month, which is the specification. The
   * consequence is that a parcel posted on 29 October is delivered in November
   * and its revenue still lands here, and that is the first thing an accountant
   * asks about. These are the numbers that answer it, as data rather than
   * prose, so the workbook can place them next to the statement.
   */
  const costed = buildReport(
    inputs({ charges: [...new Set(OCT_ORDERS.flatMap((o) => o.awbs))].map((a) => charge(a, DELIVERED_COD_CHARGE)) }),
  );

  it('states the basis, and that it is not orders delivered in the month', () => {
    expect(report.settlement.cohortBasis).toBe('orders placed in the month (IST), not orders delivered in it');
    expect(report.settlement.monthEndUtc).toBe('2026-10-31T18:30:00Z');
  });

  it('counts the delivered orders that settled after the month closed', () => {
    // Frozen at the 2026-11-03 pull: #1230 on 11-01, #1232 on 11-02, #1224 on
    // 11-03. A later pull moves more orders into this list, which is the point.
    expect(report.settlement.deliveredAfterMonthEnd).toBe(3);
    expect(report.settlement.deliveredTotal).toBe(34);
    expect(report.settlement.orders.map((o) => o.name)).toEqual(['#1230', '#1232', '#1224']);
    expect(report.settlement.orders.every((o) => o.deliveredAt > '2026-10-31T18:30:00Z')).toBe(true);
  });

  it('carries the net revenue that settled late, tied to the statement', () => {
    expect(costed.settlement.deliveredAfterMonthEndCounted).toBe(3);
    const fromRows = costed.settlement.orders.reduce((a, o) => a + o.netRevenuePaise, 0);
    expect(costed.settlement.netRevenueAfterMonthEndPaise).toBe(fromRows);
    expect(costed.settlement.netRevenueAfterMonthEndPct).toBeCloseTo(
      (fromRows / costed.totals.netRevenuePaise) * 100,
      6,
    );
  });

  it('only counts money that is actually in the statement', () => {
    // With no charges every delivered row is blocked, so there is no late
    // revenue to disclose and the share is null rather than a stray 0%.
    expect(report.settlement.deliveredAfterMonthEndCounted).toBe(0);
    expect(report.settlement.netRevenueAfterMonthEndPaise).toBe(0);
    expect(report.settlement.netRevenueAfterMonthEndPct).toBeNull();
  });

  it('names the RTO parcels that have not reached us and the ones that turned around late', () => {
    expect(report.settlement.rtoLegsNotFinalOrders).toEqual(['#1208', '#1209', '#1220', '#1225', '#1227']);
    expect(report.settlement.rtoLegsNotFinal).toBe(5);
    expect(report.settlement.rtoStartedAfterMonthEndOrders).toEqual(['#1220', '#1227']);
  });

  it('writes one sentence from those numbers, always shown', () => {
    expect(costed.settlement.note).toMatch(/orders PLACED in it \(IST\)/);
    expect(costed.settlement.note).toMatch(/3 of 34 delivered orders were delivered after the month closed/);
    expect(costed.settlement.note).toMatch(/of net revenue/);
    expect(costed.settlement.note).toMatch(/5 RTO parcels have not reached us yet/);
  });
});

describe('istWallToUtc', () => {
  it("reads an offsetless Delhivery stamp as IST, not as the machine's clock", () => {
    // The trap: Date.parse on an offsetless stamp uses LOCAL time, so on a
    // Lambda running UTC this delivery would land 5.5 hours early.
    expect(istWallToUtc('2026-11-01T10:30:00.000')).toBe('2026-11-01T05:00:00.000Z');
    // 31 Oct 23:00 IST is 17:30Z, still inside October, and must not be read
    // as 23:00Z, which would push it into November.
    expect(istWallToUtc('2026-10-31T23:00:00')).toBe('2026-10-31T17:30:00.000Z');
  });

  it('leaves a Shopify stamp alone, because it already carries Z', () => {
    expect(istWallToUtc('2026-10-08T06:50:57Z')).toBe('2026-10-08T06:50:57.000Z');
  });

  it('is null for nothing and for nonsense', () => {
    expect(istWallToUtc(null)).toBeNull();
    expect(istWallToUtc('not a date')).toBeNull();
  });

  it('puts #1230 in November however the machine clock is set', () => {
    const delivered = shipmentsFor('#1230')[0];
    expect(delivered.deliveredAt).toBe('2026-11-01T12:32:01.002');
    expect(istWallToUtc(delivered.deliveredAt) > '2026-10-31T18:30:00Z').toBe(true);
  });
});

// ------------------------------------------------------------ assumptions

describe('assumptions', () => {
  const rows = assumptionRows(pnlConfig);
  const by = (k) => rows.find((r) => r.key === k);

  it('labels the gateway rate ASSUMED, the slabs VERIFIED and the policy values CONFIG', () => {
    expect(by('gatewayFeePct').source).toBe('ASSUMED');
    expect(by('assumedWeightGrams').source).toBe('ASSUMED');
    expect(by('gstSlabs').source).toBe('VERIFIED');
    expect(by('metaGstPct').source).toBe('VERIFIED');
    expect(by('originPin').source).toBe('CONFIG');
    expect(by('packingCostPerOrder').source).toBe('CONFIG');
  });

  it('gives every value a note, and the report carries them all', () => {
    expect(rows.every((r) => r.note.length > 20)).toBe(true);
    expect(report.assumptions).toHaveLength(rows.length);
  });

  it('shows empty fixed costs as "not set"', () => {
    expect(by('fixedMonthlyCosts').value).toBe('not set');
  });

  it('converts RULES.pnl rupees into paise and makes the top slab open-ended', () => {
    const c = toPnlConfig();
    expect(c.packingCostPerOrderPaise).toBe(1500);
    expect(c.gstSlabs).toEqual([
      { ratePct: 5, upToPaise: 262500 },
      { ratePct: 18, upToPaise: Infinity },
    ]);
    expect(c.ruleOfThumbCodPaise).toBe(17000);
  });
});
