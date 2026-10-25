/*
 * Flow W end to end: whole journeys, not single guards.
 *
 * The other suites each test one decision in isolation. What nothing tests is
 * whether the pieces COMPOSE: the 11:00 sweep handing a customer to the worker
 * over SQS, the worker's message leading to a /w/{token} tap, the tap leading
 * to an order, and the order closing the offer. A guard that is right on its
 * own and wrong in sequence is exactly the failure a customer would see, so
 * every test here walks the real chain:
 *
 *   sweepNewSubscribers -> the queued message -> onFirst -> GET /w/{token}
 *     -> onOrderCreated / onSubStatus / onWindowOpen
 *
 * Real modules throughout. Only Shopify, WhatsApp and SES are faked, and the
 * table is the memory backend.
 *
 * ONE thing reads the wall clock: the redirect handler compares codeEndsAt to
 * Date.now(), because a customer's tap has no injected clock. Journeys that
 * reach the redirect re-anchor codeEndsAt to the real now first, and say so.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { config } from './config.mjs';
import { RULES } from '../messages/rules.mjs';
import { table, _resetMemory } from './store/table.mjs';
import { _drainQueue } from './queue.mjs';
import { _resetTimers, _peekTimers } from './timers/schedule.mjs';
import { _resetSecrets } from './secrets.mjs';
import { makeFakeClients } from './clients/fakes/index.mjs';
import { makeFakeSes } from './clients/fakes/ses.mjs';
import { fromISTWall } from './lib/time.mjs';
import { setOptOut, touchInbound, markMarketing } from './store/phoneProfile.mjs';
import { emailKey } from './domain/subscriberOffer.mjs';
import {
  getSubRec, getPhoneOfferLock, getEmailOfferLock, getSubParked, getSweepDay,
} from './store/subscriberOffer.mjs';
import { sweepNewSubscribers } from './timers/subscriber-sweep.mjs';
import { handler as reconcile } from './timers/reconcile.mjs';
import { handler as wRedirect } from './ingest/w-redirect.mjs';
import * as W from './worker/subscriberOffer.run.mjs';

const NOW = fromISTWall(2026, 9, 24, 11, 0); // 11:00 IST, the cron slot
const ID = '25164544835956';
const GID = `gid://shopify/Customer/${ID}`;
const PHONE = '+919637361371';
const OTHER = '+918888888888';
const EMAIL = 'priya.test@example.com';
const UNSUB = 'https://www.morpaankh.in/unsubscribe?id=abc';

const BEST_SELLERS = [
  { title: 'Khili Dhoop', handle: 'khili-dhoop', status: 'ACTIVE', availableForSale: true, imageUrl: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1' },
  { title: 'Bandhan', handle: 'bandhan', status: 'ACTIVE', availableForSale: true, imageUrl: 'https://cdn.shopify.com/s/files/1/x/b.jpg?v=1' },
  { title: 'Morani', handle: 'morani', status: 'ACTIVE', availableForSale: true, imageUrl: 'https://cdn.shopify.com/s/files/1/x/c.jpg?v=1' },
];
const APPROVED = { subscriber_offer_v1: 'APPROVED', subscriber_offer_plain_v1: 'APPROVED' };

/** A real-shaped Customer node, created yesterday at 10:30 IST, never ordered. */
function customer(id = ID, over = {}) {
  const { phone = PHONE, email = EMAIL, ...rest } = over;
  return {
    id: `gid://shopify/Customer/${id}`,
    createdAt: '2026-10-23T05:00:00Z',
    firstName: 'Priya',
    lastName: 'Sharma',
    numberOfOrders: '0',
    tags: ['popup-subscriber'],
    defaultEmailAddress: email ? { emailAddress: email, marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: UNSUB } : null,
    defaultPhoneNumber: phone ? { phoneNumber: phone } : null,
    ...rest,
  };
}

