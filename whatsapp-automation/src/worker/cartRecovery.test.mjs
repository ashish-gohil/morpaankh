/*
 * Flow R behaviour. Every test here is a line off the loophole checklist, and
 * most of them are about the flow NOT sending something.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { table, _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { _resetSecrets } from '../secrets.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { setOptOut, setUndeliverable, touchInbound, markMarketing, canSendMarketing } from '../store/phoneProfile.mjs';
import { getRec, getPhoneLock, lockPhone, getCartLinkMap, getParked } from '../store/cartRecovery.mjs';
import * as R from './cartRecovery.run.mjs';

const NOW = fromISTWall(2026, 9, 12, 12, 0); // 12:00 IST, inside 09:30-22:30
const PHONE = '+919637361371';
const CHECKOUT_ID = '66743166239092';

function checkout(over = {}) {
  return {
    id: `gid://shopify/AbandonedCheckout/${CHECKOUT_ID}`,
    name: `#${CHECKOUT_ID}`,
    createdAt: '2026-10-12T05:00:00Z', // 10:30 IST, 90 minutes before NOW
    completedAt: null,
    abandonedCheckoutUrl: 'https://www.morpaankh.in/99862610292/checkouts/ac/TOK/recover?key=SECRETKEY&locale=en-IN',
    totalDiscountSet: { shopMoney: { amount: '0.0' } },
    customAttributes: [
      { key: '_otpVerifiedPhoneNumber', value: '919637361371' },
      { key: '_codkAmountType', value: 'cod' },
    ],
    customer: { id: 'gid://shopify/Customer/25164544835956', firstName: 'Bharti' },
    shippingAddress: { firstName: 'Bharti' },
    lineItems: {
      nodes: [
        {
          title: 'Khili Dhoop',
          quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: '1599.0' } },
          image: { url: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1', width: 1200, height: 1500 },
          variant: { id: 'gid://shopify/ProductVariant/54758494110068', availableForSale: true, selectedOptions: [{ name: 'Size', value: 'XS' }] },
        },
      ],
    },
    ...over,
  };
}

function setup({ cart = checkout(), whatsapp, shopify } = {}) {
  const clients = makeFakeClients({ whatsapp, shopify });
  clients.shopify.seedCheckout(cart);
  return { clients, deps: { clients, now: NOW } };
}

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  config.ownerAlertPhones = ['+919999999999'];
  config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
  config.cartRecoveryAllowlist = [];
});

const templates = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const discounts = (sh) => sh.calls.filter((c) => c.op === 'createDiscountCode').map((c) => c.args);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);
const alerts = (wa) => wa.sent.filter((s) => s.type === 'template' && s.name.startsWith('ops_alert'));
const timerNames = () => _peekTimers().map((t) => t.name);

describe('message 1', () => {
  it('sends, creates one code, locks the phone and arms the reminder', async () => {
    const { clients, deps } = setup();
    const out = await R.onFirst(CHECKOUT_ID, deps);
    expect(out.sent).toBe(true);

    expect(templates(clients.whatsapp)).toContain('cart_recovery_v1');
    const made = discounts(clients.shopify);
    expect(made).toHaveLength(1);
    // Beats WELCOME150's Rs 150 on a Rs 1,249 bag, exactly as the fixtures say.
    expect(made[0].amountInr).toBe(200); // the top tier's ceiling
    // 0.9 of the bag, and never below minSubtotalFloorInr. It used to be
    // Rs 1,124 on a Rs 1,249 bag: a code spendable on a basket smaller than
    // the minimum we are willing to discount at all.
    expect(made[0].minSubtotalInr).toBe(1439);
    expect(made[0].title).toBe(`Cart recovery #${CHECKOUT_ID}`);
    // Never a phone number in a Shopify title: it shows in the admin list.
    expect(made[0].title).not.toContain('9637');

    const rec = await getRec(CHECKOUT_ID);
    expect(rec.firstSentAt).toBeTruthy();
    expect(rec.code).toMatch(/^MORPAANKHBHARTI[2-9]{2}$/);
    // A successful send is NOT an outcome: the sequence is still running.
    expect(rec.outcome).toBeUndefined();

    const lock = await getPhoneLock(PHONE);
    expect(lock.checkoutId).toBe(CHECKOUT_ID);
    expect(new Date(lock.lockUntil).getTime() - NOW.getTime()).toBe(RULES.cartRecovery.cooldownDays * 86400 * 1000);

    expect(timerNames()).toContain(`R-${CHECKOUT_ID}-final`);
    expect(await getCartLinkMap(rec.token)).toMatchObject({ checkoutId: CHECKOUT_ID });
  });

  it('the Shopify code cannot stack, is single use, and ends when we said it would', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const rec = await getRec(CHECKOUT_ID);
    const args = discounts(clients.shopify)[0];
    expect(args.endsAt).toBe(rec.codeEndsAt);
    expect(args.code).toBe(rec.code);
    /*
     * usageLimit 1, appliesOncePerCustomer and combinesWith are fixed inside
     * the existing createDiscountCode, which is why Flow R reuses it rather
     * than writing its own mutation. The mutation's own variables are asserted
     * against a stubbed fetch in clients/discount-code.test.mjs; what this
     * test owns is that Flow R passes nothing that could loosen them.
     */
    expect(Object.keys(args).sort()).toEqual(
      ['amountInr', 'code', 'endsAt', 'minSubtotalInr', 'startsAt', 'title'].sort(),
    );
  });

  it('a gated send creates no code and takes no lock, because nothing went out', async () => {
    // DRY_RUN or a SEND_ALLOWLIST that does not hold this number. The send's
    // own reply comes back AFTER the Shopify code exists, so asking the client
    // first is the only thing that stops an orphan single-use code per cart.
    const { clients, deps } = setup({ whatsapp: { skipWith: 'not_allowlisted' } });
    await R.onFirst(CHECKOUT_ID, deps);

    expect((await getRec(CHECKOUT_ID)).outcome).toBe('send-not_allowlisted');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(templates(clients.whatsapp)).toHaveLength(0);
    expect(await getPhoneLock(PHONE)).toBe(null);
    expect(timerNames()).not.toContain(`R-${CHECKOUT_ID}-final`);
  });

  it('writes nothing at all when the flow is off, so the next sweep retries', async () => {
    config.flows.R = { enabled: false, startAt: '2026-10-01T00:00:00Z' };
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getRec(CHECKOUT_ID)).toBe(null);
    expect(templates(clients.whatsapp)).toHaveLength(0);
  });

  it('writes nothing outside the send window either', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, { ...deps, now: fromISTWall(2026, 9, 12, 23, 0) });
    expect(await getRec(CHECKOUT_ID)).toBe(null);
    expect(templates(clients.whatsapp)).toHaveLength(0);
  });

  it('an SQS redelivery sends once and creates one code', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onFirst(CHECKOUT_ID, deps);
    expect(templates(clients.whatsapp).filter((n) => n === 'cart_recovery_v1')).toHaveLength(1);
    expect(discounts(clients.shopify)).toHaveLength(1);
  });

  it('a second checkout from the same phone is refused for 30 days', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const second = checkout({ id: 'gid://shopify/AbandonedCheckout/999', name: '#999' });
    clients.shopify.seedCheckout(second);
    await R.onFirst('999', deps);
    expect(await getRec('999')).toMatchObject({ outcome: 'cooldown' });
    expect(templates(clients.whatsapp).filter((n) => n === 'cart_recovery_v1')).toHaveLength(1);
  });

  it('honours an EXPIRED lock even though DynamoDB has not deleted the row', async () => {
    const { clients, deps } = setup();
    // A row that is still physically there, which is normal: TTL deletion runs
    // on Dynamo's own schedule and is routinely days late.
    await lockPhone(PHONE, { checkoutId: 'old', until: new Date(NOW.getTime() - 1000), now: new Date(NOW.getTime() - 40 * 86400 * 1000) });
    expect(await getPhoneLock(PHONE)).toBeTruthy();
    await R.onFirst(CHECKOUT_ID, deps);
    expect(templates(clients.whatsapp)).toContain('cart_recovery_v1');
    expect((await getPhoneLock(PHONE)).checkoutId).toBe(CHECKOUT_ID);
  });

  it('refuses when the bag already gets as much as we could offer', async () => {
    // A bag carrying a better discount than 20% of itself.
    const { clients, deps } = setup({ cart: checkout({ totalDiscountSet: { shopMoney: { amount: '400.0' } } }) });
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'public-offer-better' });
    expect(templates(clients.whatsapp)).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  /*
   * The one that would be a silent pricing bug. Without the live codes the
   * floor is only what is already applied, so this bag would be offered Rs 130
   * while WELCOME150 offers Rs 150 on the cart page.
   */
  it('refuses to offer at all when the live discount codes cannot be read', async () => {
    const { clients, deps } = setup({ shopify: { failPublicCodes: 'Access denied for discountNodes field' } });
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'no-public-codes' });
    expect(templates(clients.whatsapp).filter((n) => n === 'cart_recovery_v1')).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneLock(PHONE)).toBe(null);
    expect(alerts(clients.whatsapp).length).toBeGreaterThan(0);
  });

  it('only alerts once a day about an account-wide failure', async () => {
    const { clients, deps } = setup({ shopify: { failPublicCodes: 'nope' } });
    await R.onFirst(CHECKOUT_ID, deps);
    clients.shopify.seedCheckout(checkout({ id: 'gid://shopify/AbandonedCheckout/777', name: '#777' }));
    await R.onFirst('777', deps);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  it('respects the service-wide marketing cap, so it cannot stack on a prepaid offer', async () => {
    const { clients, deps } = setup();
    await markMarketing(PHONE, new Date(NOW.getTime() - 2 * 86400 * 1000));
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'marketing-cap' });
    expect(templates(clients.whatsapp)).toHaveLength(0);
  });

  it('refuses an opted-out or undeliverable number without taking the lock', async () => {
    const a = setup();
    await setOptOut(PHONE, true);
    await R.onFirst(CHECKOUT_ID, a.deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'opted-out' });
    expect(await getPhoneLock(PHONE)).toBe(null);

    _resetMemory();
    const b = setup();
    await setUndeliverable(PHONE);
    await R.onFirst(CHECKOUT_ID, b.deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'undeliverable' });
    expect(await getPhoneLock(PHONE)).toBe(null);
  });

  it('does not message someone who has already ordered since walking away', async () => {
    const { clients, deps } = setup();
    clients.shopify.seed({
      id: 'gid://shopify/Order/555',
      name: '#555',
      createdAt: '2026-10-12T06:00:00Z',
      customer: { id: 'gid://shopify/Customer/25164544835956' },
    });
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'already-ordered' });
    expect(templates(clients.whatsapp)).toHaveLength(0);
  });

  /*
   * The sweep bounds its Shopify query to 12 hours, so a stale checkout is
   * normally never listed. This is the other half: the queue can hold a
   * message for minutes, and the flow can be re-enabled with an old record in
   * flight, so onFirst re-reads and refuses on its own.
   */
  it('refuses a checkout that has aged past 12h by the time the worker gets to it', async () => {
    const { clients, deps } = setup({ cart: checkout({ createdAt: '2026-10-11T05:00:00Z', updatedAt: '2026-10-12T06:29:00Z' }) });
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'too-old', skipReason: 'too-old' });
    expect(templates(clients.whatsapp)).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('refuses one that was completed between the sweep and the worker', async () => {
    const { clients, deps } = setup({ cart: checkout({ completedAt: '2026-10-12T06:00:00Z' }) });
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'completed' });
    expect(templates(clients.whatsapp)).toHaveLength(0);
  });

  it('retries past a code collision and widens to three digits', async () => {
    // Six two-digit attempts collide, so the seventh must be a three-digit one.
    const { clients, deps } = setup({ shopify: { takenCodes: Array(6).fill(true) } });
    await R.onFirst(CHECKOUT_ID, deps);
    const tried = discounts(clients.shopify).map((a) => a.code);
    expect(tried).toHaveLength(7);
    expect(tried.slice(0, 6).every((c) => /^MORPAANKHBHARTI[2-9]{2}$/.test(c))).toBe(true);
    expect(tried[6]).toMatch(/^MORPAANKHBHARTI[2-9]{3}$/);
    expect((await getRec(CHECKOUT_ID)).code).toBe(tried[6]);
    expect(templates(clients.whatsapp)).toContain('cart_recovery_v1');
  });

  it('uses the plain template when the bag has no photo', async () => {
    const cart = checkout();
    cart.lineItems.nodes[0].image = null;
    const { clients, deps } = setup({ cart });
    await R.onFirst(CHECKOUT_ID, deps);
    expect(templates(clients.whatsapp)).toContain('cart_recovery_plain_v1');
  });
});

