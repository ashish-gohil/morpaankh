/*
 * The Flow W sweep, which decides nothing.
 *
 * It runs ONCE A DAY at 11:00 IST off cron(30 5 * * ? *), reads yesterday's new
 * customers, and enqueues. Every real decision belongs to the worker, which
 * re-reads the customer and re-checks every gate, so the worst a wrong answer
 * here can do is cost a queue message.
 *
 * The one genuinely dangerous line in the feature is the reconcile mode
 * dispatch, which collapses anything unrecognised to 'full'. 'full' runs
 * sweepUnreviewed, which SENDS review asks to real customers, and
 * sweepUnconfirmed runs ABOVE the mode branch, so { mode: 'subscribers' }
 * MUST be handled and returned at the very top of the handler.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { table, _resetMemory } from '../store/table.mjs';
import { _drainQueue } from '../queue.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { emailKey, istYesterdayWindow } from '../domain/subscriberOffer.mjs';
import { ensureSubRec, getSweepDay } from '../store/subscriberOffer.mjs';
import { sweepNewSubscribers } from './subscriber-sweep.mjs';
import { handler as reconcileHandler } from './reconcile.mjs';

const NOW = fromISTWall(2026, 9, 24, 11, 0); // 11:00 IST on 24 Oct 2026
const YESTERDAY = istYesterdayWindow(NOW); // the IST day of 23 Oct
const PHONE = '+919637361371';
const EMAIL = 'priya.test@example.com';
const UNSUB = 'https://www.morpaankh.in/unsubscribe?id=abc';

const customer = (id, over = {}) => ({
  id: `gid://shopify/Customer/${id}`,
  createdAt: '2026-10-23T05:00:00Z', // 10:30 IST on 23 Oct, inside the window
  firstName: 'Priya',
  lastName: 'Sharma',
  numberOfOrders: '0',
  tags: [],
  defaultEmailAddress: { emailAddress: EMAIL, marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: UNSUB },
  defaultPhoneNumber: { phoneNumber: PHONE },
  ...over,
});

/* subscriber_offer_v1 and its twin, both approved: the quiet case. */
const APPROVED = { subscriber_offer_v1: 'APPROVED', subscriber_offer_plain_v1: 'APPROVED' };

/*
 * The Flow W half of the Shopify client, attached to the existing fake, which
 * this suite may not edit. `pages` is served in order and each call must carry
 * the previous page's cursor as `after`, which is how the pagination test can
 * tell a real loop from one page read twice.
 */
function setup({ customers = [], pages = null, templates = APPROVED, failSearch = null, failOnPage = null } = {}) {
  const clients = makeFakeClients({ whatsapp: { templates } });
  let i = 0;
  clients.shopify.listNewCustomers = async (args) => {
    clients.shopify.calls.push({ op: 'listNewCustomers', args });
    /*
     * The real client throws on json.errors, maps THROTTLED to 429, and throws
     * on any non-2xx. A failed customers(query:) therefore RAISES; it cannot
     * come back as a short list, so there is no such thing as this search
     * failing open.
     */
    if (failSearch) throw new Error(String(failSearch));
    if (failOnPage !== null && i === failOnPage) throw new Error('THROTTLED');
    if (!pages) return { nodes: customers, cursor: null };
    const page = pages[i] || { nodes: [], cursor: null };
    i += 1;
    return page;
  };
  return clients;
}

const listCalls = (clients) => clients.shopify.calls.filter((c) => c.op === 'listNewCustomers').map((c) => c.args);
const alerts = (wa) => wa.sent.filter((s) => s.type === 'template' && s.name.startsWith('ops_alert'));

beforeEach(() => {
  _resetMemory();
  _drainQueue();
  config.ownerAlertPhones = ['+919999999999'];
  config.flows.W = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
});

