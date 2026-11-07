import { describe, it, expect, beforeEach } from 'vitest';
import { summarizeDigest, countEvents, waSpendLine } from '../domain/digest.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { sanitizeParam } from '../../messages/templates.mjs';

/** The longest of the real NEXT_ACTION strings in timers/digest.mjs. */
const NEXT_ACTION_SAMPLE = 'has its pickup booked, the new parcel is not booked yet';
import { trackActiveShipments } from './track-active.mjs';
import { _resetMemory, table } from '../store/table.mjs';
import { setAwbMap } from '../store/maps.mjs';
import { getState } from '../store/orderState.mjs';
import { mapCourierStatus } from '../domain/courier-status.mjs';
import { _drainQueue } from '../queue.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';

describe('summarizeDigest', () => {
  it('counts by tag and builds one line', () => {
    const orders = [
      { tags: ['wa-cod-sent', 'wa-confirmed'] },
      { tags: ['wa-cod-sent', 'wa-prepaid-converted'] },
      { tags: ['RTO', 'rto-reason-changed-mind'] },
      { tags: ['wa-no-verified-phone'] },
    ];
    const { counts, line } = summarizeDigest(orders);
    expect(counts.cod).toBe(2);
    expect(counts.converted).toBe(1);
    expect(counts.rto).toBe(1);
    expect(counts.noPhone).toBe(1);
    expect(line).toContain('2 COD asked');
  });

  /*
   * The line that would have caught replacement_raised_v1 going out
   * unsubmitted. It is appended LAST and in capitals because it is the only
   * item in the digest about the service being broken rather than about the
   * day's orders.
   */
  it('names a template the sender cannot use, and stays quiet when all are fine', () => {
    const orders = [{ tags: ['wa-confirmed'] }];

    const bad = summarizeDigest(orders, {
      templateProblems: [
        { name: 'replacement_raised_v1', status: 'PENDING' },
        { name: 'order_shipped_v2', status: 'REJECTED' },
      ],
    }).line;
    expect(bad).toContain('TEMPLATE NOT USABLE: replacement_raised_v1 is PENDING; order_shipped_v2 is REJECTED');

    // Self silencing: once Meta approves, the digest goes back to normal with
    // no code change and nothing to switch off.
    expect(summarizeDigest(orders, { templateProblems: [] }).line).not.toContain('TEMPLATE');
    // soft() returns null on a Meta outage, which must read as a quiet day
    // rather than throw inside the digest.
    expect(summarizeDigest(orders, { templateProblems: null }).line).not.toContain('TEMPLATE');
    expect(summarizeDigest(orders).line).not.toContain('TEMPLATE');
  });

  /*
   * FLOW W'S LINE, AND THE LENGTH OF THE WHOLE THING.
   *
   * The digest is ONE WhatsApp body parameter. sanitizeParam does not
   * truncate, and Meta answers an over-long hydrated body with 132005, which
   * is in TEMPLATE_UNUSABLE: an over-long digest does not arrive shortened, it
   * makes ops_digest unsendable and the owner gets nothing at all. So the
   * welcome-offer line caps its skip reasons at the two biggest, counted, and
   * this test holds the whole rendered summary to a length that still fits
   * inside the template around it.
   */
  it('reports the welcome offers, capped, and stays inside one body parameter', () => {
    const subscribers = {
      sent: 3, whatsapp: 2, email: 1, parked: 1, converted: 1, revenuePaise: 189900,
      skips: [
        { reason: 'has-cart', count: 4 },
        { reason: 'already-ordered', count: 9 },
        { reason: 'marketing-cap', count: 2 },
        { reason: 'public-offer-better', count: 1 },
      ],
    };
    const line = summarizeDigest([{ tags: ['wa-confirmed'] }], { subscribers }).line;
    expect(line).toContain('Welcome offers: 3 sent, 2 WhatsApp, 1 email, 1 parked, 1 converted ₹1,899');
    // The two BIGGEST, in order, and the rest counted rather than listed.
    expect(line).toContain('Top welcome skips: already-ordered 9, has-cart 4, and 2 more reasons');
    expect(line).not.toContain('public-offer-better');

    // Self silencing: a day with no welcome offers adds nothing at all.
    expect(summarizeDigest([{ tags: [] }], {}).line).not.toContain('Welcome');
    expect(summarizeDigest([{ tags: [] }], { subscribers: { sent: 0, skips: [] } }).line).not.toContain('Welcome');
  });

  it('a worst-case day still renders one sendable body parameter', () => {
    /*
     * Every line at its cap at once: the welcome offers, the open
     * replacements and the unusable templates. ops_digest's own body is 105
     * characters and Meta's limit on the hydrated text is 1024, so the
     * summary has to leave room for the template around it.
     */
    const worst = summarizeDigest(
      Array.from({ length: 50 }, () => ({ tags: ['wa-cod-sent', 'wa-confirmed', 'RTO', 'wa-undeliverable'] })),
      {
        cartsMessaged: 99,
        subscribers: {
          sent: 100, whatsapp: 60, email: 40, parked: 12, converted: 9, revenuePaise: 12345600,
          skips: Array.from({ length: 12 }, (_, i) => ({ reason: `a-very-long-outcome-name-${i}`, count: 100 - i })),
        },
        replacements: Array.from({ length: 6 }, (_, i) => ({ orderName: `#120${i}`, nextAction: NEXT_ACTION_SAMPLE })),
        templateProblems: Array.from({ length: 6 }, (_, i) => ({ name: `a_long_template_name_v${i}`, status: 'REJECTED' })),
      },
    ).line;
    expect(worst.length).toBeLessThanOrEqual(1024 - 105);
    // And it survives the parameter sanitiser unchanged: no newline, no tab,
    // and no run of spaces long enough for Meta to refuse the send.
    expect(sanitizeParam(worst)).toBe(worst);
    expect(/[\n\t]/.test(worst)).toBe(false);
    expect(/ {5,}/.test(worst)).toBe(false);
  });

  it('caps the template list so one bad day cannot eat the whole digest', () => {
    const problems = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}_v1`, status: 'missing' }));
    const line = summarizeDigest([{ tags: [] }], { templateProblems: problems }).line;
    expect(line).toContain('and 2 more');
    expect(line).not.toContain('t3_v1');
  });
});

describe('trackActiveShipments', () => {
  beforeEach(() => {
    _resetMemory();
    _drainQueue();
  });

  it('enqueues on a status change and drops terminal shipments from the GSI', async () => {
    await setAwbMap('AWB1', '777');
    const clients = makeFakeClients({ courier: { statuses: { AWB1: { status: 'Delivered', statusType: 'DL' } } } });
    const r = await trackActiveShipments(clients);
    expect(r.changed).toBe(1);
    const q = _drainQueue();
    expect(q).toHaveLength(1);
    expect(q[0].message).toMatchObject({ kind: 'delhivery', awb: 'AWB1' });
    expect(q[0].groupId).toBe('order:777');
    expect(await table.scanGsi1()).toHaveLength(0); // dropped (terminal)
  });

  /*
   * The poller and the worker BOTH run mapCourierStatus, and the queue message
   * between them is what used to lose the field that decided the answer. The
   * assertion is the round trip rather than a list of field names, because
   * hardcoding the list is the same mistake one level up: whatever the mapper
   * grows to read, the message has to carry enough of it to reach the same
   * state the poller just stored.
   *
   * Real payload, AWB 59152210001271 read from Delhivery on 2026-10-12: a
   * return in progress is Status 'In Transit' with StatusType 'RT'. There is no
   * 'rto' substring anywhere, so RT is the only signal, and dropping it made
   * the worker read a plain IN_TRANSIT and route a return to no branch at all.
   */
  it('enqueues enough for the worker to re-derive the state it stored', async () => {
    await setAwbMap('AWB1', '777');
    const clients = makeFakeClients({ courier: { statuses: { AWB1: { status: 'In Transit', statusType: 'RT' } } } });
    await trackActiveShipments(clients);
    const [{ message }] = _drainQueue();
    const stored = (await getState('777'))?.courierStatus;
    expect(stored).toBe('RTO_INITIATED');
    // The message is itself a valid mapper input, which is the point.
    expect(mapCourierStatus(message)).toBe(stored);
  });

  it('does not re-enqueue when the status is unchanged', async () => {
    await setAwbMap('AWB1', '777');
    const clients = makeFakeClients({ courier: { statuses: { AWB1: { status: 'In Transit' } } } });
    await trackActiveShipments(clients);
    _drainQueue();
    const r2 = await trackActiveShipments(clients);
    expect(r2.changed).toBe(0);
    expect(_drainQueue()).toHaveLength(0);
  });

  /*
   * The same round trip as above, for the field that decides NDR. Order #1165's
   * refusal at the door is Status 'Pending' / StatusType 'UD' with the outcome
   * in StatusCode, so the message has to carry the code or the worker re-derives
   * PENDING and onDelhivery has no branch for it.
   */
  it('carries enough for the worker to re-derive a failed delivery attempt', async () => {
    await setAwbMap('AWB1', '777');
    const clients = makeFakeClients({
      courier: { statuses: { AWB1: { status: 'Pending', statusType: 'UD', statusCode: 'EOD-6O' } } },
    });
    await trackActiveShipments(clients);
    const [{ message }] = _drainQueue();
    const stored = (await getState('777'))?.courierStatus;
    expect(stored).toBe('NDR');
    expect(mapCourierStatus(message)).toBe(stored);
  });

  /*
   * A terminal state recorded by any other path left the AWB in the GSI for
   * ever, because the drop sits past the unchanged `continue`. #1165 and #1170
   * were re-tracked hourly at RTO_INITIATED for days.
   */
  it('drops a terminal shipment from the GSI even when the status has not changed', async () => {
    await setAwbMap('AWB1', '777');
    const clients = makeFakeClients({ courier: { statuses: { AWB1: { status: 'RTO In Transit', statusType: 'RT' } } } });
    await trackActiveShipments(clients); // first pass records it and drops it
    await setAwbMap('AWB1', '777'); // back in the GSI, as if another path had written it
    const r2 = await trackActiveShipments(clients);
    expect(r2.changed).toBe(0); // still unchanged, so nothing is re-sent
    expect(_drainQueue()).toHaveLength(1); // only the first pass enqueued
    expect(await table.scanGsi1()).toHaveLength(0); // and it is out of the GSI again
  });
});

/*
 * F17. An AWB is dropped from the sparse index the moment it turns terminal, so
 * whichever state the poller observes FIRST is the only one we will ever see.
 * RTO_DELIVERED and LOST were not in ACTIONABLE, so a return that completed
 * inside a polling gap was seen once, enqueued nowhere, and dropped from
 * tracking: no RTO count, no reason asked. LOST was silent in both directions.
 */
describe('terminal states the poller used to swallow', () => {
  beforeEach(() => {
    _resetMemory();
    _drainQueue();
  });

  const statusOf = (status, statusType) => ({ courier: { statuses: { AWB1: { status, statusType } } } });

  it('enqueues a return that completed between two polls', async () => {
    await setAwbMap('AWB1', '777');
    // A return that reaches the seller is reported as a delivery with an RTO
    // status string, which is why the mapper checks RTO before delivered.
    const clients = makeFakeClients(statusOf('RTO Delivered', 'DL'));
    await trackActiveShipments(clients);
    expect((await getState('777')).courierStatus).toBe('RTO_DELIVERED');
    const q = _drainQueue();
    expect(q).toHaveLength(1);
    expect(q[0].message).toMatchObject({ kind: 'delhivery', awb: 'AWB1' });
  });

  it('enqueues a lost parcel, which used to vanish entirely', async () => {
    await setAwbMap('AWB1', '777');
    const clients = makeFakeClients(statusOf('Lost', 'UD'));
    await trackActiveShipments(clients);
    expect((await getState('777')).courierStatus).toBe('LOST');
    expect(_drainQueue()).toHaveLength(1);
  });

  it('still says nothing about an ordinary in-transit scan', async () => {
    await setAwbMap('AWB1', '777');
    const clients = makeFakeClients(statusOf('In Transit', 'UD'));
    await trackActiveShipments(clients);
    expect(_drainQueue()).toHaveLength(0);
    // and it stays in the index, because it is not terminal
    expect(await table.scanGsi1()).toHaveLength(1);
  });
});

/*
 * F23. The digest counted TAGS on orders Shopify reported as updated. Every tag
 * this service writes updates the order, and so does every courier scan, so an
 * order confirmed a fortnight ago and merely touched yesterday was counted as
 * yesterday's confirmation, again, every time anything happened to it.
 */
describe('countEvents counts yesterday, and only yesterday', () => {
  // The IST day boundaries the digest uses: 00:00 IST is 18:30 UTC the day before.
  const Y_START = fromISTWall(2026, 10, 5, 0, 0).toISOString();
  const T_START = fromISTWall(2026, 10, 6, 0, 0).toISOString();
  const win = { fromISO: Y_START, toISO: T_START };
  const yesterday = fromISTWall(2026, 10, 5, 14, 0).toISOString();
  const lastWeek = fromISTWall(2026, 9, 28, 14, 0).toISOString();
  const today = fromISTWall(2026, 10, 6, 9, 0).toISOString();

  it('counts a confirmation from yesterday', () => {
    const c = countEvents([{ class: 'COD', flowA: { codConfirmAt: yesterday, confirmedAt: yesterday } }], win);
    expect(c.cod).toBe(1);
    expect(c.confirmed).toBe(1);
  });

  it('ignores the same order a week later, however often it is touched', () => {
    const c = countEvents([{ class: 'COD', flowA: { codConfirmAt: lastWeek, confirmedAt: lastWeek } }], win);
    expect(c.cod).toBe(0);
    expect(c.confirmed).toBe(0);
  });

  it('ignores today, because the digest is about yesterday', () => {
    expect(countEvents([{ class: 'COD', flowA: { codConfirmAt: today } }], win).cod).toBe(0);
  });

  it('counts each failed delivery attempt, not each order', () => {
    const c = countEvents(
      [{ flowC: { ndrAsked: { '2026-11-05': yesterday, '2026-11-04': lastWeek, '2026-11-06': today } } }],
      win,
    );
    expect(c.ndr).toBe(1);
  });

  it('counts three attempts on three days as three', () => {
    const second = fromISTWall(2026, 10, 5, 18, 0).toISOString();
    const third = fromISTWall(2026, 10, 5, 20, 0).toISOString();
    const c = countEvents([{ flowC: { ndrAsked: { a: yesterday, b: second, c: third } } }], win);
    expect(c.ndr).toBe(3);
  });

  it('counts an RTO when the return happened, not when the customer replied', () => {
    expect(countEvents([{ flowC: { rtoAt: yesterday } }], win).rto).toBe(1);
    expect(countEvents([{ flowC: { rtoAt: lastWeek, rtoReason: 'not_needed' } }], win).rto).toBe(0);
  });

  it('counts a review ask as the delivery, and the review separately', () => {
    const c = countEvents([{ flowB: { askedAt: yesterday, reviewedAt: yesterday } }], win);
    expect(c.delivered).toBe(1);
    expect(c.reviewed).toBe(1);
  });

  it('counts the holds, the no-phone skips and the customers not reached', () => {
    const c = countEvents(
      [
        { flowA: { heldAt: yesterday } },
        { flowA: { codSkip: 'no-phone-anywhere', codSkipAt: yesterday } },
        { flowA: { codSkip: 'opted-out', codSkipAt: yesterday } },
        { flowA: { undeliverableAt: yesterday } },
      ],
      win,
    );
    expect(c.holds).toBe(1);
    expect(c.noPhone).toBe(1); // the opted-out skip is a different thing
    expect(c.undelivered).toBe(1);
  });

  it('leaves a PREPAID order out of "COD asked", which was never a question', () => {
    expect(countEvents([{ class: 'PREPAID', flowA: { codConfirmAt: yesterday } }], win).cod).toBe(0);
  });

  it('survives a state row with no flow objects at all', () => {
    expect(countEvents([{}, { flowA: null }, null], win).cod).toBe(0);
  });
});

/*
 * N9. Nothing said what this service spends on WhatsApp. The owner could read
 * it in WhatsApp Manager, a screen they do not otherwise use, so the largest
 * variable cost in the automation was invisible beside freight and COGS.
 *
 * Marketing is roughly seven times utility, which is why O8 and O9 exist and
 * why a template silently recategorised to MARKETING is worth an urgent alert.
 */
describe('what WhatsApp cost this month', () => {
  const rates = { marketing: 0.86, utility: 0.115, service: 0.115 };

  it('counts by category and prices the billable ones', () => {
    const line = waSpendLine({ 'marketing#billable': 30, 'utility#billable': 100 }, rates);
    expect(line).toContain('30 marketing');
    expect(line).toContain('100 utility');
    // 30 x 0.86 + 100 x 0.115 = 25.80 + 11.50 = 37.30
    expect(line).toContain('37.30');
  });

  it('charges nothing for a message Meta did not bill', () => {
    const line = waSpendLine({ 'utility#free': 500 }, rates);
    expect(line).toContain('500 utility');
    expect(line).not.toMatch(/about ₹|about Rs/);
  });

  it('names how close the free service allowance is', () => {
    expect(waSpendLine({ SERVICE: 910 }, rates)).toContain('910 of 1,000 free');
  });

  /*
   * The share of sends Meta turns away is the number that explains why a flow
   * "is not working": roughly a third of this store's marketing sends.
   */
  it('counts what Meta refused, which is not billed but matters more', () => {
    const line = waSpendLine({ 'marketing#billable': 10, 'REFUSED#131049': 7, 'REFUSED#130472': 2 }, rates);
    expect(line).toContain('refused by Meta: 9');
  });

  it('adds nothing at all in a month with nothing counted', () => {
    expect(waSpendLine({}, rates)).toBe('');
  });

  /*
   * Meta's field shape is not something this code has seen live, so an
   * unrecognised category must land somewhere visible rather than throw.
   */
  it('shows an unknown category rather than hiding it', () => {
    expect(waSpendLine({ 'unknown#billable': 3 }, rates)).toContain('3 unknown');
  });

  it('does not accumulate floating-point error over a few hundred messages', () => {
    /*
     * 200 x 0.115 is exactly 23. Rounding the RATE to whole paise first takes
     * 11.5 to 12 and reads as 24: a cost line confidently several percent out.
     * formatINR drops the paise when they are zero, hence '23' and not '23.00'.
     */
    expect(waSpendLine({ 'utility#billable': 200 }, rates)).toContain('₹23');
    expect(waSpendLine({ 'utility#billable': 200 }, rates)).not.toContain('₹24');
  });
});