describe('shadow mode', () => {
  it('creates no code, writes no lock and sends nothing', async () => {
    config.cartRecoveryAllowlist = ['+919999999999'];
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    expect(templates(clients.whatsapp)).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneLock(PHONE)).toBe(null);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ outcome: 'shadow' });
  });

  it('logs once per checkout, not once per sweep', async () => {
    config.cartRecoveryAllowlist = ['+919999999999'];
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const first = await getRec(CHECKOUT_ID);
    await R.onFirst(CHECKOUT_ID, deps);
    // The outcome is what stops it: a second pass sees it and returns early.
    expect((await getRec(CHECKOUT_ID)).outcomeAt).toBe(first.outcomeAt);
  });

  it('still messages a phone that IS on the allowlist', async () => {
    config.cartRecoveryAllowlist = [PHONE];
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    expect(templates(clients.whatsapp)).toContain('cart_recovery_v1');
  });
});

describe('a send that Meta refuses never takes the phone lock', () => {
  for (const [label, waCode, outcome] of [
    ['131026, this number cannot receive WhatsApp', 131026, 'meta-131026'],
    ['131049, the per-user marketing cap', 131049, 'waiting-window'],
    ['132001, the template is not usable', 132001, 'template-unusable'],
  ]) {
    it(label, async () => {
      const { clients, deps } = setup({ whatsapp: { failTemplateWith: waCode } });
      await R.onFirst(CHECKOUT_ID, deps);
      const rec = await getRec(CHECKOUT_ID);
      expect(rec.outcome).toBe(outcome);
      expect(rec.firstSentAt).toBeUndefined();
      expect(await getPhoneLock(PHONE)).toBe(null);
      // And no reminder. The guard that catches it is "no firstSentAt", which
      // sits above the outcome check, so assert the OUTCOME here and the fact
      // that nothing was sent, rather than which guard happened to fire.
      const final = await R.onFinal(CHECKOUT_ID, deps);
      expect(final.sent).toBeUndefined();
      expect(final.skipped).toBeTruthy();
      expect(templates(clients.whatsapp)).not.toContain('cart_final_v1');
    });
  }

  it('lets a genuinely transient failure throw, so SQS redelivers it', async () => {
    const { deps } = setup({ whatsapp: { failTemplateWith: 500 } });
    await expect(R.onFirst(CHECKOUT_ID, deps)).rejects.toThrow();
    expect(await getPhoneLock(PHONE)).toBe(null);
  });
});

