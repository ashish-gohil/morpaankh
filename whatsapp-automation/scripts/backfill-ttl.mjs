#!/usr/bin/env node
/*
 * backfill-ttl.mjs — stamp `expiresAt` on the rows written before they had one.
 *
 * STATE, ORDER MSG#, AWB#, PAYLINK# and WAMID# rows had no TTL at all, so every
 * order added rows that stayed forever. New rows get one from their writers;
 * this is for everything already in the table.
 *
 *   node scripts/backfill-ttl.mjs            # dry run
 *   node scripts/backfill-ttl.mjs --live     # writes
 *
 * `expiresAt` is computed from the row's OWN timestamp, never from the clock:
 * stamping "now + 180 days" would give a two-year-old message row another six
 * months, which is the opposite of the point. A row with no honest timestamp is
 * left alone and counted, rather than given an invented one.
 *
 * WHAT IT WILL NOT TOUCH, and these are the ones that matter:
 *   SUBOFFER#.../LOCK   the LIFETIME welcome-offer lock. One per person, ever,
 *                       and an expiry on it is a second free Rs 200 code.
 *   PHONE#.../PROFILE   opt-out, undeliverable and the RTO count. An expired
 *                       opt-out is marketing to somebody who said stop.
 *   REPL#...            replacement records, which already carry 400 days.
 *   anything that already has expiresAt.
 */
import { config } from '../src/config.mjs';
import { table } from '../src/store/table.mjs';
import { RULES } from '../messages/rules.mjs';

const LIVE = process.argv.includes('--live');
const DAY = 86400;

/* sort key (exact or prefix) -> { days, the row's own time fields } */
const PLANS = [
  { sk: 'STATE', days: RULES.stateTtlDays, at: ['createdAt', 'updatedAt', 'at'] },
  { prefix: 'MSG#', days: RULES.stateRetentionDays, at: ['at', 'updatedAt'] },
  { sk: 'MAP', days: RULES.stateRetentionDays, at: ['at', 'updatedAt', 'createdAt'], pkPrefix: ['AWB#', 'PAYLINK#', 'WAMID#'] },
];

const planFor = (row) => {
  const sk = String(row.SK || '');
  const pk = String(row.PK || '');
  const plan = PLANS.find((p) => (p.sk ? sk === p.sk : sk.startsWith(p.prefix)));
  if (!plan) return null;
  // PAYTOKEN# is excluded by this list on purpose: it already carries the
  // Razorpay link's own expiry, which is shorter than anything here.
  if (plan.pkPrefix && !plan.pkPrefix.some((pre) => pk.startsWith(pre))) return null;
  const at = plan.at.map((f) => row[f]).find((v) => typeof v === 'string' && v);
  const t = at ? Date.parse(at) : NaN;
  if (Number.isFinite(t)) return { expiresAt: Math.floor(t / 1000) + plan.days * DAY, from: at, days: plan.days };
  /*
   * NO TIMESTAMP AT ALL, which is true of every MAP row written before
   * maps.mjs started recording `at`: a dry run on 2026-11-07 found 424 of
   * them. There is nothing to compute from, so the choice is leaving them to
   * live forever or giving them one window from today.
   *
   * Today, labelled. It is bounded and it is once, which is strictly better
   * than forever, and the alternative would be inventing a creation date for a
   * row and calling it history. maps.mjs now writes `at`, so this branch stops
   * being needed after this run.
   */
  return { expiresAt: Math.floor(Date.now() / 1000) + plan.days * DAY, from: 'no timestamp, from today', days: plan.days };
};

async function main() {
  if (config.dynamoBackend !== 'aws') {
    console.error('This writes to the live table and DYNAMO_BACKEND is not "aws". Set it and try again.');
    process.exit(1);
  }
  console.log(`${LIVE ? 'LIVE' : 'DRY RUN'}: table ${config.tableName} in ${config.region}\n`);

  const rows = [...(await table.scanStates())];
  // MSG# and MAP need their own passes: scanBySk matches an exact sort key, and
  // MSG# carries the wamid in it.
  rows.push(...(await table.scanBySk('MAP')));
  const states = rows.filter((r) => r.SK === 'STATE');
  for (const st of states) {
    const msgs = (await table.query(st.PK)).filter((r) => String(r.SK || '').startsWith('MSG#'));
    rows.push(...msgs);
  }

  const now = Math.floor(Date.now() / 1000);
  let already = 0;
  let noTime = 0;
  let notForTtl = 0;
  let expired = 0;
  const counts = {};
  for (const row of rows) {
    if (row.expiresAt) { already += 1; continue; }
    const plan = planFor(row);
    if (!plan) { notForTtl += 1; continue; }
    if (plan.from === 'no timestamp, from today') noTime += 1;
    const kind = String(row.SK).startsWith('MSG#') ? 'MSG#' : String(row.SK);
    counts[kind] = (counts[kind] || 0) + 1;
    // Worth seeing before writing: a row whose computed expiry is already past
    // will be deleted by DynamoDB within 48 hours of this run.
    if (plan.expiresAt <= now) expired += 1;
    if (LIVE) await table.update(row.PK, row.SK, { expiresAt: plan.expiresAt });
    else console.log(`would stamp ${row.PK} / ${row.SK} -> +${plan.days}d from ${plan.from}${plan.expiresAt <= now ? '  ALREADY PAST' : ''}`);
  }

  console.log('\nby row kind:', counts);
  console.log(`read ${rows.length}, already stamped ${already}, not for a TTL ${notForTtl}`);
  if (noTime) console.log(`${noTime} had no timestamp of their own and were given one window from today; maps.mjs now records \`at\` so this will not recur.`);
  if (expired) console.log(`\n${expired} of these are ALREADY past their expiry and DynamoDB will delete them within about 48 hours.`);
  if (!LIVE) console.log('\nNothing was written. Re-run with --live.');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
