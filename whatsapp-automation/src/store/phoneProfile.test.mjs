import { describe, it, expect, beforeEach } from 'vitest';
import { _resetMemory, table } from './table.mjs';
import {
  setOptOut, isOptedOut, markMarketing, touchInbound,
  setUndeliverable, clearUndeliverable, isUndeliverable, markRto, getProfile,
  setAwaiting, getAwaiting, listAwaiting, clearAwaiting,
} from './phoneProfile.mjs';
import { RULES } from '../../messages/rules.mjs';

const P = '+919999900001';
beforeEach(() => _resetMemory());

describe('phone profile writes do not clobber each other', () => {
  it('a concurrent marketing stamp cannot erase an opt-out', async () => {
    // The real race, reproduced: two records for the same phone are in flight at
    // once, because the queue serializes by ORDER, not by phone. Both reads land
    // before either write. Started together, not awaited in turn, or there is no
    // interleaving to test.
    await touchInbound(P);
    await Promise.all([setOptOut(P, true), markMarketing(P)]);
    const after = await getProfile(P);
    expect(after.optOut).toBe(true); // the customer said STOP; that must survive
    expect(after.lastMarketingAt).toBeTruthy();
  });

  it('a concurrent inbound cannot resurrect a phone we just blocked', async () => {
    await Promise.all([setUndeliverable(P), markMarketing(P)]);
    expect(await isUndeliverable(P)).toBe(true);
  });

  it('two RTOs land as two, not one', async () => {
    const counts = await Promise.all([markRto(P), markRto(P)]);
    expect(counts.sort()).toEqual([1, 2]);
    expect((await getProfile(P)).rtoCount).toBe(2);
  });
});

describe('undeliverable is a window, not a life sentence', () => {
  it('blocks right after the bounce', async () => {
    await setUndeliverable(P);
    expect(await isUndeliverable(P)).toBe(true);
  });

  it('expires, so the number gets another chance', async () => {
    await setUndeliverable(P);
    const later = new Date(Date.now() + (RULES.undeliverableRetryDays + 1) * 86400 * 1000);
    expect(await isUndeliverable(P, later)).toBe(false);
  });

  it('an inbound message clears it immediately', async () => {
    await setUndeliverable(P);
    expect(await isUndeliverable(P)).toBe(true);
    await touchInbound(P); // they just wrote to us: the number plainly works
    expect(await isUndeliverable(P)).toBe(false);
  });

  it('clearUndeliverable also drops the timestamp, so it cannot re-block', async () => {
    await setUndeliverable(P);
    await clearUndeliverable(P);
    const p = await getProfile(P);
    expect(p.undeliverable).toBe(false);
    expect(p.undeliverableAt).toBeFalsy();
  });

  it('a flag with no timestamp still blocks (rows written before the expiry existed)', async () => {
    await table.put({ PK: `PHONE#${P}`, SK: 'PROFILE', phone: P, undeliverable: true });
    expect(await isUndeliverable(P)).toBe(true);
  });
});

/*
 * F26. `awaiting` was ONE slot per phone, so a customer with two orders in
 * trouble lost a question silently: the NDR address question for order X was
 * overwritten by the RTO "why" question for order Y, and their next message was
 * read as the answer to whichever survived. On the address path that means an
 * address pushed to the courier against the wrong waybill.
 */
describe('two open questions on one phone', () => {
  const P = '+919812345678';
  const soon = () => new Date(Date.now() + 3600 * 1000).toISOString();

  it('keeps both, rather than one overwriting the other', async () => {
    await setAwaiting(P, { type: 'address', orderId: '111', until: soon() });
    await setAwaiting(P, { type: 'rto_other', orderId: '222', until: soon() });
    const open = await listAwaiting(P);
    expect(open.map((a) => a.orderId).sort()).toEqual(['111', '222']);
  });

  it('answers "which one" with null, so no reply can be misapplied', async () => {
    await setAwaiting(P, { type: 'address', orderId: '111', until: soon() });
    await setAwaiting(P, { type: 'rto_other', orderId: '222', until: soon() });
    expect(await getAwaiting(P)).toBe(null);
  });

  it('routes normally again once one is closed', async () => {
    await setAwaiting(P, { type: 'address', orderId: '111', until: soon() });
    await setAwaiting(P, { type: 'rto_other', orderId: '222', until: soon() });
    await clearAwaiting(P, '222');
    expect(await getAwaiting(P)).toMatchObject({ type: 'address', orderId: '111' });
  });

  it('still expires an unanswered question', async () => {
    await setAwaiting(P, { type: 'address', orderId: '111', until: new Date(Date.now() - 1000).toISOString() });
    expect(await listAwaiting(P)).toEqual([]);
    expect(await getAwaiting(P)).toBe(null);
  });

  it('still reads a question opened before this change, with no order key', async () => {
    await setAwaiting(P, { type: 'address', until: soon() });
    expect(await getAwaiting(P)).toMatchObject({ type: 'address' });
  });

  it('clears everything when no order is named', async () => {
    await setAwaiting(P, { type: 'address', orderId: '111', until: soon() });
    await setAwaiting(P, { type: 'rto_other', orderId: '222', until: soon() });
    await clearAwaiting(P);
    expect(await listAwaiting(P)).toEqual([]);
  });
});
