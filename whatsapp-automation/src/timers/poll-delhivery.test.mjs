/*
 * O12. The poller runs hourly from 08:00 to 22:00 IST and is the only source of
 * NDR, delivery and RTO, because Delhivery has not enabled the status push for
 * this account: 2 invocations in 30 days against the poller's 452.
 *
 * Once the push IS live, hourly polling is redundant work. But "is the push
 * live" has to be an OBSERVATION rather than a flag, because the failure that
 * matters is the push going quiet without anybody noticing, which is a day of
 * parcels nobody is watching.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetMemory } from '../store/table.mjs';
import { _drainQueue } from '../queue.mjs';
import { config } from '../config.mjs';
import { setAwbMap, markDelhiveryPush } from '../store/maps.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { realClients } from '../clients/index.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { handler } from './poll-delhivery.mjs';

let tracked;
beforeEach(() => {
  _resetMemory();
  _drainQueue();
  config.dryRun = true; // no owner template actually leaves
  config.ownerAlertPhones = [];
  tracked = 0;
  const fake = makeFakeClients({ courier: { statuses: { AWB1: { status: 'In Transit', statusType: 'UD' } } } });
  vi.spyOn(realClients.courier, 'track').mockImplementation(async (awbs) => {
    tracked += 1;
    return fake.courier.track(awbs);
  });
});

const at = (h) => vi.setSystemTime(fromISTWall(2026, 11, 7, h, 0));

describe('while the push is not live', () => {
  it('tracks every hour, because it is the only source', async () => {
    await setAwbMap('AWB1', '777');
    at(11);
    const out = await handler();
    expect(out.skipped).toBeUndefined();
    expect(tracked).toBe(1);
  });
});

describe('once the push is delivering', () => {
  beforeEach(async () => {
    await setAwbMap('AWB1', '777');
    await markDelhiveryPush(fromISTWall(2026, 11, 7, 8, 0));
  });

  it('skips an ordinary hour without touching Delhivery at all', async () => {
    at(11);
    const out = await handler();
    expect(out.skipped).toBe('push-is-live');
    // The whole saving is in not making the request: assert zero calls, not a
    // faster one.
    expect(tracked).toBe(0);
  });

  it('still reconciles three times a day', async () => {
    for (const h of [9, 14, 19]) {
      at(h);
      const out = await handler();
      expect(out.skipped, `hour ${h}`).toBeUndefined();
    }
    expect(tracked).toBe(3);
  });
});

describe('when the push goes quiet', () => {
  it('takes over hourly again rather than trusting a flag', async () => {
    await setAwbMap('AWB1', '777');
    // It worked two days ago and has said nothing since.
    await markDelhiveryPush(fromISTWall(2026, 11, 5, 8, 0));
    at(11);
    const out = await handler();
    expect(out.skipped).toBeUndefined();
    expect(tracked).toBe(1);
  });
});
