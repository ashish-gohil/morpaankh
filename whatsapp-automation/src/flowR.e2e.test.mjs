/*
 * Flow R end to end: whole journeys, not single guards.
 *
 * The other suites each test one decision in isolation. What nothing tested is
 * whether the pieces COMPOSE: the five-minute sweep handing a checkout to the
 * worker over SQS, the worker's message leading to a /r/{token} tap, the tap
 * leading to an order, and the order shutting the sequence down. A guard that
 * is right on its own and wrong in sequence is exactly the failure a customer
 * would see, so every test here walks the real chain:
 *
 *   sweepAbandonedCarts -> the queued message -> onFirst -> GET /r/{token}
 *     -> onFinal / onTap / onOrderCreated / onCartStatus
 *
 * Real modules throughout. Only the two outside services are faked, and the
 * table is the memory backend.
 *
 * ONE thing reads the wall clock: the redirect handler compares codeEndsAt to
 * Date.now(), because a customer's tap has no injected clock. Journeys that
 * reach the redirect therefore re-anchor codeEndsAt to the real now first, and
 * say so where they do it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { config } from '../src/config.mjs';
import { RULES } from '../messages/rules.mjs';
import { table, _resetMemory } from './store/table.mjs';
import { _drainQueue } from './queue.mjs';
import { _resetTimers, _peekTimers } from './timers/schedule.mjs';
import { _resetSecrets } from './secrets.mjs';
import { makeFakeClients } from './clients/fakes/index.mjs';
import { fromISTWall } from './lib/time.mjs';
import { setOptOut, setUndeliverable, touchInbound, markMarketing } from './store/phoneProfile.mjs';
import { getRec, getPhoneLock } from './store/cartRecovery.mjs';
import { sweepAbandonedCarts } from './timers/cart-sweep.mjs';
import { putCapture, getCapture } from './store/cartCapture.mjs';
import { getParked, getOrdered } from './store/cartRecovery.mjs';
import { shopifyIngest } from './ingest/shopify.mjs';
import { realClients } from './clients/index.mjs';
import { routes } from './worker/index.mjs';
import { handler as reconcile } from './timers/reconcile.mjs';
import { handler as redirect } from './ingest/cart-redirect.mjs';
import * as R from './worker/cartRecovery.run.mjs';

const NOW = fromISTWall(2026, 9, 12, 12, 0); // 12:00 IST, inside 09:30-22:30
const PHONE = '+919637361371';
const OTHER = '+918888888888';
const ID = '66743166239092';

/** A real-shaped abandoned checkout. Defaults to the Rs 1,249 single-piece bag. */
function cart(id = ID, over = {}) {
  const { phone = '919637361371', items, ...rest } = over;
  return {
    id: `gid://shopify/AbandonedCheckout/${id}`,
    name: `#${id}`,
    createdAt: '2026-10-12T05:00:00Z', // 90 minutes before NOW
    completedAt: null,
    abandonedCheckoutUrl: `https://www.morpaankh.in/99862610292/checkouts/ac/TOK${id}/recover?key=SECRETKEY&locale=en-IN`,
    totalDiscountSet: { shopMoney: { amount: '0.0' } },
    customAttributes: [
      { key: '_otpVerifiedPhoneNumber', value: phone },
      { key: '_codkAmountType', value: 'cod' },
      { key: '_codkAmountValue', value: '50.0' },
      // Present on a fully prepaid checkout too, which is why it is not the
      // partial-advance signal. Here to keep that trap in the journey.
      { key: '_partialPaymentProduct', value: 'partial-payment' },
    ],
    customer: { id: 'gid://shopify/Customer/25164544835956', firstName: 'Bharti' },
    shippingAddress: { firstName: 'Bharti' },
    lineItems: {
      nodes: items || [
        {
          title: 'Khili Dhoop',
          quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: '1599.0' } },
          image: { url: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1', width: 1200, height: 1500 },
          variant: {
            id: 'gid://shopify/ProductVariant/54758494110068',
            availableForSale: true,
            selectedOptions: [{ name: 'Size', value: 'XS' }],
          },
        },
      ],
    },
    ...rest,
  };
}

const order = (over = {}) => ({
  id: 5551212,
  admin_graphql_api_id: 'gid://shopify/Order/5551212',
  name: '#1170',
  created_at: '2026-10-12T09:00:00Z', // 3 hours after NOW, inside the grace
  note_attributes: [{ name: '_otpVerifiedPhoneNumber', value: '919637361371' }],
  discount_codes: [],
  ...over,
});

function world(carts = [cart()], opts = {}) {
  const clients = makeFakeClients({ whatsapp: opts.whatsapp, shopify: opts.shopify });
  for (const c of carts) clients.shopify.seedCheckout(c);
  return { clients, deps: { clients, now: opts.now || NOW } };
}

/** The sweep, then the messages it actually queued, in order. */
async function sweepAndDrain(clients, now = NOW) {
  const out = await sweepAbandonedCarts(clients, now);
  return { out, queued: _drainQueue() };
}

/** Deliver the queued cart messages to the worker exactly as the worker would. */
async function runQueue(queued, deps) {
  const results = [];
  for (const q of queued) {
    const m = q.message;
    if (m.kind !== 'cart') continue;
    results.push(m.step === 'final' ? await R.onFinal(m.checkoutId, deps) : await R.onFirst(m.checkoutId, deps));
  }
  return results;
}