describe('the reminder', () => {
  const sendFirst = async (over) => {
    const s = setup(over);
    await R.onFirst(CHECKOUT_ID, s.deps);
    return s;
  };
  // Two hours before the code closes: 22 hours after message 1.
  const atReminder = (rec) => new Date(new Date(rec.reminderAt).getTime());

  it('sends when nothing has changed', async () => {
    const { clients, deps } = await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    const out = await R.onFinal(CHECKOUT_ID, { ...deps, now: atReminder(rec) });
    expect(out.sent).toBe(true);
    expect(templates(clients.whatsapp)).toContain('cart_final_v1');
    expect((await getRec(CHECKOUT_ID)).finalSentAt).toBeTruthy();
  });

  it('never sends twice', async () => {
    const { clients, deps } = await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    await R.onFinal(CHECKOUT_ID, { ...deps, now: atReminder(rec) });
    await R.onFinal(CHECKOUT_ID, { ...deps, now: atReminder(rec) });
    expect(templates(clients.whatsapp).filter((n) => n === 'cart_final_v1')).toHaveLength(1);
  });

  it('stops when the code has been used by anyone', async () => {
    const { clients, deps } = await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    clients.shopify.calls.length = 0;
    const withUsage = makeFakeClients({ shopify: { discountUsage: { [rec.discountId]: 1 } } });
    withUsage.shopify.seedCheckout(checkout());
    const out = await R.onFinal(CHECKOUT_ID, { clients: withUsage, now: atReminder(rec) });
    expect(out).toMatchObject({ skipped: 'code-used' });
  });

  it('stops when they have written to us since', async () => {
    const { deps } = await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    await touchInbound(PHONE, new Date(new Date(rec.firstSentAt).getTime() + 60000));
    expect(await R.onFinal(CHECKOUT_ID, { ...deps, now: atReminder(rec) })).toMatchObject({ skipped: 'they-replied' });
  });

  it('stops after STOP, after Talk to us, and after a delivery failure', async () => {
    const a = await sendFirst();
    let rec = await getRec(CHECKOUT_ID);
    await setOptOut(PHONE, true);
    expect(await R.onFinal(CHECKOUT_ID, { ...a.deps, now: atReminder(rec) })).toMatchObject({ skipped: 'opted-out' });

    _resetMemory();
    const b = await sendFirst();
    rec = await getRec(CHECKOUT_ID);
    await R.onTap(CHECKOUT_ID, 'help', PHONE, b.deps);
    expect(await R.onFinal(CHECKOUT_ID, { ...b.deps, now: atReminder(rec) })).toMatchObject({ skipped: 'asked-for-a-person' });

    _resetMemory();
    const c = await sendFirst();
    rec = await getRec(CHECKOUT_ID);
    await R.onCartStatus(CHECKOUT_ID, { status: 'failed', errors: [{ code: 131026 }] }, NOW);
    expect(await R.onFinal(CHECKOUT_ID, { ...c.deps, now: atReminder(rec) })).toMatchObject({ skipped: 'first-message-failed' });
  });

  it('stops when the checkout has been completed', async () => {
    const { clients, deps } = await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    clients.shopify.seedCheckout(checkout({ completedAt: '2026-10-12T08:00:00Z' }));
    expect(await R.onFinal(CHECKOUT_ID, { ...deps, now: atReminder(rec) })).toMatchObject({ skipped: 'completed' });
  });

  it('stops outside the window and stops when there is no time left to act', async () => {
    const { deps } = await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    expect(await R.onFinal(CHECKOUT_ID, { ...deps, now: fromISTWall(2026, 9, 13, 23, 30) })).toMatchObject({ skipped: 'outside-window' });
    const nearEnd = new Date(new Date(rec.codeEndsAt).getTime() - 10 * 60000);
    expect(await R.onFinal(CHECKOUT_ID, { ...deps, now: nearEnd })).toMatchObject({ skipped: 'too-close-to-the-end' });
  });

  it('stops when the flow has been switched off since', async () => {
    const { deps } = await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    config.flows.R = { enabled: false, startAt: '2026-10-01T00:00:00Z' };
    expect(await R.onFinal(CHECKOUT_ID, { ...deps, now: atReminder(rec) })).toMatchObject({ skipped: 'flow-r-off' });
  });

  it('is armed for the stored reminder time, on the per-phone FIFO group', async () => {
    await sendFirst();
    const rec = await getRec(CHECKOUT_ID);
    const timer = _peekTimers().find((t) => t.name === `R-${CHECKOUT_ID}-final`);
    /*
     * scheduleTimer FLOORS anything already past at real-now + 60s, on purpose:
     * a timer armed for a moment that has gone would never fire at all. The
     * fixture's reminderAt is a fixed October minute, so once the wall clock
     * passes it the floor applies and the literal minute stops matching. This
     * asserts the rule instead, which is what production depends on, and used
     * to be a test that only passed before 10:00 IST.
     */
    const stored = Date.parse(rec.reminderAt);
    const floored = stored <= Date.now() + 60 * 1000;
    if (floored) expect(timer.at.getTime()).toBeGreaterThan(Date.now());
    else expect(timer.at.toISOString()).toBe(rec.reminderAt);
    expect(timer.groupId).toBe(`phone:${PHONE}`);
  });
});

