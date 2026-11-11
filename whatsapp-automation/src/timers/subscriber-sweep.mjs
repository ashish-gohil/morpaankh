/*
 * subscriber-sweep.mjs — Flow W's only starter. Runs ONCE A DAY at 11:00 IST,
 * on the reconcile Lambda with { mode: 'subscribers' }.
 *
 * IT DECIDES NOTHING. It reads yesterday's new customers and enqueues them;
 * the worker re-reads each one with customer(id:) and re-checks every gate
 * before anything is created or sent. So the worst a wrong answer here can do
 * is cost a queue message.
 *
 * THE TWO THINGS IT DOES DECIDE ARE BOTH REFUSALS, and both are deliberate:
 * a day with more candidates than maxPerRun, and a template Meta has not
 * approved, stop the whole run rather than start it. Sending a hundred private
 * codes cannot be undone.
 */
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { realClients } from '../clients/index.mjs';
import { istYesterdayWindow, istDayWindow, normalizeCustomer, subscriberEligible } from '../domain/subscriberOffer.mjs';
import { getSubRec, getSweepDay, setSweepDay, subAlertOncePerDay } from '../store/subscriberOffer.mjs';
import { subGroup } from '../worker/subscriberOffer.run.mjs';
import { TEMPLATES, LEGACY } from '../../messages/templates.mjs';
import { enqueue } from '../queue.mjs';
import { ownerAlert } from '../worker/send.mjs';
import { soft } from '../lib/resilience.mjs';
import { log } from '../log.mjs';

const w = () => RULES.subscriberOffer;

/** Tell the owner once a day, whatever happens to the send. */
async function alertOnce(clients, label, text, now) {
  await soft('subscriberSweepAlert', async () => {
    if (await subAlertOncePerDay(label, now)) await ownerAlert({ clients }, 'welcome offer', text);
  }, { label });
}

/**
 * Is the offer template usable at all?
 *
 * Checked HERE rather than discovered one send at a time, because an
 * unapproved template fails for every candidate at once and each failure is a
 * record with a terminal outcome: a day run against a PENDING template would
 * mark a hundred people `template-unusable` for ever, and the offer is once
 * per person. Both names are needed, because the plain twin is what goes out
 * when the collection has no photo.
 */
async function templatesReady(clients) {
  const live = await clients.whatsapp.listTemplates();
  const ok = (name) => String(live?.[name] || '').toUpperCase() === 'APPROVED';
  /*
   * ENGLISH NAMES ONLY, deliberately, and this must stay that way.
   *
   * This gate decides whether the sweep runs at all, and a failed run marks
   * people template-unusable for ever against a once-per-person offer. An
   * unapproved HINDI template is not a reason to hold the sweep: send.mjs
   * falls back to English, so the offer still reaches everyone. Adding the
   * Hindi names here would let a pending translation stop a hundred welcome
   * offers that would have gone out perfectly well.
   *
   * The plain twin's name comes from LEGACY rather than a literal, so bumping
   * its version cannot leave this checking a template that no longer exists.
   */
  return ok(TEMPLATES.subscriber_offer.name) && ok(LEGACY.subscriber_offer.name);
}

/**
 * @param {any} [clients]
 * @param {Date} [now]
 */
/**
 * N5. Yesterday, and the days before it that never happened.
 *
 * The sweep only ever looked at yesterday, and the day marker is written on
 * SUCCESS. So a run that failed, or was blocked because the template was not
 * approved, or never fired because the rule was off, lost that day's
 * subscribers for good: nothing went back to look, and only a hand-run with
 * `run --date` could recover it.
 *
 * Up to three previous days, OLDEST FIRST, each with its own marker, its own
 * maxPerRun and its own startAt check. Oldest first because a person who
 * signed up three days ago has been waiting longest, and because the per-run
 * cap should spend itself on them rather than on today's.
 *
 * Three is the cap for the same reason the offer has a 24 hour code: a welcome
 * message a week late is not a welcome.
 */
