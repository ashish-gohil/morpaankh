/*
 * poll-delhivery.mjs — hourly Delhivery poll (08:00-22:00 IST). Source of truth
 * for NDR/RTO until the push webhook is enabled; drops to reconciliation cadence
 * afterwards. Re-tracks active AWBs and enqueues changes for the worker.
 */
import { trackActiveShipments } from './track-active.mjs';
import { log } from '../log.mjs';

export const handler = async () => {
  const r = await trackActiveShipments();
  log.info('poll-delhivery done', r);
  return { ok: true, ...r };
};
