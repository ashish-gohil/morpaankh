/*
 * timers/pnl-report.mjs — the monthly P&L Lambda.
 *
 * Three callers, one path:
 *   EventBridge  wa-pnl-monthly, the 7th at 09:00 IST  -> {trigger:'schedule'}
 *   the worker   /pnl from an admin phone, async invoke -> {month, trigger:'whatsapp', phone}
 *   a human      aws lambda invoke                      -> {month:'2026-10'}
 *
 * It owns no logic. Its whole job is to decide WHICH month, then hand off to
 * runPnl and report the outcome in one log line.
 */
import { config } from '../config.mjs';
import { log } from '../log.mjs';
import { realClients } from '../clients/index.mjs';
import { runPnl, previousMonth, monthLabel } from '../pnl/run.mjs';
import { renderSession } from '../../messages/session.mjs';
import { adminPhones } from '../pnl/deliver.mjs';
import { soft } from '../lib/resilience.mjs';

export const handler = async (event = {}) => {
  if (!config.pnlEnabled) {
    log.info('pnl: disabled by PNL_ENABLED, nothing built', {});
    return { skipped: 'disabled' };
  }
  const now = new Date();
  const trigger = event.trigger || 'invoke';
  /*
   * A scheduled run always means the month before, computed in IST at run time
   * rather than passed in, so a retry the next day still reports October and
   * not whatever the payload was frozen with.
   */
  const month = event.month || previousMonth(now);

  try {
    const r = await runPnl({
      month,
      trigger,
      clients: realClients,
      now,
      send: event.send !== false,
      phones: event.phone ? [event.phone] : undefined,
    });
    if (r.skipped) return r;
    return {
      ok: true,
      month: r.month,
      runId: r.runId,
      incomplete: r.incomplete,
      funnel: r.report.funnel,
      netProfitPaise: r.report.totals.netProfitPaise,
    };
  } catch (e) {
    /*
     * A report that cannot be built at all tells the owner why, rather than
     * failing into a log nobody reads once a month. The throw is kept so the
     * Lambda error alarm and the log subscription both still fire.
     */
    const reason = /** @type {any} */ (e)?.message?.slice(0, 300) || 'unknown error';
    log.error('pnl failed to build', { month, trigger, err: reason });
    const to = event.phone ? [event.phone] : adminPhones();
    const msg = renderSession('pnl_failed', { month: monthLabel(month), reason });
    for (const phone of to) {
      await soft('pnl.failed-alert', () => realClients.whatsapp.sendText({ to: phone, body: msg.body }));
    }
    throw e;
  }
};
