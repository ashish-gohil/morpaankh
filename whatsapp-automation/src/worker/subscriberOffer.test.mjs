/*
 * Flow W behaviour, gate by gate. A sibling of cartRecovery.test.mjs, and like
 * that suite most of these tests are about the flow NOT sending something.
 *
 * Every gate has ONE recorded outcome string, and that string is the contract:
 * it is the only answer the owner will ever get to "why did this person not
 * get their welcome code". They are asserted literally, never by shape.
 *
 * The private code is worth Rs 200 to a stranger, so the tests that matter
 * most are the ones proving nothing is CREATED before the send is known to
 * have been accepted: no discount, no lock, no token.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { table, _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { _resetSecrets } from '../secrets.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { makeFakeSes } from '../clients/fakes/ses.mjs';
import { fromISTWall, nextWindowTime } from '../lib/time.mjs';
import {
  setOptOut, setUndeliverable, touchInbound, markMarketing, canSendMarketing,
} from '../store/phoneProfile.mjs';
import { emailKey } from '../domain/subscriberOffer.mjs';
import {
  getSubRec, getPhoneOfferLock, getEmailOfferLock, getSubLinkMap, getSubCodeMap,
  getSubParked, lockPhoneOffer,
} from '../store/subscriberOffer.mjs';
import { lockPhone as lockCartPhone, parkForWindow as parkCart, getRec as getCartRec } from '../store/cartRecovery.mjs';
import { putCapture } from '../store/cartCapture.mjs';
import * as W from './subscriberOffer.run.mjs';
import * as R from './cartRecovery.run.mjs';

const NOW = fromISTWall(2026, 9, 24, 11, 0); // 11:00 IST, inside 10:00-21:00
const CUSTOMER_ID = '25164544835956';
const GID = `gid://shopify/Customer/${CUSTOMER_ID}`;
const PHONE = '+919637361371';
const EMAIL = 'priya.test@example.com';
const UNSUB = 'https://www.morpaankh.in/unsubscribe?id=abc';

const BEST_SELLERS = [
  { title: 'Khili Dhoop', handle: 'khili-dhoop', status: 'ACTIVE', availableForSale: true, imageUrl: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1' },
  { title: 'Bandhan', handle: 'bandhan', status: 'ACTIVE', availableForSale: true, imageUrl: 'https://cdn.shopify.com/s/files/1/x/b.jpg?v=1' },
  { title: 'Morani', handle: 'morani', status: 'ACTIVE', availableForSale: true, imageUrl: 'https://cdn.shopify.com/s/files/1/x/c.jpg?v=1' },
];

function customer(over = {}) {
  return {
    id: GID,
    createdAt: '2026-10-23T05:00:00Z', // 10:30 IST yesterday
    firstName: 'Priya',
    lastName: 'Sharma',
    numberOfOrders: '0',
    tags: [],
    defaultEmailAddress: { emailAddress: EMAIL, marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: UNSUB },
    defaultPhoneNumber: { phoneNumber: PHONE },
    ...over,
  };
}

/*
 * The Flow W half of the Shopify client, bolted onto the existing fake.
 *
 * fakes/shopify.mjs is a source file this suite must not edit, so the methods
 * Flow W needs are attached here instead. Every name below is part of the
 * contract: the real client in src/clients/shopify.mjs has to grow the same
 * five, with the same arguments and the same return shapes.
 */
function flowWShopify(sh, {
  customers = [customer()],
  ordersByEmail = {},
  draftOrders = [],
  bestSellers = BEST_SELLERS,
  failBestSellers = null,
  failDraftOrders = null,
} = {}) {
  const byGid = new Map(customers.map((c) => [String(c.id), c]));
  sh.seedCustomer = (c) => byGid.set(String(c.id), c);
  sh.getCustomer = async (idOrGid) => {
    sh.calls.push({ op: 'getCustomer', idOrGid });
    const gid = String(idOrGid).startsWith('gid://') ? String(idOrGid) : `gid://shopify/Customer/${idOrGid}`;
    return byGid.get(gid) || null;
  };
  sh.listNewCustomers = async (args) => {
    sh.calls.push({ op: 'listNewCustomers', args });
    return { nodes: [...byGid.values()], cursor: null };
  };
  sh.ordersByEmail = async (address) => {
    sh.calls.push({ op: 'ordersByEmail', address });
    return ordersByEmail[String(address).toLowerCase()] || [];
  };
  sh.listOpenDraftOrders = async (sinceISO) => {
    sh.calls.push({ op: 'listOpenDraftOrders', sinceISO });
    // read_draft_orders is NOT a granted scope today, so a 403 here is the
    // expected case until the owner adds it by hand.
    if (failDraftOrders) throw new Error(String(failDraftOrders));
    return draftOrders;
  };
  sh.collectionBestSellers = async (handle, limit) => {
    sh.calls.push({ op: 'collectionBestSellers', handle, limit });
    if (failBestSellers) throw new Error(String(failBestSellers));
    return bestSellers;
  };
  return sh;
}

function setup({ whatsapp, shopify, email, flowW, customers } = {}) {
  const base = makeFakeClients({ whatsapp, shopify });
  flowWShopify(base.shopify, { ...(flowW || {}), ...(customers ? { customers } : {}) });
  const clients = { ...base, email: makeFakeSes(email || {}) };
  return { clients, deps: { clients, now: NOW } };
}

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  config.ownerAlertPhones = ['+919999999999'];
  config.flows.W = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
  config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
  config.subscriberOfferAllowlist = [];
  config.cartRecoveryAllowlist = [];
  config.emailFrom = 'care@morpaankh.in';
});

const templates = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const customerTemplates = (wa) => templates(wa).filter((n) => n.startsWith('subscriber_'));
const ctaSends = (wa) => wa.sent.filter((m) => m.type === 'cta_url');
const discounts = (sh) => sh.calls.filter((c) => c.op === 'createDiscountCode').map((c) => c.args);
const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);
const alerts = (wa) => wa.sent.filter((s) => s.type === 'template' && s.name.startsWith('ops_alert'));
const timerNames = () => _peekTimers().map((t) => t.name);
/** The MORPAANKH code inside any payload, however it was rendered. */
const codeIn = (payload) => (JSON.stringify(payload).match(/MORPAANKH[A-Z]*\d+/) || [null])[0];