// ---------------------------------------------------------------------------
describe('the daily sweep', () => {
  it('asks Shopify for yesterday in IST and enqueues on the phone group', async () => {
    const clients = setup({ customers: [customer('A1')] });
    const out = await sweepNewSubscribers(clients, NOW);

    expect(out.enqueued).toEqual(['A1']);
    expect(listCalls(clients)[0]).toMatchObject({ sinceISO: YESTERDAY.startISO, untilISO: YESTERDAY.endISO });

    const q = _drainQueue();
    expect(q).toHaveLength(1);
    expect(q[0].message).toEqual({ kind: 'suboffer', step: 'first', customerId: 'A1' });
    // The same group id Flow R uses, so the two cannot overtake each other on
    // the same person.
    expect(q[0].groupId).toBe(`phone:${PHONE}`);
    expect(q[0].dedupId).toBe('w-first-A1');
  });

  it('groups on the email hash when there is no reachable number', async () => {
    const clients = setup({ customers: [customer('A2', { defaultPhoneNumber: null })] });
    await sweepNewSubscribers(clients, NOW);
    const [q] = _drainQueue();
    expect(q.groupId).toBe(`email:${emailKey(EMAIL)}`);
    // Never the raw address: a group id lands in SQS metadata and in logs.
    expect(q.groupId).not.toContain('priya');
  });

  it('writes the day marker only AFTER a complete sweep', async () => {
    const clients = setup({ customers: [customer('A1')] });
    expect(await getSweepDay(YESTERDAY.date)).toBe(null);
    await sweepNewSubscribers(clients, NOW);
    expect(await getSweepDay(YESTERDAY.date)).toBeTruthy();
  });

  it('a completed day re-runs as a no-op', async () => {
    const clients = setup({ customers: [customer('A1')] });
    await sweepNewSubscribers(clients, NOW);
    _drainQueue();

    const again = await sweepNewSubscribers(clients, NOW);
    expect(again).toEqual({ skipped: 'already-swept', date: YESTERDAY.date });
    expect(_drainQueue()).toHaveLength(0);
    // And it did not even ask Shopify a second time.
    expect(listCalls(clients)).toHaveLength(1);
  });

  /*
   * A run that died after enqueueing two of three people leaves no marker, so
   * the next run reads the same day again. That is SAFE and must stay safe:
   * the dedupId is identical, so SQS drops the duplicate inside its window,
   * and anyone the worker already reached has a SUB row that stops them here.
   */
  it('a partial-sweep re-run enqueues no duplicates', async () => {
    const clients = setup({ customers: [customer('A1'), customer('A2'), customer('A3')] });
    const first = await sweepNewSubscribers(clients, NOW);
    expect(first.enqueued).toEqual(['A1', 'A2', 'A3']);
    const firstQ = _drainQueue();

    /*
     * THE STATE A DIED RUN LEAVES, which is no marker at all. The run above
     * completed, so it wrote one, and the completed-day no-op test below is
     * what proves a marker stops a re-run dead. Deleting it here is how this
     * test reaches the case it is actually about: the marker is written LAST,
     * so a crash anywhere before that leaves the day unmarked and the next run
     * reads it again.
     */
    await table.del(`SUBOFFER#RUN#${YESTERDAY.date}`, 'DAY');
    expect(await getSweepDay(YESTERDAY.date)).toBe(null);

    // A1 has been handled by the worker since; A2 and A3 have not.
    await ensureSubRec('A1', { phone: PHONE }, NOW);

    const second = await sweepNewSubscribers(clients, NOW);
    expect(second.enqueued).toEqual(['A2', 'A3']);
    expect(second.skipped).toMatchObject({ 'already-started': 1 });

    const secondQ = _drainQueue();
    // Byte-identical dedup ids, which is what makes the re-run free.
    expect(secondQ.map((m) => m.dedupId)).toEqual(['w-first-A2', 'w-first-A3']);
    for (const m of secondQ) {
      expect(firstQ.find((f) => f.message.customerId === m.message.customerId).dedupId).toBe(m.dedupId);
    }
  });

  it('does nothing when the flow is off', async () => {
    config.flows.W = { enabled: false, startAt: '2026-10-01T00:00:00Z' };
    const clients = setup({ customers: [customer('A1')] });
    expect(await sweepNewSubscribers(clients, NOW)).toEqual({ skipped: 'flow-w-off' });
    expect(_drainQueue()).toHaveLength(0);
    expect(await getSweepDay(YESTERDAY.date)).toBe(null);
  });

  it('with no startAt at all, nothing qualifies', async () => {
    config.flows.W = { enabled: true, startAt: '' };
    const clients = setup({ customers: [customer('A1')] });
    expect((await sweepNewSubscribers(clients, NOW)).enqueued).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('what the sweep drops', () => {
  /*
   * The node-level re-check is INSURANCE AGAINST A QUERY TYPO, and the comment
   * in the sweep must say that rather than claim it defends against staleness:
   * createdAt and numberOfOrders come back in the same search response, from
   * the same index, so they cannot contradict the filter that selected them.
   * The real gate against a stale or wrong row is the worker's customer(id:)
   * re-read.
   */
  const dropped = [
    ['created today, which the query should never have returned', { createdAt: '2026-10-24T04:00:00Z' }, 'outside-window'],
    ['created the day before yesterday', { createdAt: '2026-10-22T05:00:00Z' }, 'outside-window'],
    ['created exactly at today 00:00 IST, the exclusive end', { createdAt: YESTERDAY.endISO }, 'outside-window'],
    ['has already ordered', { numberOfOrders: '1' }, 'already-ordered'],
    ['carries an excluded tag', { tags: ['no-marketing'] }, 'excluded-tag'],
    ['unreachable by either channel', { defaultPhoneNumber: null, defaultEmailAddress: null }, 'no-channel'],
  ];

  it.each(dropped)('drops one that %s', async (_n, over, reason) => {
    const clients = setup({ customers: [customer('A1', over)] });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out.enqueued).toEqual([]);
    expect(out.skipped).toMatchObject({ [reason]: 1 });
    expect(_drainQueue()).toHaveLength(0);
  });

  /*
   * OWNER'S CORRECTION, 2026-10-24. This was a `no-phone` DROP, which read an
   * unusable number as terminal. It is not: a foreign number or a landline is
   * WhatsApp being impossible, which is what the email channel exists for, and
   * the email group id in the enqueue below only exists because email-only
   * candidates are meant to reach the worker.
   */
  it('keeps one whose number we cannot use, on the email group', async () => {
    const clients = setup({ customers: [customer('A1', { defaultPhoneNumber: { phoneNumber: '+14155550123' } })] });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out.enqueued).toEqual(['A1']);
    const [q] = _drainQueue();
    expect(q.groupId).toBe(`email:${emailKey(EMAIL)}`);
  });

  it('keeps one created at exactly yesterday 00:00 IST, the inclusive start', async () => {
    const clients = setup({ customers: [customer('A1', { createdAt: YESTERDAY.startISO })] });
    expect((await sweepNewSubscribers(clients, NOW)).enqueued).toEqual(['A1']);
  });

  it('drops a node Shopify sent back as nothing', async () => {
    const clients = setup({ customers: [null, customer('A1')] });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out.enqueued).toEqual(['A1']);
    expect(out.skipped).toMatchObject({ 'not-found': 1 });
  });
});

// ---------------------------------------------------------------------------
describe('the blast radius', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => customer(`C${i}`, { defaultPhoneNumber: { phoneNumber: `+9196000000${String(i).padStart(2, '0')}` } }));

  it('enqueues nothing at all once there are more candidates than maxPerRun', async () => {
    // A single bad query, a backfilled import, or a bot signing up 500 accounts
    // overnight. Sending 500 private codes is unrecoverable, so the sweep stops
    // dead and asks a human instead.
    const over = RULES.subscriberOffer.maxPerRun + 1;
    const clients = setup({ customers: many(over) });
    const out = await sweepNewSubscribers(clients, NOW);

    expect(out).toMatchObject({ skipped: 'too-many-candidates', candidates: over });
    expect(_drainQueue()).toHaveLength(0);
    expect(await getSweepDay(YESTERDAY.date)).toBe(null); // so it can be re-run by hand
    expect(alerts(clients.whatsapp)).toHaveLength(1);
    expect(JSON.stringify(alerts(clients.whatsapp))).toMatch(/\b101\b/);
  });

  /*
   * THE GUARD MUST NOT VANISH WITH ITS OWN VALUE.
   *
   * `candidates.length > w().maxPerRun` compares against undefined if that key
   * is ever renamed or dropped, and `5 > undefined` is false, so the ONE blast
   * radius control in this feature silently became "no limit" and the sweep
   * enqueued everything it found. No attacker needed: one bad deploy. Every
   * other switch in this service fails closed (DRY_RUN defaults to true, an
   * empty FLOW_W_START_AT means nobody is eligible, unreadable public codes
   * refuse the send), and this one failed open.
   */
  it('a missing maxPerRun refuses the run instead of becoming no limit', async () => {
    const was = RULES.subscriberOffer.maxPerRun;
    delete RULES.subscriberOffer.maxPerRun;
    try {
      const clients = setup({ customers: many(3) });
      const out = await sweepNewSubscribers(clients, NOW);
      expect(out.skipped).toBe('too-many-candidates');
      expect(_drainQueue()).toHaveLength(0);
      expect(await getSweepDay(YESTERDAY.date)).toBe(null);
      expect(alerts(clients.whatsapp)).toHaveLength(1);
    } finally {
      RULES.subscriberOffer.maxPerRun = was;
    }
  });

  it('and the same for a nonsense limit', async () => {
    const was = RULES.subscriberOffer.maxPerRun;
    for (const bad of [0, -1, 1.5, '100', null]) {
      _resetMemory();
      RULES.subscriberOffer.maxPerRun = /** @type {any} */ (bad);
      const clients = setup({ customers: many(3) });
      // eslint-disable-next-line no-await-in-loop
      const out = await sweepNewSubscribers(clients, NOW);
      expect(out.skipped, String(bad)).toBe('too-many-candidates');
      expect(_drainQueue(), String(bad)).toHaveLength(0);
    }
    RULES.subscriberOffer.maxPerRun = was;
  });

  it('runs at exactly maxPerRun, because the limit is a limit and not a fence', async () => {
    const clients = setup({ customers: many(RULES.subscriberOffer.maxPerRun) });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out.enqueued).toHaveLength(RULES.subscriberOffer.maxPerRun);
  });

  it('counts only the ELIGIBLE candidates towards maxPerRun', async () => {
    // 200 signups of which 198 already ordered is a normal day, not a breach.
    const ordered = Array.from({ length: 200 }, (_, i) => customer(`O${i}`, { numberOfOrders: '2' }));
    const clients = setup({ customers: [...ordered, customer('A1')] });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out.enqueued).toEqual(['A1']);
  });

  it('enqueues nothing while the template is not APPROVED, and alerts once', async () => {
    const clients = setup({
      customers: [customer('A1')],
      templates: { subscriber_offer_v1: 'PENDING', subscriber_offer_plain_v1: 'APPROVED' },
    });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out).toMatchObject({ skipped: 'template-not-approved' });
    expect(_drainQueue()).toHaveLength(0);
    expect(await getSweepDay(YESTERDAY.date)).toBe(null);
    expect(alerts(clients.whatsapp)).toHaveLength(1);

    // A second run the same day says nothing more.
    await sweepNewSubscribers(clients, NOW);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  it('also stops when Meta has never heard of the template at all', async () => {
    const clients = setup({ customers: [customer('A1')], templates: {} });
    expect(await sweepNewSubscribers(clients, NOW)).toMatchObject({ skipped: 'template-not-approved' });
  });
});

