/*
 * pnl/snapshot.mjs — what the report said at the time.
 *
 * TWO JOBS. Next month's report shows a RESTATED block for the month before it
 * (parcels that were in transit have landed, an RTO has come back, a ledger has
 * arrived), and that block is only possible if last month's totals were kept.
 * The other job is the question "what did the report say when you sent it to
 * the accountant", which cannot be answered by re-running it.
 *
 * THE SNAPSHOT HOLDS TOTALS, NOT ORDERS. Every NormOrder carries a customer's
 * display name, their city and their pin, and a snapshot is a JSON object
 * sitting in a bucket for 400 days. The restated block needs totals and the
 * source status; it does not need to know who bought what, so the inputs are
 * stored as a digest of their shape and the personal data never leaves the
 * invocation.
 *
 * THE AWS SDK MAY GENUINELY NOT BE THERE. iac builds the Lambda asset with
 * `exclude: ['node_modules']`, so a function gets only what the NODEJS_24_X
 * runtime ships; @aws-sdk/client-s3 is a devDependency for tests and the type
 * checker. So the import is dynamic, inside try/catch, and a deploy without it
 * degrades to `{ skipped: 's3-unavailable' }` rather than killing the cold
 * start. Same shape as clients/email.mjs.
 *
 * ONE THING IS STILL MISSING AND IT IS NOT MINE TO ADD: @aws-sdk/client-s3 is
 * not in package.json. clients/email.mjs carries @aws-sdk/client-sesv2 as a
 * devDependency precisely so the tests and `npm run typecheck` can see it, and
 * this needs the same entry. Without it the dynamic import still degrades
 * correctly at runtime, but tsc cannot resolve the module, so adding src/pnl to
 * the jsconfig include set before that dependency exists will fail the gate.
 *
 * THE INDEX ROW CARRIES NO `activeShipment`. That attribute is GSI1's hash key,
 * which is what the poller tracks, so a PNL# row holding one would put a month
 * into the courier poller's queue. The sort key avoids STATE, REC, SUB and
 * REPLOPEN too: reconcile hands every SK=STATE row to flowB as an order id, the
 * digest reads every SK=REC row as a cart, and Flow W scans SUB.
 */
import { config } from '../config.mjs';
import { table } from '../store/table.mjs';
import { log } from '../log.mjs';
import { RULES } from '../../messages/rules.mjs';

const pk = (month) => `PNL#${month}`;
const sk = (runId) => `SNAPSHOT#${runId}`;

/** Where a run's artefacts live. One place, so the uploader and the reader agree. */
export const keys = {
  report: (month, runId) => `reports/${month}/${runId}.xlsx`,
  snapshot: (month, runId) => `snapshots/${month}/${runId}.json`,
  /** The prefix the owner's ledger upload lands under. */
  inputsPrefix: (month) => `inputs/delhivery/${month}/`,
};

const bucket = () => process.env.REPORTS_BUCKET || '';

let s3 = null;
let s3Broken = false;

/**
 * The S3 client, or null if this deploy has no S3 SDK to talk to.
 * Remembered either way: a missing module is a property of the bundle, not of
 * the moment, so retrying the import per call would only cost latency.
 */
async function client() {
  if (s3 || s3Broken) return s3;
  try {
    const mod = await import('@aws-sdk/client-s3');
    const c = new mod.S3Client({ region: config.region });
    s3 = {
      send: (cmd) => c.send(cmd),
      PutObjectCommand: mod.PutObjectCommand,
      GetObjectCommand: mod.GetObjectCommand,
      /*
       * Guarded, not destructured. A vitest ESM mock THROWS on access to an
       * export it does not define, so reading this unconditionally turned a
       * mocked S3 into 's3-unavailable' and took the snapshot test down. The
       * guard also means a bundle without the command degrades the ledger
       * lookup instead of breaking snapshots, which is the right order of
       * importance: a snapshot is a financial record, a ledger lookup is a
       * convenience.
       */
      ListObjectsV2Command: 'ListObjectsV2Command' in mod ? mod.ListObjectsV2Command : null,
    };
  } catch (e) {
    s3Broken = true;
    log.error('pnl snapshot: no S3 SDK in this bundle, snapshots are unavailable', {
      err: /** @type {any} */ (e).message,
    });
  }
  return s3;
}

/**
 * What the snapshot records about the inputs: enough to explain a number, never
 * enough to identify a customer.
 */
function digest(inputs = {}) {
  return {
    month: inputs.month ?? null,
    monthStartUtc: inputs.monthStartUtc ?? null,
    monthEndUtc: inputs.monthEndUtc ?? null,
    generatedAt: inputs.generatedAt ?? null,
    trigger: inputs.trigger ?? null,
    counts: {
      orders: inputs.orders?.length ?? null,
      shipments: inputs.shipments?.length ?? null,
      charges: inputs.charges?.length ?? null,
      metaDays: inputs.meta?.length ?? null,
      gateway: inputs.gateway?.length ?? null,
      replacements: inputs.replacements?.length ?? null,
    },
    sourceStatus: inputs.sourceStatus ?? null,
    config: inputs.config ?? null,
  };
}