const tapEvent = (token, over = {}) => ({
  pathParameters: { token },
  requestContext: { http: { method: 'GET', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' } },
  headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' },
  ...over,
});

/*
 * Push the code's end into the real future. The redirect handler has no
 * injected clock, so a journey anchored to 12 Oct would otherwise serve the
 * "code has closed" page for a code the worker had just created.
 */
async function liveifyCode(id) {
  const rec = await getRec(id);
  await table.put({ ...rec, codeEndsAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString() });
  return getRec(id);
}

const templates = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const sessions = (wa) => wa.sent.filter((s) => s.type !== 'template');
const discounts = (sh) => sh.calls.filter((c) => c.op === 'createDiscountCode').map((c) => c.args);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);
const alerts = (wa) => wa.sent.filter((s) => s.type === 'template' && s.name.startsWith('ops_alert'));
const customerTemplates = (wa) => templates(wa).filter((n) => n.startsWith('cart_'));
const timerNames = () => _peekTimers().map((t) => t.name);

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  _drainQueue();
  config.ownerAlertPhones = ['+919999999999'];
  config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
  config.cartRecoveryAllowlist = [];
});

// ---------------------------------------------------------------------------
// The journeys that are supposed to work
// ---------------------------------------------------------------------------
describe('POSITIVE: the whole way through', () => {
  it('abandons, is swept, is messaged, is tapped, and comes back with the code', async () => {
    const { clients, deps } = world();

    // 1. the five-minute sweep finds it and queues it on its own phone group
    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued).toEqual([ID]);
    expect(queued[0].groupId).toBe(`phone:${PHONE}`);
    expect(queued[0].dedupId).toBe(`cart-first-${ID}`);

    // 2. the worker sends message 1 and nothing else
    await runQueue(queued, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
    const made = discounts(clients.shopify);
    expect(made).toHaveLength(1);
    // Rs 200 is the top tier's ceiling, reached on a Rs 1,599 bag. The same
    // Rs 200 on a Rs 1,249 bag is 16% off and is what offerTiers now forbids.
    expect(made[0].amountInr).toBe(200);
    expect(made[0].title).toBe(`Cart recovery #${ID}`);
    const rec = await getRec(ID);
    expect(rec.code).toMatch(/^MORPAANKHBHARTI[2-9]{2}$/);
    expect(rec.firstSentAt).toBeTruthy();
    expect(await getPhoneLock(PHONE)).toMatchObject({ checkoutId: ID });
    expect(timerNames()).toContain(`R-${ID}-final`);

    // the message carries the code, the item, the saving and the close time
    const msg = clients.whatsapp.sent.find((s) => s.name === 'cart_recovery_v1');
    const text = JSON.stringify(msg.components);
    expect(text).toContain(rec.code);
    expect(text).toContain('Khili Dhoop, size XS');
    expect(text).toContain('200');
    // and never the recovery credential
    expect(text).not.toContain('SECRETKEY');

    // 3. they tap Complete my order
    const live = await liveifyCode(ID);
    const res = await redirect(tapEvent(live.token));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toContain(`/discount/${live.code}?redirect=`);
    const back = decodeURIComponent(new URL(res.headers.Location).searchParams.get('redirect'));
    expect(back).toContain(`/checkouts/ac/TOK${ID}/recover`);
    expect((await getRec(ID)).clicks).toBe(1);

    // 4. they order, with the code on it
    await R.onOrderCreated(order({ discount_codes: [{ code: live.code }] }), deps);
    const done = await getRec(ID);
    expect(done).toMatchObject({ outcome: 'recovered', orderId: '5551212', codeUsed: true });
    expect(tagsAdded(clients.shopify)).toEqual(expect.arrayContaining(['wa-cart-recovered', 'gift-in-parcel']));
    expect(timerNames()).not.toContain(`R-${ID}-final`);

    // 5. and the reminder that was armed before the order is now a no-op
    expect(await R.onFinal(ID, { ...deps, now: new Date(done.reminderAt) })).toMatchObject({ skipped: 'outcome-recovered' });
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
  });

  it('no tap: the reminder goes two hours before the close, then they come back', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    const rec = await getRec(ID);

    // the reminder is armed for the stored time, on the same per-phone group
    const armed = _peekTimers().find((t) => t.name === `R-${ID}-final`);
    /*
     * The stored minute when it is still ahead of the caller's clock, and the
     * clock + 60s floor when it is not. scheduleTimer refuses to arm a timer in
     * the past, and that floor used to read the WALL clock, which made
     * asserting the literal value pass only in the morning. It measures against
     * `deps.now` now, so the fixture's reminderAt is always the stored minute.
     */
    const stored = Date.parse(rec.reminderAt);
    if (stored <= NOW.getTime() + 60 * 1000) expect(new Date(armed.at).getTime()).toBeGreaterThan(NOW.getTime());
    else expect(new Date(armed.at).toISOString()).toBe(rec.reminderAt);
    expect(armed.groupId).toBe(`phone:${PHONE}`);

    // it fires
    expect(await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) })).toMatchObject({ sent: true });
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1', 'cart_final_v1']);
    // the SAME code and the SAME close time, never a new one
    const after = await getRec(ID);
    expect(after.code).toBe(rec.code);
    expect(after.codeEndsAt).toBe(rec.codeEndsAt);
    expect(discounts(clients.shopify)).toHaveLength(1);

    // then the order
    await R.onOrderCreated(order({ created_at: after.codeEndsAt, discount_codes: [{ code: rec.code }] }), deps);
    expect((await getRec(ID)).outcome).toBe('recovered');
  });

  it('comes back WITHOUT using the code: still recovered, and the owner is told', async () => {
    const { clients, deps } = world();
    await R.onFirst(ID, deps);
    await R.onOrderCreated(order(), deps);

    const rec = await getRec(ID);
    expect(rec).toMatchObject({ outcome: 'recovered', codeUsed: false });
    expect(tagsAdded(clients.shopify)).toContain('wa-cart-recovered');
    expect(JSON.stringify(alerts(clients.whatsapp))).toMatch(/was NOT applied/);
  });

  it('comes back after the code closed but inside the grace: recovered, no gift', async () => {
    const { clients, deps } = world();
    await R.onFirst(ID, deps);
    const rec = await getRec(ID);
    const late = new Date(new Date(rec.codeEndsAt).getTime() + 3600 * 1000).toISOString();

    await R.onOrderCreated(order({ created_at: late }), { ...deps, now: new Date(late) });
    expect((await getRec(ID)).outcome).toBe('recovered');
    expect(tagsAdded(clients.shopify)).toContain('wa-cart-recovered');
    expect(tagsAdded(clients.shopify)).not.toContain('gift-in-parcel');
    expect(JSON.stringify(alerts(clients.whatsapp))).not.toMatch(/was NOT applied/);
  });

  it('taps Talk to us: gets a person, and the reminder is called off', async () => {
    const { clients, deps } = world();
    await R.onFirst(ID, deps);
    await R.onTap(ID, 'help', PHONE, deps);

    const reply = sessions(clients.whatsapp);
    expect(reply).toHaveLength(1);
    expect(JSON.stringify(reply[0])).toMatch(/until/);
    expect(timerNames()).not.toContain(`R-${ID}-final`);
    const rec = await getRec(ID);
    expect(rec.helpRequestedAt).toBeTruthy();
    expect(await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) })).toMatchObject({ skipped: 'asked-for-a-person' });

    // and the owner hears about it, with the bag named
    expect(JSON.stringify(alerts(clients.whatsapp))).toMatch(/Khili Dhoop/);
  });

  it('a bag with no photo goes out as the plain twin, all the way through', async () => {
    const noPhoto = cart(ID, {
      items: [{
        title: 'Khili Dhoop',
        quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1599.0' } },
        image: null,
        variant: { id: 'gid://shopify/ProductVariant/1', availableForSale: true, selectedOptions: [{ name: 'Size', value: 'XS' }] },
      }],
    });
    const { clients, deps } = world([noPhoto]);
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_plain_v1']);

    const rec = await getRec(ID);
    await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) });
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_plain_v1', 'cart_final_plain_v1']);
  });

  it('two phones, one allowlisted: one is messaged and one is only watched', async () => {
    config.cartRecoveryAllowlist = [PHONE];
    const mine = cart(ID);
    const theirs = cart('77700000000001', { phone: '918888888888' });
    const { clients, deps } = world([mine, theirs]);

    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued.sort()).toEqual([ID, '77700000000001'].sort());
    await runQueue(queued, deps);

    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
    expect((await getRec('77700000000001')).outcome).toBe('shadow');
    expect(await getPhoneLock(OTHER)).toBe(null);
    expect(discounts(clients.shopify)).toHaveLength(1);
  });

  it('the same bag abandoned twice: the newest wins, and the older is never touched', async () => {
    const older = cart('66748125053300', { createdAt: '2026-10-12T04:00:00Z' });
    const newer = cart(ID, { createdAt: '2026-10-12T05:00:00Z' });
    // Deliberately seeded oldest-first, so only the sweep's own sort can save it.
    const { clients, deps } = world([older, newer]);

    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued).toEqual([ID]);
    expect(out.skipped['older-checkout-for-phone']).toBe(1);
    await runQueue(queued, deps);

    expect(await getRec('66748125053300')).toBe(null);
    const sent = clients.whatsapp.sent.find((s) => s.name === 'cart_recovery_v1');
    expect(JSON.stringify(sent.components)).toContain('Khili Dhoop');
    expect(customerTemplates(clients.whatsapp)).toHaveLength(1);

    // A sweep five minutes later finds the same pair and does nothing at all.
    const second = await sweepAndDrain(clients, new Date(NOW.getTime() + 5 * 60000));
    expect(second.out.enqueued).toEqual([]);
    expect(second.queued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The journeys that must stop, and where
// ---------------------------------------------------------------------------
describe('NEGATIVE: nothing gets through the sweep that should not', () => {
  /*
   * Excluded by the QUERY, not by our own check: `status:open
   * created_at:>='<12h ago>'`. The fake filters the same way the real API
   * does, so these never reach the eligibility loop at all, and the assertion
   * that matters is that the window asked for is the one the rules say.
   */
  const notEvenListed = [
    ['older than 12h, however fresh updatedAt looks', { createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-12T11:59:00Z' }],
    ['abandoned weeks ago', { createdAt: '2026-09-30T06:00:00Z' }],
    ['already completed', { completedAt: '2026-10-12T06:00:00Z' }],
  ];

  it.each(notEvenListed)('is never even listed when it is %s', async (_name, over) => {
    const { clients } = world([cart(ID, over)]);
    const { out, queued } = await sweepAndDrain(clients);
    expect(out.listed).toBe(0);
    expect(out.enqueued).toEqual([]);
    expect(queued).toHaveLength(0);
    expect(await getRec(ID)).toBe(null);

    const asked = clients.shopify.calls.find((c) => c.op === 'listAbandonedCheckouts');
    expect(NOW.getTime() - new Date(asked.sinceISO).getTime())
      .toBe(RULES.cartRecovery.maxCheckoutAgeHours * 3600 * 1000);
  });

  const unfit = [
    ['younger than the 20 minute wait', { createdAt: '2026-10-12T06:25:00Z' }, 'too-fresh'],
    ['no verified phone', { customAttributes: [{ key: '_codkAmountType', value: 'cod' }] }, 'no-verified-phone'],
    ['a partial advance, where the prices are only the deposit', {
      customAttributes: [
        { key: '_otpVerifiedPhoneNumber', value: '919637361371' },
        { key: '_codkAmountType', value: 'percentage' },
        { key: '_codkAmountValue', value: '5.0' },
      ],
    }, 'partial-advance'],
    ['a bag that has sold out since', {
      items: [{
        title: 'Khili Dhoop', quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1249.0' } },
        image: null,
        variant: { id: 'gid://shopify/ProductVariant/1', availableForSale: false, selectedOptions: [] },
      }],
    }, 'sold-out'],
    ['a bag worth nothing', {
      items: [{
        title: 'Freebie', quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '0.0' } },
        image: null,
        variant: { id: 'gid://shopify/ProductVariant/1', availableForSale: true, selectedOptions: [] },
      }],
    }, 'no-value'],
  ];

  it('skips one created before the flow was switched on, even though it is fresh', async () => {
    // Listed, because it is inside the 12 hours. Refused, because the flow was
    // switched on after they walked away: a first enable must not message a
    // backlog.
    config.flows.R = { enabled: true, startAt: '2026-10-12T06:00:00Z' };
    const { clients } = world([cart(ID, { createdAt: '2026-10-12T05:00:00Z' })]);
    const { out, queued } = await sweepAndDrain(clients);
    expect(out.listed).toBe(1);
    expect(out.skipped['before-start']).toBe(1);
    expect(queued).toHaveLength(0);
    expect(await getRec(ID)).toBe(null);
  });

  it.each(unfit)('skips one that is %s', async (_name, over, reason) => {
    const { clients } = world([cart(ID, over)]);
    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued).toEqual([]);
    expect(queued).toHaveLength(0);
    expect(Object.keys(out.skipped)).toContain(reason);
    // Nothing was written, so a later sweep is free to reconsider.
    expect(await getRec(ID)).toBe(null);
  });

  const silent = [
    ['the flow is switched off', () => { config.flows.R = { enabled: false, startAt: '2026-10-01T00:00:00Z' }; }, 'flow-r-off'],
    ['there is no start time at all', () => { config.flows.R = { enabled: true, startAt: '' }; }, null],
  ];

  it.each(silent)('writes nothing when %s', async (_name, mutate, skipped) => {
    mutate();
    const { clients } = world();
    const { out, queued } = await sweepAndDrain(clients);
    if (skipped) expect(out).toEqual({ skipped });
    else expect(out.enqueued).toEqual([]);
    expect(queued).toHaveLength(0);
    expect(await getRec(ID)).toBe(null);
  });

  it('writes nothing outside 09:30 to 22:30 IST, and queues nothing for later', async () => {
    const { clients } = world();
    for (const hour of [0, 6, 9, 23]) {
      const at = fromISTWall(2026, 9, 12, hour, hour === 9 ? 0 : 15);
      const { out, queued } = await sweepAndDrain(clients, at);
      expect(out).toEqual({ skipped: 'outside-window' });
      expect(queued).toHaveLength(0);
    }
    expect(await getRec(ID)).toBe(null);
  });
});

describe('NEGATIVE: the worker refuses, and records why', () => {
  const refusals = [
    ['they have opted out', async () => setOptOut(PHONE, true, NOW), 'opted-out'],
    ['the number cannot receive WhatsApp', async () => setUndeliverable(PHONE, 'x', NOW), 'undeliverable'],
    ['they already had a sequence inside 30 days', async () => {
      const { lockPhone } = await import('./store/cartRecovery.mjs');
      await lockPhone(PHONE, { checkoutId: 'OTHER', until: new Date(NOW.getTime() + 20 * 86400000), now: NOW });
    }, 'cooldown'],
    ['they had another marketing message this week', async () => markMarketing(PHONE, new Date(NOW.getTime() - 86400000)), 'marketing-cap'],
  ];

  it.each(refusals)('refuses because %s, taking no lock and creating nothing', async (_name, arrange, outcome) => {
    const { clients, deps } = world();
    await arrange();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);

    expect((await getRec(ID)).outcome).toBe(outcome);
    expect(customerTemplates(clients.whatsapp)).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(timerNames()).not.toContain(`R-${ID}-final`);
  });

  it('refuses when the bag already gets as much as we could offer', async () => {
    // Rs 1,600 with Rs 250 already off it. The offer ceiling for this band is
    // Rs 200, so there is nothing we can put on the table that beats what the
    // bag is already getting. The tier is what refuses it now, not the 20% cap.
    const rich = cart(ID, {
      totalDiscountSet: { shopMoney: { amount: '250.0' } },
      items: [{
        title: 'Sahaj', quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1600.0' } },
        image: null,
        variant: { id: 'gid://shopify/ProductVariant/1', availableForSale: true, selectedOptions: [] },
      }],
    });
    const { clients, deps } = world([rich]);
    await R.onFirst(ID, deps);
    expect((await getRec(ID)).outcome).toBe('public-offer-better');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('refuses to offer blind when the live codes cannot be read, and tells the owner once', async () => {
    const { clients, deps } = world([cart()], { shopify: { failPublicCodes: true } });
    await R.onFirst(ID, deps);
    expect((await getRec(ID)).outcome).toBe('no-public-codes');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(JSON.stringify(alerts(clients.whatsapp))).toMatch(/read_discounts/);

    // A second checkout the same day does not alert again.
    const before = alerts(clients.whatsapp).length;
    clients.shopify.seedCheckout(cart('66748125053300'));
    await R.onFirst('66748125053300', deps);
    expect(alerts(clients.whatsapp)).toHaveLength(before);
  });

  it('a gated send (DRY_RUN or SEND_ALLOWLIST) creates nothing at all', async () => {
    const { clients, deps } = world([cart()], { whatsapp: { skipWith: 'dry_run' } });
    await R.onFirst(ID, deps);
    expect((await getRec(ID)).outcome).toBe('send-dry_run');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneLock(PHONE)).toBe(null);
  });

  it.each([[131026], [131049], [132001]])('Meta refusing with %i leaves no lock and no reminder', async (code) => {
    const { clients, deps } = world([cart()], { whatsapp: { failTemplateWith: code } });
    await R.onFirst(ID, deps);

    const rec = await getRec(ID);
    const expected = { 132001: 'template-unusable', 131049: 'waiting-window' }[code] || `meta-${code}`;
    expect(rec.outcome).toBe(expected);
    expect(rec.firstSentAt).toBeUndefined();
    expect(await getPhoneLock(PHONE)).toBe(null);
    expect(timerNames()).not.toContain(`R-${ID}-final`);
    // and the reminder, if something ever did fire it, refuses too
    expect(await R.onFinal(ID, deps)).toMatchObject({ skipped: 'no-first-message' });

    // the next sweep does NOT try again: the outcome is recorded
    const second = await sweepAndDrain(clients, new Date(NOW.getTime() + 5 * 60000));
    expect(second.out.enqueued).toEqual([]);
  });

  it('a transient failure throws so SQS redelivers, and the customer still gets ONE of everything', async () => {
    const { clients, deps } = world([cart()], { whatsapp: { failTemplateWith: 500 } });
    // Not recorded as an outcome and not swallowed: the message has to be tried
    // again, so the throw is the point.
    await expect(R.onFirst(ID, deps)).rejects.toThrow();
    const half = await getRec(ID);
    expect(half.firstSentAt).toBeUndefined();
    expect(half.outcome).toBeUndefined();
    expect(customerTemplates(clients.whatsapp)).toHaveLength(0);
    // The code was already created before the send was attempted, which is why
    // it is memoised: the retry must not mint a second one.
    expect(discounts(clients.shopify)).toHaveLength(1);
    expect(await getPhoneLock(PHONE)).toBe(null);

    // SQS redelivers to a healthy worker. Same table, new clients.
    const ok = world([cart()]);
    await R.onFirst(ID, ok.deps);
    expect(customerTemplates(ok.clients.whatsapp)).toEqual(['cart_recovery_v1']);
    const sentRec = await getRec(ID);
    expect(sentRec.code).toBe(half.code);
    expect(sentRec.codeEndsAt).toBe(half.codeEndsAt);
    // No SECOND code: the one the failed attempt made is the one they get.
    expect(discounts(ok.clients.shopify)).toHaveLength(0);

    // And a third delivery of the same message changes nothing.
    await R.onFirst(ID, ok.deps);
    expect(customerTemplates(ok.clients.whatsapp)).toEqual(['cart_recovery_v1']);
  });

  it('a code collision retries and widens to three digits rather than reusing one', async () => {
    const { clients, deps } = world([cart()], { shopify: { takenCodes: Array(6).fill(true) } });
    await R.onFirst(ID, deps);
    const made = discounts(clients.shopify);
    expect(made).toHaveLength(7);
    expect(made.slice(0, 6).every((a) => /[2-9]{2}$/.test(a.code))).toBe(true);
    expect(made[6].code).toMatch(/[2-9]{3}$/);
    expect((await getRec(ID)).code).toBe(made[6].code);
  });
});

describe('NEGATIVE: every reason the reminder stays quiet', () => {
  async function started(opts = {}) {
    // Held by reference so a test can mark the code used AFTER it exists.
    const usage = {};
    const w = world([cart()], { ...opts, shopify: { discountUsage: usage, ...(opts.shopify || {}) } });
    await R.onFirst(ID, w.deps);
    const rec = await getRec(ID);
    return { ...w, usage, rec, at: { ...w.deps, now: new Date(rec.reminderAt) } };
  }

  it('does not send twice', async () => {
    const s = await started();
    expect(await R.onFinal(ID, s.at)).toMatchObject({ sent: true });
    expect(await R.onFinal(ID, s.at)).toMatchObject({ skipped: 'already-sent' });
    expect(customerTemplates(s.clients.whatsapp).filter((n) => n === 'cart_final_v1')).toHaveLength(1);
  });

  const quiet = [
    ['the code has been used by anyone', async (s) => { s.usage[s.rec.discountId] = 1; }, 'code-used'],
    ['they have written to us since', async (s) => touchInbound(PHONE, new Date(s.rec.reminderAt)), 'they-replied'],
    ['they sent STOP', async () => setOptOut(PHONE, true, NOW), 'opted-out'],
    ['they asked for a person', async (s) => R.onTap(ID, 'help', PHONE, s.deps), 'asked-for-a-person'],
    ['message 1 never actually reached them', async (s) => R.onCartStatus(ID, { id: (await getRec(ID)).wamids[0], status: 'failed', errors: [{ code: 131026 }] }), 'first-message-failed'],
    ['the checkout has been completed since', async (s) => { s.clients.shopify.seedCheckout(cart(ID, { completedAt: '2026-10-12T20:00:00Z' })); }, 'completed'],
    ['the flow has been switched off since', async () => { config.flows.R = { enabled: false, startAt: '2026-10-01T00:00:00Z' }; }, 'flow-r-off'],
  ];

  it.each(quiet)('stays quiet because %s', async (_name, arrange, reason) => {
    const s = await started();
    await arrange(s);
    expect(await R.onFinal(ID, s.at)).toMatchObject({ skipped: reason });
    expect(customerTemplates(s.clients.whatsapp)).not.toContain('cart_final_v1');
    expect((await getRec(ID)).finalSkipped).toBe(reason);
  });

  it('stays quiet outside the window, and when there is no time left to act', async () => {
    const s = await started();
    const end = new Date(s.rec.codeEndsAt);
    // 23:00 IST on the day of the reminder
    const night = fromISTWall(2026, 9, 12, 23, 0);
    expect(await R.onFinal(ID, { ...s.deps, now: night })).toMatchObject({ skipped: 'outside-window' });
    // ten minutes before the close, which is less than finalMinRemainingMin
    const late = new Date(end.getTime() - 10 * 60000);
    expect(await R.onFinal(ID, { ...s.deps, now: late })).toMatchObject({ skipped: 'too-close-to-the-end' });
    expect(customerTemplates(s.clients.whatsapp)).not.toContain('cart_final_v1');
  });
});

describe('NEGATIVE: the link itself', () => {
  async function live() {
    const { clients, deps } = world();
    await R.onFirst(ID, deps);
    return { clients, deps, rec: await liveifyCode(ID) };
  }

  it('an unknown, guessed or truncated token goes to the shop, never an error', async () => {
    await live();
    for (const token of ['nope', '', 'MORPAANKHBHARTI47', 'a'.repeat(64)]) {
      const res = await redirect(tapEvent(token));
      expect(res.statusCode).toBe(302);
      expect(res.headers.Location).toBe('https://www.morpaankh.in');
    }
  });

  it('a preview fetch, a bot and a HEAD are redirected but never counted', async () => {
    const { rec } = await live();
    const agents = ['WhatsApp/2.23.20.0', 'facebookexternalhit/1.1', 'Googlebot/2.1', 'TelegramBot (like TwitterBot)'];
    for (const ua of agents) {
      const res = await redirect(tapEvent(rec.token, {
        requestContext: { http: { method: 'GET', userAgent: ua } },
        headers: { 'user-agent': ua },
      }));
      expect(res.statusCode).toBe(302);
    }
    const head = await redirect(tapEvent(rec.token, {
      requestContext: { http: { method: 'HEAD', userAgent: 'Mozilla/5.0' } },
      headers: { 'user-agent': 'Mozilla/5.0' },
    }));
    expect(head.statusCode).toBe(302);
    expect((await getRec(ID)).clicks).toBeUndefined();

    // then a real tap, which does count
    await redirect(tapEvent(rec.token));
    expect((await getRec(ID)).clicks).toBe(1);
  });

  it('serves the closed page once the code has gone, still carrying their bag', async () => {
    const { rec } = await live();
    await table.put({ ...(await getRec(ID)), codeEndsAt: new Date(Date.now() - 1000).toISOString() });
    const res = await redirect(tapEvent(rec.token));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`/checkouts/ac/TOK${ID}/recover`);
    expect(res.body).not.toContain('discount=');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('serves the thank-you page once the order is in', async () => {
    const { rec, deps } = await live();
    await R.onOrderCreated(order({ discount_codes: [{ code: rec.code }] }), deps);
    const res = await redirect(tapEvent(rec.token));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('recover?key=');
  });

  it('never lets the recovery key reach a log line, on any branch of a whole journey', async () => {
    const seen = [];
    const spy = (...a) => seen.push(JSON.stringify(a));
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(spy),
      vi.spyOn(console, 'warn').mockImplementation(spy),
      vi.spyOn(console, 'error').mockImplementation(spy),
    ];
    try {
      const { clients, deps } = world();
      const { queued } = await sweepAndDrain(clients);
      await runQueue(queued, deps);
      const rec = await liveifyCode(ID);
      await redirect(tapEvent(rec.token));
      await redirect(tapEvent('nope'));
      await R.onTap(ID, 'help', PHONE, deps);
      await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) });
      await R.onOrderCreated(order({ discount_codes: [{ code: rec.code }] }), deps);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = seen.join('\n');
    expect(all).not.toContain('SECRETKEY');
    expect(all).not.toContain('key=');
    expect(all).not.toContain('/recover');
    // and no full phone number either
    expect(all).not.toContain('919637361371');
  });

  it('ignores a tap from a phone that does not own the checkout', async () => {
    const { clients, deps } = await live();
    const before = clients.whatsapp.sent.length;
    await R.onTap(ID, 'help', OTHER, deps);
    expect(clients.whatsapp.sent).toHaveLength(before);
    expect((await getRec(ID)).helpRequestedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ORDERED: every way an order can reach us, walked end to end
//
// These are the journeys that actually failed in production on 30 and 31 Oct
// 2026. They run the REAL chain, including the real router, because the bug
// was never in one guard: it was in what the pieces knew about each other.
//
//   checkouts/update webhook -> onCheckoutSeen -> CAP row
//     -> sweepAbandonedCarts -> SQS -> onFirst
//     -> orders/create webhook -> shopifyIngest -> routes.shopify -> the stop
// ---------------------------------------------------------------------------
describe('ORDERED: an order stops the sequence, whatever shape it arrives in', () => {
  const VARIANT = 'gid://shopify/ProductVariant/54758494110068';
  const CART_TOKEN = 'Z2NwLWFzaWEtc291dGgxOjAx';

  /** The live COD King checkout webhook, which is how a cart is really seen. */
  const checkoutWebhook = (over = {}) => ({
    token: 'hWNIV3Gkef85j1R6nr2cSecm',
    cart_token: CART_TOKEN,
    completed_at: null,
    created_at: '2026-10-12T05:00:00Z',
    updated_at: '2026-10-12T05:00:00Z',
    note_attributes: [
      { name: '_otpVerifiedPhoneNumber', value: '919637361371' },
      { name: '_codkSessionId', value: '9a221ac6-47de-41e9-90e5-1ad6cf353330' },
      { name: '_codkAmountType', value: 'cod' },
      { name: '_codkAmountValue', value: '50.0' },
    ],
    line_items: [{ variant_id: 54758494110068, quantity: 1 }],
    ...over,
  });

  /** A fake with the variant the captured cart is priced against. */
  function capturedWorld(opts = {}) {
    const w = world([], opts);
    w.clients.shopify.seedVariant({
      id: VARIANT,
      price: '1599.00',
      availableForSale: true,
      title: 'XS',
      selectedOptions: [{ name: 'Size', value: 'XS' }],
      product: { title: 'Khili Dhoop', featuredImage: { url: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1', width: 1200, height: 1500 } },
    });
    w.clients.shopify.seedCustomerByPhone(PHONE, { id: 'gid://shopify/Customer/25164544835956', firstName: 'Bharti' });
    return w;
  }

  /*
   * The order webhook over the REAL router, with realClients swapped for the
   * fakes for the duration. Driving routes.shopify rather than the handler
   * directly is the point: the wiring between the ingest, Flow A and this hook
   * is where a correct handler goes unreached.
   */
  async function orderWebhookThroughRouter(clients, payload) {
    const [item] = shopifyIngest.toItems(
      { 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': `wh-${payload.id}` },
      payload,
    );
    expect(item.message.kind).toBe('shopify');
    const saved = { shopify: realClients.shopify, whatsapp: realClients.whatsapp };
    realClients.shopify = clients.shopify;
    realClients.whatsapp = clients.whatsapp;
    try {
      return await routes.shopify(item.message);
    } finally {
      Object.assign(realClients, saved);
    }
  }

  /** A prepaid order through Shopify's own checkout: no COD King attribute. */
  const prepaidOrder = (over = {}) => ({
    id: 779001,
    admin_graphql_api_id: 'gid://shopify/Order/779001',
    name: '#1301',
    created_at: '2026-10-12T05:30:00Z',
    note_attributes: [],
    discount_codes: [],
    shipping_address: { phone: '+91 96373 61371' },
    ...over,
  });

  it('THE PRODUCTION FAILURE: the capture is refreshed a second after the order, and nothing goes out', async () => {
    /*
     * #1234 exactly: order created 09:55:02Z, capture refreshed 09:55:03.116Z
     * as the checkout completed, messaged 22 minutes later. The orders query
     * was anchored on the capture, so the order sat one second outside it.
     */
    const { clients, deps } = capturedWorld();
    const ORDER_AT = '2026-10-12T05:55:02Z';
    const CAPTURED_AT = '2026-10-12T05:55:03.116Z';

    // the checkout is seen, twice: once mid-session, once as the order lands
    await R.onCheckoutSeen(checkoutWebhook(), { now: new Date('2026-10-12T05:00:00Z') });
    await R.onCheckoutSeen(checkoutWebhook({ updated_at: CAPTURED_AT }), { now: new Date(CAPTURED_AT) });
    expect((await getCapture(`cap_${CART_TOKEN}`)).capturedAt).toBe(CAPTURED_AT);

    // they paid online, so the order carries no OTP attribute at all
    clients.shopify.seed({
      id: 'gid://shopify/Order/779001', name: '#1301', createdAt: ORDER_AT,
      customer: null, shippingAddress: { phone: '+919637361371' },
    });

    // 20 minutes after the capture, the sweep picks the cart up and queues it
    const later = new Date('2026-10-12T06:17:00Z');
    const { out, queued } = await sweepAndDrain(clients, later);
    expect(out.enqueued).toEqual([`cap_${CART_TOKEN}`]);

    await runQueue(queued, { ...deps, now: later });

    expect(customerTemplates(clients.whatsapp)).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneLock(PHONE)).toBe(null);
    expect((await getRec(`cap_${CART_TOKEN}`)).outcome).toBe('already-ordered');
    expect(timerNames()).toHaveLength(0);
  });

  it('COD through COD King: the whole sequence is stopped the moment the order webhook lands', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
    expect(timerNames()).toContain(`R-${ID}-final`);
    const rec = await getRec(ID);

    // a COD order, 30 minutes later, carrying the OTP attribute
    clients.shopify.seed({ id: 'gid://shopify/Order/779002', name: '#1302', createdAt: '2026-10-12T07:00:00Z' });
    await orderWebhookThroughRouter(clients, order({
      id: 779002, admin_graphql_api_id: 'gid://shopify/Order/779002', name: '#1302',
      created_at: '2026-10-12T07:00:00Z',
    }));

    expect(timerNames()).not.toContain(`R-${ID}-final`);
    // the reminder refuses even if its timer fires anyway
    await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) });
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
  });

  it('PREPAID from a different device and checkout: still stopped, on the shipping phone alone', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    const rec = await getRec(ID);

    /*
     * Nothing links this to the cart but the number on the shipping address,
     * and it was placed while message 1 was in flight, so it cannot be a
     * recovery: the stop is the only thing that can end this sequence.
     */
    clients.shopify.seed({ id: 'gid://shopify/Order/779003', name: '#1303', createdAt: '2026-10-12T06:00:00Z' });
    await orderWebhookThroughRouter(clients, prepaidOrder({
      id: 779003, admin_graphql_api_id: 'gid://shopify/Order/779003', name: '#1303',
      created_at: '2026-10-12T06:00:00Z', customer: null,
    }));

    const after = await getRec(ID);
    expect(after.outcome).toBe('already-ordered');
    expect(after.stoppedByOrder).toBe('779003');
    expect(timerNames()).not.toContain(`R-${ID}-final`);
    await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) });
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
  });

  it('the order arrives BEFORE the sweep has even started a sequence', async () => {
    /*
     * No REC row exists yet, so there is nothing to stamp. The per-identity
     * marker carries the answer instead, and it is read before Shopify is
     * asked, which also covers the order search index lagging the create.
     */
    const { clients, deps } = capturedWorld();
    await R.onCheckoutSeen(checkoutWebhook(), { now: new Date('2026-10-12T05:00:00Z') });

    // the webhook lands first, and Shopify has NOT indexed the order yet
    await orderWebhookThroughRouter(clients, prepaidOrder({ created_at: '2026-10-12T05:30:00Z' }));
    expect(await getOrdered('p:9637361371')).toMatchObject({ orderId: '779001' });

    const { queued } = await sweepAndDrain(clients, new Date('2026-10-12T05:45:00Z'));
    expect(queued).toHaveLength(1); // the sweep still queues it: it decides nothing
    await runQueue(queued, { ...deps, now: new Date('2026-10-12T05:45:00Z') });

    expect(customerTemplates(clients.whatsapp)).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect((await getRec(`cap_${CART_TOKEN}`)).outcome).toBe('already-ordered');
  });

  it('a checkout parked for a service window is released, and the customer writing in sends nothing', async () => {
    // Meta refuses the template with the per-user marketing cap, so the
    // checkout waits for a service window instead.
    const { clients, deps } = world([cart()], { whatsapp: { failTemplateWith: 131049 } });
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    expect(await getParked(PHONE)).toMatchObject({ checkoutId: ID });

    clients.shopify.seed({ id: 'gid://shopify/Order/779004', name: '#1304', createdAt: '2026-10-12T06:30:00Z' });
    await orderWebhookThroughRouter(clients, prepaidOrder({
      id: 779004, admin_graphql_api_id: 'gid://shopify/Order/779004', name: '#1304',
      created_at: '2026-10-12T06:30:00Z',
    }));
    expect(await getParked(PHONE)).toBe(null);

    // they write to us an hour later: the window is open and still nothing goes
    const later = new Date(NOW.getTime() + 3600 * 1000);
    await touchInbound(PHONE, later);
    await R.onWindowOpen(PHONE, { clients, now: later });
    expect(customerTemplates(clients.whatsapp)).toHaveLength(0);
  });

  it('a late, duplicated and out-of-order webhook storm changes nothing', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    const rec = await getRec(ID);

    clients.shopify.seed({ id: 'gid://shopify/Order/779005', name: '#1305', createdAt: '2026-10-12T06:00:00Z' });
    const payload = prepaidOrder({
      id: 779005, admin_graphql_api_id: 'gid://shopify/Order/779005', name: '#1305',
      created_at: '2026-10-12T06:00:00Z',
    });
    // the same webhook five times over
    for (let i = 0; i < 5; i += 1) await orderWebhookThroughRouter(clients, payload);
    // then a replay of a DIFFERENT order from a week later, arriving out of
    // order. By then the code has closed, so it has nothing left to stop.
    await orderWebhookThroughRouter(clients, { ...payload, id: 779006, created_at: '2026-10-19T06:30:00Z' });

    const after = await getRec(ID);
    expect(after.outcome).toBe('already-ordered');
    // The row is stamped once; nothing after it relabels why we stopped.
    expect(after.stoppedByOrder).toBe('779005');
    expect(after.outcomeAt).toBe((await getRec(ID)).outcomeAt);
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
    await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) });
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
  });

  it('a REAL recovery is still attributed, tagged and owed its gift', async () => {
    /*
     * Order #1239 reproduced: our code applied, inside the window, through
     * Shopify's own checkout with no OTP attribute, and against a SECOND
     * customer record COD King minted for the same person.
     */
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    const rec = await getRec(ID);

    clients.shopify.seed({ id: 'gid://shopify/Order/779007', name: '#1239', createdAt: '2026-10-12T07:26:00Z' });
    await orderWebhookThroughRouter(clients, prepaidOrder({
      id: 779007, admin_graphql_api_id: 'gid://shopify/Order/779007', name: '#1239',
      created_at: '2026-10-12T07:26:00Z',
      customer: { id: 25277029941620 },
      discount_codes: [{ code: rec.code }],
    }));

    expect(await getRec(ID)).toMatchObject({ outcome: 'recovered', orderId: '779007', codeUsed: true });
    expect(tagsAdded(clients.shopify)).toEqual(expect.arrayContaining(['wa-cart-recovered', 'gift-in-parcel']));
    expect(timerNames()).not.toContain(`R-${ID}-final`);
  });

  it('a phone written any way at all still matches', async () => {
    for (const written of ['0 96373 61371', '+91-96373-61371', '919637361371', '96373 61371', '+91 9637361371']) {
      _resetMemory();
      _resetTimers();
      _drainQueue();
      const { clients, deps } = world();
      clients.shopify.seed({
        id: 'gid://shopify/Order/779008', name: '#1308', createdAt: '2026-10-12T05:30:00Z',
        customer: null, phone: written,
      });
      const { queued } = await sweepAndDrain(clients);
      await runQueue(queued, deps);
      expect(customerTemplates(clients.whatsapp), `written as ${written}`).toHaveLength(0);
      expect((await getRec(ID)).outcome).toBe('already-ordered');
    }
  });

  it('REGRESSION: a stranger ordering leaves the sequence completely alone', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    const rec = await getRec(ID);

    clients.shopify.seed({ id: 'gid://shopify/Order/779009', name: '#1309', createdAt: '2026-10-12T06:30:00Z' });
    await orderWebhookThroughRouter(clients, prepaidOrder({
      id: 779009, admin_graphql_api_id: 'gid://shopify/Order/779009', name: '#1309',
      created_at: '2026-10-12T06:30:00Z',
      customer: { id: 424242 }, phone: '+919000000001',
      shipping_address: { phone: '+919000000001' }, email: 'someone@else.com',
    }));

    expect((await getRec(ID)).outcome).toBeUndefined();
    expect(timerNames()).toContain(`R-${ID}-final`);
    // and the reminder still goes out, exactly as before
    await R.onFinal(ID, { ...deps, now: new Date(rec.reminderAt) });
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1', 'cart_final_v1']);
  });

  it('REGRESSION: an order six days old does not silence a fresh cart', async () => {
    /*
     * The owner's own number did this on 29 Oct: orders on 13 and 23 Oct, a
     * new bag abandoned on the 29th. That message was correct, so the lookback
     * is bounded at the longest a sequence can live rather than "ever".
     */
    const { clients, deps } = world();
    clients.shopify.seed({
      id: 'gid://shopify/Order/779010', name: '#1310',
      createdAt: '2026-10-06T06:30:00Z', // six days before this cart
      customer: { id: 'gid://shopify/Customer/25164544835956' },
    });
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['cart_recovery_v1']);
  });
});

describe('NEGATIVE: the five-minute rule cannot run the nightly pass', () => {
  it('{mode:carts} does carts and nothing else, 288 times a day', async () => {
    config.flows.R = { enabled: false, startAt: '' };
    const out = await reconcile({ mode: 'carts' });
    expect(out).toMatchObject({ ok: true, mode: 'carts' });
    // The nightly pass's own work is ABSENT, not merely falsy: sweepUnreviewed
    // sends review asks to real customers and sweepUnconfirmed re-arms Flow A.
    for (const k of ['orders', 'reviews', 'shipments', 'webhooks']) expect(out[k]).toBeUndefined();
  });
});
