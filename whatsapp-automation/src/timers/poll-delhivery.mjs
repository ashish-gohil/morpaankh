/*
 * poll-delhivery.mjs — hourly Delhivery tracking poll (08:00-22:00 IST).
 * Source of truth for NDR/RTO until the push webhook is enabled. Real polling
 * lands in Phase 7; this stub keeps the scheduled Lambda deployable.
 */
import { log } from '../log.mjs';

export const handler = async () => {
  log.info('poll-delhivery: not implemented yet (Phase 7)');
  return { ok: true };
};
