/*
 * store.mjs — the idempotency ledger.
 *
 * One record per order id: the last state we acted on, whether the
 * DeliveredPurchase event was already sent, and which audience the buyer
 * currently sits in. This is what makes re-processing a webhook safe and stops
 * any order being counted twice.
 *
 * Backed by a single JSON file, loaded once, written atomically (temp file +
 * rename) behind a one-at-a-time write queue so racing webhooks can't corrupt
 * it. Fine for a single-process service; swap for SQLite/Postgres if it ever
 * runs multi-process.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.mjs';

const PATH = config.stateDbPath;

let db = null; // { orders: { [id]: record } }
let writeChain = Promise.resolve();

function ensureLoaded() {
  if (db) return;
  try {
    db = JSON.parse(readFileSync(PATH, 'utf8'));
  } catch {
    db = { orders: {} };
  }
  if (!db.orders) db.orders = {};
}

function persist() {
  // Serialise writes so two callers never clobber the file mid-write.
  writeChain = writeChain.then(() => {
    mkdirSync(dirname(PATH), { recursive: true });
    const tmp = `${PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, PATH); // atomic on the same filesystem
  });
  return writeChain;
}

/** @returns {{state?:string, deliveredSent?:boolean, audience?:('delivered'|'lost'|null), updatedAt?:string}|null} */
export function getRecord(orderId) {
  ensureLoaded();
  return db.orders[String(orderId)] || null;
}

export async function setRecord(orderId, patch) {
  ensureLoaded();
  const id = String(orderId);
  const prev = db.orders[id] || {};
  db.orders[id] = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  await persist();
  return db.orders[id];
}

export function allRecords() {
  ensureLoaded();
  return db.orders;
}

/** Flush any pending writes (call before process exit in scripts). */
export async function flush() {
  await writeChain;
}
