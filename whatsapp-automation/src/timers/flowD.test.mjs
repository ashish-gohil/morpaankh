import { describe, it, expect, beforeEach } from 'vitest';
import { summarizeDigest } from '../domain/digest.mjs';
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