export async function sweepNewSubscribers(clients = realClients, now = new Date()) {
  if (!config.flows.W.enabled) return { skipped: 'flow-w-off' };

  const days = [];
  for (let back = w().catchUpDays ?? 3; back >= 1; back -= 1) days.push(istDayWindow(now, back));

  const runs = [];
  for (const day of days) {
    // Each day is independent: one that cannot be read must not stop the rest,
    // and the day marker means a completed one costs nothing to revisit.
    const r = await soft('subscriberSweepDay', () => sweepOneDay(clients, now, day), { date: day.date });
    if (r) runs.push(r);
  }
  const latest = runs[runs.length - 1] || { skipped: 'nothing-to-do' };
  const caught = runs.slice(0, -1).filter((r) => (r.enqueued?.length || 0) > 0);
  if (caught.length) {
    log.warn('subscriber sweep: caught up days that had been missed', {
      days: caught.map((r) => r.date),
      enqueued: caught.reduce((n, r) => n + r.enqueued.length, 0),
    });
  }
  /*
   * `catchUp` only when there IS one, so a one-day run returns exactly the
   * shape it always did. An always-present empty key would make every caller
   * and every test carry a field that means nothing.
   */
  const earlier = runs.slice(0, -1);
  if (!earlier.length) return latest;
  return { ...latest, catchUp: earlier.map((r) => ({ date: r.date, enqueued: r.enqueued?.length ?? 0, skipped: r.skipped })) };
}

