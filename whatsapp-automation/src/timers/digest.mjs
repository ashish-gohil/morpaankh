/*
 * digest.mjs — daily owner digest (09:30 IST): one-line summary of yesterday's
 * COD/confirm/convert/cancel/deliver/review/NDR/RTO/failure counts to
 * OWNER_ALERT_PHONES. Real logic lands in Phase 8.
 */
import { log } from '../log.mjs';

export const handler = async () => {
  log.info('digest: not implemented yet (Phase 8)');
  return { ok: true };
};
