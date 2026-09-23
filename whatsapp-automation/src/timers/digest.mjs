/*
 * digest.mjs — daily owner digest (09:30 IST). Lists yesterday's updated orders,
 * counts by the tags this service writes, and sends a one-line ops_digest to the
 * owner phones. DRY_RUN + allowlist gated (via the whatsapp client).
 */
import { config } from '../config.mjs';
import { realClients } from '../clients/index.mjs';
import { tpl } from '../worker/send.mjs';
import { summarizeDigest } from '../domain/digest.mjs';
import { istParts, fromISTWall, addDays, formatISTDate } from '../lib/time.mjs';
import { log } from '../log.mjs';

export const handler = async () => {
  const now = new Date();
  const p = istParts(now);
  const todayStart = fromISTWall(p.y, p.mon, p.day, 0, 0);
  const yStart = addDays(todayStart, -1);

  const orders = await realClients.shopify.ordersUpdatedSince(yStart.toISOString());
  const norm = orders.map((o) => ({
    tags: Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
  }));
  const { line } = summarizeDigest(norm);

  const deps = { clients: realClients };
  for (const phone of config.ownerAlertPhones) {
    await tpl(deps, phone, 'ops_digest', { date: formatISTDate(yStart), summary: line }, {});
  }
  log.info('digest sent', { line });
  return { ok: true, line };
};
