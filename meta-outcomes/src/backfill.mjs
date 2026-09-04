/*
 * backfill.mjs — manual full re-seed from BACKFILL_SINCE (created_at based),
 * ignoring the poll checkpoint. The scheduled poll already backfills on its
 * first run; use this only to deliberately re-scan all history.
 *
 *   node src/backfill.mjs            # uses BACKFILL_SINCE
 *   node src/backfill.mjs 2026-08-15 # override the cutoff
 */
import { config, assertConfig, redact } from './config.mjs';
import { iterateOrdersSince } from './shopify.mjs';
import { initStore, flush } from './store.mjs';
import { reconcileOrder } from './reconcile.mjs';

async function main() {
  const since = process.argv[2] || config.backfillSince;
  assertConfig();
  await initStore();
  console.log(`backfill from ${since}: dryRun=${config.dryRun} store=${config.stateBackend} token=${redact(config.shopify.token)}`);

  const tally = {};
  let n = 0;
  for await (const order of iterateOrdersSince(since)) {
    const r = await reconcileOrder(order);
    tally[r.state] = (tally[r.state] || 0) + 1;
    n += 1;
    if (!(r.actions.length === 1 && r.actions[0] === 'no-op')) {
      console.log(`  ${r.name} -> ${r.state} [${r.actions.join(', ')}]`);
    }
  }
  await flush();
  console.log(`\nbackfill done: ${n} orders`);
  for (const [s, c] of Object.entries(tally)) console.log(`  ${s}: ${c}`);
  if (config.dryRun) console.log('\n(dry-run: nothing was sent to Meta)');
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
