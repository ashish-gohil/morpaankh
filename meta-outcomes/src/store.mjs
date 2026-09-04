/*
 * store.mjs — the idempotency ledger + poll checkpoint.
 *
 * One record per order id (last state acted on, whether DeliveredPurchase was
 * sent, which audience the buyer is in) plus a `lastPolledAt` cursor. This is
 * what makes re-processing safe and stops any order being counted twice.
 *
 * Two backends behind one API:
 *   - file  (local dry-runs / backfill): a JSON file on disk.
 *   - s3    (Lambda): a single JSON object in S3, because Lambda's disk is wiped
 *           between runs. @aws-sdk/client-s3 is provided by the Lambda runtime;
 *           it is imported lazily so local file-mode needs nothing installed.
 *
 * Load once with initStore(), read/write in memory (sync), persist once with
 * flush(). At our cadence (a couple of runs a day, one invocation at a time,
 * Lambda reserved-concurrency 1) whole-object read/write is safe and simplest.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.mjs';

let db = null; // { meta: { lastPolledAt }, orders: { [id]: record } }
let dirty = false;

function blank() {
  return { meta: { lastPolledAt: null }, orders: {} };
}

// ---- S3 helpers (lazy) ------------------------------------------------------
let s3 = null;
async function s3client() {
  if (s3) return s3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  s3 = new S3Client({ region: config.awsRegion });
  return s3;
}
async function s3Load() {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const res = await (await s3client()).send(
      new GetObjectCommand({ Bucket: config.s3Bucket, Key: config.s3Key }),
    );
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (e) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return blank();
    throw e;
  }
}
async function s3Save() {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3client()).send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: config.s3Key,
      Body: JSON.stringify(db),
      ContentType: 'application/json',
    }),
  );
}

// ---- lifecycle --------------------------------------------------------------
export async function initStore() {
  if (db) return;
  if (config.stateBackend === 's3') {
    if (!config.s3Bucket) throw new Error('STATE_BACKEND=s3 requires STATE_S3_BUCKET');
    db = await s3Load();
  } else {
    try {
      db = JSON.parse(readFileSync(config.stateDbPath, 'utf8'));
    } catch {
      db = blank();
    }
  }
  if (!db.meta) db.meta = { lastPolledAt: null };
  if (!db.orders) db.orders = {};
}

function assertInit() {
  if (!db) throw new Error('store not initialised: await initStore() first');
}

export function getRecord(orderId) {
  assertInit();
  return db.orders[String(orderId)] || null;
}

export function setRecord(orderId, patch) {
  assertInit();
  const id = String(orderId);
  db.orders[id] = { ...(db.orders[id] || {}), ...patch, updatedAt: new Date().toISOString() };
  dirty = true;
  return db.orders[id];
}

export function getCheckpoint() {
  assertInit();
  return db.meta.lastPolledAt || null;
}

export function setCheckpoint(iso) {
  assertInit();
  db.meta.lastPolledAt = iso;
  dirty = true;
}

export function allRecords() {
  assertInit();
  return db.orders;
}

export async function flush() {
  if (!db || !dirty) return;
  if (config.stateBackend === 's3') {
    await s3Save();
  } else {
    mkdirSync(dirname(config.stateDbPath), { recursive: true });
    const tmp = `${config.stateDbPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, config.stateDbPath);
  }
  dirty = false;
}

/** Test-only: drop the in-memory state so a fresh initStore() reloads. */
export function _reset() {
  db = null;
  dirty = false;
}
