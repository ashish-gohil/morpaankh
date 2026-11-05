/*
 * run.mjs — one month, end to end: gather, compute, render, store, deliver.
 *
 * The only place that knows the order of operations. Everything it calls is
 * either a pure function (the engine, the workbook) or an adapter that talks to
 * exactly one provider, so this file is the whole of the orchestration and none
 * of the logic.
 *
 * TWO RULES SHAPE IT:
 *
 * 1. A SOURCE THAT FAILS IS NOT A ZERO. Every gather step is caught on its own
 *    and recorded in sourceStatus. The workbook still builds, it carries an
 *    INCOMPLETE banner, and the summary says so. The alternative, a report that
 *    quietly says the month made no sales because Shopify timed out, is the
 *    failure this whole design exists to avoid.
 * 2. ONE RUN PER MONTH AT A TIME. A lock row, not reserved concurrency: two
 *    triggers a second apart would both pass a concurrency check, and the
 *    expensive half of a double run is two documents in the owner's chat.
 */
import { config } from '../config.mjs';
import { log, metric } from '../log.mjs';
import { randomToken } from '../lib/ids.mjs';
import { istParts, fromISTWall } from '../lib/time.mjs';
import { toPaise } from '../lib/money.mjs';
import { RULES } from '../../messages/rules.mjs';
import { table } from '../store/table.mjs';
import { pnlConfig } from '../domain/pnl/config.mjs';
import { monthWindow } from '../domain/pnl/cohort.mjs';
import { buildReport } from '../domain/pnl/engine.mjs';
import { buildWorkbook } from './workbook.mjs';
import { putSnapshot, putReport, getSnapshot, getLatestInput } from './snapshot.mjs';
import { fetchOrders } from './sources/shopify.mjs';
import { fetchShipments, fetchCharges } from './sources/delhivery.mjs';
import { fetchMetaSpend } from './sources/meta.mjs';
import { fetchGatewayFees } from './sources/gateway.mjs';
import { fetchReplacements } from './sources/replacements.mjs';
import { parseLedger } from './sources/ledger.mjs';
import { deliver, adminPhones } from './deliver.mjs';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ABBR = MONTHS.map((m) => m.slice(0, 3).toLowerCase());

/** '2026-10' -> 'October 2026'. */
export function monthLabel(month) {
  const [y, m] = String(month).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** The IST calendar month before the one `now` falls in. */
export function previousMonth(now = new Date()) {
  const p = istParts(now);
  const y = p.mon === 0 ? p.y - 1 : p.y;
  const mon = p.mon === 0 ? 11 : p.mon - 1;
  return `${y}-${String(mon + 1).padStart(2, '0')}`;
}

/** The IST calendar month `now` falls in. */
export function currentMonth(now = new Date()) {
  const p = istParts(now);
  return `${p.y}-${String(p.mon + 1).padStart(2, '0')}`;
}

/**
 * What the owner typed after /pnl, as a month.
 *
 * Never throws: a command that cannot be read comes back as `{error}` and the
 * caller replies with the usage line, which is how every other owner command in
 * this service behaves.
 *
 * @param {string} args
 * @param {Date} [now]
 * @returns {{month: string, mtd: boolean} | {error: string}}
 */
export function parseMonthArg(args, now = new Date()) {
  const raw = String(args || '').trim().toLowerCase();
  if (!raw) return { month: previousMonth(now), mtd: false };
  if (raw === 'mtd') return { month: currentMonth(now), mtd: true };

  // 2026-10 or 2026/10
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})$/);
  if (iso) {
    const m = Number(iso[2]);
    if (m < 1 || m > 12) return { error: `there is no month ${iso[2]}` };
    return { month: `${iso[1]}-${String(m).padStart(2, '0')}`, mtd: false };
  }

  // oct | october | oct 2026 | october 2026
  const named = raw.match(/^([a-z]{3,9})(?:\s+(\d{4}))?$/);
  if (named) {
    const i = ABBR.indexOf(named[1].slice(0, 3));
    if (i === -1) return { error: `"${named[1]}" is not a month` };
    const p = istParts(now);
    /*
     * A bare month name means the most recent one that has already happened.
     * Typing "oct" in November means last month, not ten months away; typing
     * "dec" in November means last December, not one that has not finished.
     */
    const year = named[2] ? Number(named[2]) : i > p.mon ? p.y - 1 : p.y;
    return { month: `${year}-${String(i + 1).padStart(2, '0')}`, mtd: false };
  }
  return { error: `could not read "${raw}" as a month` };
}

