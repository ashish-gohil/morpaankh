/*
 * reconcile.mjs — decide and apply side effects for ONE order, idempotently.
 *
 * Shared by the scheduled poll and the backfill. Takes an already-fetched order
 * node (no re-fetch), classifies it, and reconciles the two side effects
 * (DeliveredPurchase event, audience membership) against the ledger. Every
 * effect is guarded so re-processing the same order changes nothing.
 */
import { config } from './config.mjs';
import { classifyOrder, normaliseFromGraphql, extractContact, STATES } from './classify.mjs';
import { buildUserData } from './hash.mjs';
import { sendDeliveredPurchase, ensureAudience, audienceAddUsers, audienceRemoveUsers } from './meta.mjs';
import { getRecord, setRecord } from './store.mjs';

function audienceFor(state) {
  if (state === STATES.DELIVERED_PAID) return 'delivered';
  if (state === STATES.CANCELLED_ON_CALL || state === STATES.RTO) return 'lost';
  return null; // PLACED / IN_TRANSIT are undecided
}

function ageDays(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

export async function reconcileOrder(order) {
  const result = classifyOrder(normaliseFromGraphql(order));
  const record = getRecord(result.orderId) || {};
  const userData = buildUserData(extractContact(order));
  const actions = [];

  // Side effect 1: DeliveredPurchase, exactly once per order, only when fresh.
  if (result.state === STATES.DELIVERED_PAID && !record.deliveredSent) {
    const outcomeAge = ageDays(order.updatedAt);
    if (outcomeAge <= config.capiMaxAgeDays) {
      const nowUnix = Math.floor(Date.now() / 1000);
      const upUnix = order.updatedAt ? Math.floor(Date.parse(order.updatedAt) / 1000) : nowUnix;
      await sendDeliveredPurchase({
        eventId: result.eventId,
        eventTime: Math.min(nowUnix, upUnix || nowUnix), // never in the future
        value: result.value,
        currency: result.currency,
        userData,
        sourceUrl: 'https://www.morpaankh.in',
      });
      actions.push('sent-DeliveredPurchase');
    } else {
      actions.push(`skipped-DeliveredPurchase(age ${Math.round(outcomeAge)}d, audience-only)`);
    }
    record.deliveredSent = true; // handled either way; never re-fired
  }

  // Side effect 2: audience membership, moved only on an actual change.
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

  setRecord(result.orderId, {
    state: result.state,
    deliveredSent: !!record.deliveredSent,
    audience: record.audience ?? null,
  });

  return { orderId: result.orderId, name: order.name, state: result.state, value: result.value, actions: actions.length ? actions : ['no-op'] };
}
