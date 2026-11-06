/*
 * router.test.mjs — worker/index.mjs had no test of its own. It is the piece
 * that decides whose order a tap acts on and what happens to a send that
 * WhatsApp accepted and then failed to deliver, so both were unguarded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { ensureState, patchState, recordMessage, getSide, updateMessageStatus } from '../store/orderState.mjs';
import { table } from '../store/table.mjs';
import { setUndeliverable, isUndeliverable, setOptOut } from '../store/phoneProfile.mjs';
import { setAwaiting, getAwaiting, markMarketing, canSendMarketing } from '../store/phoneProfile.mjs';
import { RULES } from '../../messages/rules.mjs';
import { routes } from './index.mjs';
import { getRec, ensureRec, patchRec, parkForWindow, getParked } from '../store/cartRecovery.mjs';

const OWNER = '+919812345678';
const STRANGER = '+919800000000';

beforeEach(() => {
  _resetMemory();
  config.ownerAlertPhones = ['+919999999999'];
  // Empty is the default. A test that narrows /replace sets it and the next
  // test must not inherit it, because it is part of the command gate.
  config.replaceAdminPhones = [];
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

  /*
   * The incident email in iac/lib/stack.js fires on any `level = "error"` line,
   * so the LEVEL is the wiring, not decoration.
   *
   * 131026 is the most completely handled failure there is: the number is
   * parked undeliverable, the marketing cap is given back, and the send-failed
   * owner alert already names the order and asks the owner to phone the
   * customer. An incident email beside that alert says a Lambda broke when
   * nothing did, and a false alarm is how a real one gets ignored.
   */
  it('logs an undeliverable number as a warning, not as an incident', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await routes.wa_status({
        kind: 'wa_status',
        status: { id: 'wamid.ND1', status: 'failed', recipient_id: '919812345678', errors: [{ code: 131026 }] },
      });

      const said = (spy) => spy.mock.calls.flat().filter((l) => String(l).includes('wa status'));
      expect(said(err)).toEqual([]);
      expect(said(warn).join('')).toMatch(/131026/);
      // Still parked, so nothing is hidden by the quieter level.
      expect(await isUndeliverable('+919812345678')).toBe(true);
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
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

/*
 * Slash commands are the only inbound text this router acts on by itself, and
 * they act on SOMEBODY ELSE'S order, so the gate is the phone it came from.
 */
describe('a slash command is only a command when an owner typed it', () => {
  const OWNER_PHONE = '+919999999999';
  const text = (from, body) => routes.wa_inbound({ kind: 'wa_inbound', from, msg: { text: { body } } });

  /*
   * The command handler always answers the sender, and the client is in dry run
   * here, so a recorded send IS the reply. Getting one at all is the assertion:
   * a stranger gets nothing back, because for them this was never a command.
   */
  const replied = { skipped: 'dry_run' };

  it('ignores /size-change from anyone who is not us', async () => {
    await expect(text(STRANGER, '/size-change 1214')).resolves.toBeUndefined();
  });

  it('runs it for an owner phone', async () => {
    await expect(text(OWNER_PHONE, '/size-change 1214')).resolves.toMatchObject(replied);
  });

  /*
   * REPLACE_ADMIN_PHONES narrows /replace and nothing else. Gating the command
   * router on it alone took /size-change away from every owner phone that is not
   * on that list: the text fell through to the customer branches and was
   * answered by nothing, which is the kind of regression nobody reports because
   * it looks like WhatsApp swallowed the message.
   */
  it('still runs /size-change for an owner when the replace admin list names someone else', async () => {
    config.replaceAdminPhones = ['+918888888888'];
    await expect(text(OWNER_PHONE, '/size-change 1214')).resolves.toMatchObject(replied);
  });

  it('leaves ordinary customer text alone', async () => {
    // Word for word what the #1214 customer sent. A human answers this one.
    await expect(text(STRANGER, 'size L')).resolves.toBeUndefined();
  });

  it('answers an unknown command instead of swallowing it', async () => {
    await expect(text(OWNER_PHONE, '/sizechange 1214')).resolves.toMatchObject(replied);
  });
});

// ---------------------------------------------------------------------------
/*
 * 130472's log LEVEL, which is alert wiring and not decoration: the incident
 * email in iac/lib/stack.js fires on any `level = "error"` line.
 *
 * Both of Flow W's candidates failed with 130472 on 2026-10-26 and both logged
 * at ERROR, so the owner got incident mail reading "that step did not complete,
 * it retries automatically, then parks in the dead letter queue". None of that
 * was true: nothing retried and the DLQ stayed empty. Now that the code parks
 * the offer and falls back to email it is a handled outcome, so it belongs
 * beside 131049 and 131026 at WARN.
 *
 * The METRIC had to follow, which is the second test here. Demoting the log
 * level silenced the incident email but not the wa-whatsapp-failures alarm,
 * which sits at threshold 1 on MessageFailed and so went on mailing the owner
 * for every one of the roughly one in three sends Meta refuses. A handled
 * failure is now counted under its own name, so the alarm is left to the
 * failures nobody recovered from.
 */
describe('a held-out number is a handled outcome, not an incident', () => {
  const status = (code) => ({
    kind: 'wa_status',
    status: {
      id: `wamid.${code}`,
      status: 'failed',
      recipient_id: '919307740298',
      errors: [{ code, title: 'refused' }],
    },
  });

  it('logs 130472 as a warning carrying the code, not as an error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await routes.wa_status(status(130472));

      const said = (spy) => spy.mock.calls.flat().filter((l) => String(l).includes('wa status'));
      expect(said(err)).toEqual([]);
      expect(said(warn).join('')).toMatch(/130472/);
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  /*
   * The alarm metric is dimensionless and matched by name, so the names are
   * asserted literally: renaming either one here silently unhooks the alarm.
   */
  it.each([[131049], [130472], [131026]])(
    'keeps a handled %i out of the alarm metric',
    async (code) => {
      const emitted = await metricsOf(() => routes.wa_status(status(code)));
      expect(emitted).toContain('MessageFailedHandled');
      expect(emitted).not.toContain('MessageFailed');
    },
  );

  it('still counts a failure nothing recovered from, so the alarm can fire', async () => {
    const emitted = await metricsOf(() => routes.wa_status(status(470)));
    expect(emitted).toContain('MessageFailed');
    expect(emitted).not.toContain('MessageFailedHandled');
  });
});

/** The metric names emitted while `fn` runs, read off the EMF log lines. */
async function metricsOf(fn) {
  const names = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return; }
    for (const d of parsed?._aws?.CloudWatchMetrics || []) {
      for (const m of d.Metrics || []) names.push(m.Name);
    }
  });
  const quiet = [
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
  try {
    await fn();
  } finally {
    spy.mockRestore();
    quiet.forEach((s) => s.mockRestore());
  }
  return names;
}