/** `Morpaankh-PnL-2026-10-provisional.xlsx` */
export function reportFilename(month, provisional) {
  return `Morpaankh-PnL-${month}-${provisional ? 'provisional' : 'final'}.xlsx`;
}

/**
 * Fold the owner's ledger over the computed charges.
 *
 * The ledger is the only exact source of courier cost: Delhivery returns no
 * scanned weight by any API, so a computed charge is an estimate at an assumed
 * weight. Where both exist the ledger wins and the difference is kept, because
 * a persistent gap is how a weight dispute shows up.
 *
 * @param {any[]} charges computed
 * @param {{rows: any[]}} ledger parsed
 */
export function mergeLedger(charges, ledger) {
  if (!ledger?.rows?.length) return { charges, applied: 0 };
  const byAwb = new Map();
  for (const r of ledger.rows) {
    if (!r.awb) continue;
    const prev = byAwb.get(r.awb) || 0;
    byAwb.set(r.awb, prev + toPaise(r.chargeInr));
  }
  let applied = 0;
  const out = charges.map((c) => {
    if (!byAwb.has(c.awb)) return c;
    applied += 1;
    const actual = byAwb.get(c.awb);
    const computed = c.totalPaise;
    return {
      ...c,
      source: /** @type {const} */ ('ledger'),
      totalPaise: actual,
      variancePaise: computed == null ? null : actual - computed,
      // The ledger gives one netted figure per AWB, not a per-head breakdown,
      // so the legs keep their computed SHAPE and the total becomes exact. The
      // variance is what says how far the shape is off.
      flags: [...(c.flags || []), 'total from ledger, legs computed'],
    };
  });
  return { charges: out, applied };
}

/**
 * Run one month.
 *
 * @param {{month: string, trigger: string, clients: any, now?: Date,
 *          send?: boolean, ledgerBuffer?: Uint8Array|null, ledgerName?: string,
 *          phones?: string[], emails?: string[], lock?: boolean}} args
 */
