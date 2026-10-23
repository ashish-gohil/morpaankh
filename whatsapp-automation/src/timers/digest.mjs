/*
 * digest.mjs — daily owner digest (09:30 IST). Lists yesterday's updated orders,
 * counts by the tags this service writes, and sends a one-line ops_digest to the
 * owner phones. DRY_RUN + allowlist gated (via the whatsapp client).
 */
import { config } from '../config.mjs';
import { realClients } from '../clients/index.mjs';
import { tpl } from '../worker/send.mjs';
import { summarizeDigest } from '../domain/digest.mjs';
import { TEMPLATES, LEGACY, NO_PRICE } from '../../messages/templates.mjs';
import { soft } from '../lib/resilience.mjs';
import { allRecs } from '../store/cartRecovery.mjs';
import { listOpen } from '../store/replace.mjs';
import { istParts, fromISTWall, addDays, formatISTDate } from '../lib/time.mjs';
import { log } from '../log.mjs';


/*
 * What a person still has to do, per state. The new parcel is left Ready to
 * Ship on purpose (we never request a pickup for it), so "add it to a pickup"
 * is a real daily task rather than a status.
 */
const NEXT_ACTION = {
  AWAITING_CONFIRMATION: 'is waiting for your Confirm tap',
  CONFIRMED: 'is mid booking',
  RETURN_CREATED: 'has its pickup booked, the new parcel is not booked yet',
  FORWARD_CREATED: 'needs the new parcel added to a pickup',
  CUSTOMER_NOTIFIED: 'needs the new parcel added to a pickup',
  FAILED: 'FAILED, needs /replace retry',
};

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

  /*
   * Open replacements, with the human step each one is waiting on.
   *
   * A replacement writes nothing to Shopify by design, so no tag can reveal
   * one and the digest is the only place a half-finished one surfaces by
   * itself. The states that need a person are named rather than counted,
   * because "2 open" is not a task and "add the new parcel to a pickup" is.
   */
  const replacements = (await listOpen(10, now)).map((r) => ({
    orderName: r.orderName,
    state: r.state,
    nextAction: NEXT_ACTION[r.state] || `is ${r.state}`,
  }));
  /*
   * Template health, checked once a day against Meta.
   *
   * ALL THREE registries, because the sender can reach all three: LEGACY is
   * what it falls back to while new copy is in review and NO_PRICE is what it
   * uses with no prepaid price or photo, so either being unapproved is just as
   * silent as the main one.
   *
   * soft(), because a Meta outage must never cost the owner the whole digest:
   * no answer means no line, which is the same as the day nothing was wrong.
   * That is the right trade only because templates-sync is the authority and
   * this is the reminder to go run it.
   */
  const templateProblems = await soft('digestTemplateHealth', async () => {
    const live = await realClients.whatsapp.listTemplates();
    const reachable = [...Object.values(NO_PRICE), ...Object.values(LEGACY), ...Object.values(TEMPLATES)];
    const seen = new Set();
    const bad = [];
    for (const t of reachable) {
      if (!t?.name || seen.has(t.name)) continue;
      seen.add(t.name);
      const status = live[t.name];
      if (String(status || '').toUpperCase() !== 'APPROVED') bad.push({ name: t.name, status: status || 'missing' });
    }
    return bad;
    // soft()'s third argument is LOG FIELDS, not a fallback: it returns null on
    // failure, and templateProblemsLine treats null as "nothing wrong", which
    // is the intended quiet day.
  });

  const { line } = summarizeDigest(norm, { cartsMessaged, replacements, templateProblems });

  const deps = { clients: realClients };
  for (const phone of config.ownerAlertPhones) {
    await tpl(deps, phone, 'ops_digest', { date: formatISTDate(yStart), summary: line }, {});
  }
  log.info('digest sent', { line });
  return { ok: true, line };
};
