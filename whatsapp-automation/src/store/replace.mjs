/*
 * replace.mjs — /replace rows.
 *
 *   REPL#<orderId>  / REQ#<seq>   the request, one per command
 *   REPL#<orderId>  / LOCK        the one-execution-at-a-time lease
 *   REPL#<orderId>  / REPLOPEN    a pointer, so `list` is one scanBySk
 *   REPLAWB#<awb>   / MAP         { orderId, seq, leg }
 *
 * THREE THINGS HERE ARE LOAD-BEARING.
 *
 * 1. A REPLAWB row carries NO `activeShipment` attribute, and that is the whole
 *    reason it exists instead of setAwbMap. `activeShipment` is what puts a row
 *    into GSI1, which is what the poller tracks, and onDelhivery routes any
 *    terminal event on a mapped AWB into the ORIGINAL order's flows. A
 *    replacement AWB in there would mean the reverse pickup reaching RTO fires
 *    Flow C's RTO flow on an order that was never returned (tagging it, asking
 *    the customer why, counting it toward their COD block) and the new parcel
 *    reaching DELIVERED asks the same customer for a second review. See
 *    DECISIONS.md T2.
 *
 * 2. The sort keys are REQ#/LOCK/REPLOPEN, never STATE and never REC.
 *    reconcile's scanStates() hands every SK=STATE row to flowB as an order id
 *    read out of the PK, and the digest scans every SK=REC row as a cart.
 *
 * 3. `expiresAt` is the table's TTL attribute and holds the 400 day retention,
 *    nothing else. The preview deadline lives in `confirmBy`: putting it in
 *    expiresAt would have DynamoDB delete the whole record the moment the
 *    preview went stale, taking the only record of what was promised with it.
 */
import { table, VersionConflict } from './table.mjs';
import { RULES } from '../../messages/rules.mjs';

const pk = (orderId) => `REPL#${orderId}`;
const awbPk = (awb) => `REPLAWB#${awb}`;
const sk = (seq) => `REQ#${seq}`;

/**
 * A replacement record outlives stateRetentionDays (180) on purpose: a return
 * that never reaches the warehouse becomes a dispute months later and this row
 * is the only record of what was promised.
 */
const ttl = (now = new Date()) => Math.floor(now.getTime() / 1000) + RULES.replace.recordTtlDays * 86400;

/**
 * The states that end a request. The REPLOPEN pointer is dropped on these, so
 * `list` shows exactly what still needs a human: a live preview, a half-booked
 * execution, or a FAILED one waiting for /replace retry. FAILED is deliberately
 * NOT here, because it is resumable and it is the one the owner must see.
 */
export const TERMINAL = new Set(['DONE', 'REJECTED', 'EXPIRED', 'CANCELLED']);

export const getRequest = (orderId, seq) => table.get(pk(orderId), sk(seq));

/**
 * Every REQ row for this order, oldest first.
 *
 * The `r.PK === p` filter is not redundant. The memory backend joins PK and SK
 * with an EMPTY separator and matches a query by string prefix, so a query for
 * REPL#123 also matches REPL#1234's rows. The AWS backend conditions on
 * PK = :pk exactly, so without this line the two backends disagree and only
 * the one nobody tests against is right.
 */
async function allRequests(orderId) {
  const p = pk(orderId);
  const rows = await table.query(p);
  return rows
    .filter((r) => r.PK === p && String(r.SK || '').startsWith('REQ#'))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
}

/*
 * The states in which a request has actually consumed stock from a line.
 *
 * CONFIRMED and everything after it has at least a reverse pickup booked, and
 * FAILED usually holds exactly that, so all of them count. AWAITING_CONFIRMATION
 * has booked nothing (the owner may never tap Confirm) and the three cancelled
 * states have given it back, so none of those do.
 */
const CONSUMED = new Set(['CONFIRMED', 'RETURN_CREATED', 'FORWARD_CREATED', 'CUSTOMER_NOTIFIED', 'DONE', 'FAILED']);

/**
 * How much of each line this order has already had replaced, by line id.
 *
 * Derived from the request rows rather than counted into a field somewhere,
 * because a running total is a second source of truth that drifts the first
 * time a write half-fails. This is what stops `again` from replacing a
 * two-piece order three times: without it the quantity cap in validate() reads
 * a number nobody maintains and can never fire.
 */