export async function runPnl({
  month,
  trigger = 'cli',
  clients,
  now = new Date(),
  send = true,
  ledgerBuffer = null,
  ledgerName = '',
  phones,
  emails,
  lock = true,
}) {
  const runId = `${month}-${randomToken(6)}`;
  const { monthStartUtc, monthEndUtc } = monthWindow(month);
  const cfg = pnlConfig;

  if (lock && !(await acquireMonth(month, now))) {
    log.info('pnl: a run for this month is already in flight', { month, trigger });
    return { skipped: 'already-running', month };
  }

  /** @type {any} */
  const status = {
    shopify: false,
    delhiveryTracking: false,
    delhiveryCharges: false,
    meta: false,
    gateway: false,
    courierChargeBasis: 'computed',
    failures: [],
  };
  /** A source that throws is named, not swallowed and not turned into a zero. */
  const step = async (name, key, fn, fallback) => {
    try {
      const v = await fn();
      status[key] = true;
      return v;
    } catch (e) {
      const msg = /** @type {any} */ (e)?.message || String(e);
      status.failures.push(`${name}: ${msg}`.slice(0, 300));
      log.error('pnl source failed', { source: name, month, err: msg.slice(0, 200) });
      return fallback;
    }
  };

  try {
    const orders = await step('Shopify orders', 'shopify', () =>
      fetchOrders({ monthStartUtc, monthEndUtc, clients }), []);

    const awbs = [...new Set(orders.flatMap((o) => o.awbs))];
    const shipments = await step('Delhivery tracking', 'delhiveryTracking', () =>
      fetchShipments(awbs, { clients }), []);

    let charges = await step('Delhivery charges', 'delhiveryCharges', () =>
      fetchCharges({ shipments, orders, config: cfg }), []);

    /*
     * The ledger, if the owner has sent one. It only ever makes the numbers
     * more exact, so a parse failure degrades to computed rather than failing.
     *
     * A buffer passed in wins, then whatever is sitting in S3 for this month:
     * that is what makes a plain `/pnl 2026-10` pick up a statement uploaded
     * days earlier without the owner having to mention it.
     */
    let ledgerApplied = 0;
    if (!ledgerBuffer) {
      const stored = await getLatestInput(month).catch(() => null);
      if (stored) {
        ledgerBuffer = stored.bytes;
        ledgerName = stored.filename;
      }
    }
    if (ledgerBuffer) {
      const parsed = await step('Delhivery ledger', 'delhiveryCharges', async () =>
        parseLedger(ledgerBuffer, ledgerName), null);
      if (parsed) {
        const merged = mergeLedger(charges, parsed);
        charges = merged.charges;
        ledgerApplied = merged.applied;
        for (const w of parsed.warnings || []) status.failures.push(`ledger: ${w}`.slice(0, 300));
      }
    }
    if (ledgerApplied > 0) status.courierChargeBasis = 'ledger';

    const meta = await step('Meta insights', 'meta', () =>
      fetchMetaSpend({ month, config: cfg }), []);
    const gateway = await step('Gateway fees', 'gateway', () =>
      fetchGatewayFees({ orders, config: cfg }), []);
    // Passing orders makes this one exact query per order instead of a scan.
    const replacements = await step('Replacements', 'gateway', () =>
      fetchReplacements({ monthStartUtc, monthEndUtc, orders }), []);

    const previousSnapshot = await getSnapshot(previousMonth(fromISTWall(
      Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 2, 12, 0,
    ))).catch(() => null);

    const inputs = {
      month,
      monthStartUtc,
      monthEndUtc,
      generatedAt: now.toISOString(),
      trigger,
      orders,
      shipments,
      charges,
      meta,
      gateway,
      replacements,
      config: cfg,
      sourceStatus: status,
      previousSnapshot,
    };

    const report = buildReport(inputs);
    const incomplete = status.failures.length > 0;
    const provisional = report.provisional !== false;
    const p = istParts(now);
    const wbMeta = {
      month,
      monthLabel: monthLabel(month),
      provisional,
      generatedAtIST: `${String(p.day).padStart(2, '0')} ${MONTHS[p.mon].slice(0, 3)} ${p.y}, ${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`,
      trigger,
      courierChargeBasis:
        status.courierChargeBasis === 'ledger'
          ? 'Delhivery ledger (exact)'
          : 'computed from Delhivery rates and an assumed weight. Upload the ledger to lock actuals.',
      incomplete,
      adminOrderUrlBase: `https://admin.shopify.com/store/${String(config.shopDomain).split('.')[0]}/orders/`,
    };

    /*
     * `inputs` is handed over alongside the report because a Report carries no
     * charges, shipments or replacements: those are PnlInputs. Without it the
     * Courier Ledger and Replacements sheets render "none this month" on a
     * month that plainly had parcels, and the per-order Delhivery status
     * columns quietly fall back to Shopify, which is the one source this whole
     * report exists not to trust.
     */
    const bytes = await buildWorkbook({ ...report, inputs }, wbMeta);
    const filename = reportFilename(month, provisional);

    const soften = (e) => ({ skipped: /** @type {any} */ (e)?.message?.slice(0, 120) || 'failed' });
    /*
     * The workbook goes up before it goes out. If delivery fails, or the owner
     * deletes the chat, the bucket is the copy that survives, and the snapshot
     * index row records its key either way.
     */
    const storedReport = await putReport({ month, runId, bytes }).catch(soften);
    const stored = await putSnapshot({ month, runId, inputs, totals: report.totals, now }).catch(soften);

    let delivered = null;
    if (send) {
      delivered = await deliver({ report, meta: wbMeta, bytes, filename, clients, phones, emails });
    }

    metric('PnlBuilt', 1, { month });
    log.info('pnl built', {
      month,
      trigger,
      runId,
      orders: orders.length,
      delivered: report.funnel.delivered,
      rto: report.funnel.rto,
      pending: report.funnel.pending,
      incomplete,
      ledgerApplied,
      sent: Boolean(send),
    });

    return { month, runId, report, bytes, filename, wbMeta, stored, storedReport, delivered, incomplete, status };
  } finally {
    if (lock) await releaseMonth(month).catch(() => {});
  }
}

/* ------------------------------------------------------------------ the lock */

/*
 * SK is 'LOCK', matching /replace's lease. Deliberately NOT 'STATE' (reconcile
 * hands every SK=STATE row to flowB as an order id), not 'REC' (the digest
 * reads those as carts) and not 'SUB'. And no activeShipment attribute: that is
 * what puts a row into GSI1 and makes the courier poller start tracking it.
 */
const lockPk = (month) => `PNL#${month}`;

async function acquireMonth(month, now) {
  const until = new Date(now.getTime() + RULES.pnl.lockMinutes * 60000).toISOString();
  return table.putIfFree(
    {
      PK: lockPk(month),
      SK: 'LOCK',
      month,
      lockUntil: until,
      lockedAt: now.toISOString(),
      // Retention only, never a business deadline.
      expiresAt: Math.floor(now.getTime() / 1000) + RULES.pnl.snapshotTtlDays * 86400,
    },
    'lockUntil',
    now.toISOString(),
  );
}

async function releaseMonth(month) {
  await table.del(lockPk(month), 'LOCK');
}

export { adminPhones };
