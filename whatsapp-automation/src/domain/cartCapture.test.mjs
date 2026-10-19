import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _drainQueue } from '../queue.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { putCapture, getCapture } from '../store/cartCapture.mjs';
import { capturedToCheckout, variantGidsOf, isCapturedId, captureIdFor } from './cartCapture.mjs';
import { normalizeCheckout, cartEligible, personalCodeName } from './cart.mjs';
import { sweepAbandonedCarts } from '../timers/cart-sweep.mjs';
import { cleanToken, cleanItems, cleanAttrs } from '../ingest/cart-capture.mjs';
import { buildTarget } from '../ingest/cart-redirect.mjs';
import { RULES } from '../../messages/rules.mjs';

const NOW = fromISTWall(2026, 9, 12, 12, 0); // 12:00 IST
const VGID = 'gid://shopify/ProductVariant/9';

const variant = (over = {}) => ({
  id: VGID,
  title: 'XS',
  price: '1249.00',
  availableForSale: true,
  selectedOptions: [{ name: 'Size', value: 'XS' }],
  image: { url: 'https://cdn.shopify.com/a.jpg', width: 1200, height: 1500 },
  product: { id: 'gid://shopify/Product/1', handle: 'khili-dhoop', title: 'Khili Dhoop' },
  ...over,
});

const row = (over = {}) => ({
  id: captureIdFor('TOK1'),
  token: 'TOK1',
  phone: '+919637361371',
  items: [{ id: VGID, qty: 1 }],
  attrs: {},
  capturedAt: '2026-10-12T05:00:00Z', // 90 minutes before NOW
  ...over,
});

beforeEach(() => {
  _resetMemory();
  _drainQueue();
  config.flows.R = { enabled: true, startAt: '2026-10-01T00:00:00Z' };
});

describe('a captured cart becomes a checkout', () => {
  it('produces a node normalizeCheckout reads, with the verified phone and the bag', () => {
    const n = normalizeCheckout(capturedToCheckout(row(), [variant()]));
    expect(n.verifiedPhone).toBe('+919637361371');
    expect(n.numericId).toBe('cap_TOK1');
    expect(n.bagPaise).toBe(124900);
    expect(n.lineItems[0].title).toBe('Khili Dhoop');
    expect(n.lineItems[0].size).toBe('XS');
    expect(cartEligible(n, { now: NOW, startAt: '2026-10-01T00:00:00Z', rules: RULES }).ok).toBe(true);
  });

  it('prices the bag from SHOPIFY, never from anything the browser sent', () => {
    /* The row carries an inflated price in a field the browser could set. The
     * offer is a percentage of the bag, so trusting it would be handing the
     * caller a dial on their own discount. */
    const hostile = row({ items: [{ id: VGID, qty: 1, price: '9999999', line_price: '9999999' }] });
    const n = normalizeCheckout(capturedToCheckout(hostile, [variant()]));
    expect(n.bagPaise).toBe(124900);
  });

  it('cannot be told who to message by the stored attributes', () => {
    const spoofed = row({ attrs: { _otpVerifiedPhoneNumber: '919999999999' } });
    const n = normalizeCheckout(capturedToCheckout(spoofed, [variant()]));
    expect(n.verifiedPhone).toBe('+919637361371');
  });

  it('keeps the COD King partial-advance signal so those carts are still refused', () => {
    const partial = row({ attrs: { _codkAmountType: 'percentage', _codkAmountValue: '20.0' } });
    const n = normalizeCheckout(capturedToCheckout(partial, [variant()]));
    expect(cartEligible(n, { now: NOW, startAt: '2026-10-01T00:00:00Z', rules: RULES }).reason)
      .toBe('partial-advance');
  });

  it('drops a line whose variant Shopify no longer returns, and the cart with it when none are left', () => {
    expect(capturedToCheckout(row(), [])).toBeNull();
    const two = row({ items: [{ id: VGID, qty: 1 }, { id: 'gid://shopify/ProductVariant/404', qty: 1 }] });
    expect(capturedToCheckout(two, [variant()]).lineItems.nodes).toHaveLength(1);
  });

  it('marks a sold out bag, so the sweep refuses it', () => {
    const n = normalizeCheckout(capturedToCheckout(row(), [variant({ availableForSale: false })]));
    expect(cartEligible(n, { now: NOW, startAt: '2026-10-01T00:00:00Z', rules: RULES }).reason).toBe('sold-out');
  });

  /*
   * A captured cart has no customer of its own: it never became a Shopify
   * checkout. Without the lookup every captured cart is greeted "Hello there"
   * and gets the VIP fallback code, which on a recovery message reads as a
   * mailshot rather than a note to one person.
   */
  it('is named from the customer COD King created at OTP', () => {
    const c = { id: 'gid://shopify/Customer/2520', firstName: 'Nidhi', lastName: 'Vaze' };
    const n = normalizeCheckout(capturedToCheckout(row(), [variant()], c));
    expect(n.firstName).toBe('Nidhi');
    expect(n.customerGid).toBe('gid://shopify/Customer/2520');
    expect(personalCodeName(n.rawFirstName, RULES)).toBe('NIDHI');
  });

  it('still sends, unnamed, when no customer is found', () => {
    const n = normalizeCheckout(capturedToCheckout(row(), [variant()], null));
    expect(n.customerGid).toBeFalsy();
    expect(personalCodeName(n.rawFirstName, RULES)).toBe(RULES.cartRecovery.codeFallbackName);
    expect(cartEligible(n, { now: NOW, startAt: '2026-10-01T00:00:00Z', rules: RULES }).ok).toBe(true);
  });

  it('tells its own ids apart from Shopify checkout ids', () => {
    expect(isCapturedId('cap_TOK1')).toBe(true);
    expect(isCapturedId('66786007613812')).toBe(false);
    expect(variantGidsOf(row())).toEqual([VGID]);
  });
});