async function sweepOneDay(clients, now, day) {
  /*
   * The day marker, read first. A completed day is a complete no-op, including
   * the Shopify read: this runs once a day off a cron, and a second invocation
   * for the same day (a retry, a hand re-run, a cron that double-fired) must
   * cost nothing and reach nobody.
   */
  if (await getSweepDay(day.date)) return { skipped: 'already-swept', date: day.date };

  if (!(await templatesReady(clients))) {
    await alertOnce(
      clients,
      'template-not-approved',
      'the welcome offer template is not APPROVED at Meta, so today\'s welcome offers have NOT been sent. They are not lost: no day marker was written, so a re-run reaches them once it is approved',
      now,
    );
    return { skipped: 'template-not-approved', date: day.date };
  }

  /*
   * PAGINATED, AND A FAILURE DISCARDS EVERY PAGE.
   *
   * The real client throws on json.errors, maps THROTTLED to 429 and throws on
   * any non-2xx, so a failed customers(query:) RAISES: there is no such thing
   * as this search failing open and coming back short. The alternative to
   * discarding is the worst failure this feature has: a half-read day, a
   * marker written over it, and a hundred people who silently never get their
   * welcome code and never will.
   */
  const nodes = [];
  let after = null;
  try {
    for (;;) {
      const page = await clients.shopify.listNewCustomers({ sinceISO: day.startISO, untilISO: day.endISO, after });
      const got = page?.nodes || [];
      // An empty page ends it even if a cursor comes back with it: otherwise a
      // Shopify quirk is an infinite loop on a 300 second Lambda.
      if (!got.length) break;
      nodes.push(...got);
      if (!page.cursor) break;
      after = page.cursor;
    }
  } catch (e) {
    log.error('subscriber sweep: the customer search failed, enqueueing nothing', { err: e.message });
    await alertOnce(
      clients,
      'subscriber-search',
      `the welcome offer could not read yesterday's new customers (${String(e.message).slice(0, 120)}), so nothing has been sent. No day marker was written, so a re-run still reaches them`,
      now,
    );
    return { skipped: 'search-failed', date: day.date };
  }

  const out = { date: day.date, listed: nodes.length, enqueued: /** @type {string[]} */ ([]), skipped: /** @type {Record<string, number>} */ ({}) };
  const note = (reason) => {
    out.skipped[reason] = (out.skipped[reason] || 0) + 1;
  };

  const candidates = [];
  for (const node of nodes) {
    const n = normalizeCustomer(node);
    if (!n) {
      note('not-found');
      continue;
    }
    /*
     * A node-level window check, which is INSURANCE AGAINST A QUERY TYPO and
     * nothing more. createdAt comes back in the same response, from the same
     * index, as the filter that selected it, so it cannot contradict that
     * filter: a row that is outside the window here means the query asked for
     * the wrong window. The real guard against a stale or wrong row is the
     * worker's own customer(id:) re-read.
     */
    const at = Date.parse(n.createdAt);
    if (!(at >= Date.parse(day.startISO) && at < Date.parse(day.endISO))) {
      note('outside-window');
      continue;
    }
    const e = subscriberEligible(n, { now, startAt: config.flows.W.startAt, rules: RULES });
    if (!e.ok) {
      note(e.reason || 'ineligible');
      continue;
    }
    // Already in flight, finished, or deliberately stopped.
    if (await getSubRec(n.numericId)) {
      note('already-started');
      continue;
    }
    candidates.push(n);
  }

  /*
   * THE BLAST RADIUS, AND WHY IT COUNTS NODES.
   *
   * customersCount(query:) was tried live on 2026-10-24 and returned 475, the
   * ENTIRE customer base, for every filter including tags. A guard built on it
   * would compare 475 against 100 and refuse to run every single day, for
   * ever. So the count is of the candidates actually paged and filtered, and
   * the obvious one-query version is wrong.
   *
   * Over the limit stops the run DEAD and writes no marker. A bad query, a
   * backfilled customer import or a bot signing up five hundred accounts
   * overnight are all the same shape, and five hundred private codes with a
   * gift promise on each is not recoverable.
   */
  /*
   * THE LIMIT MUST NOT VANISH WITH ITS OWN VALUE.
   *
   * `candidates.length > w().maxPerRun` compares against undefined the moment
   * that key is renamed or dropped, and `5 > undefined` is false, so the one
   * blast radius control in this feature silently becomes "no limit" and the
   * sweep enqueues everything it found. A string limit ('100') reads the same
   * way. One bad deploy, no attacker.
   *
   * So a missing or nonsense limit is read as ZERO and the run refuses, which
   * is the direction every other switch here already fails in: DRY_RUN
   * defaults to true, an empty FLOW_W_START_AT means nobody is eligible, and
   * unreadable public codes stop the send. The owner gets the same alert, and
   * "over the limit of 0" says exactly what happened.
   */
  const cap = Number.isInteger(w().maxPerRun) && w().maxPerRun > 0 ? w().maxPerRun : 0;
  if (candidates.length > cap) {
    await alertOnce(
      clients,
      'too-many-candidates',
      `the welcome offer found ${candidates.length} new customers for ${day.date}, over the limit of ${cap}, so it has sent NOTHING. Check for a customer import or a signup bot, then re-run it by hand`,
      now,
    );
    return { skipped: 'too-many-candidates', date: day.date, candidates: candidates.length };
  }

  for (const n of candidates) {
    await enqueue(
      { kind: 'suboffer', step: 'first', customerId: n.numericId },
      // The same group id Flow R uses for a person, so the two flows cannot
      // overtake each other on the same customer. The dedupId is stable across
      // re-runs, which is what makes a partial sweep free to repeat.
      { groupId: subGroup(n), dedupId: `w-first-${n.numericId}` },
    );
    out.enqueued.push(n.numericId);
  }

  // LAST. A marker written before the enqueues would turn a crash half way
  // through into a day nobody will ever look at again.
  await setSweepDay(day.date, { enqueued: out.enqueued.length, listed: out.listed }, now);
  log.info('subscriber sweep done', { date: day.date, listed: out.listed, enqueued: out.enqueued.length, skipped: out.skipped });
  return out;
}
