/*
 * router.test.mjs — worker/index.mjs had no test of its own. It is the piece
 * that decides whose order a tap acts on and what happens to a send that
 * WhatsApp accepted and then failed to deliver, so both were unguarded.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { ensureState, patchState, recordMessage, getSide, updateMessageStatus } from '../store/orderState.mjs';
import { table } from '../store/table.mjs';
import { setUndeliverable, isUndeliverable } from '../store/phoneProfile.mjs';
import { setAwaiting, getAwaiting, markMarketing, canSendMarketing } from '../store/phoneProfile.mjs';
import { RULES } from '../../messages/rules.mjs';
import { routes } from './index.mjs';
import { getRec, ensureRec, patchRec } from '../store/cartRecovery.mjs';

const OWNER = '+919812345678';
const STRANGER = '+919800000000';

beforeEach(() => {
  _resetMemory();
  config.ownerAlertPhones = ['+919999999999'];
});

describe('a button tap may only act on the tapper own order', () => {
  beforeEach(async () => {
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: OWNER, name: '#1234' });
  });

  const tap = (from, payload) => routes.wa_inbound({ kind: 'wa_inbound', from, msg: { button: { payload } } });

  it('ignores a cancel_yes tap from a phone that does not own the order', async () => {
    // Payloads are unsigned clear text, so this check is the whole defence.
    // Without it the tap reaches flowA.onCancelYes, which reads the order
    // through the REAL Shopify client and rejects, so resolving is the proof
    // that routing stopped here.
    await expect(tap(STRANGER, 'v1|A|12345|cancel_yes')).resolves.toBeUndefined();
  });

  it('refuses a Flow C tap from a stranger too', async () => {
    await expect(tap(STRANGER, 'v1|C|12345|ndr_cancel')).resolves.toBeUndefined();
  });

  it('does route the real customer through (and out to Shopify)', async () => {
    // The owner IS allowed past the check, so this one reaches the flow and
    // fails on the network. That asymmetry is what proves the gate is real and
    // not just returning early for everyone.
    await expect(tap(OWNER, 'v1|A|12345|cancel_yes')).rejects.toThrow();
  });
});

describe('a send that WhatsApp accepted and then failed to deliver', () => {
  beforeEach(async () => {
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: OWNER, name: '#1234' });
    await recordMessage('12345', 'wamid.ABC', { key: 'cod_confirm', template: 'cod_confirm_v1' });
  });

  const failedStatus = (code) => ({
    kind: 'wa_status',
    status: {
      id: 'wamid.ABC',
      status: 'failed',
      recipient_id: '919812345678',
      errors: [{ code, title: 'Business eligibility payment issue' }],
    },
  });

  it('finds the order behind the wamid and tells the owner once', async () => {
    await routes.wa_status(failedStatus(131042));
    expect(await getSide('12345', 'send-failed:cod_confirm')).toMatchObject({ alerted: true });
  });

  it('does not alert twice for the same message kind on the same order', async () => {
    await routes.wa_status(failedStatus(131042));
    await routes.wa_status(failedStatus(131042));
    await routes.wa_status(failedStatus(131042));
    expect(await getSide('12345', 'send-failed:cod_confirm')).toMatchObject({ alerted: true });
  });

  it('stays quiet for a delivered status', async () => {
    await routes.wa_status({ kind: 'wa_status', status: { id: 'wamid.ABC', status: 'delivered', recipient_id: '919812345678' } });
    expect(await getSide('12345', 'send-failed:cod_confirm')).toBeNull();
  });
});

describe('every delivery outcome is recorded, not only the failures', () => {
  const msg = () => table.get('ORDER#12345', 'MSG#wamid.ABC');
  const status = (s, extra = {}) =>
    routes.wa_status({ kind: 'wa_status', status: { id: 'wamid.ABC', status: s, recipient_id: '919812345678', ...extra } });

  beforeEach(async () => {
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: OWNER, name: '#1234' });
    await recordMessage('12345', 'wamid.ABC', { key: 'cod_confirm', template: 'cod_confirm_v1' });
  });

  it('records a successful delivery, so "did they get it" has an answer', async () => {
    // Only failures used to land here, which meant a message that reached the
    // customer and one that never left were indistinguishable: both rows had no
    // status at all.
    expect((await msg()).status).toBeUndefined();
    await status('sent');
    expect((await msg()).status).toBe('sent');
    await status('delivered');
    expect((await msg()).status).toBe('delivered');
    await status('read');
    expect((await msg()).status).toBe('read');
  });

  it('keeps the whole sequence in history', async () => {
    await status('sent');
    await status('delivered');
    expect((await msg()).history.map((h) => h.status)).toEqual(['sent', 'delivered']);
  });

  it('a late sent webhook cannot erase a failure or its errors', async () => {
    // Status webhooks are not ordered. Now that the whole lifecycle is written
    // here, a stale 'sent' arriving after 'failed' would turn the one record
    // that proves a customer was never reached back into a clean send.
    await status('failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });
    await status('sent');
    const row = await msg();
    expect(row.status).toBe('failed');
    expect(row.errors[0].code).toBe(131026);
  });

  it('a delivered status lifts an earlier undeliverable block', async () => {
    await setUndeliverable(OWNER);
    expect(await isUndeliverable(OWNER)).toBe(true);
    await status('delivered');
    expect(await isUndeliverable(OWNER)).toBe(false);
  });

  it('a 131026 failure still blocks the number', async () => {
    await status('failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });
    expect(await isUndeliverable(OWNER)).toBe(true);
  });
});

describe('updateMessageStatus never moves a status backwards', () => {
  beforeEach(async () => {
    await ensureState('777', {});
    await recordMessage('777', 'wamid.Z', { key: 'order_confirmed' });
  });
  it('read does not downgrade to delivered', async () => {
    await updateMessageStatus('777', 'wamid.Z', 'read', undefined);
    await updateMessageStatus('777', 'wamid.Z', 'delivered', undefined);
    expect((await table.get('ORDER#777', 'MSG#wamid.Z')).status).toBe('read');
  });
  it('failed outranks everything', async () => {
    await updateMessageStatus('777', 'wamid.Z', 'read', undefined);
    await updateMessageStatus('777', 'wamid.Z', 'failed', [{ code: 131049 }]);
    expect((await table.get('ORDER#777', 'MSG#wamid.Z')).status).toBe('failed');
  });
});

describe('an unanswered question does not stay open forever', () => {
  it('expires the awaiting state once its until has passed', async () => {
    await setAwaiting(OWNER, { type: 'address', orderId: '12345', until: '2026-09-20T00:00:00Z' });
    expect(await getAwaiting(OWNER, new Date('2026-09-21T00:00:00Z'))).toBeNull();
  });

  it('keeps it while it is still open', async () => {
    await setAwaiting(OWNER, { type: 'address', orderId: '12345', until: '2026-09-22T00:00:00Z' });
    expect(await getAwaiting(OWNER, new Date('2026-09-21T00:00:00Z'))).toMatchObject({ type: 'address' });
  });

  it('does not route a stale reply into the NDR address handler', async () => {
    await setAwaiting(OWNER, { type: 'address', orderId: '12345', until: '2020-01-01T00:00:00Z' });
    // Months later, an unrelated message. While the awaiting state was immortal
    // this reached flowC.onAddressText, read the order through the real Shopify
    // client and pushed "hi" to the courier as an address edit.
    await expect(
      routes.wa_inbound({ kind: 'wa_inbound', from: OWNER, msg: { text: { body: 'hi' } } }),
    ).resolves.toBeUndefined();
  });

  it('still routes a reply that arrives while the question is open', async () => {
    await setAwaiting(OWNER, { type: 'address', orderId: '12345', until: '2099-01-01T00:00:00Z' });
    await expect(
      routes.wa_inbound({ kind: 'wa_inbound', from: OWNER, msg: { text: { body: '302001 Jaipur' } } }),
    ).rejects.toThrow();
  });
});

/*
 * Flow R's four wiring points in this file. The flow functions have their own
 * suite; what was untested is the router that reaches them, which is the only
 * code path production actually uses. Every case below is picked to stop at a
 * guard before any client call, because the router builds the REAL clients.
 */