describe('Talk to us', () => {
  it('replies, stops the reminder and names the bag to the owner', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onTap(CHECKOUT_ID, 'help', PHONE, deps);
    const texts = clients.whatsapp.sent.filter((s) => s.type === 'text').map((s) => s.body);
    expect(texts.some((t) => /Someone from our team will message you here shortly/.test(t))).toBe(true);
    expect(texts.some((t) => /is open until/.test(t))).toBe(true);
    expect((await getRec(CHECKOUT_ID)).helpRequestedAt).toBeTruthy();
    expect(timerNames()).not.toContain(`R-${CHECKOUT_ID}-final`);
    const alert = alerts(clients.whatsapp)[0];
    expect(JSON.stringify(alert)).toMatch(/Talk to us/);
    // Only the last four digits ever reach an alert.
    expect(JSON.stringify(alert)).not.toContain('919637361371');
  });

  it('uses the closed wording once the code has ended', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const rec = await getRec(CHECKOUT_ID);
    await R.onTap(CHECKOUT_ID, 'help', PHONE, { ...deps, now: new Date(new Date(rec.codeEndsAt).getTime() + 1000) });
    const texts = clients.whatsapp.sent.filter((s) => s.type === 'text').map((s) => s.body);
    expect(texts.some((t) => /and your bag stays saved\.$/.test(t))).toBe(true);
    expect(texts.some((t) => /is open until/.test(t))).toBe(false);
  });

  /*
   * The router's ownsOrder() fails open on an id it has never seen, and a Flow
   * R payload carries a CHECKOUT id, so there is never a STATE row for it and
   * that gate always passes. This strict check is the only thing standing
   * between a clear-text payload and somebody else's bag.
   */
  it('ignores a tap from a phone that does not own the checkout', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const before = clients.whatsapp.sent.length;
    await R.onTap(CHECKOUT_ID, 'help', '+919111111111', deps);
    expect(clients.whatsapp.sent.length).toBe(before);
    expect((await getRec(CHECKOUT_ID)).helpRequestedAt).toBeUndefined();
  });
});