// ---------------------------------------------------------------------------
describe('a search that fails, fails CLOSED', () => {
  /*
   * R10. The alternative would be the worst possible failure for this feature:
   * a half-read day, a day marker written over it, and a hundred people who
   * silently never get their welcome code and never will, because the offer is
   * once per person ever and the sweep will not look at that day again.
   */
  it('enqueues nothing, writes no day marker, and tells the owner', async () => {
    const clients = setup({ customers: [customer('A1')], failSearch: 'Access denied for customers field' });
    const out = await sweepNewSubscribers(clients, NOW);

    expect(out).toMatchObject({ skipped: 'search-failed' });
    expect(_drainQueue()).toHaveLength(0);
    // No marker, so tomorrow`s run or a hand re-run can still reach these people.
    expect(await getSweepDay(YESTERDAY.date)).toBe(null);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  it('does not throw out of the handler, so the daily rule is not a dead letter', async () => {
    const clients = setup({ failSearch: 'THROTTLED' });
    await expect(sweepNewSubscribers(clients, NOW)).resolves.toMatchObject({ skipped: 'search-failed' });
  });

  it('alerts once a day, even across two runs', async () => {
    const clients = setup({ failSearch: 'THROTTLED' });
    await sweepNewSubscribers(clients, NOW);
    await sweepNewSubscribers(clients, NOW);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  it('a failure on the SECOND page discards the first page too', async () => {
    // Half a day enqueued and a marker written is the same permanent loss.
    const clients = setup({
      pages: [{ nodes: [customer('P1'), customer('P2')], cursor: 'cur-1' }, { nodes: [], cursor: null }],
      failOnPage: 1,
    });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out).toMatchObject({ skipped: 'search-failed' });
    expect(_drainQueue()).toHaveLength(0);
    expect(await getSweepDay(YESTERDAY.date)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
describe('pagination', () => {
  it('follows the cursor until Shopify stops giving one', async () => {
    const clients = setup({
      pages: [
        { nodes: [customer('P1'), customer('P2')], cursor: 'cur-1' },
        { nodes: [customer('P3')], cursor: 'cur-2' },
        { nodes: [customer('P4')], cursor: null },
      ],
    });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out.enqueued).toEqual(['P1', 'P2', 'P3', 'P4']);

    const calls = listCalls(clients);
    expect(calls).toHaveLength(3);
    // Every page asks for the SAME day, and carries the previous cursor.
    for (const c of calls) {
      expect(c.sinceISO).toBe(YESTERDAY.startISO);
      expect(c.untilISO).toBe(YESTERDAY.endISO);
    }
    expect(calls.map((c) => c.after || null)).toEqual([null, 'cur-1', 'cur-2']);
  });

  it('stops on an empty page even if a cursor comes back with it', async () => {
    // Otherwise a Shopify quirk is an infinite loop on a 300 second Lambda.
    const clients = setup({ pages: [{ nodes: [], cursor: 'cur-1' }] });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out.enqueued).toEqual([]);
    expect(listCalls(clients)).toHaveLength(1);
  });

  it('counts candidates across pages, so maxPerRun cannot be paged around', async () => {
    const page = (p) => ({
      nodes: Array.from({ length: 60 }, (_, i) => customer(`${p}-${i}`, { defaultPhoneNumber: { phoneNumber: `+919${p}0000${String(i).padStart(3, '0')}` } })),
      cursor: p === 'b' ? null : 'next',
    });
    const clients = setup({ pages: [page('a'), page('b')] });
    const out = await sweepNewSubscribers(clients, NOW);
    expect(out).toMatchObject({ skipped: 'too-many-candidates', candidates: 120 });
    expect(_drainQueue()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the reconcile mode dispatch', () => {
  it("{ mode: 'subscribers' } runs the subscriber sweep and nothing else", async () => {
    config.flows.W = { enabled: false, startAt: '' };
    const out = await reconcileHandler({ mode: 'subscribers' });
    expect(out).toMatchObject({ ok: true, mode: 'subscribers' });
    expect(out.subscribers).toEqual({ skipped: 'flow-w-off' });
    /*
     * ABSENT, not merely falsy. sweepUnreviewed sends review asks to real
     * customers, sweepUnconfirmed re-arms Flow A, and both run above or inside
     * the 'full' branch this event must never reach.
     */
    for (const k of ['orders', 'reviews', 'shipments', 'webhooks', 'carts']) expect(out[k]).toBeUndefined();
  });

  it("leaves 'carts', 'orders' and the nightly pass exactly as they were", async () => {
    config.flows.R = { enabled: false, startAt: '' };
    const carts = await reconcileHandler({ mode: 'carts' });
    expect(carts.mode).toBe('carts');
    expect(carts.subscribers).toBeUndefined();

    const orders = await reconcileHandler({ mode: 'orders' });
    expect(orders.mode).toBe('orders');
    expect(orders.subscribers).toBeUndefined();

    const full = await reconcileHandler({});
    expect(full.mode).toBe('full');
    expect(full.subscribers).toBeUndefined();
  });
});