/*
 * F2. The opt-out return used to sit above the taps, so a customer who had
 * ever sent STOP vanished from their own conversation: they tapped "Yes,
 * cancel", nothing happened, nothing was logged, and the order shipped.
 */
describe('STOP stops what we start, not what the customer does', () => {
  const tap = (from, payload) => routes.wa_inbound({ kind: 'wa_inbound', from, msg: { button: { payload } } });
  const text = (from, body) => routes.wa_inbound({ kind: 'wa_inbound', from, msg: { text: { body } } });

  beforeEach(async () => {
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: OWNER, name: '#1234' });
    await setOptOut(OWNER, true);
  });

  /*
   * Reaching the flow IS the assertion: past the router it reads the order
   * through the real Shopify client and rejects. Before this fix the same tap
   * resolved silently, which is the shape of the defect, not of a pass.
   */
  it('acts on their cancel tap', async () => {
    await expect(tap(OWNER, 'v1|A|12345|cancel_yes')).rejects.toThrow();
  });

  it('acts on their Flow C tap', async () => {
    await expect(tap(OWNER, 'v1|C|12345|ndr_reattempt')).rejects.toThrow();
  });

  it('reads the text answering our own NDR address question', async () => {
    await setAwaiting(OWNER, { type: 'address', orderId: '12345' });
    await expect(text(OWNER, '395007 Surat')).rejects.toThrow();
  });

  it('still refuses to unlock the marketing we parked against that number', async () => {
    await parkForWindow(OWNER, '66743166239092', new Date(Date.now() + 86400000));
    // An inbound text from an opted-out phone must not reach onWindowOpen at
    // all: untouched, not released with an outcome.
    await text(OWNER, 'hello');
    expect(await getParked(OWNER)).toMatchObject({ checkoutId: '66743166239092' });
  });

  it('and the opt-out itself still answers', async () => {
    await setOptOut(OWNER, false);
    await expect(text(OWNER, 'STOP')).resolves.toBeDefined();
  });
});