describe('an order that came back', () => {
  const orderPayload = (over = {}) => ({
    id: 5551212,
    name: '#1201',
    created_at: '2026-10-12T09:00:00Z',
    note_attributes: [{ name: '_otpVerifiedPhoneNumber', value: '919637361371' }],
    discount_codes: [],
    ...over,
  });

  it('attributes it, tags it, cancels the reminder and owes the gift', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const rec = await getRec(CHECKOUT_ID);
    await R.onOrderCreated(orderPayload({ discount_codes: [{ code: rec.code }] }), deps);

    const after = await getRec(CHECKOUT_ID);
    expect(after).toMatchObject({ outcome: 'recovered', orderId: '5551212', codeUsed: true });
    expect(tagsAdded(clients.shopify)).toEqual(expect.arrayContaining(['wa-cart-recovered', 'gift-in-parcel']));
    expect(timerNames()).not.toContain(`R-${CHECKOUT_ID}-final`);
  });

  it('alerts the owner when they came back and the code was NOT applied', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onOrderCreated(orderPayload(), deps);
    expect((await getRec(CHECKOUT_ID)).codeUsed).toBe(false);
    expect(JSON.stringify(alerts(clients.whatsapp))).toMatch(/was NOT applied/);
  });

  it('stops the reminder either way', async () => {
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const rec = await getRec(CHECKOUT_ID);
    await R.onOrderCreated(orderPayload(), deps);
    expect(await R.onFinal(CHECKOUT_ID, { ...deps, now: new Date(rec.reminderAt) })).toMatchObject({ skipped: 'outcome-recovered' });
  });

  it('is idempotent and ignores an order outside the attribution window', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onOrderCreated(orderPayload(), deps);
    const once = await getRec(CHECKOUT_ID);
    await R.onOrderCreated(orderPayload(), deps);
    expect((await getRec(CHECKOUT_ID)).orderId).toBe(once.orderId);
    expect(tagsAdded(clients.shopify).filter((t) => t === 'wa-cart-recovered')).toHaveLength(1);

    // An order placed days after the grace period is not ours to claim.
    _resetMemory();
    const b = setup();
    await R.onFirst(CHECKOUT_ID, b.deps);
    await R.onOrderCreated(orderPayload({ created_at: '2026-10-20T09:00:00Z' }), b.deps);
    expect((await getRec(CHECKOUT_ID)).outcome).toBeUndefined();
  });

  it('attributes an order placed inside the grace but after the code closed, and owes no gift', async () => {
    /*
     * The only reason attributionGraceHours exists: they came back because of
     * the message, but too late for the code. We still count the recovery and
     * still tag it, and we do NOT owe a gift we never charged them for.
     */
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const rec = await getRec(CHECKOUT_ID);
    const late = new Date(new Date(rec.codeEndsAt).getTime() + 3600 * 1000).toISOString();
    await R.onOrderCreated(orderPayload({ created_at: late }), { ...deps, now: new Date(late) });

    expect((await getRec(CHECKOUT_ID)).outcome).toBe('recovered');
    expect(tagsAdded(clients.shopify)).toContain('wa-cart-recovered');
    expect(tagsAdded(clients.shopify)).not.toContain('gift-in-parcel');
    // No "the code was not applied" alert either: the code had closed, so of
    // course it was not applied, and the owner does not need telling.
    expect(JSON.stringify(alerts(clients.whatsapp))).not.toMatch(/was NOT applied/);
  });

  it('does nothing for an order from a phone we never messaged', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    clients.shopify.calls.length = 0;
    await R.onOrderCreated(orderPayload({ note_attributes: [{ name: '_otpVerifiedPhoneNumber', value: '919000000000' }] }), deps);
    expect(tagsAdded(clients.shopify)).toHaveLength(0);
  });
});