export async function replacedByLine(orderId) {
  const out = {};
  for (const r of await allRequests(orderId)) {
    if (!CONSUMED.has(String(r.state || ''))) continue;
    for (const [lineId, qty] of Object.entries(r.replacedQty || {})) {
      out[lineId] = (out[lineId] || 0) + Number(qty || 0);
    }
  }
  return out;
}

/** The newest request for this order, or null. */
export async function latestRequest(orderId) {
  const rows = await allRequests(orderId);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Write a new request and its open-pointer. Returns the stored row.
 *
 * The sequence is "one past the newest", which makes every older preview
 * superseded by arithmetic rather than by a flag anybody has to remember to
 * clear. Two commands racing for the same seq cannot both land: putNew
 * conditions on absence, and the caller holds the execution lease anyway.
 */
export async function createRequest(orderId, data, now = new Date()) {
  const prev = await latestRequest(orderId);
  const seq = (Number(prev?.seq) || 0) + 1;
  const created = await table.putNew({
    PK: pk(orderId),
    SK: sk(seq),
    orderId: String(orderId),
    seq,
    version: 0,
    state: 'AWAITING_CONFIRMATION',
    createdAt: now.toISOString(),
    expiresAt: ttl(now),
    ...data,
  });
  if (!created) throw new Error(`replace: request ${orderId}/${seq} already exists`);
  await table.put({
    PK: pk(orderId),
    SK: 'REPLOPEN',
    orderId: String(orderId),
    seq,
    at: now.toISOString(),
    expiresAt: ttl(now),
  });
  return getRequest(orderId, seq);
}

/** Merge fields into a request. Retries once on a version conflict. */
export async function patchRequest(orderId, seq, fields) {
  let row;
  try {
    row = await table.update(pk(orderId), sk(seq), fields);
  } catch (e) {
    if (!(e instanceof VersionConflict)) throw e;
    row = await table.update(pk(orderId), sk(seq), fields);
  }
  // The pointer goes when the request ends, so `list` never shows finished work.
  // Keyed on the row's own state rather than on `fields`, so a patch that only
  // touches a timestamp cannot resurrect a closed request.
  if (TERMINAL.has(String(row?.state || ''))) await table.del(pk(orderId), 'REPLOPEN');
  return row;
}

/**
 * The requests that are still open, newest first.
 *
 * One scan of the pointer rows, then one read each. The pointer deliberately
 * carries only the keys: two copies of the state is two things to keep in step,
 * and this runs a handful of times a week.
 */
export async function listOpen(limit = 10) {
  const ptrs = await table.scanBySk('REPLOPEN');
  const rows = [];
  for (const p of ptrs.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)) {
    const r = await getRequest(p.orderId, p.seq);
    if (r) rows.push(r);
  }
  return rows;
}

/**
 * Take the one-execution-per-order lease, or report that somebody holds it.
 *
 * putIfFree, not putNew: the lease has to expire on its own, because a worker
 * killed mid-execution cannot release it and an order stuck behind a dead lock
 * would refuse /replace retry forever.
 */
export function acquireLock(orderId, { until, now = new Date(), by = '' }) {
  return table.putIfFree(
    {
      PK: pk(orderId),
      SK: 'LOCK',
      orderId: String(orderId),
      lockUntil: until.toISOString(),
      lockedAt: now.toISOString(),
      by,
      expiresAt: ttl(now),
    },
    'lockUntil',
    now.toISOString(),
  );
}

export const releaseLock = (orderId) => table.del(pk(orderId), 'LOCK');

/**
 * Map a replacement waybill back to its request.
 *
 * No `activeShipment`: see the note at the top of this file. The poller cannot
 * see this row and getAwbMap cannot find it, which is the point.
 */
export const setReplAwb = (awb, data, now = new Date()) =>
  table.put({ PK: awbPk(awb), SK: 'MAP', awb: String(awb), ...data, expiresAt: ttl(now) });

export const getReplAwb = (awb) => table.get(awbPk(awb), 'MAP');
