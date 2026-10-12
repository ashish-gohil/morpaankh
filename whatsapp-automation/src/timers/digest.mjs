/*
 * digest.mjs — daily owner digest (09:30 IST). Lists yesterday's updated orders,
 * counts by the tags this service writes, and sends a one-line ops_digest to the
 * owner phones. DRY_RUN + allowlist gated (via the whatsapp client).
 */
import { config } from '../config.mjs';
import { realClients } from '../clients/index.mjs';
import { tpl } from '../worker/send.mjs';
import { summarizeDigest } from '../domain/digest.mjs';
import { allRecs } from '../store/cartRecovery.mjs';
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
  /*
   * Carts messaged comes from the Flow R records, not from a tag: an abandoned
   * checkout has no order to carry one. Recovered DOES have a tag, so it stays
   * in the Shopify count above and the two numbers can be compared.
   */
  const yEnd = todayStart.getTime();
  const cartsMessaged = (await allRecs()).filter((rec) => {
    const at = rec.firstSentAt ? new Date(rec.firstSentAt).getTime() : 0;
    return at >= yStart.getTime() && at < yEnd;
  }).length;

  const { line } = summarizeDigest(norm, { cartsMessaged });

  const deps = { clients: realClients };
  for (const phone of config.ownerAlertPhones) {
    await tpl(deps, phone, 'ops_digest', { date: formatISTDate(yStart), summary: line }, {});
  }
  log.info('digest sent', { line });
  return { ok: true, line };
};