const order = (over = {}) => ({
  id: 5551212,
  admin_graphql_api_id: 'gid://shopify/Order/5551212',
  name: '#1201',
  created_at: '2026-10-24T09:00:00Z', // 14:30 IST, three hours after the send
  note_attributes: [{ name: '_otpVerifiedPhoneNumber', value: '919637361371' }],
  discount_codes: [],
  ...over,
});

/*
 * The Flow W half of the Shopify client. fakes/shopify.mjs is a source file
 * this suite may not edit, so these are attached here; every name is one the
 * real client has to grow.
 */
function world(customers = [customer()], opts = {}) {
  const base = makeFakeClients({
    whatsapp: { templates: APPROVED, ...(opts.whatsapp || {}) },
    shopify: opts.shopify,
  });
  const sh = base.shopify;
  const byGid = new Map(customers.filter(Boolean).map((c) => [String(c.id), c]));
  sh.seedCustomer = (c) => byGid.set(String(c.id), c);
  sh.getCustomer = async (idOrGid) => {
    sh.calls.push({ op: 'getCustomer', idOrGid });
    const gid = String(idOrGid).startsWith('gid://') ? String(idOrGid) : `gid://shopify/Customer/${idOrGid}`;
    return byGid.get(gid) || null;
  };
  sh.listNewCustomers = async (args) => {
    sh.calls.push({ op: 'listNewCustomers', args });
    if (opts.failSearch) throw new Error(String(opts.failSearch));
    return { nodes: [...byGid.values()], cursor: null };
  };
  sh.ordersByEmail = async (address) => {
    sh.calls.push({ op: 'ordersByEmail', address });
    return (opts.ordersByEmail || {})[String(address).toLowerCase()] || [];
  };
  sh.collectionBestSellers = async (handle, limit) => {
    sh.calls.push({ op: 'collectionBestSellers', handle, limit });
    if (opts.failBestSellers) throw new Error(String(opts.failBestSellers));
    return opts.bestSellers || BEST_SELLERS;
  };
  const clients = { ...base, email: makeFakeSes(opts.email || {}) };
  return { clients, deps: { clients, now: opts.now || NOW } };
}

/** The sweep, then the messages it actually queued, in order. */
async function sweepAndDrain(clients, now = NOW) {
  const out = await sweepNewSubscribers(clients, now);
  return { out, queued: _drainQueue() };
}

/** Deliver the queued Flow W messages to the worker exactly as the worker would. */
async function runQueue(queued, deps) {
  const results = [];
  for (const q of queued) {
    if (q.message.kind !== 'suboffer') continue;
    results.push(await W.onFirst(q.message.customerId, deps));
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
 * injected clock, so a journey anchored to 24 Oct would otherwise be served
 * the closed branch for a code the worker had just created.
 */
async function liveifyCode(id) {
  const rec = await getSubRec(id);
  await table.put({ ...rec, codeEndsAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString() });
  return getSubRec(id);
}

const templates = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const customerTemplates = (wa) => templates(wa).filter((n) => n.startsWith('subscriber_'));
const sessions = (wa) => wa.sent.filter((s) => s.type !== 'template');
const discounts = (sh) => sh.calls.filter((c) => c.op === 'createDiscountCode').map((c) => c.args);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);
const alerts = (wa) => wa.sent.filter((s) => s.type === 'template' && s.name.startsWith('ops_alert'));
const timerNames = () => _peekTimers().map((t) => t.name);

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  _drainQueue();
  config.ownerAlertPhones = ['+919999999999'];
  config.flows.W = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
  config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
  config.subscriberOfferAllowlist = [];
  config.cartRecoveryAllowlist = [];
  config.emailFrom = 'care@morpaankh.in';
});

