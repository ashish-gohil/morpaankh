/*
 * backfill.mjs — replay orders from BACKFILL_SINCE (default 2026-08-01).
 *
 * On first run this walks every order created on/after the cutoff, classifies
 * each, and applies the same idempotent side effects the live webhook path
 * uses. Safe to re-run: the ledger means nothing is sent or added twice.
 *
 *   node src/backfill.mjs            # uses BACKFILL_SINCE
 *   node src/backfill.mjs 2026-08-15 # override the cutoff
 */
import { config, assertConfig, redact } from './config.mjs';
import { iterateOrdersSince } from './shopify.mjs';
import { classifyOrder, normaliseFromGraphql, extractContact, STATES } from './classify.mjs';
import { buildUserData } from './hash.mjs';
import { sendDeliveredPurchase, ensureAudience, audienceAddUsers, audienceRemoveUsers } from './meta.mjs';
import { getRecord, setRecord, flush } from './store.mjs';

function audienceFor(state) {
  if (state === STATES.DELIVERED_PAID) return 'delivered';
  if (state === STATES.CANCELLED_ON_CALL || state === STATES.RTO) return 'lost';
  return null;
}

// Same reconciliation as process.mjs, but takes an already-fetched order node so
// the backfill does one bulk read instead of a per-order round trip.
async function reconcile(order) {
  const result = classifyOrder(normaliseFromGraphql(order), { returnRegex: config.returnRegex });
  const record = getRecord(result.orderId) || {};
  const userData = buildUserData(extractContact(order));
  const actions = [];

  if (result.state === STATES.DELIVERED_PAID && !record.deliveredSent) {
    await sendDeliveredPurchase({
      eventId: result.eventId,
      eventTime: Math.floor(Date.now() / 1000),
      value: result.value,
      currency: result.currency,
      userData,
      sourceUrl: 'https://www.morpaankh.in',
    });
    record.deliveredSent = true;
    actions.push('sent-DeliveredPurchase');
  }

  const target = audienceFor(result.state);
  if (target && target !== record.audience) {
    const targetName = target === 'delivered' ? config.meta.audienceDelivered : config.meta.audienceLost;
    await audienceAddUsers(await ensureAudience(targetName), [userData]);
    actions.push(`audience-add:${target}`);
    if (record.audience && record.audience !== target) {
      const oldName = record.audience === 'delivered' ? config.meta.audienceDelivered : config.meta.audienceLost;
      await audienceRemoveUsers(await ensureAudience(oldName), [userData]);
      actions.push(`audience-remove:${record.audience}`);
    }
    record.audience = target;
  }

  await setRecord(result.orderId, {
    state: result.state,
    deliveredSent: !!record.deliveredSent,
    audience: record.audience ?? null,
  });
  return { state: result.state, actions };
}

async function main() {
  const since = process.argv[2] || config.backfillSince;
  assertConfig();
  console.log(
    `backfill from ${since}: dryRun=${config.dryRun} store=${config.shopify.domain} token=${redact(config.shopify.token)}`,
  );

  const tally = {};
  let n = 0;
  for await (const order of iterateOrdersSince(since)) {
    const { state, actions } = await reconcile(order);
    tally[state] = (tally[state] || 0) + 1;
    n += 1;
    if (actions.some((a) => a !== 'no-op')) {
      console.log(`  ${order.name} -> ${state} [${actions.join(', ')}]`);
    }
  }
  await flush();
  console.log(`\nbackfill done: ${n} orders`);
  for (const [state, count] of Object.entries(tally)) console.log(`  ${state}: ${count}`);
  if (config.dryRun) console.log('\n(dry-run: nothing was sent to Meta)');
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