/**
 * Store a run's snapshot and index it.
 *
 * The index row is written only AFTER the object lands, so a row can never
 * point at a key that is not there; the alternative reads as a corrupt
 * snapshot rather than as a missing one.
 *
 * @param {{month: string, runId: string, inputs?: any, totals?: any, now?: Date}} args
 * @returns {Promise<{key:string}|{skipped:string}>}
 */
export async function putSnapshot({ month, runId, inputs = {}, totals = {}, now = new Date() }) {
  if (!bucket()) {
    log.warn('pnl snapshot: no REPORTS_BUCKET, nothing stored', { month, runId });
    return { skipped: 'no-bucket' };
  }
  const c = await client();
  if (!c) return { skipped: 's3-unavailable' };

  const key = keys.snapshot(month, runId);
  const body = {
    month,
    runId,
    storedAt: now.toISOString(),
    inputs: digest({ month, ...inputs }),
    totals,
  };
  try {
    await c.send(
      new c.PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
      }),
    );
  } catch (e) {
    log.error('pnl snapshot: S3 put failed, nothing indexed', { month, runId, err: /** @type {any} */ (e).message });
    return { skipped: 's3-put-failed' };
  }

  await table.put({
    PK: pk(month),
    SK: sk(runId),
    month,
    runId,
    at: now.toISOString(),
    snapshotKey: key,
    reportKey: keys.report(month, runId),
    expiresAt: Math.floor(now.getTime() / 1000) + RULES.pnl.snapshotTtlDays * 86400,
  });
  log.info('pnl snapshot: stored', { month, runId, key });
  return { key };
}

/**
 * The newest snapshot for a month, or null.
 *
 * Null is a real answer and not an error: the first month the report ever runs
 * has no month before it, and the restated block is simply absent. Every
 * failure below is therefore logged and nulled rather than thrown, so a missing
 * previous month cannot stop this month's report.
 *
 * @param {string} month '2026-10'
 * @returns {Promise<any|null>}
 */
export async function getSnapshot(month) {
  const p = pk(month);
  const rows = (await table.query(p)).filter((r) => r.PK === p && String(r.SK || '').startsWith('SNAPSHOT#'));
  if (!rows.length) return null;
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const row = rows[0];
  if (!bucket()) return null;
  const c = await client();
  if (!c) return null;
  try {
    const res = await c.send(new c.GetObjectCommand({ Bucket: bucket(), Key: row.snapshotKey }));
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (e) {
    log.warn('pnl snapshot: stored snapshot could not be read, continuing without the restated block', {
      month,
      key: row.snapshotKey,
      err: /** @type {any} */ (e).message,
    });
    return null;
  }
}

/** Test-only: forget the memoized S3 client. */
export function _resetS3() {
  s3 = null;
  s3Broken = false;
}

/*
 * The owner's Delhivery ledger, as sent in on WhatsApp.
 *
 * Kept as the raw bytes under inputs/delhivery/<month>/ rather than parsed and
 * thrown away, because the parse is by header name and header names change:
 * when a future statement arrives in a shape the parser does not know, the file
 * that proved it is still there to read.
 */
export async function putInput({ month, filename, bytes, now = new Date() }) {
  if (!bucket()) return { skipped: 'no-bucket' };
  const c = await client();
  if (!c) return { skipped: 's3-unavailable' };
  const safe = String(filename || 'ledger').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const Key = `${keys.inputsPrefix(month)}${now.toISOString().replace(/[:.]/g, '-')}-${safe}`;
  await c.send(
    new c.PutObjectCommand({ Bucket: bucket(), Key, Body: bytes, ContentType: 'application/octet-stream' }),
  );
  log.info('pnl ledger stored', { month, key: Key, bytes: bytes?.length ?? 0 });
  return { key: Key };
}

/**
 * The most recently uploaded ledger for a month, so a plain `/pnl 2026-10`
 * picks up a file the owner sent in days earlier without them having to say so.
 * @returns {Promise<{bytes: Uint8Array, filename: string}|null>}
 */
export async function getLatestInput(month) {
  if (!bucket()) return null;
  const c = await client();
  if (!c) return null;
  if (!c.ListObjectsV2Command) return null;
  try {
    const list = await c.send(
      new c.ListObjectsV2Command({ Bucket: bucket(), Prefix: keys.inputsPrefix(month) }),
    );
    const items = (list.Contents || []).filter((o) => o.Size > 0);
    if (!items.length) return null;
    // Keys are ISO-stamped, so lexical order is chronological order.
    items.sort((a, b) => (a.Key < b.Key ? 1 : -1));
    const newest = items[0];
    const res = await c.send(new c.GetObjectCommand({ Bucket: bucket(), Key: newest.Key }));
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    log.info('pnl ledger found in s3', { month, key: newest.Key, bytes: bytes.length });
    return { bytes, filename: newest.Key.split('/').pop() || 'ledger.csv' };
  } catch (e) {
    log.warn('pnl: could not read a stored ledger, falling back to computed charges', {
      month,
      err: /** @type {any} */ (e).message?.slice(0, 160),
    });
    return null;
  }
}
