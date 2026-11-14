/*
 * digest.mjs — daily owner digest (09:30 IST). Lists yesterday's updated orders,
 * counts by the tags this service writes, and sends a one-line ops_digest to the
 * owner phones. DRY_RUN + allowlist gated (via the whatsapp client).
 */
import { config } from '../config.mjs';
import { realClients } from '../clients/index.mjs';
import { tpl, ownerSend } from '../worker/send.mjs';
import { summarizeDigest, countEvents } from '../domain/digest.mjs';
import { TEMPLATES, LEGACY, NO_PRICE } from '../../messages/templates.mjs';
import { TEMPLATES_HI, PLAIN_HI, HI_NOT_SUBMITTED } from '../../messages/templates.hi.mjs';
import { soft } from '../lib/resilience.mjs';
import { table } from '../store/table.mjs';
import { allRecs } from '../store/cartRecovery.mjs';
import { allSubRecs } from '../store/subscriberOffer.mjs';
import { listOpen } from '../store/replace.mjs';
import { windowOpen, waCounts } from '../store/phoneProfile.mjs';
import { RULES } from '../../messages/rules.mjs';
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
  // Bounded: this only counts records whose firstSentAt is inside yesterday,
  // and a record is created at most a few hours before its first send.
  const recsSince = addDays(yStart, -2).toISOString();
  const cartsMessaged = (await allRecs(recsSince)).filter((rec) => {
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
    /*
     * HINDI IS COLLECTED SEPARATELY and reported on its own line, because the
     * two mean different things to the person reading the digest. An
     * unapproved English template is a message that does not go out at all;
     * an unapproved Hindi one is the same message in the other language. The
     * first needs the owner to act this morning. The second needs them to know.
     *
     * The two Hindi review asks are excluded: they are deliberately not
     * submitted, so reporting them every single day would be noise that trains
     * the owner to skip this line.
     */
    const reachableHi = [...Object.values(PLAIN_HI), ...Object.values(TEMPLATES_HI)]
      .filter((t) => !HI_NOT_SUBMITTED.has(t.name));
    const seen = new Set();
    const bad = [];
    const badHi = [];
    for (const [list, out] of [[reachable, bad], [reachableHi, badHi]]) {
      for (const t of list) {
        if (!t?.name || seen.has(t.name)) continue;
        seen.add(t.name);
        const status = live[t.name];
        if (String(status || '').toUpperCase() !== 'APPROVED') out.push({ name: t.name, status: status || 'missing' });
      }
    }
    return { bad, badHi };
    // soft()'s third argument is LOG FIELDS, not a fallback: it returns null on
    // failure, and templateProblemsLine treats null as "nothing wrong", which
    // is the intended quiet day.
  });

  /*
   * Yesterday's welcome offers, off the SUB rows.
   *
   * Counted here rather than from a tag for the same reason as the carts: a
   * customer who was offered a code has no order to carry one, and the only
   * one that does (a conversion) is already tagged and already counted above.
   * The skip reasons are what the owner actually needs: "12 swept, 11 skipped
   * has-cart" is the difference between a flow that is working and one that is
   * quietly reaching nobody.
   */
  const subs = (await allSubRecs(recsSince)).filter((rec) => {
    const at = Date.parse(rec.firstSentAt || rec.outcomeAt || rec.createdAt || '');
    return at >= yStart.getTime() && at < yEnd;
  });
  const skipCounts = {};
  for (const rec of subs) {
    // `converted` is an outcome but it is not a skip: it is the best one there
    // is, and counting it as a skip reason would be the digest lying.
    if (rec.outcome && rec.outcome !== 'converted' && !rec.firstSentAt) {
      skipCounts[rec.outcome] = (skipCounts[rec.outcome] || 0) + 1;
    }
  }
  const sentSubs = subs.filter((rec) => rec.firstSentAt);
  const subscribers = {
    sent: sentSubs.length,
    whatsapp: sentSubs.filter((rec) => rec.channel !== 'email').length,
    email: sentSubs.filter((rec) => rec.channel === 'email').length,
    parked: subs.filter((rec) => rec.outcome === 'waiting-window').length,
    converted: subs.filter((rec) => rec.outcome === 'converted').length,
    revenuePaise: subs.reduce((sum, rec) => sum + (rec.outcome === 'converted' ? rec.revenuePaise || 0 : 0), 0),
    skips: Object.entries(skipCounts).map(([reason, count]) => ({ reason, count })),
  };

  /*
   * Yesterday's EVENTS, from the timestamps this service writes, rather than
   * yesterday's TAGS on orders Shopify reported as updated. Every tag write
   * updates the order, so the old counts included anything merely touched in
   * the window, however old. See countEvents.
   *
   * One scan a day, which is what scanStates is for; nothing on a hot path
   * reads it.
   */
  const events = countEvents(await table.scanStates(), {
    fromISO: yStart.toISOString(),
    toISO: todayStart.toISOString(),
  });

  /*
   * N9. Month to date, not yesterday: the free service allowance resets
   * monthly and the marketing cost only matters in aggregate. One query on one
   * row.
   */
  const month = `${p.y}-${String(p.mon + 1).padStart(2, '0')}`;
  const counts = (await soft('readWaCounts', () => waCounts(month), {})) || {};

  const { line } = summarizeDigest(norm, {
    cartsMessaged, replacements, templateProblems, subscribers, events,
    waCounts: counts,
    waRates: RULES.waRatesInr,
  });

  const deps = { clients: realClients };
  const vars = { date: formatISTDate(yStart), summary: line };

  /*
   * THE DIGEST IS THE ONE OWNER MESSAGE THAT MAY GO BY EMAIL INSTEAD.
   *
   * ops_digest is MARKETING, as Meta categorised it, so this was about 30
   * marketing templates a month per owner phone, each exposed to the per-user
   * cap behind 131049. Some days it was refused outright: a summary that
   * silently does not arrive is worse than one that arrives late.
   *
   * Inside the owner's window it goes free-form, with a "Got it" button whose
   * tap reopens the window so tomorrow's is free too. Outside it, email, which
   * is unmetered and is where the P&L already goes. An ALERT never does this
   * (see ownerSend): an alert that waits for a window is not an alert.
   */
  let sent = 0;
  for (const phone of config.ownerAlertPhones) {
    const open = RULES.digestChannel !== 'template' && (await windowOpen(phone, now, RULES.windowSafetyMinutes));
    if (!open && RULES.digestChannel === 'window-else-email' && config.pnlEmailTo.length) continue;
    await soft('digestSend', () => ownerSend(deps, phone, 'ops_digest', vars), {});
    sent += 1;
  }

  const byEmail = sent < config.ownerAlertPhones.length && config.pnlEmailTo.length > 0;
  let emailed = 0;
  if (byEmail) {
    const parts = {
      subject: `Morpaankh, ${formatISTDate(yStart)}`,
      text: `${formatISTDate(yStart)}\n\n${line}\n`,
      html: `<p><strong>${formatISTDate(yStart)}</strong></p><p>${line}</p>`,
    };
    /*
     * ONE SES CALL PER RECIPIENT, as pnl/deliver.mjs already does for the
     * workbook, so a dud address cannot take the other one down with it. That
     * matters at one or two emails a day: SES judges a sender on its bounce
     * RATE, where a single bad address is a double-digit percentage of the day.
     *
     * This used to pass `pnlEmailTo.join(',')` as one address. SES refused the
     * whole send with "Illegal address" and the digest silently went nowhere.
     */
    for (const addr of config.pnlEmailTo) {
      const r = await soft('digestEmail', () => realClients.email.send({ to: addr, ...parts }), {});
      if (r && !r.skipped) emailed += 1;
    }
  }

  /*
   * NOTHING REACHED THE OWNER YET, so send the template after all.
   *
   * The WhatsApp route above was skipped in FAVOUR of email, so when email does
   * not go there is no route left and the digest is simply lost, with a soft
   * error in the log as its only trace. That is how 2026-11-14 passed with no
   * digest and no alert.
   *
   * ops_digest is MARKETING and may be refused by the per-user cap behind
   * 131049, which is exactly why it is the last resort rather than the first.
   * A refused attempt still beats no attempt.
   */
  const rescued = byEmail && emailed === 0;
  if (rescued) {
    for (const phone of config.ownerAlertPhones) {
      await soft('digestRescue', () => ownerSend(deps, phone, 'ops_digest', vars), {});
    }
  }

  log.info('digest sent', { line, byWhatsApp: sent, byEmail, emailed, rescued });
  return { ok: true, line };
};