// ---------------------------------------------------------------------------
// The journeys that are supposed to work
// ---------------------------------------------------------------------------
describe('POSITIVE: the whole way through', () => {
  it('signs up, is swept, is messaged, taps the link, and orders with the code', async () => {
    const { clients, deps } = world();

    // 1. the 11:00 sweep finds yesterday's signup and queues it on its phone group
    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued).toEqual([ID]);
    expect(queued[0].message).toEqual({ kind: 'suboffer', step: 'first', customerId: ID });
    expect(queued[0].groupId).toBe(`phone:${PHONE}`);
    expect(queued[0].dedupId).toBe(`w-first-${ID}`);
    expect(await getSweepDay('2026-10-23')).toBeTruthy();

    // 2. the worker sends ONE message and creates ONE code
    await runQueue(queued, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    const made = discounts(clients.shopify);
    expect(made).toHaveLength(1);
    expect(made[0].amountInr).toBe(RULES.subscriberOffer.amountInr);
    expect(made[0].minSubtotalInr).toBe(1500.01);
    expect(made[0].title).toBe(`Subscriber offer #${ID}`);

    const rec = await getSubRec(ID);
    expect(rec.code).toMatch(/^MORPAANKHPRIYA[2-9]{4}$/);
    expect(rec.firstSentAt).toBeTruthy();
    expect(rec.channel).toBe('whatsapp');
    expect(await getPhoneOfferLock(PHONE)).toMatchObject({ customerId: ID });
    expect(await getEmailOfferLock(emailKey(EMAIL))).toMatchObject({ customerId: ID });

    // the message carries the code, the saving, the minimum and the best sellers
    const msg = clients.whatsapp.sent.find((s) => s.name === 'subscriber_offer_v1');
    const text = JSON.stringify(msg.components);
    expect(text).toContain(rec.code);
    expect(text).toContain('Priya');
    expect(text).toContain('₹200');
    expect(text).toContain('₹1,500');
    expect(text).toContain('Khili Dhoop, Bandhan and Morani');

    // 3. they tap Shop best sellers
    const live = await liveifyCode(ID);
    const res = await wRedirect(tapEvent(live.token));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toContain(`/discount/${live.code}?redirect=`);
    expect(decodeURIComponent(new URL(res.headers.Location).searchParams.get('redirect')))
      .toBe('/collections/best-sellers?utm_source=whatsapp&utm_medium=automation&utm_campaign=welcome_24h');
    expect((await getSubRec(ID)).clicks).toBe(1);

    // 4. they order, with the code on it
    await W.onOrderCreated(order({ discount_codes: [{ code: live.code }] }), deps);
    const done = await getSubRec(ID);
    expect(done).toMatchObject({ outcome: 'converted', orderId: '5551212', codeUsed: true });
    expect(tagsAdded(clients.shopify)).toEqual(
      expect.arrayContaining(['wa-subscriber-converted', RULES.cartRecovery.giftTag]),
    );

    // 5. and nothing else is ever sent to them
    await W.onFirst(ID, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect(discounts(clients.shopify)).toHaveLength(1);
  });

  it('an email-only signup gets the same offer by email, and converts the same way', async () => {
    const { clients, deps } = world([customer(ID, { phone: null })]);

    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued).toEqual([ID]);
    expect(queued[0].groupId).toBe(`email:${emailKey(EMAIL)}`);
    await runQueue(queued, deps);

    expect(clients.whatsapp.sent.filter((s) => s.name === 'subscriber_offer_v1')).toHaveLength(0);
    expect(clients.email.sent).toHaveLength(1);
    const rec = await getSubRec(ID);
    expect(rec.channel).toBe('email');
    expect(clients.email.sent[0].html).toContain(rec.code);
    expect(clients.email.sent[0].html).toContain('utm_source=email');

    // the email's own link works, and is tagged as an email tap
    const live = await liveifyCode(ID);
    const res = await wRedirect(tapEvent(live.token));
    expect(decodeURIComponent(new URL(res.headers.Location).searchParams.get('redirect'))).toContain('utm_source=email');

    await W.onOrderCreated(order({ note_attributes: [], discount_codes: [{ code: live.code }] }), deps);
    expect((await getSubRec(ID)).outcome).toBe('converted');
    expect(tagsAdded(clients.shopify)).toContain('wa-subscriber-converted');
  });

  it('a WhatsApp cap refusal reaches them by email, then by WhatsApp when they write in', async () => {
    const { clients, deps } = world([customer()], { whatsapp: { failTemplateWith: 131049 } });
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);

    const rec = await getSubRec(ID);
    expect(rec.outcome).toBe('waiting-window');
    expect((await getSubParked(PHONE)).customerId).toBe(ID);
    expect(clients.email.sent).toHaveLength(1);
    /*
     * The fallback DELIVERED the code, so the once-per-person-ever lock is
     * held even though WhatsApp refused the template. A park is still armed:
     * the lock stops a SECOND offer, it does not stop this one being finished
     * on the channel it was meant for, which is the next half of this test.
     */
    expect(await getPhoneOfferLock(PHONE)).toMatchObject({ customerId: ID });

    const later = new Date(NOW.getTime() + 2 * 3600 * 1000);
    await touchInbound(PHONE, later);
    await W.onWindowOpen(PHONE, { clients, now: later });

    const after = await getSubRec(ID);
    expect(sessions(clients.whatsapp).filter((m) => m.type === 'cta_url')).toHaveLength(1);
    expect(after.code).toBe(rec.code);
    expect(after.firstSentAt).toBeTruthy();
    expect(await getSubParked(PHONE)).toBe(null);
    // Still ONE code, through two channels.
    expect(discounts(clients.shopify)).toHaveLength(1);
  });

  it('two signups, one allowlisted: one is messaged and one is only watched', async () => {
    config.subscriberOfferAllowlist = [PHONE];
    const mine = customer();
    const theirs = customer('77700000000001', { phone: OTHER, email: 'other@example.com' });
    const { clients, deps } = world([mine, theirs]);

    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued.sort()).toEqual([ID, '77700000000001'].sort());
    await runQueue(queued, deps);

    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect((await getSubRec('77700000000001')).outcome).toBe('shadow');
    expect(await getPhoneOfferLock(OTHER)).toBe(null);
    expect(discounts(clients.shopify)).toHaveLength(1);
    expect(clients.email.sent).toHaveLength(0);
  });

  it('runs once a day: the second run of the same day is a complete no-op', async () => {
    const { clients, deps } = world();
    const first = await sweepAndDrain(clients);
    await runQueue(first.queued, deps);

    const second = await sweepAndDrain(clients, new Date(NOW.getTime() + 60 * 60 * 1000));
    expect(second.out).toMatchObject({ skipped: 'already-swept' });
    expect(second.queued).toHaveLength(0);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
  });

  it('once ever: a person who signs up again a year later gets nothing', async () => {
    const { clients, deps } = world();
    await runQueue((await sweepAndDrain(clients)).queued, deps);

    // A fresh customer record, same number, a year on.
    const nextYear = fromISTWall(2027, 9, 24, 11, 0);
    const again = customer('99900000000002', { createdAt: '2027-10-23T05:00:00Z' });
    clients.shopify.seedCustomer(again);
    await W.onFirst('99900000000002', { ...deps, now: nextYear });

    expect((await getSubRec('99900000000002')).outcome).toBe('already-offered');
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect(discounts(clients.shopify)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The journeys that must stop, and where
// ---------------------------------------------------------------------------
describe('NEGATIVE: nothing gets through the sweep that should not', () => {
  const dropped = [
    ['created today rather than yesterday', { createdAt: '2026-10-24T04:00:00Z' }, 'outside-window'],
    ['already ordered', { numberOfOrders: '1' }, 'already-ordered'],
    ['tagged no-marketing', { tags: ['no-marketing'] }, 'excluded-tag'],
    ['unreachable', { phone: null, email: null }, 'no-channel'],
  ];

  it.each(dropped)('never enqueues one that is %s', async (_n, over, reason) => {
    const { clients } = world([customer(ID, over)]);
    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued).toEqual([]);
    expect(Object.keys(out.skipped)).toContain(reason);
    expect(queued).toHaveLength(0);
    // Nothing written, so a later run is free to reconsider.
    expect(await getSubRec(ID)).toBe(null);
  });

  /*
   * OWNER'S CORRECTION, 2026-10-24. This case was a `no-phone` drop. A number
   * we hold and cannot use is WhatsApp being impossible, not the person being
   * ineligible, so the whole journey still runs: swept, enqueued on the email
   * group, emailed, and the code still works through /w/{token}.
   */
  it('still carries one holding an unusable number all the way, by email', async () => {
    const { clients, deps } = world([customer(ID, { phone: '+14155550123' })]);
    const { out, queued } = await sweepAndDrain(clients);
    expect(out.enqueued).toEqual([ID]);
    expect(queued[0].groupId).toBe(`email:${emailKey(EMAIL)}`);

    await runQueue(queued, deps);
    const rec = await getSubRec(ID);
    expect(rec.outcome).toBeUndefined();
    expect(rec.channel).toBe('email');
    expect(rec.phoneSkipReason).toBe('non-india');
    expect(clients.email.sent).toHaveLength(1);
    expect(clients.email.sent[0].html).toContain(rec.code);

    const live = await liveifyCode(ID);
    const res = await wRedirect(tapEvent(live.token));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toContain(`/discount/${live.code}?redirect=`);
  });

  it('writes nothing at all when the flow is off', async () => {
    config.flows.W = { enabled: false, startAt: '2026-10-01T00:00:00Z' };
    const { clients } = world();
    const { out, queued } = await sweepAndDrain(clients);
    expect(out).toEqual({ skipped: 'flow-w-off' });
    expect(queued).toHaveLength(0);
    expect(await getSubRec(ID)).toBe(null);
    expect(await getSweepDay('2026-10-23')).toBe(null);
  });

  it('a failed customer search loses nobody, because the day stays unswept', async () => {
    const broken = world([customer()], { failSearch: 'Access denied for customers field' });
    const first = await sweepAndDrain(broken.clients);
    expect(first.out).toMatchObject({ skipped: 'search-failed' });
    expect(first.queued).toHaveLength(0);
    expect(await getSweepDay('2026-10-23')).toBe(null);
    expect(alerts(broken.clients.whatsapp)).toHaveLength(1);

    // A healthy re-run the same day reaches them after all, which is the whole
    // point of refusing to write the marker.
    const ok = world();
    const second = await sweepAndDrain(ok.clients);
    expect(second.out.enqueued).toEqual([ID]);
    await runQueue(second.queued, ok.deps);
    expect(customerTemplates(ok.clients.whatsapp)).toEqual(['subscriber_offer_v1']);
  });

  it('refuses the whole run rather than message a backlog of signups', async () => {
    const many = Array.from({ length: RULES.subscriberOffer.maxPerRun + 5 }, (_, i) =>
      customer(`B${i}`, { phone: `+9196100000${String(i).padStart(2, '0')}`, email: `b${i}@example.com` }));
    const { clients } = world(many);
    const { out, queued } = await sweepAndDrain(clients);
    expect(out).toMatchObject({ skipped: 'too-many-candidates' });
    expect(queued).toHaveLength(0);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });
});

describe('NEGATIVE: the worker refuses, and records why', () => {
  const refusals = [
    ['they have sent STOP', async () => setOptOut(PHONE, true), 'opted-out'],
    ['they had another marketing message this week', async () => markMarketing(PHONE, new Date(NOW.getTime() - 86400000)), 'marketing-cap'],
    ['they already have a private cart code', async () => {
      const { lockPhone } = await import('./store/cartRecovery.mjs');
      await lockPhone(PHONE, { checkoutId: 'OTHER', until: new Date(NOW.getTime() + 20 * 86400000), now: NOW });
    }, 'has-cart'],
  ];

  it.each(refusals)('refuses because %s, creating nothing and locking nothing', async (_n, arrange, outcome) => {
    const { clients, deps } = world();
    await arrange();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);

    expect((await getSubRec(ID)).outcome).toBe(outcome);
    expect(customerTemplates(clients.whatsapp)).toHaveLength(0);
    expect(clients.email.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
  });

  it('refuses when a public code already gives as much, and tells the owner once', async () => {
    const { clients, deps } = world([customer()], {
      shopify: { publicCodes: [{ code: 'WELCOME200', title: 'WELCOME200', type: 'amount', amountPaise: 20000, minSubtotalPaise: 119900 }] },
    });
    await runQueue((await sweepAndDrain(clients)).queued, deps);
    expect((await getSubRec(ID)).outcome).toBe('public-offer-better');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  it('refuses to offer blind when the live codes cannot be read', async () => {
    const { clients, deps } = world([customer()], { shopify: { failPublicCodes: 'Access denied for discountNodes field' } });
    await runQueue((await sweepAndDrain(clients)).queued, deps);
    expect((await getSubRec(ID)).outcome).toBe('no-public-codes');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(JSON.stringify(alerts(clients.whatsapp))).toMatch(/read_discounts/);
  });

  it('a gated send creates nothing at all', async () => {
    const { clients, deps } = world([customer()], { whatsapp: { skipWith: 'dry_run' } });
    await runQueue((await sweepAndDrain(clients)).queued, deps);
    expect((await getSubRec(ID)).outcome).toBe('send-dry_run');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
  });

  it('an order placed between the sweep and the worker stops the offer', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    // They ordered in the ninety seconds the message spent on the queue.
    clients.shopify.seed({
      id: 'gid://shopify/Order/559', name: '#559', createdAt: '2026-10-24T05:25:00Z', customer: { id: GID },
    });
    await runQueue(queued, deps);

    expect((await getSubRec(ID)).outcome).toBe('already-ordered');
    expect(customerTemplates(clients.whatsapp)).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('a cart abandoned between the sweep and the worker hands them to Flow R', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    clients.shopify.seedCheckout({
      id: 'gid://shopify/AbandonedCheckout/66743166239092',
      name: '#66743166239092',
      createdAt: '2026-10-24T05:20:00Z',
      completedAt: null,
      customer: { id: GID },
      customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919637361371' }],
      lineItems: { nodes: [] },
    });
    await runQueue(queued, deps);

    expect((await getSubRec(ID)).outcome).toBe('has-cart');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('an SQS redelivery of the whole run changes nothing', async () => {
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients);
    await runQueue(queued, deps);
    await runQueue(queued, deps);
    await runQueue(queued, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect(discounts(clients.shopify)).toHaveLength(1);
    expect(clients.email.sent).toHaveLength(0);
  });

  it('a status webhook saying it never arrived hands the person back', async () => {
    const { clients, deps } = world();
    await runQueue((await sweepAndDrain(clients)).queued, deps);
    expect(await getPhoneOfferLock(PHONE)).toBeTruthy();
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBeTruthy();

    await W.onSubStatus(ID, { status: 'failed', errors: [{ code: 131049 }] }, NOW);
    /*
     * R9. Meta accepted the send with a 200 and reported the per-user cap
     * seconds later, so both lifetime locks were already written. "Once per
     * person, ever" means leaving them would burn this customer permanently
     * over a message they never saw.
     */
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
    expect((await getSubParked(PHONE)).customerId).toBe(ID);

    // And the window opening delivers the offer they never saw.
    const later = new Date(NOW.getTime() + 3600 * 1000);
    await touchInbound(PHONE, later);
    await W.onWindowOpen(PHONE, { clients, now: later });
    expect(sessions(clients.whatsapp).filter((m) => m.type === 'cta_url')).toHaveLength(1);
    expect(discounts(clients.shopify)).toHaveLength(1);
  });
});

describe('NEGATIVE: the link itself', () => {
  async function live() {
    const { clients, deps } = world();
    await runQueue((await sweepAndDrain(clients)).queued, deps);
    return { clients, deps, rec: await liveifyCode(ID) };
  }

  it('an unknown, guessed or truncated token goes to the collection, never an error', async () => {
    await live();
    for (const token of ['nope', '', 'MORPAANKHPRIYA4729', 'a'.repeat(64)]) {
      const res = await wRedirect(tapEvent(token));
      expect(res.statusCode, token).toBe(302);
      expect(res.headers.Location, token).toBe('https://www.morpaankh.in/collections/best-sellers');
    }
  });

  it('nothing in the request can move the Location, over a whole journey', async () => {
    const { rec } = await live();
    const clean = (await wRedirect(tapEvent(rec.token))).headers.Location;
    const tampered = await wRedirect(tapEvent(rec.token, {
      queryStringParameters: { redirect: 'https://evil.example', code: 'BUY3' },
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'user-agent': 'Mozilla/5.0' },
      rawPath: `/w/${rec.token}/../../evil`,
    }));
    expect(tampered.headers.Location).toBe(clean);
    expect(tampered.headers.Location).not.toContain('evil.example');
  });

  it('serves the plain collection once the code has closed', async () => {
    const { rec } = await live();
    await table.put({ ...(await getSubRec(ID)), codeEndsAt: new Date(Date.now() - 1000).toISOString() });
    const res = await wRedirect(tapEvent(rec.token));
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('https://www.morpaankh.in/collections/best-sellers');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('never lets the code, the token or the number reach a log line', async () => {
    const seen = [];
    const spy = (...a) => seen.push(JSON.stringify(a));
    const spies = ['log', 'warn', 'error'].map((m) => vi.spyOn(console, m).mockImplementation(spy));
    try {
      const { clients, deps } = world();
      const { queued } = await sweepAndDrain(clients);
      await runQueue(queued, deps);
      const rec = await liveifyCode(ID);
      await wRedirect(tapEvent(rec.token));
      await wRedirect(tapEvent('nope'));
      await W.onTap(ID, 'help', PHONE, deps);
      await W.onOrderCreated(order({ discount_codes: [{ code: rec.code }] }), deps);
      expect(seen.length).toBeGreaterThan(0);
      const all = seen.join('\n');
      expect(all).not.toContain(rec.code);
      expect(all).not.toContain(rec.token);
      expect(all).not.toContain('919637361371');
      expect(all).not.toContain(EMAIL);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe('NEGATIVE: the daily rule cannot run the nightly pass', () => {
  it('{mode:subscribers} does subscribers and nothing else', async () => {
    config.flows.W = { enabled: false, startAt: '' };
    const out = await reconcile({ mode: 'subscribers' });
    expect(out).toMatchObject({ ok: true, mode: 'subscribers' });
    /*
     * ABSENT, not falsy. sweepUnreviewed sends review asks to real customers,
     * sweepUnconfirmed re-arms Flow A, and reconcile collapses every
     * unrecognised mode to 'full'.
     */
    for (const k of ['orders', 'reviews', 'shipments', 'webhooks', 'carts']) expect(out[k]).toBeUndefined();
  });

  it('and the Flow W timer it arms is its own, never one of Flow R`s', async () => {
    const early = fromISTWall(2026, 9, 24, 9, 0);
    const { clients, deps } = world();
    const { queued } = await sweepAndDrain(clients, NOW);
    await runQueue(queued, { ...deps, now: early });
    expect(timerNames()).toEqual([`W-${ID}-first`]);
  });
});