describe('the sweep reads captured carts', () => {
  async function seed(clients, over = {}) {
    clients.shopify.seedVariant(variant());
    const r = row(over);
    await putCapture({
      token: r.token, phone: r.phone, items: r.items, attrs: r.attrs,
      now: new Date(r.capturedAt),
    });
    return r;
  }

  it('enqueues a captured cart that Shopify never filed as a checkout', async () => {
    const clients = makeFakeClients({});
    await seed(clients);
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual(['cap_TOK1']);
    const q = _drainQueue();
    expect(q[0].message).toEqual({ kind: 'cart', step: 'first', checkoutId: 'cap_TOK1' });
    expect(q[0].groupId).toBe('phone:+919637361371');
  });

  it('leaves a cart alone until firstAfterMin has passed', async () => {
    const clients = makeFakeClients({});
    await seed(clients, { capturedAt: new Date(NOW.getTime() - 5 * 60000).toISOString() });
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual([]);
    expect(out.captured.eligible).toBe(0);
  });

  it('does not pay Shopify for carts that are already too old to act on', async () => {
    const clients = makeFakeClients({});
    await seed(clients, { capturedAt: new Date(NOW.getTime() - 40 * 3600 * 1000).toISOString() });
    await sweepAbandonedCarts(clients, NOW);
    expect(clients.shopify.calls.find((c) => c.op === 'getVariantsByIds')).toBeUndefined();
  });

  it('still works when captured carts cannot be priced, falling back to Shopify alone', async () => {
    const clients = makeFakeClients({});
    await seed(clients); // variant seeded, then the lookup is made to fail
    clients.shopify.getVariantsByIds = async () => { throw new Error('shopify down'); };
    const out = await sweepAbandonedCarts(clients, NOW);
    expect(out.enqueued).toEqual([]);
    expect(out.listed).toBe(0);
  });

  it('sends one sequence per phone when the same person is in both sources', async () => {
    const clients = makeFakeClients({});
    await seed(clients);
    // The same phone, reaching Shopify checkout AFTER the capture.
    clients.shopify.seedCheckout({
      id: 'gid://shopify/AbandonedCheckout/LATER',
      name: '#LATER',
      createdAt: new Date(NOW.getTime() - 30 * 60000).toISOString(),
      completedAt: null,
      abandonedCheckoutUrl: 'https://www.morpaankh.in/9/checkouts/ac/LATER/recover?key=K',
      totalDiscountSet: { shopMoney: { amount: '0.0' } },
      customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919637361371' }],
      customer: { id: 'gid://shopify/Customer/1', firstName: 'Bharti' },
      lineItems: { nodes: [{
        title: 'Khili Dhoop', quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1249.0' } },
        image: { url: 'https://cdn.shopify.com/a.jpg', width: 1200, height: 1500 },
        variant: { id: VGID, availableForSale: true, selectedOptions: [{ name: 'Size', value: 'XS' }] },
      }] },
    });
    const out = await sweepAbandonedCarts(clients, NOW);
    // The newer row wins, and it is the Shopify one: it carries a real recover
    // URL that lands them in their own checkout rather than a rebuilt cart.
    expect(out.enqueued).toEqual(['LATER']);
    expect(out.skipped['older-checkout-for-phone']).toBe(1);
  });
});

describe('the capture endpoint refuses anything it cannot vouch for', () => {
  it('takes a real cart token and rejects the rest', () => {
    expect(cleanToken('41d028f2a9cf4b1e')).toBe('41d028f2a9cf4b1e');
    expect(cleanToken('short')).toBeNull();
    expect(cleanToken('has spaces in it')).toBeNull();
  });

  it('takes variant ids and quantities, and refuses a bag it cannot read in full', () => {
    expect(cleanItems([{ id: '54759640170868', qty: 2 }]))
      .toEqual([{ id: 'gid://shopify/ProductVariant/54759640170868', qty: 2 }]);
    expect(cleanItems([{ id: '54759640170868', qty: 1 }, { id: 'nope', qty: 1 }])).toBeNull();
    expect(cleanItems([{ id: '54759640170868', qty: 0 }])).toBeNull();
    expect(cleanItems([])).toBeNull();
  });

  it('keeps COD King attributes and drops a recipient smuggled through them', () => {
    expect(cleanAttrs({ _codkAmountType: 'percentage', _otpVerifiedPhoneNumber: '919999999999', x: 'y' }))
      .toEqual({ _codkAmountType: 'percentage' });
  });
});

describe('the recovery link for a captured cart', () => {
  it('rebuilds the bag with the code on it, because there is no checkout to recover', () => {
    const t = buildTarget({ code: 'MORPAANKHVIP42', cartItems: [{ v: '9', q: 2 }] });
    expect(t).toBe('https://www.morpaankh.in/discount/MORPAANKHVIP42?redirect=%2Fcart%2F9%3A2');
  });

  it('sends them to the shop rather than an empty cart when nothing is left to rebuild', () => {
    expect(buildTarget({ code: 'X', cartItems: [] })).toBe('https://www.morpaankh.in');
  });
});
