#!/usr/bin/env node
/*
 * backfill-kind.mjs — stamp `kind` and `kindAt` on the rows already in the
 * table, so GSI2 can see them.
 *
 * GSI2 is SPARSE: a row only appears in it once it carries `kind`. New rows get
 * stamped by their writers, but everything written before that deploy is
 * invisible to the new queries, which is why every reader keeps a scan fallback
 * until this has run.
 *
 *   node scripts/backfill-kind.mjs            # dry run, prints what it would do
 *   node scripts/backfill-kind.mjs --live     # writes
 *
 * ONE SCAN, which is the thing this whole change exists to stop doing, run
 * once on purpose. It reads the table, picks out the five sort keys that belong
 * in the index, and writes only the two attributes.
 *
 * `kindAt` is taken from the row's OWN timestamp (capturedAt, createdAt, at),
 * never from the clock: the index is sorted by it and every reader bounds
 * itself by date, so stamping "now" would file a month-old cart as today's and
 * put it back in front of the sweep.
 *
 * Safe to re-run. A row that already carries `kind` is skipped, so a run that
 * dies halfway can simply be run again.
 */
import { config } from '../src/config.mjs';
import { table } from '../src/store/table.mjs';

const LIVE = process.argv.includes('--live');

/*
 * sort key -> { kind, the row's own time fields in order of preference }.
 * REQ# is a prefix rather than an exact key, because the sequence number is
 * part of it.
 */
const EXACT = {
  CAP: { kind: 'capcart', at: ['capturedAt', 'createdAt'] },
  REC: { kind: 'cartrec', at: ['createdAt'], pkPrefix: 'CART#' },
  SUB: { kind: 'subrec', at: ['createdAt'] },
  REPLOPEN: { kind: 'replopen', at: ['at', 'createdAt'] },
};
const PREFIX = [['REQ#', { kind: 'replreq', at: ['createdAt'], pkPrefix: 'REPL#' }]];

const planFor = (row) => {
  const sk = String(row.SK || '');
  const spec = EXACT[sk] || PREFIX.find(([p]) => sk.startsWith(p))?.[1];
  if (!spec) return null;
  // The PK guard is the same one the readers keep: a sort key alone does not
  // say which flow a row belongs to, and filing someone else's row under
  // 'cartrec' would have the digest count it as an abandoned cart.
  if (spec.pkPrefix && !String(row.PK || '').startsWith(spec.pkPrefix)) return null;
  const at = spec.at.map((f) => row[f]).find((v) => typeof v === 'string' && v);
  if (!at) return null; // no honest timestamp: leave it out rather than invent one
  return { kind: spec.kind, kindAt: at };
};

async function main() {
  if (config.dynamoBackend !== 'aws') {
    console.error('This writes to the live table and DYNAMO_BACKEND is not "aws". Set it and try again.');
    process.exit(1);
  }
  console.log(`${LIVE ? 'LIVE' : 'DRY RUN'}: table ${config.tableName} in ${config.region}\n`);

  // One scan of everything, by sort key, which is the only way to find rows
  // that are not yet in the index we are filling.
  const sortKeys = [...Object.keys(EXACT)];
  const rows = [];
  for (const sk of sortKeys) rows.push(...(await table.scanBySk(sk)));
  // REQ#<seq>: the sequence is unbounded in principle, so walk until a page is
  // empty rather than guessing a ceiling.
  for (let seq = 1; ; seq += 1) {
    const page = await table.scanBySk(`REQ#${seq}`);
    if (!page.length) break;
    rows.push(...page);
  }

  const counts = {};
  let skipped = 0;
  let already = 0;
  for (const row of rows) {
    if (row.kind) { already += 1; continue; }
    const plan = planFor(row);
    if (!plan) { skipped += 1; continue; }
    counts[plan.kind] = (counts[plan.kind] || 0) + 1;
    if (LIVE) await table.update(row.PK, row.SK, plan);
    else console.log(`would stamp ${row.PK} / ${row.SK} -> ${plan.kind} @ ${plan.kindAt}`);
  }

  console.log('\nby kind:', counts);
  console.log(`already stamped: ${already}, not for the index: ${skipped}, read: ${rows.length}`);
  if (!LIVE) console.log('\nNothing was written. Re-run with --live.');
  else console.log('\nDone. The scan fallbacks in the readers can now be deleted.');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