describe('a delivery status for a cart message', () => {
  it('releases the phone lock, because they received nothing', async () => {
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    expect(await getPhoneLock(PHONE)).toBeTruthy();
    await R.onCartStatus(CHECKOUT_ID, { status: 'failed', errors: [{ code: 131049 }] }, NOW);
    expect(await getPhoneLock(PHONE)).toBe(null);
    expect(await getRec(CHECKOUT_ID)).toMatchObject({ deliveryFailed: true, deliveryError: 131049 });
  });

  it('records a good status without touching the lock', async () => {
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onCartStatus(CHECKOUT_ID, { status: 'delivered' });
    expect((await getRec(CHECKOUT_ID)).lastStatus).toBe('delivered');
    expect(await getPhoneLock(PHONE)).toBeTruthy();
  });

  /*
   * The WAMID row must carry cartId and NO orderId. onWaStatus tags the order
   * and alerts by order name past that point, and a checkout has neither:
   * given a checkout id it would tag gid://shopify/Order/<checkoutId>, a
   * well-formed id pointing at nothing.
   */
  it('maps the wamid to a cart and never to an order', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const wamid = clients.whatsapp.sent[0].__wamid || 'fake-wamid-1';
    const map = await table.get(`WAMID#${wamid}`, 'MAP');
    expect(map).toMatchObject({ cartId: CHECKOUT_ID, key: 'cart_recovery' });
    expect(map.orderId).toBeUndefined();
  });
});