// ---------------------------------------------------------------------------
describe('the offer going out', () => {
  it('sends, creates one code, maps the link and the code, and takes both locks', async () => {
    const { clients, deps } = setup();
    const out = await W.onFirst(CUSTOMER_ID, deps);
    expect(out.sent).toBe(true);

    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    const made = discounts(clients.shopify);
    expect(made).toHaveLength(1);
    expect(made[0].amountInr).toBe(RULES.subscriberOffer.amountInr);
    // The SHOPIFY minimum, a paisa above the figure in the copy, so that
    // "above Rs 1,500" is literally true of every order the code works on.
    expect(made[0].minSubtotalInr).toBe(1500.01);
    expect(made[0].title).toBe(`Subscriber offer #${CUSTOMER_ID}`);
    // Never PII in a Shopify title: it shows in the admin discount list.
    expect(made[0].title).not.toContain('9637');
    expect(made[0].title).not.toContain('Priya');
    expect(made[0].title).not.toContain('priya');

    const rec = await getSubRec(CUSTOMER_ID);
    expect(rec.firstSentAt).toBeTruthy();
    expect(rec.channel).toBe('whatsapp');
    expect(rec.code).toMatch(/^MORPAANKHPRIYA[2-9]{4}$/);
    /*
     * A successful send is NOT an outcome, exactly as in Flow R: `outcome` is
     * reserved for the reasons we STOPPED, and `converted` has to be able to
     * land on this record later without losing to a first-writer-wins guard.
     * What stops a second offer is firstSentAt plus the two lifetime locks.
     */
    expect(rec.outcome).toBeUndefined();

    // 24 hours, from the code itself and not from the TTL attribute.
    expect(Date.parse(rec.codeEndsAt) - NOW.getTime()).toBe(RULES.subscriberOffer.codeValidHours * 3600 * 1000);
    expect(made[0].endsAt).toBe(rec.codeEndsAt);
    expect(made[0].code).toBe(rec.code);

    expect(await getSubLinkMap(rec.token)).toMatchObject({ customerId: CUSTOMER_ID, channel: 'whatsapp' });
    expect(await getSubCodeMap(rec.code)).toMatchObject({ customerId: CUSTOMER_ID });
    expect(await getPhoneOfferLock(PHONE)).toMatchObject({ customerId: CUSTOMER_ID });
    expect(await getEmailOfferLock(emailKey(EMAIL))).toMatchObject({ customerId: CUSTOMER_ID });
  });

  it('passes nothing to createDiscountCode that could loosen it', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    // usageLimit 1, appliesOncePerCustomer and combinesWith are fixed inside
    // the existing createDiscountCode, which is why Flow W reuses it.
    expect(Object.keys(discounts(clients.shopify)[0]).sort())
      .toEqual(['amountInr', 'code', 'endsAt', 'minSubtotalInr', 'startsAt', 'title'].sort());
  });

  it('carries the code, the saving, the closing time and the best sellers', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);
    const msg = clients.whatsapp.sent.find((s) => s.name === 'subscriber_offer_v1');
    const text = JSON.stringify(msg.components);
    expect(text).toContain(rec.code);
    expect(text).toContain('Priya');
    expect(text).toContain('Khili Dhoop, Bandhan and Morani');
    // The header image is the collection's own top seller.
    expect(text).toContain('https://cdn.shopify.com/s/files/1/x/a.jpg');
  });

  it('names only the pieces somebody can actually buy', async () => {
    const { clients, deps } = setup({
      flowW: {
        bestSellers: [
          { title: 'Gone', status: 'ACTIVE', availableForSale: false, imageUrl: 'https://cdn.shopify.com/x/gone.jpg' },
          { title: 'Hidden', status: 'DRAFT', availableForSale: true, imageUrl: 'https://cdn.shopify.com/x/hidden.jpg' },
          ...BEST_SELLERS,
        ],
      },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    const text = JSON.stringify(clients.whatsapp.sent.find((s) => s.name === 'subscriber_offer_v1').components);
    expect(text).toContain('Khili Dhoop, Bandhan and Morani');
    expect(text).not.toContain('Gone');
    expect(text).not.toContain('Hidden');
  });

  it('still sends when the best sellers cannot be read, naming none of them', async () => {
    // The collection is decoration, not the offer. Losing it must not cost
    // somebody their code.
    const { clients, deps } = setup({ flowW: { failBestSellers: 'Access denied for collection field' } });
    await W.onFirst(CUSTOMER_ID, deps);
    const text = JSON.stringify(clients.whatsapp.sent).toLowerCase();
    expect(text).toContain('our best sellers');
    expect((await getSubRec(CUSTOMER_ID)).firstSentAt).toBeTruthy();
  });

  it('uses the image-free twin when the collection has no photo', async () => {
    const { clients, deps } = setup({
      flowW: { bestSellers: BEST_SELLERS.map((b) => ({ ...b, imageUrl: null })) },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_plain_v1']);
  });

  it('an SQS redelivery sends once, creates one code and takes one lock', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onFirst(CUSTOMER_ID, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect(discounts(clients.shopify)).toHaveLength(1);
    expect(clients.email.sent).toHaveLength(0);
  });

  it('never writes an SK of STATE or REC, which other sweeps read as their own', async () => {
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    /*
     * reconcile's scanStates() hands every SK=STATE row to flowB.onDelivered
     * as an order, and cartRecovery's allRecs() is a scanBySk('REC') that
     * feeds the daily "carts messaged" count. A Flow W row under either sort
     * key would be messaged or counted as something it is not.
     */
    expect(await table.scanStates()).toHaveLength(0);
    expect((await table.scanBySk('REC')).filter((x) => String(x.PK).startsWith('SUBOFFER'))).toHaveLength(0);
    const subs = await table.scanBySk('SUB');
    expect(subs).toHaveLength(1);
    expect(subs[0].PK).toBe(`SUBOFFER#${CUSTOMER_ID}`);
  });

  it('never puts the code end in the TTL attribute', async () => {
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);
    const codeEndEpoch = Math.floor(Date.parse(rec.codeEndsAt) / 1000);
    expect(rec.expiresAt).not.toBe(codeEndEpoch);
    // stateRetentionDays out, not 24 hours: otherwise Dynamo deletes the record
    // the moment the code closes and takes the attribution window with it.
    expect(rec.expiresAt).toBeGreaterThan(codeEndEpoch + (RULES.stateRetentionDays - 10) * 86400);
  });

  it('the lifetime locks have no TTL, because "once ever" outlives the record', async () => {
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getPhoneOfferLock(PHONE)).expiresAt).toBeUndefined();
    expect((await getEmailOfferLock(emailKey(EMAIL))).expiresAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('every gate, and the outcome it records', () => {
  it('flow off: writes NOTHING, so the next run can retry', async () => {
    config.flows.W = { enabled: false, startAt: '2026-10-01T00:00:00Z' };
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    expect(await getSubRec(CUSTOMER_ID)).toBe(null);
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(clients.email.sent).toHaveLength(0);
    expect(timerNames()).toHaveLength(0);
  });

  /*
   * Flow R DROPS a cart outside its window, on purpose: a cold bag is not worth
   * waking someone at 09:30 for. Flow W is the opposite. The offer is a whole
   * day long and there is exactly one of them per person ever, so an 09:00 run
   * must WAIT for the window, never throw the person away.
   */
  it('outside the send window: arms a timer for the next window and records no outcome', async () => {
    const early = fromISTWall(2026, 9, 24, 9, 0); // 09:00 IST, before 10:00
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, { ...deps, now: early });

    const rec = await getSubRec(CUSTOMER_ID);
    expect(rec).toBeTruthy();
    // NOT an outcome: an outcome is terminal and would lose this person for good.
    expect(rec.outcome).toBeUndefined();
    expect(rec.firstSentAt).toBeUndefined();
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);

    const timer = _peekTimers().find((t) => t.name === `W-${CUSTOMER_ID}-first`);
    expect(timer).toBeTruthy();
    expect(timer.at.toISOString()).toBe(nextWindowTime(early, RULES.subscriberOffer.sendWindow).toISOString());
    expect(timer.groupId).toBe(`phone:${PHONE}`);
  });

  it('and the deferred run then sends, once, when the window opens', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, { ...deps, now: fromISTWall(2026, 9, 24, 9, 0) });
    await W.onFirst(CUSTOMER_ID, { ...deps, now: fromISTWall(2026, 9, 24, 10, 0) });
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect(discounts(clients.shopify)).toHaveLength(1);
  });

  it('a late evening run waits for TOMORROW morning rather than dropping it', async () => {
    const late = fromISTWall(2026, 9, 24, 22, 0); // past 21:00
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, { ...deps, now: late });
    const timer = _peekTimers().find((t) => t.name === `W-${CUSTOMER_ID}-first`);
    expect(timer.at.toISOString()).toBe(fromISTWall(2026, 9, 25, 10, 0).toISOString());
  });

  const gated = [
    ['created before FLOW_W_START_AT', { createdAt: '2026-09-20T05:00:00Z' }, 'before-start'],
    ['carries an excluded tag', { tags: ['no-marketing'] }, 'excluded-tag'],
    ['already has an order on the customer record', { numberOfOrders: '2' }, 'already-ordered'],
    /*
     * R4, owner's decision 2026-10-24: the recipient is
     * Customer.defaultPhoneNumber validated through the EXISTING
     * normalizeVerifiedPhone. A number we hold but cannot use is a refusal,
     * not a quiet slide onto email.
     */
    ['a phone we cannot use', { defaultPhoneNumber: { phoneNumber: '+14155550123' } }, 'no-phone'],
    ['an Indian landline', { defaultPhoneNumber: { phoneNumber: '+912212345678' } }, 'no-phone'],
    ['no way to reach them at all', { defaultPhoneNumber: null, defaultEmailAddress: null }, 'no-channel'],
  ];

  it.each(gated)('%s: outcome %s, nothing created, nothing sent', async (_n, over, outcome) => {
    const { clients, deps } = setup({ customers: [customer(over)] });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe(outcome);
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(clients.email.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
  });

  it('messages defaultPhoneNumber, in whichever digit form Shopify holds it', async () => {
    for (const raw of ['+919637361371', '919637361371', '9637361371']) {
      _resetMemory();
      const { clients, deps } = setup({ customers: [customer({ defaultPhoneNumber: { phoneNumber: raw } })] });
      await W.onFirst(CUSTOMER_ID, deps);
      const sent = clients.whatsapp.sent.find((m) => m.name === 'subscriber_offer_v1');
      expect(sent, raw).toBeTruthy();
      expect(sent.to, raw).toBe(PHONE);
      expect((await getSubRec(CUSTOMER_ID)).phone, raw).toBe(PHONE);
    }
  });

  it('a customer Shopify no longer has: outcome not-found', async () => {
    const { deps } = setup({ customers: [] });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('not-found');
  });

  it('requireAnyTag, once set, refuses anyone without one of those tags', async () => {
    const original = RULES.subscriberOffer.requireAnyTag;
    RULES.subscriberOffer.requireAnyTag = ['popup-subscriber', 'newsletter'];
    try {
      const a = setup({ customers: [customer({ tags: ['vip'] })] });
      await W.onFirst(CUSTOMER_ID, a.deps);
      expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('not-a-subscriber');

      _resetMemory();
      const b = setup({ customers: [customer({ tags: ['popup-subscriber'] })] });
      await W.onFirst(CUSTOMER_ID, b.deps);
      expect((await getSubRec(CUSTOMER_ID)).firstSentAt).toBeTruthy();
    } finally {
      RULES.subscriberOffer.requireAnyTag = original;
    }
  });

  // ---- the order gates ----------------------------------------------------
  it('an order placed under the SAME customer id, between the sweep and the worker', async () => {
    const { clients, deps } = setup();
    clients.shopify.seed({
      id: 'gid://shopify/Order/555',
      name: '#555',
      createdAt: '2026-10-23T09:00:00Z',
      customer: { id: GID },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('already-ordered');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('an order placed under the same VERIFIED PHONE but no customer link', async () => {
    const { clients, deps } = setup();
    clients.shopify.seed({
      id: 'gid://shopify/Order/556',
      name: '#556',
      createdAt: '2026-10-23T09:00:00Z',
      customer: null,
      customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919637361371' }],
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('already-ordered');
  });

  it('an order found by their exact email, which is the guest-checkout case', async () => {
    const { clients, deps } = setup({ flowW: { ordersByEmail: { [EMAIL]: [{ id: 'gid://shopify/Order/557', name: '#557' }] } } });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('already-ordered');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('an open draft order the owner is building for them', async () => {
    const { clients, deps } = setup({
      flowW: { draftOrders: [{ id: 'gid://shopify/DraftOrder/9', customer: { id: GID }, email: null, phone: null }] },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('has-draft-order');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  /*
   * R6: unlike the public-codes read, a missing draft-order check cannot make
   * us offer too much money. It only risks messaging someone the owner is
   * already serving by hand, which is a far smaller harm than muting the
   * whole flow, so this gate fails OPEN and says so once a day.
   */
  it('a draft-order lookup that 403s skips that gate only, and still sends', async () => {
    const { clients, deps } = setup({ flowW: { failDraftOrders: 'Access denied for draftOrders field' } });
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);
    expect(rec.firstSentAt).toBeTruthy();
    expect(rec.draftCheckSkipped).toBe(true);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
    expect(JSON.stringify(alerts(clients.whatsapp))).toMatch(/draft/i);
  });

  it('and it says so once a day, not once per customer', async () => {
    const { clients, deps } = setup({ flowW: { failDraftOrders: 'Access denied' } });
    await W.onFirst(CUSTOMER_ID, deps);
    clients.shopify.seedCustomer(customer({
      id: 'gid://shopify/Customer/890',
      defaultPhoneNumber: { phoneNumber: '+919800000004' },
      defaultEmailAddress: { emailAddress: 'd@example.com', marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: UNSUB },
    }));
    await W.onFirst('890', deps);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  // ---- the cart gates -----------------------------------------------------
  it('an abandoned checkout of theirs, so Flow R owns this person', async () => {
    const { clients, deps } = setup();
    clients.shopify.seedCheckout({
      id: 'gid://shopify/AbandonedCheckout/66743166239092',
      name: '#66743166239092',
      createdAt: '2026-10-23T09:00:00Z',
      completedAt: null,
      customer: { id: GID },
      customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919637361371' }],
      lineItems: { nodes: [] },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('has-cart');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('a cart the storefront captured for that phone', async () => {
    const { clients, deps } = setup();
    await putCapture({ token: 'captok', phone: PHONE, items: [{ v: '1', q: 1 }], now: new Date(NOW.getTime() - 3600 * 1000) });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('has-cart');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  const flowRRows = [
    ['a Flow R cooldown LOCK', async () => lockCartPhone(PHONE, { checkoutId: 'X', until: new Date(NOW.getTime() + 20 * 86400000), now: NOW })],
    ['a Flow R WAIT park', async () => parkCart(PHONE, 'X', new Date(NOW.getTime() + 3600 * 1000), NOW)],
  ];

  it.each(flowRRows)('%s on the phone stops Flow W, so one person gets one private code', async (_n, arrange) => {
    const { clients, deps } = setup();
    await arrange();
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('has-cart');
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  // ---- consent ------------------------------------------------------------
  it('STOP wins over the customer record counting as consent', async () => {
    const { clients, deps } = setup();
    await setOptOut(PHONE, true);
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('opted-out');
    // Not even the email: STOP means stop.
    expect(clients.email.sent).toHaveLength(0);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
  });

  it('a Shopify UNSUBSCRIBED email stops the email, and still allows WhatsApp', async () => {
    // They are reachable on WhatsApp and have not sent STOP, so the offer
    // stands; only the channel they refused is closed.
    const { clients, deps } = setup({
      customers: [customer({ defaultEmailAddress: { emailAddress: EMAIL, marketingState: 'UNSUBSCRIBED', marketingUnsubscribeUrl: UNSUB } })],
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect(clients.email.sent).toHaveLength(0);
  });

  /*
   * R5, owner's decision 2026-10-24: UNSUBSCRIBED ONLY. The customer record is
   * itself the consent, so a half-finished or bounced marketing state is not a
   * refusal, and there is deliberately no address-format gate.
   */
  it.each([['NOT_SUBSCRIBED'], ['PENDING'], ['INVALID']])('still emails a customer in state %s', async (state) => {
    const { clients, deps } = setup({
      customers: [customer({
        defaultPhoneNumber: null,
        defaultEmailAddress: { emailAddress: EMAIL, marketingState: state, marketingUnsubscribeUrl: UNSUB },
      })],
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect(clients.email.sent, state).toHaveLength(1);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBeUndefined();
  });

  it('an UNSUBSCRIBED email with no phone is the end of it', async () => {
    const { clients, deps } = setup({
      customers: [customer({
        defaultPhoneNumber: null,
        defaultEmailAddress: { emailAddress: EMAIL, marketingState: 'UNSUBSCRIBED', marketingUnsubscribeUrl: UNSUB },
      })],
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('email-unsubscribed');
    expect(clients.email.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('a number on the undeliverable list', async () => {
    const { clients, deps } = setup();
    await setUndeliverable(PHONE);
    await W.onFirst(CUSTOMER_ID, deps);
    // 131026 said this number cannot receive WhatsApp, so the offer goes by
    // email instead: the person is not refused, only the channel.
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(clients.email.sent).toHaveLength(1);
    expect((await getSubRec(CUSTOMER_ID)).channel).toBe('email');
  });

  it('an undeliverable number and no email at all', async () => {
    const { clients, deps } = setup({ customers: [customer({ defaultEmailAddress: null })] });
    await setUndeliverable(PHONE);
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('undeliverable');
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  // ---- once per person, ever ---------------------------------------------
  it('a lifetime PHONE lock refuses a second customer record on the same number', async () => {
    const { clients, deps } = setup();
    await lockPhoneOffer(PHONE, { customerId: '999', now: new Date(NOW.getTime() - 400 * 86400 * 1000) });
    await W.onFirst(CUSTOMER_ID, deps);
    // A year later is still "ever": this lock never expires.
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('already-offered');
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('a lifetime EMAIL lock refuses a new number farming the same address', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);

    // Same person, same email, a fresh customer record and a fresh number.
    const second = customer({ id: 'gid://shopify/Customer/777', defaultPhoneNumber: { phoneNumber: '+919800000001' } });
    clients.shopify.seedCustomer(second);
    await W.onFirst('777', { ...deps, now: NOW });
    expect((await getSubRec('777')).outcome).toBe('already-offered');
    expect(discounts(clients.shopify)).toHaveLength(1);
  });

  it('respects the service-wide marketing cap', async () => {
    const { clients, deps } = setup();
    await markMarketing(PHONE, new Date(NOW.getTime() - 2 * 86400 * 1000));
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('marketing-cap');
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('but not when the 24 hour window is open, because a session message is not a template', async () => {
    const { clients, deps } = setup();
    await markMarketing(PHONE, new Date(NOW.getTime() - 86400 * 1000));
    await touchInbound(PHONE, new Date(NOW.getTime() - 3600 * 1000));
    await W.onFirst(CUSTOMER_ID, deps);
    expect(ctaSends(clients.whatsapp)).toHaveLength(1);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBeUndefined();
    expect((await getSubRec(CUSTOMER_ID)).firstSentAt).toBeTruthy();
  });

  it('and a session send does not spend a cap it never used', async () => {
    const { deps } = setup();
    await touchInbound(PHONE, new Date(NOW.getTime() - 3600 * 1000));
    await W.onFirst(CUSTOMER_ID, deps);
    expect(await canSendMarketing(PHONE, NOW, RULES.marketingCapDays)).toBe(true);
  });

  // ---- the offer guard ---------------------------------------------------
  it('refuses when a public code matches or beats the private one', async () => {
    const { clients, deps } = setup({
      shopify: {
        publicCodes: [{ code: 'WELCOME200', title: 'WELCOME200', type: 'amount', amountPaise: 20000, minSubtotalPaise: 119900 }],
      },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('public-offer-better');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(clients.whatsapp.sent.filter((s) => s.name === 'subscriber_offer_v1')).toHaveLength(0);
  });

  it('and alerts the owner once a day about it, not once per customer', async () => {
    const { clients, deps } = setup({
      shopify: { publicCodes: [{ code: 'WELCOME200', title: 'WELCOME200', type: 'amount', amountPaise: 20000, minSubtotalPaise: 119900 }] },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    clients.shopify.seedCustomer(customer({ id: 'gid://shopify/Customer/888', defaultPhoneNumber: { phoneNumber: '+919800000002' }, defaultEmailAddress: { emailAddress: 'b@example.com', marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: UNSUB } }));
    await W.onFirst('888', deps);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  it('FAILS CLOSED when the live discount codes cannot be read', async () => {
    // Without them the floor is unknown, so a private Rs 200 code could be
    // worth less than something printed on the cart page. Silence is better.
    const { clients, deps } = setup({ shopify: { failPublicCodes: 'Access denied for discountNodes field' } });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('no-public-codes');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(clients.whatsapp.sent.filter((s) => s.name === 'subscriber_offer_v1')).toHaveLength(0);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(alerts(clients.whatsapp).length).toBeGreaterThan(0);
  });

  it('and its own single-use codes never count as public ones', async () => {
    // publicCodeDiscounts() must skip anything titled "Subscriber offer #",
    // exactly as it already skips "Cart recovery #", or the first code issued
    // becomes the floor every later one has to beat.
    const { clients, deps } = setup({
      shopify: {
        publicCodes: [{ code: 'MORPAANKHPRIYA4729', title: 'Subscriber offer #1', type: 'amount', amountPaise: 20000, minSubtotalPaise: 100 }],
      },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).firstSentAt).toBeTruthy();
  });

  // ---- shadow + the send gate --------------------------------------------
  it('shadow mode creates nothing, sends nothing and locks nothing', async () => {
    config.subscriberOfferAllowlist = ['+919999999999'];
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    expect(clients.whatsapp.sent).toHaveLength(0);
    expect(clients.email.sent).toHaveLength(0);
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('shadow');
  });

  it('shadow mode logs once per person, not once per run', async () => {
    config.subscriberOfferAllowlist = ['+919999999999'];
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const first = await getSubRec(CUSTOMER_ID);
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcomeAt).toBe(first.outcomeAt);
  });

  /*
   * R19: Flow R's shadow line logs a `codePreview` that embeds the customer's
   * first name in clear text in CloudWatch, right beside a masked phone. Flow
   * W does not copy that.
   */
  it('the shadow log carries a masked phone and no name or code preview', async () => {
    config.subscriberOfferAllowlist = ['+919999999999'];
    const lines = [];
    const spies = ['log', 'warn', 'error'].map((m) => vi.spyOn(console, m).mockImplementation((...a) => lines.push(a.map(String).join(' '))));
    try {
      const { deps } = setup();
      await W.onFirst(CUSTOMER_ID, deps);
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
    const all = lines.join('\n');
    expect(all).toMatch(/would send/);
    expect(all).not.toContain('Priya');
    expect(all).not.toContain('MORPAANKH');
    expect(all).not.toContain('919637361371');
    expect(all).not.toContain(EMAIL);
  });

  it('a phone ON the allowlist is still messaged for real', async () => {
    config.subscriberOfferAllowlist = [PHONE];
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    expect(customerTemplates(clients.whatsapp)).toEqual(['subscriber_offer_v1']);
  });

  it('a gated send creates no code, because nothing went out', async () => {
    // DRY_RUN or a SEND_ALLOWLIST that does not hold this number. The send's
    // own reply comes back AFTER the Shopify code exists, so asking first is
    // the only thing that stops one orphan single-use code per customer.
    const { clients, deps } = setup({ whatsapp: { skipWith: 'dry_run' } });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('send-dry_run');
    expect(discounts(clients.shopify)).toHaveLength(0);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(await getSubCodeMap('MORPAANKHPRIYA4729')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
describe('a send Meta refuses', () => {
  it('131049: parks against the phone AND sends the email fallback', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131049 } });
    await W.onFirst(CUSTOMER_ID, deps);

    const rec = await getSubRec(CUSTOMER_ID);
    expect(rec.outcome).toBe('waiting-window');
    // They received nothing on WhatsApp, so no WhatsApp lock.
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    const parked = await getSubParked(PHONE);
    expect(parked.customerId).toBe(CUSTOMER_ID);
    // The park lives exactly as long as the offer does.
    expect(parked.until).toBe(rec.codeEndsAt);

    expect(clients.email.sent).toHaveLength(1);
    expect(clients.email.sent[0].to).toBe(EMAIL);
  });

  it('and the window opening then delivers the SAME code, byte for byte', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131049 } });
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);

    const emailCode = codeIn(clients.email.sent[0]);
    expect(emailCode).toBe(rec.code);

    // They write to us, which opens a 24 hour service window. The fake only
    // fails TEMPLATES, so this proves the fallback channel is a different one.
    const later = new Date(NOW.getTime() + 2 * 3600 * 1000);
    await touchInbound(PHONE, later);
    await W.onWindowOpen(PHONE, { clients, now: later });

    expect(ctaSends(clients.whatsapp)).toHaveLength(1);
    const sessionCode = codeIn(ctaSends(clients.whatsapp)[0]);
    // THE assertion: one person, one code, whichever door it came through.
    expect(sessionCode).toBe(emailCode);
    expect(sessionCode).toBe(rec.code);
    expect(discounts(clients.shopify)).toHaveLength(1);

    const after = await getSubRec(CUSTOMER_ID);
    expect(after.code).toBe(rec.code);
    expect(after.codeEndsAt).toBe(rec.codeEndsAt);
    expect(after.firstSentAt).toBeTruthy();
    // Cleared, not left reading `waiting-window` for an offer that has landed.
    expect(after.outcome).toBe(null);
    expect(await getSubParked(PHONE)).toBe(null);
    expect(await getPhoneOfferLock(PHONE)).toBeTruthy();
  });

  it('131026: sends the email fallback and does not park, because no window helps', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131026 } });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('meta-131026');
    expect(await getSubParked(PHONE)).toBe(null);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(clients.email.sent).toHaveLength(1);
    expect(codeIn(clients.email.sent[0])).toBe((await getSubRec(CUSTOMER_ID)).code);
  });

  it('132001: the template is unusable, and the owner is told once a day', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 132001 } });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('template-unusable');
    expect(await getPhoneOfferLock(PHONE)).toBe(null);

    clients.shopify.seedCustomer(customer({
      id: 'gid://shopify/Customer/889',
      defaultPhoneNumber: { phoneNumber: '+919800000003' },
      defaultEmailAddress: { emailAddress: 'c@example.com', marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: UNSUB },
    }));
    await W.onFirst('889', deps);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
  });

  it('anything else throws, so SQS redelivers it', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 500 } });
    await expect(W.onFirst(CUSTOMER_ID, deps)).rejects.toThrow();
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect((await getSubRec(CUSTOMER_ID)).firstSentAt).toBeUndefined();
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBeUndefined();
    // The code was memoised before the send, so the retry must not mint a second.
    expect(discounts(clients.shopify)).toHaveLength(1);
  });

  it('a redelivery after a throw reuses the same code and sends once', async () => {
    const { deps } = setup({ whatsapp: { failTemplateWith: 500 } });
    await expect(W.onFirst(CUSTOMER_ID, deps)).rejects.toThrow();
    const half = await getSubRec(CUSTOMER_ID);

    const ok = setup();
    await W.onFirst(CUSTOMER_ID, ok.deps);
    expect(customerTemplates(ok.clients.whatsapp)).toEqual(['subscriber_offer_v1']);
    expect((await getSubRec(CUSTOMER_ID)).code).toBe(half.code);
    expect(discounts(ok.clients.shopify)).toHaveLength(0);
  });

  it('does nothing when a window opens on a phone with nothing parked', async () => {
    const { clients } = setup();
    await W.onWindowOpen(PHONE, { clients, now: NOW });
    expect(clients.whatsapp.sent).toHaveLength(0);
  });

  it('drops a parked offer once its code has closed', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131049 } });
    await W.onFirst(CUSTOMER_ID, deps);
    const past = new Date(NOW.getTime() + (RULES.subscriberOffer.codeValidHours + 1) * 3600 * 1000);
    await touchInbound(PHONE, past);
    await W.onWindowOpen(PHONE, { clients, now: past });
    expect(ctaSends(clients.whatsapp)).toHaveLength(0);
    expect(await getSubParked(PHONE)).toBe(null);
  });

  it('drops a parked offer for someone who has since ordered', async () => {
    const { clients, deps } = setup({ whatsapp: { failTemplateWith: 131049 } });
    await W.onFirst(CUSTOMER_ID, deps);
    clients.shopify.seed({ id: 'gid://shopify/Order/558', name: '#558', createdAt: '2026-10-24T06:00:00Z', customer: { id: GID } });
    const later = new Date(NOW.getTime() + 3600 * 1000);
    await touchInbound(PHONE, later);
    await W.onWindowOpen(PHONE, { clients, now: later });
    expect(ctaSends(clients.whatsapp)).toHaveLength(0);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('already-ordered');
  });
});

// ---------------------------------------------------------------------------
describe('the delivery status webhook', () => {
  /*
   * THE REAL FAILURE SHAPE for 131049. Meta accepts the send with a 200 and
   * reports the per-user marketing cap asynchronously seconds later, so
   * firstSentAt is already stamped and nothing ever throws. Every 131049 this
   * store has had arrived this way.
   */
  it('failed: releases the lock, gives the cap back, and parks a 131049', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    expect(await getPhoneOfferLock(PHONE)).toBeTruthy();
    expect(await canSendMarketing(PHONE, NOW, RULES.marketingCapDays)).toBe(false);

    await W.onSubStatus(CUSTOMER_ID, { status: 'failed', errors: [{ code: 131049 }] }, NOW);

    /*
     * R9, THE HIGHEST-CONSEQUENCE PATH IN THE FEATURE. The send was accepted
     * with a 200, so both lifetime locks are already written by the time this
     * webhook lands. The offer is "once per person, EVER": leaving the locks
     * in place would burn this customer permanently over a message they never
     * received. Both locks go back, and the marketing cap with them, BEFORE
     * anything is parked or emailed.
     */
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
    expect(await canSendMarketing(PHONE, NOW, RULES.marketingCapDays)).toBe(true);
    expect((await getSubRec(CUSTOMER_ID))).toMatchObject({ deliveryFailed: true, deliveryError: 131049 });
    expect((await getSubParked(PHONE)).customerId).toBe(CUSTOMER_ID);
    expect(clients.email.sent).toHaveLength(1);
  });

  it('a 131026 on the status webhook releases both locks but parks nothing', async () => {
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onSubStatus(CUSTOMER_ID, { status: 'failed', errors: [{ code: 131026 }] }, NOW);
    expect(await getSubParked(PHONE)).toBe(null);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
  });

  it('a failure with no error code at all still gives the locks back', async () => {
    // "Once ever" means a lock must never outlive a message nobody got, and we
    // do not get to wait for Meta to tell us which flavour of nothing it was.
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onSubStatus(CUSTOMER_ID, { status: 'failed', errors: [] }, NOW);
    expect(await getPhoneOfferLock(PHONE)).toBe(null);
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
    expect(await canSendMarketing(PHONE, NOW, RULES.marketingCapDays)).toBe(true);
  });

  it('and the offer can then genuinely be made again', async () => {
    // The whole reason the locks go back: this person has had nothing.
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onSubStatus(CUSTOMER_ID, { status: 'failed', errors: [{ code: 131026 }] }, NOW);

    const later = fromISTWall(2026, 9, 25, 11, 0);
    clients.shopify.seedCustomer(customer({ id: 'gid://shopify/Customer/891', createdAt: '2026-10-24T05:00:00Z' }));
    await W.onFirst('891', { ...deps, now: later });
    expect((await getSubRec('891')).outcome).not.toBe('already-offered');
  });

  it('a good status touches neither the lock nor the cap', async () => {
    const { deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onSubStatus(CUSTOMER_ID, { status: 'delivered' }, NOW);
    expect((await getSubRec(CUSTOMER_ID)).lastStatus).toBe('delivered');
    expect(await getPhoneOfferLock(PHONE)).toBeTruthy();
  });

  it('maps the wamid to a CUSTOMER and never to an order', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const wamid = clients.whatsapp.sent[0].__wamid || 'fake-wamid-1';
    const map = await table.get(`WAMID#${wamid}`, 'MAP');
    expect(map).toMatchObject({ customerId: CUSTOMER_ID, key: 'subscriber_offer' });
    // onWaStatus tags the order and alerts by order name past that point, and
    // a customer id is not an order id.
    expect(map.orderId).toBeUndefined();
    expect(map.cartId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('the email channel', () => {
  const emailOnly = (over = {}) => customer({ defaultPhoneNumber: null, ...over });

  it('sends a subject, a text part and an HTML part, with the code in all of them', async () => {
    const { clients, deps } = setup({ customers: [emailOnly()] });
    await W.onFirst(CUSTOMER_ID, deps);

    const rec = await getSubRec(CUSTOMER_ID);
    expect(rec.channel).toBe('email');
    expect(clients.whatsapp.sent.filter((s) => s.name === 'subscriber_offer_v1')).toHaveLength(0);
    const [mail] = clients.email.sent;
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toBe('Priya, your private welcome code closes tomorrow');
    expect(mail.html).toContain(rec.code);
    expect(mail.text).toContain(rec.code);
    expect(mail.html).toContain('A private welcome, for the next 24 hours');
    expect(mail.text.length).toBeGreaterThan(100);
    // The link in the email is tagged as an email tap, not a WhatsApp one.
    expect(mail.html).toContain('utm_source=email');
  });

  it('drops the name from the subject when there is not one', async () => {
    const { clients, deps } = setup({ customers: [emailOnly({ firstName: '', lastName: '' })] });
    await W.onFirst(CUSTOMER_ID, deps);
    expect(clients.email.sent[0].subject).toBe('Your private welcome code closes tomorrow');
  });

  it('carries List-Unsubscribe from the Shopify URL on that customer', async () => {
    const { clients, deps } = setup({ customers: [emailOnly()] });
    await W.onFirst(CUSTOMER_ID, deps);
    const h = clients.email.sent[0].headers || {};
    expect(h['List-Unsubscribe']).toContain(UNSUB);
    expect(clients.email.sent[0].html).toContain(UNSUB);
  });

  it('strips CR and LF out of every header value', async () => {
    // A marketingUnsubscribeUrl is a value Shopify gives us, and a header with
    // a bare CRLF in it appends headers of somebody else's choosing.
    const hostile = 'https://www.morpaankh.in/u?id=1\r\nBcc: victim@example.com';
    const { clients, deps } = setup({
      customers: [emailOnly({ defaultEmailAddress: { emailAddress: EMAIL, marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: hostile } })],
    });
    await W.onFirst(CUSTOMER_ID, deps);
    const mail = clients.email.sent[0];
    for (const [k, v] of Object.entries(mail.headers || {})) {
      expect(/[\r\n]/.test(String(v)), `${k}: ${JSON.stringify(v)}`).toBe(false);
    }
    expect(/[\r\n]/.test(String(mail.subject))).toBe(false);
    expect(String(mail.to)).not.toContain('victim@example.com');
  });

  it('escapes the name and the product titles on the way into the HTML', async () => {
    const { clients, deps } = setup({
      customers: [emailOnly({ firstName: '<script>alert(1)</script>' })],
      flowW: { bestSellers: [{ title: 'Khili "Dhoop" & <b>Co</b>', status: 'ACTIVE', availableForSale: true, imageUrl: 'https://cdn.shopify.com/x/a.jpg' }] },
    });
    await W.onFirst(CUSTOMER_ID, deps);
    const { html } = clients.email.sent[0];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Co</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('SES unavailable: outcome email-unavailable, and never a throw', async () => {
    const { clients, deps } = setup({ customers: [emailOnly()], email: { unavailable: true } });
    await expect(W.onFirst(CUSTOMER_ID, deps)).resolves.toBeDefined();
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('email-unavailable');
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
    // And no orphan code: nothing was created for a message that never went.
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  /*
   * R5: an address that cannot receive is not screened in advance, it simply
   * fails at SES. That is a DIFFERENT outcome from "we have no email channel
   * at all", because one is a dud address and the other is a broken deploy.
   */
  it('SES rejecting the message is email-send-failed, and still not a throw', async () => {
    const { clients, deps } = setup({ customers: [emailOnly()], email: { failWith: 'MessageRejected' } });
    await expect(W.onFirst(CUSTOMER_ID, deps)).resolves.toBeDefined();
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('email-send-failed');
    expect(await getEmailOfferLock(emailKey(EMAIL))).toBe(null);
    expect(clients.email.sent).toHaveLength(0);
  });

  it('and a dud address is simply allowed through to SES', async () => {
    // No validFormat gate: it was offered and declined.
    const { clients, deps } = setup({
      customers: [emailOnly({ defaultEmailAddress: { emailAddress: 'not-an-address', marketingState: 'SUBSCRIBED', marketingUnsubscribeUrl: UNSUB } })],
    });
    await W.onFirst(CUSTOMER_ID, deps);
    expect(clients.email.sent).toHaveLength(1);
    expect(clients.email.sent[0].to).toBe('not-an-address');
  });

  it('a gated email creates nothing either', async () => {
    const { clients, deps } = setup({ customers: [emailOnly()], email: { skipWith: 'dry_run' } });
    await W.onFirst(CUSTOMER_ID, deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('send-dry_run');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('takes the lifetime EMAIL lock and groups on the email hash, not the address', async () => {
    const { deps } = setup({ customers: [emailOnly()] });
    await W.onFirst(CUSTOMER_ID, deps);
    const lock = await getEmailOfferLock(emailKey(EMAIL));
    expect(lock).toMatchObject({ customerId: CUSTOMER_ID });
    expect(JSON.stringify(lock)).not.toContain('priya.test@example.com');
  });

  it('an email-only redelivery sends one email and one code', async () => {
    const { clients, deps } = setup({ customers: [emailOnly()] });
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onFirst(CUSTOMER_ID, deps);
    expect(clients.email.sent).toHaveLength(1);
    expect(discounts(clients.shopify)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('Talk to us', () => {
  it('replies, and tells the owner without printing the whole number', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    await W.onTap(CUSTOMER_ID, 'help', PHONE, deps);

    const texts = clients.whatsapp.sent.filter((s) => s.type === 'text').map((s) => s.body);
    expect(texts.some((t) => /Someone from our team will message you here shortly/.test(t))).toBe(true);
    expect((await getSubRec(CUSTOMER_ID)).helpRequestedAt).toBeTruthy();
    const alert = JSON.stringify(alerts(clients.whatsapp));
    expect(alert).toMatch(/Talk to us/);
    expect(alert).not.toContain('919637361371');
  });

  /*
   * The router's ownsOrder() fails open for an id it has never seen, and a
   * Flow W payload carries a CUSTOMER id, so that gate always passes. This
   * strict check is the only thing between a clear-text payload and somebody
   * else's private code.
   */
  it('ignores a tap from a phone that does not own the record', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const before = clients.whatsapp.sent.length;
    await W.onTap(CUSTOMER_ID, 'help', '+919111111111', deps);
    expect(clients.whatsapp.sent).toHaveLength(before);
    expect((await getSubRec(CUSTOMER_ID)).helpRequestedAt).toBeUndefined();
  });

  it('ignores an unknown action', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const before = clients.whatsapp.sent.length;
    await W.onTap(CUSTOMER_ID, 'nonsense', PHONE, deps);
    expect(clients.whatsapp.sent).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
describe('an order carrying the code', () => {
  const orderPayload = (over = {}) => ({
    id: 5551212,
    name: '#1201',
    created_at: '2026-10-24T09:00:00Z',
    note_attributes: [{ name: '_otpVerifiedPhoneNumber', value: '919637361371' }],
    discount_codes: [],
    ...over,
  });

  it('records converted and tags the order', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);

    await W.onOrderCreated(orderPayload({ discount_codes: [{ code: rec.code }] }), deps);

    const after = await getSubRec(CUSTOMER_ID);
    expect(after).toMatchObject({ outcome: 'converted', orderId: '5551212', codeUsed: true });
    expect(tagsAdded(clients.shopify)).toEqual(
      expect.arrayContaining(['wa-subscriber-converted', RULES.cartRecovery.giftTag]),
    );
  });

  it('matches the code case-insensitively, as Shopify echoes it', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);
    await W.onOrderCreated(orderPayload({ discount_codes: [{ code: rec.code.toLowerCase() }] }), deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).toBe('converted');
    expect(tagsAdded(clients.shopify)).toContain('wa-subscriber-converted');
  });

  it('is idempotent, so a webhook retry does not tag twice', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);
    await W.onOrderCreated(orderPayload({ discount_codes: [{ code: rec.code }] }), deps);
    await W.onOrderCreated(orderPayload({ discount_codes: [{ code: rec.code }] }), deps);
    expect(tagsAdded(clients.shopify).filter((t) => t === 'wa-subscriber-converted')).toHaveLength(1);
  });

  it('ignores an order carrying a code we never issued', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    clients.shopify.calls.length = 0;
    await W.onOrderCreated(orderPayload({ discount_codes: [{ code: 'BUY2' }] }), deps);
    expect(tagsAdded(clients.shopify)).toHaveLength(0);
    expect((await getSubRec(CUSTOMER_ID)).outcome).not.toBe('converted');
  });

  it('ignores an order with no discount codes at all', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    clients.shopify.calls.length = 0;
    await W.onOrderCreated(orderPayload(), deps);
    expect(tagsAdded(clients.shopify)).toHaveLength(0);
  });

  it('does not attribute an order placed before the offer went out', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);
    await W.onOrderCreated(orderPayload({ created_at: '2026-10-20T09:00:00Z', discount_codes: [{ code: rec.code }] }), deps);
    expect((await getSubRec(CUSTOMER_ID)).outcome).not.toBe('converted');
    expect(tagsAdded(clients.shopify)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('Flow R stands down for a live Flow W code', () => {
  /*
   * One live private code per phone. Both flows mint a MORPAANKH code against
   * the same number, and the theme's offers script keeps whichever one the link
   * applied, so two live codes means the customer can be holding a code the
   * message they are reading does not mention.
   */
  const CHECKOUT_ID = '66743166239092';
  const checkout = (over = {}) => ({
    id: `gid://shopify/AbandonedCheckout/${CHECKOUT_ID}`,
    name: `#${CHECKOUT_ID}`,
    createdAt: '2026-10-24T04:00:00Z', // 09:30 IST, 90 minutes before NOW
    completedAt: null,
    abandonedCheckoutUrl: 'https://www.morpaankh.in/9/checkouts/ac/TOK/recover?key=SECRETKEY&locale=en-IN',
    totalDiscountSet: { shopMoney: { amount: '0.0' } },
    customAttributes: [
      { key: '_otpVerifiedPhoneNumber', value: '919637361371' },
      { key: '_codkAmountType', value: 'cod' },
    ],
    customer: { id: GID, firstName: 'Priya' },
    shippingAddress: { firstName: 'Priya' },
    lineItems: {
      nodes: [{
        title: 'Khili Dhoop',
        quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1599.0' } },
        image: { url: 'https://cdn.shopify.com/s/files/1/x/a.jpg?v=1', width: 1200, height: 1500 },
        variant: { id: 'gid://shopify/ProductVariant/9', availableForSale: true, selectedOptions: [{ name: 'Size', value: 'XS' }] },
      }],
    },
    ...over,
  });

  it('Flow R records subscriber-offer-live and sends nothing', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    clients.shopify.seedCheckout(checkout());
    clients.shopify.calls.length = 0;

    await R.onFirst(CHECKOUT_ID, deps);

    expect((await getCartRec(CHECKOUT_ID)).outcome).toBe('subscriber-offer-live');
    expect(templates(clients.whatsapp)).not.toContain('cart_recovery_v1');
    expect(discounts(clients.shopify)).toHaveLength(0);
  });

  it('but Flow R proceeds once the Flow W code has closed', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    clients.shopify.seedCheckout(checkout({ createdAt: '2026-10-25T04:00:00Z' }));

    // A day later: the welcome code has closed, so there is no clash left.
    const later = fromISTWall(2026, 9, 25, 11, 30);
    await R.onFirst(CHECKOUT_ID, { ...deps, now: later });
    expect((await getCartRec(CHECKOUT_ID)).outcome).not.toBe('subscriber-offer-live');
  });

  it('and Flow R proceeds once the Flow W code has been used', async () => {
    const { clients, deps } = setup();
    await W.onFirst(CUSTOMER_ID, deps);
    const rec = await getSubRec(CUSTOMER_ID);
    await W.onOrderCreated({
      id: 5551212,
      name: '#1201',
      created_at: '2026-10-24T06:00:00Z',
      note_attributes: [{ name: '_otpVerifiedPhoneNumber', value: '919637361371' }],
      discount_codes: [{ code: rec.code }],
    }, deps);

    clients.shopify.seedCheckout(checkout());
    await R.onFirst(CHECKOUT_ID, deps);
    expect((await getCartRec(CHECKOUT_ID)).outcome).not.toBe('subscriber-offer-live');
  });
});
