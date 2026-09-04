/*
 * poll.mjs — the scheduled "check" run (what Lambda invokes on a timer).
 *
 * Each run:
 *  1. loads state (ledger + last checkpoint),
 *  2. fetches every order UPDATED since the last checkpoint (minus a small
 *     overlap so nothing near a boundary is missed),
 *  3. reconciles each (idempotent),
 *  4. advances the checkpoint to this run's start time,
 *  5. persists state once.
 *
 * First run (no checkpoint) = the one-time backfill: it looks back to
 * BACKFILL_SINCE instead. Idempotency makes overlap and re-runs harmless.
 *
 *   node src/poll.mjs        # run once (uses .env; DRY_RUN respected)
 */
import { config, assertConfig, redact } from './config.mjs';
import { iterateOrdersUpdatedSince } from './shopify.mjs';
import { initStore, flush, getCheckpoint, setCheckpoint } from './store.mjs';
import { reconcileOrder } from './reconcile.mjs';

export async function runPoll() {
  assertConfig();
  await initStore();

  const runStart = new Date().toISOString();
  const checkpoint = getCheckpoint();

  // Where to look back to: overlap before the checkpoint, or the backfill date
  // on the very first run.
  let since;
  if (checkpoint) {
    since = new Date(Date.parse(checkpoint) - config.pollOverlapMinutes * 60000).toISOString();
  } else {
    since = new Date(`${config.backfillSince}T00:00:00Z`).toISOString();
  }
  const mode = checkpoint ? 'poll' : 'backfill';

  console.log(
    `[${mode}] dryRun=${config.dryRun} store=${config.stateBackend} shop=${config.shopify.domain} ` +
      `token=${redact(config.shopify.token)} since=${since}`,
  );

  const tally = {};
  let n = 0;
  let acted = 0;
  for await (const order of iterateOrdersUpdatedSince(since)) {
    const r = await reconcileOrder(order);
    tally[r.state] = (tally[r.state] || 0) + 1;
    n += 1;
    if (!(r.actions.length === 1 && r.actions[0] === 'no-op')) {
      acted += 1;
      console.log(`  ${r.name} -> ${r.state} [${r.actions.join(', ')}]`);
    }
  }

  setCheckpoint(runStart);
  await flush();

  console.log(`[${mode}] done: scanned ${n} orders, acted on ${acted}. Next checkpoint=${runStart}`);
  for (const [s, c] of Object.entries(tally)) console.log(`  ${s}: ${c}`);
  if (config.dryRun) console.log('(dry-run: nothing sent to Meta)');

  return { mode, scanned: n, acted, tally, checkpoint: runStart };
}

// Allow running directly: node src/poll.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  runPoll().catch((e) => {
    console.error('fatal:', e.message);
    process.exit(1);
  });
}