describe('the rows Flow R writes', () => {
  it('never uses SK STATE, which the nightly review sweep reads as an order', async () => {
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const states = await table.scanStates();
    expect(states.filter((s) => String(s.PK).startsWith('CART'))).toHaveLength(0);
    expect(await table.scanBySk('REC')).toHaveLength(1);
  });

  it('never puts the code end in the TTL attribute', async () => {
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    const rec = await getRec(CHECKOUT_ID);
    const codeEndEpoch = Math.floor(new Date(rec.codeEndsAt).getTime() / 1000);
    expect(rec.expiresAt).not.toBe(codeEndEpoch);
    // 180 days out, not 24 hours: otherwise Dynamo deletes the record at the
    // moment the code closes, taking the attribution window with it.
    expect(rec.expiresAt).toBeGreaterThan(codeEndEpoch + 170 * 86400);
  });
});

/*
 * Meta's 131049 is the per-user MARKETING TEMPLATE cap, counted across every
 * business that messages that person. It refused two of this flow's first
 * three sends. A free-form message inside the 24 hour service window is not a
 * template and is not capped, so these are the tests for the only channel
 * Meta cannot throttle.
 */
describe('reaching a customer the marketing cap would otherwise block', () => {
  const ctaSends = (wa) => wa.sent.filter((m) => m.type === 'cta_url');

  it('uses a free-form message, not a template, when the window is open', async () => {
    const { clients, deps } = setup();
    await touchInbound(PHONE, new Date(NOW.getTime() - 60 * 60 * 1000)); // an hour ago

    await R.onFirst(CHECKOUT_ID, deps);

    expect(templates(clients.whatsapp)).not.toContain('cart_recovery_v1');
    const [msg] = ctaSends(clients.whatsapp);
    expect(msg.body).toContain('your bag is still waiting for you');
    expect(msg.buttonText).toBe('Complete my order');
    expect((await getRec(CHECKOUT_ID)).firstSentAt).toBeTruthy();
  });

  it('does not spend the marketing cap on a message that never used it', async () => {
    const { deps } = setup();
    await touchInbound(PHONE, new Date(NOW.getTime() - 60 * 60 * 1000));

    await R.onFirst(CHECKOUT_ID, deps);

    // A session message is not a MARKETING template, so the 7 day cap must be
    // untouched: stamping it would bar this customer over a message that was
    // never subject to it.
    expect(await canSendMarketing(PHONE, NOW, RULES.marketingCapDays)).toBe(true);
  });

  it('sends inside an open window even when the marketing cap is spent', async () => {
    const { clients, deps } = setup();
    await markMarketing(PHONE, new Date(NOW.getTime() - 24 * 60 * 60 * 1000)); // capped yesterday
    await touchInbound(PHONE, new Date(NOW.getTime() - 60 * 60 * 1000));

    await R.onFirst(CHECKOUT_ID, deps);

    expect((await getRec(CHECKOUT_ID)).outcome).toBeUndefined();
    expect(ctaSends(clients.whatsapp)).toHaveLength(1);
  });

  it('parks a 131049 against the phone and delivers it when they write in', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131049 } });

    await R.onFirst(CHECKOUT_ID, deps);
    expect((await getRec(CHECKOUT_ID)).outcome).toBe('waiting-window');
    expect(await getPhoneLock(PHONE)).toBe(null); // they received nothing
    expect((await getParked(PHONE)).checkoutId).toBe(CHECKOUT_ID);

    // They write to us, which opens the window. The fake only fails TEMPLATES,
    // so this asserts the fallback channel really is a different one.
    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    await touchInbound(PHONE, later);
    await R.onWindowOpen(PHONE, { clients, now: later });

    const rec = await getRec(CHECKOUT_ID);
    expect(ctaSends(clients.whatsapp)).toHaveLength(1);
    expect(rec.firstSentAt).toBeTruthy();
    // Cleared, or onFinal would refuse the reminder for a checkout that has
    // just been delivered successfully.
    expect(rec.outcome).toBe(null);
    expect(await getPhoneLock(PHONE)).toBeTruthy();
    expect(await getParked(PHONE)).toBe(null);
  });

  it('drops a parked checkout once its code has closed', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131049 } });
    await R.onFirst(CHECKOUT_ID, deps);

    const past = new Date(NOW.getTime() + (RULES.cartRecovery.codeValidHours + 1) * 60 * 60 * 1000);
    await touchInbound(PHONE, past);
    await R.onWindowOpen(PHONE, { clients, now: past });

    expect(ctaSends(clients.whatsapp)).toHaveLength(0);
    expect(await getParked(PHONE)).toBe(null);
  });

  it('drops a parked checkout the customer has since completed', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131049 } });
    await R.onFirst(CHECKOUT_ID, deps);

    clients.shopify.seedCheckout(checkout({ completedAt: '2026-10-12T07:00:00Z' }));
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await touchInbound(PHONE, later);
    await R.onWindowOpen(PHONE, { clients, now: later });

    expect(ctaSends(clients.whatsapp)).toHaveLength(0);
    expect((await getRec(CHECKOUT_ID)).outcome).toBe('already-ordered');
    expect(await getParked(PHONE)).toBe(null);
  });

  /*
   * THE REAL FAILURE SHAPE. Meta accepts the send with a 200 and reports the
   * per-user cap asynchronously on the status webhook seconds later, so
   * firstSentAt is already stamped and nothing ever throws. Every 131049 this
   * store has had arrived this way. A park that only fires on a thrown error
   * parks nothing, which is exactly what happened: three refusals, zero parked
   * rows.
   */
  it('parks on the 131049 Meta reports AFTER accepting the message', async () => {
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    expect((await getRec(CHECKOUT_ID)).firstSentAt).toBeTruthy();
    expect(await getPhoneLock(PHONE)).toBeTruthy();

    await R.onCartStatus(CHECKOUT_ID, { status: 'failed', errors: [{ code: 131049 }] }, NOW);

    expect((await getRec(CHECKOUT_ID)).deliveryFailed).toBe(true);
    expect(await getPhoneLock(PHONE)).toBe(null); // they received nothing
    expect((await getParked(PHONE)).checkoutId).toBe(CHECKOUT_ID);
  });

  it('delivers a cart Meta accepted but never delivered, once a window opens', async () => {
    const { clients, deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onCartStatus(CHECKOUT_ID, { status: 'failed', errors: [{ code: 131049 }] }, NOW);

    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    await touchInbound(PHONE, later);
    await R.onWindowOpen(PHONE, { clients, now: later });

    const rec = await getRec(CHECKOUT_ID);
    expect(ctaSends(clients.whatsapp)).toHaveLength(1);
    // Cleared, or onFinal stops with 'first-message-failed' and the reminder
    // is dropped for a message that has now genuinely gone out.
    expect(rec.deliveryFailed).toBe(false);
    expect(await getParked(PHONE)).toBe(null);
  });

  it('does not park a 131026, because no window helps a number that cannot receive WhatsApp', async () => {
    const { deps } = setup();
    await R.onFirst(CHECKOUT_ID, deps);
    await R.onCartStatus(CHECKOUT_ID, { status: 'failed', errors: [{ code: 131026 }] }, NOW);
    expect(await getParked(PHONE)).toBe(null);
  });

  it('does nothing when the phone has no parked checkout', async () => {
    const { clients } = setup();
    await R.onWindowOpen(PHONE, { clients, now: NOW });
    expect(clients.whatsapp.sent).toHaveLength(0);
  });
});
