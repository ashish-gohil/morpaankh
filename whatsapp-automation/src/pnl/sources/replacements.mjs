/*
 * pnl/sources/replacements.mjs — the month's /replace jobs.
 *
 * A replacement costs two parcels and earns nothing, so it is the one thing on
 * the report that is pure loss, and whether the customer paid for it is the
 * difference between a cost and a write-off.
 *
 * REIMBURSEMENT IS FALSE UNTIL THE MONEY IS RECORDED. `pays: 'customer'` is a
 * DECISION the owner made at preview time, not a receipt: the /replace flow
 * books both legs and tells the customer, and nothing in it ever confirms the
 * courier fee came back. So this reports what was promised and what was
 * recorded as two different things, and the sheet says "expected, not
 * verified" for the gap. Treating the promise as income would book money that
 * may never have arrived, every month, invisibly.
 *
 * Read via the key shapes in src/store/replace.mjs. Nothing is written and no
 * row is touched: a P&L must never be able to disturb a live replacement.
 */
import { table } from '../../store/table.mjs';
import { log } from '../../log.mjs';
import { toPaise } from '../../lib/money.mjs';

/** Where the seq scan stops when there is no order list to key off. */
const MAX_SEQ = 10;

const paiseOrNull = (v) => (v == null || v === '' ? null : toPaise(v));

/**
 * One REPL#/REQ# row -> ReplacementJob.
 * @returns {import('../../domain/pnl/types.mjs').ReplacementJob}
 */
export function normaliseJob(r) {
  const pays = r.pays === 'us' || r.pays === 'customer' ? r.pays : null;
  return {
    orderName: String(r.orderName || ''),
    seq: Number(r.seq) || 0,
    state: String(r.state || ''),
    reason: r.reason || null,
    pays: /** @type {'us'|'customer'|null} */ (pays),
    forwardAwb: r.forwardAwb ? String(r.forwardAwb) : null,
    returnAwb: r.returnAwb ? String(r.returnAwb) : null,
    quoteForwardPaise: paiseOrNull(r.quoteForwardInr),
    quoteReturnPaise: paiseOrNull(r.quoteReturnInr),
    /*
     * The field a future "the customer paid the return fee" step would write.
     * Nothing writes it today, so this is false on every row, which is the
     * truthful answer and not a placeholder: the money has not been recorded.
     */
    reimbursementReceived: Boolean(r.reimbursementReceived || r.reimbursedAt || r.reimbursementPaise),
    createdAt: String(r.createdAt || ''),
  };
}

/**
 * Every replacement request created inside the month.
 *
 * `orders` is optional and is the cheap path: a REQ row's PK is REPL#<orderId>,
 * so with the month's orders in hand this is one exact query each and no table
 * scan at all. Without them it falls back to scanning the REQ#<n> sort keys,
 * because the table offers no prefix scan and SK has the sequence number baked
 * into it. MAX_SEQ bounds that; a warning fires if the last one scanned was
 * not empty, since that is the only sign there could be more.
 *
 * @param {{monthStartUtc: string, monthEndUtc: string,
 *          orders?: import('../../domain/pnl/types.mjs').NormOrder[]|null, maxSeq?: number}} args
 * @returns {Promise<import('../../domain/pnl/types.mjs').ReplacementJob[]>}
 */
export async function fetchReplacements({ monthStartUtc, monthEndUtc, orders = null, maxSeq = MAX_SEQ }) {
  /** @type {any[]} */
  let rows = [];
  if (orders?.length) {
    for (const o of orders) {
      const pk = `REPL#${o.numericId}`;
      // PK equality as well as the query: the memory backend matches a query by
      // string prefix, so REPL#122 would otherwise pull in REPL#1220's rows.
      rows.push(...(await table.query(pk)).filter((r) => r.PK === pk));
    }
  } else {
    /*
     * ONE QUERY, not one full-table scan per sequence number.
     *
     * This ran scanBySk('REQ#1'), scanBySk('REQ#2'), ... up to maxSeq, and
     * every one of those is billed for the whole table. It also meant a
     * replacement past maxSeq was invisible, which is what the warning below
     * was for; a query by kind has no such ceiling and the warning goes with it.
     *
     * The scan fallback covers the window between the deploy that adds GSI2 and
     * the backfill. Delete it, and maxSeq with it, once backfill-kind.mjs has
     * run --live.
     */
    const mine = (rs) => rs.filter((r) => String(r.PK || '').startsWith('REPL#'));
    const queried = mine(await table.queryKind('replreq'));
    if (queried.length) {
      rows.push(...queried);
    } else {
      for (let seq = 1; seq <= maxSeq; seq += 1) {
        const page = await table.scanBySk(`REQ#${seq}`);
        rows.push(...mine(page));
        if (seq === maxSeq && page.length) {
          log.warn('pnl replacements: an order has more replacements than the scan reaches', { maxSeq });
        }
      }
      if (rows.length) {
        log.warn('pnl replacements: GSI2 is empty but rows exist, run scripts/backfill-kind.mjs --live', { found: rows.length });
      }
    }
  }

  const from = new Date(monthStartUtc).getTime();
  const to = new Date(monthEndUtc).getTime();
  const jobs = rows
    .filter((r) => String(r.SK || '').startsWith('REQ#'))
    .filter((r) => {
      const t = new Date(r.createdAt).getTime();
      return Number.isFinite(t) && t >= from && t < to;
    })
    .map(normaliseJob)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  log.info('pnl replacements: read', {
    jobs: jobs.length,
    via: orders?.length ? 'per-order query' : 'seq scan',
    reimbursed: jobs.filter((j) => j.reimbursementReceived).length,
  });
  return jobs;
}