describe('the router reaches Flow R', () => {
  const CART = '66743166239092';

  it('routes a cart message to onFirst, which writes nothing while the flow is off', async () => {
    config.flows.R = { enabled: false, startAt: '' };
    await expect(routes.cart({ kind: 'cart', step: 'first', checkoutId: CART })).resolves.toBeUndefined();
    // No record, on purpose: the sweep five minutes later is free to retry.
    expect(await getRec(CART)).toBe(null);
  });

  it('routes the final step by checkoutId, not orderId', async () => {
    config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
    expect(await routes.cart({ kind: 'cart', step: 'final', checkoutId: CART })).toMatchObject({ skipped: 'no-record' });
  });

  it('routes an R timer to the reminder, reading the checkout id out of the orderId slot', async () => {
    config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
    expect(await routes.timer({ kind: 'timer', flow: 'R', orderId: CART, step: 'final' }))
      .toMatchObject({ skipped: 'no-record' });
    // An unknown step is logged and dropped, never retried into a send.
    expect(await routes.timer({ kind: 'timer', flow: 'R', orderId: CART, step: 'nonsense' })).toBeUndefined();
  });

  it('routes a Talk to us tap to Flow R, which then checks ownership itself', async () => {
    // ownsOrder fails open on an id with no STATE row, and a Flow R payload
    // always carries a checkout id, so onTap's own strict check is the gate.
    await expect(routes.wa_inbound({ kind: 'wa_inbound', from: STRANGER, msg: { button: { payload: `v1|R|${CART}|help` } } }))
      .resolves.toBeUndefined();
  });

  it('a cart message status is handled as a cart and never as an order', async () => {
    await ensureRec(CART, { phone: OWNER, checkoutId: CART });
    await patchRec(CART, { firstSentAt: '2026-10-12T06:30:00Z' });
    await table.put({ PK: 'WAMID#wamid.CART', SK: 'MAP', cartId: CART, key: 'cart_recovery' });

    await routes.wa_status({
      kind: 'wa_status',
      status: { id: 'wamid.CART', status: 'failed', recipient_id: '919812345678', errors: [{ code: 131026 }] },
    });

    // It reached the cart handler...
    expect((await getRec(CART)).deliveryFailed).toBeTruthy();
    // ...and it never reached the order tail, which would have tried to tag
    // and alert on an order id that does not exist.
    expect(await table.get(`ORDER#${CART}`, 'STATE')).toBe(null);
    expect(await table.get('ORDER#undefined', 'STATE')).toBe(null);
  });

  /*
   * The bug this guards against cost two real customers their next seven days.
   * markMarketing runs at SEND time; when Meta then rejects the message with
   * 131049 the customer receives nothing, and the stamp left behind barred
   * them from the next cart recovery over a message they never saw.
   */
  it('gives the marketing cap back when the message was never delivered', async () => {
    const PHONE = '+919812345678';
    const now = new Date('2026-10-19T07:07:00Z');
    await markMarketing(PHONE, now);
    expect(await canSendMarketing(PHONE, now, RULES.marketingCapDays)).toBe(false);

    await ensureRec(CART, { phone: PHONE, checkoutId: CART });
    await patchRec(CART, { firstSentAt: now.toISOString() });
    await table.put({ PK: 'WAMID#wamid.CART2', SK: 'MAP', cartId: CART, key: 'cart_recovery' });

    await routes.wa_status({
      kind: 'wa_status',
      // The real code from this store, not 131026: an undeliverable NUMBER is a
      // different fact from a throttled MESSAGE, and only the latter should
      // hand the cap back.
      status: { id: 'wamid.CART2', status: 'failed', recipient_id: '919812345678', errors: [{ code: 131049 }] },
    });

    expect(await canSendMarketing(PHONE, now, RULES.marketingCapDays)).toBe(true);
    // The failed message itself stays closed, so nothing retries into a
    // throttle that is still on.
    expect((await getRec(CART)).firstSentAt).toBe(now.toISOString());
  });

  it('a delivered message keeps the cap, so a real send still counts', async () => {
    const PHONE = '+919812345678';
    const now = new Date('2026-10-19T07:07:00Z');
    await markMarketing(PHONE, now);
    await ensureRec(CART, { phone: PHONE, checkoutId: CART });
    await table.put({ PK: 'WAMID#wamid.CART3', SK: 'MAP', cartId: CART, key: 'cart_recovery' });

    await routes.wa_status({
      kind: 'wa_status',
      status: { id: 'wamid.CART3', status: 'delivered', recipient_id: '919812345678' },
    });

    expect(await canSendMarketing(PHONE, now, RULES.marketingCapDays)).toBe(false);
  });
});
