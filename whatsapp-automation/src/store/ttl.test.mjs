/*
 * O4. STATE, ORDER MSG#, AWB#, PAYLINK# and WAMID# rows had no TTL at all, so
 * every order added rows that stayed forever: storage, point-in-time-recovery
 * size and every remaining scan grew with how long the shop had been open
 * rather than with the work it was doing.
 *
 * A backfill dry run on 2026-11-07 found 739 rows in the live table with no
 * expiry, against 113 that had one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { table, _resetMemory } from './table.mjs';
import { RULES } from '../../messages/rules.mjs';
import { ensureState, patchState, recordMessage } from './orderState.mjs';
import { setAwbMap, setPaylinkMap, setPayTokenMap, setWamidMap } from './maps.mjs';
import { setOptOut, getProfile } from './phoneProfile.mjs';

beforeEach(_resetMemory);

const days = (row) => Math.round((row.expiresAt - Date.now() / 1000) / 86400);

describe('every row that is not a lifetime record expires', () => {
  it('the order state row, at 400 days', async () => {
    await ensureState('12345', {});
    const row = await table.get('ORDER#12345', 'STATE');
    expect(days(row)).toBe(RULES.stateTtlDays);
  });

  it('a message row, at 180: it is a log, not the order s memory', async () => {
    await recordMessage('12345', 'wamid.ABC', { key: 'cod_confirm' });
    const row = await table.get('ORDER#12345', 'MSG#wamid.ABC');
    expect(days(row)).toBe(RULES.stateRetentionDays);
  });

  it('the lookup rows, which are all provider id back to order', async () => {
    await setAwbMap('AWB1', '12345');
    await setPaylinkMap('plink_1', '12345');
    await setWamidMap('wamid.ABC', { orderId: '12345', key: 'cod_confirm' });
    for (const pk of ['AWB#AWB1', 'PAYLINK#plink_1', 'WAMID#wamid.ABC']) {
      expect(days(await table.get(pk, 'MAP')), pk).toBe(RULES.stateRetentionDays);
    }
  });

  it('and they record WHEN, so the next migration has something to compute from', async () => {
    await setAwbMap('AWB1', '12345');
    expect((await table.get('AWB#AWB1', 'MAP')).at).toBeTruthy();
  });

  /*
   * The one honest coincidence: the row is worthless the moment the Razorpay
   * link it points at is dead, and /p/{token} already shows the expired page
   * when the row has gone. The caller's value must WIN over the default.
   */
  it('a pay token keeps the link s own expiry, not the 180 day default', async () => {
    const linkExpiry = Math.floor(Date.now() / 1000) + 24 * 3600;
    await setPayTokenMap('tok123', { orderId: '12345', url: 'https://rzp.io/x', expiresAt: linkExpiry });
    expect((await table.get('PAYTOKEN#tok123', 'MAP')).expiresAt).toBe(linkExpiry);
  });
});

describe('what must never expire', () => {
  /*
   * An expired opt-out is marketing to somebody who said stop, and an expired
   * welcome-offer lock is a second free Rs 200 code. Neither row has an
   * expiresAt, and the backfill script skips both by sort key.
   */
  it('a phone profile, which holds the opt-out and the RTO count', async () => {
    await setOptOut('+919812345678', true);
    expect((await getProfile('+919812345678')).expiresAt).toBeUndefined();
  });
});

describe('a patch does not reset the clock', () => {
  /*
   * update() spreads the current row before the patch, so expiresAt survives.
   * If it did not, a flow that writes often would keep pushing its own state
   * row's expiry forward and nothing would ever be evicted.
   */
  it('keeps the original expiry through a patch', async () => {
    await ensureState('12345', {});
    const before = (await table.get('ORDER#12345', 'STATE')).expiresAt;
    await patchState('12345', { name: '#1234' });
    await patchState('12345', { class: 'COD' });
    const after = await table.get('ORDER#12345', 'STATE');
    expect(after.expiresAt).toBe(before);
    expect(after.name).toBe('#1234'); // and the patch still applied
  });
});
