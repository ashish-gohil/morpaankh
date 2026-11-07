/*
 * poll-delhivery.mjs — the Delhivery status poll.
 *
 * Hourly from 08:00 to 22:00 IST while the push webhook is not live, which it
 * is not: the push endpoint has 2 invocations in 30 days against this
 * function's 452. The poller is therefore the only source of NDR, delivery and
 * RTO, and every one of those drives a message to a customer.
 *
 * ONCE THE PUSH IS LIVE, hourly polling is redundant work: Delhivery tells us
 * the moment something moves, and the poll exists to catch what the push
 * missed. So it drops to three checks a day, which is a reconciliation cadence
 * rather than a source.
 *
 * "Is the push live" is an OBSERVATION, not a flag. A flag records what
 * somebody believed when they set it, and the failure that matters here is the
 * push going quiet without anybody noticing, which is a day of parcels nobody
 * is watching. So the poller reads when the push last delivered anything, and
 * falls back to hourly the moment that goes stale, with one alert.
 */
import { trackActiveShipments } from './track-active.mjs';
import { getDelhiveryPush } from '../store/maps.mjs';
import { alertOncePerDay } from '../store/cartRecovery.mjs';
import { realClients } from '../clients/index.mjs';
import { ownerAlert } from '../worker/send.mjs';
import { istParts } from '../lib/time.mjs';
import { soft } from '../lib/resilience.mjs';
import { log } from '../log.mjs';

/* A push older than this means we are back to being the only source. */
const PUSH_STALE_HOURS = 24;
/* The reconciliation cadence: morning, mid-afternoon, evening, IST. */
const RECONCILE_HOURS = [9, 14, 19];

export const handler = async () => {
  const now = new Date();

  /*
   * Read BEFORE any tracking call. The whole saving is in not making the
   * Delhivery requests at all, so an early return has to come first: at 25
   * waybills a call and 452 runs a month, the reads are the cost.
   */
  const push = await soft('readDelhiveryPush', () => getDelhiveryPush(), {});
  const lastPushMs = push?.at ? Date.parse(push.at) : NaN;
  const pushFresh = Number.isFinite(lastPushMs) && now.getTime() - lastPushMs < PUSH_STALE_HOURS * 3600 * 1000;

  if (pushFresh) {
    const hour = istParts(now).h;
    if (!RECONCILE_HOURS.includes(hour)) {
      log.info('poll-delhivery: the push is live, skipping this hour', { hour, lastPush: push.at });
      return { ok: true, skipped: 'push-is-live', hour };
    }
  } else if (push?.at) {
    /*
     * The push WAS working and has gone quiet. That is worth one line a day:
     * the poller has already taken over, so nothing is lost, but a webhook
     * Delhivery silently turned off is something only the owner can chase.
     */
    await soft('pushStaleAlert', async () => {
      if (await alertOncePerDay('delhivery-push-stale', now)) {
        await ownerAlert(
          { clients: realClients },
          'Delhivery',
          `the Delhivery status webhook has sent nothing since ${push.at}. Hourly polling has taken over, so nothing is lost, but ask them to check it`,
        );
      }
    }, {});
  }

  const r = await trackActiveShipments();
  log.info('poll-delhivery done', { ...r, pushFresh });
  return { ok: true, ...r };
};
