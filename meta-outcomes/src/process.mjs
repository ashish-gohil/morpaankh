/*
 * process.mjs — decide and apply side effects for one order, idempotently.
 *
 * Flow: fetch the order fresh over GraphQL -> classify -> reconcile the two
 * side effects (DeliveredPurchase event, audience membership) against the
 * ledger. Every effect is guarded so re-processing a webhook, or seeing the
 * same order twice, changes nothing.
 */
import { config } from './config.mjs';
import { getOrderByNumericId } from './shopify.mjs';
import { classifyOrder, normaliseFromGraphql, extractContact, STATES } from './classify.mjs';
import { buildUserData } from './hash.mjs';
import { sendDeliveredPurchase, ensureAudience, audienceAddUsers, audienceRemoveUsers } from './meta.mjs';
import { getRecord, setRecord } from './store.mjs';

// Which audience a terminal state maps to. PLACED / IN_TRANSIT are undecided.
function audienceFor(state) {
  if (state === STATES.DELIVERED_PAID) return 'delivered';
  if (state === STATES.CANCELLED_ON_CALL || state === STATES.RTO) return 'lost';
  return null;
}

/**
 * Process one order by numeric id. Returns a summary of what happened.
 * @param {string|number} numericId
 */
export async function processOrder(numericId) {
  const order = await getOrderByNumericId(numericId);
  if (!order) return { orderId: String(numericId), skipped: 'order-not-found' };

  const result = classifyOrder(normaliseFromGraphql(order), { returnRegex: config.returnRegex });
  const record = getRecord(result.orderId) || {};
  const actions = [];

  // Build hashed match keys once; raw contact never leaves this scope.
  const userData = buildUserData(extractContact(order));

  // --- Side effect 1: DeliveredPurchase, exactly once per order -------------
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

  // --- Side effect 2: audience membership, moved only on change ------------
  const target = audienceFor(result.state); // 'delivered' | 'lost' | null
  if (target && target !== record.audience) {
    const targetName = target === 'delivered' ? config.meta.audienceDelivered : config.meta.audienceLost;
    const targetId = await ensureAudience(targetName);
    await audienceAddUsers(targetId, [userData]);
    actions.push(`audience-add:${target}`);

    if (record.audience && record.audience !== target) {
      const oldName = record.audience === 'delivered' ? config.meta.audienceDelivered : config.meta.audienceLost;
      const oldId = await ensureAudience(oldName);
      await audienceRemoveUsers(oldId, [userData]);
      actions.push(`audience-remove:${record.audience}`);
    }
    record.audience = target;
  }

  await setRecord(result.orderId, {
    state: result.state,
    deliveredSent: !!record.deliveredSent,
    audience: record.audience ?? null,
  });

  return {
    orderId: result.orderId,
    name: order.name,
    state: result.state,
    value: result.value,
    actions: actions.length ? actions : ['no-op'],
  };
}
