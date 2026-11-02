import { describe, it, expect } from 'vitest';
import { whatsapp } from './whatsapp.mjs';
import { shopify } from './shopify.mjs';
import { config } from '../config.mjs';
import { makeFakeClients } from './fakes/index.mjs';

describe('real whatsapp client is safe by default (DRY_RUN)', () => {
  it('skips the send instead of calling Meta', async () => {
    const r = await whatsapp.sendText({ to: '+919812345678', body: 'hello' });
    expect(r.skipped).toBe('dry_run');
    expect(r.messageId).toContain('dry');
  });
});

describe('fake clients record calls for flow tests', () => {
  it('whatsapp fake returns ids and records sends', async () => {
    const c = makeFakeClients();
    await c.whatsapp.sendButtons({ to: '+91x', body: 'confirm?', buttons: [{ id: 'v1|A|1|confirm', title: 'Confirm order' }] });
    expect(c.whatsapp.sent).toHaveLength(1);
    expect(c.whatsapp.sent[0].type).toBe('buttons');
  });

  it('shopify fake seeds + returns orders and records tags', async () => {
    const c = makeFakeClients({ shopify: { orders: {} } });
    c.shopify.seed({ id: '555', name: '#555', tags: [] });
    expect(await c.shopify.getOrder('555')).toMatchObject({ name: '#555' });
    await c.shopify.tagsAdd('gid://shopify/Order/555', ['wa-cod-sent']);
    expect(c.shopify.calls.find((x) => x.op === 'tagsAdd').tags).toContain('wa-cod-sent');
  });

  it('razorpay + courier fakes record', async () => {
    const c = makeFakeClients({ courier: { statuses: { AWB1: { status: 'IN_TRANSIT' } } } });
    const link = await c.razorpay.createLink({ amountPaise: 100000, referenceId: '555-P1' });
    expect(link.shortUrl).toContain('rzp.fake');
    const [t] = await c.courier.track(['AWB1']);
    expect(t.status).toBe('IN_TRANSIT');
    await c.courier.editToPrepaid('AWB1');
    expect(c.courier.calls[0]).toMatchObject({ op: 'editToPrepaid', awb: 'AWB1' });
  });
});

describe('real clients ride out a transient provider failure', () => {
  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fail = (status) => ({ ok: false, status, json: async () => ({ error: { message: 'nope' } }), text: async () => '{}' });

  it('retries a Shopify read through a 503 and returns the data', async () => {
    const { shopify } = await import('./shopify.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1 ? fail(503) : okJson({ data: { order: { id: 'gid://shopify/Order/1', name: '#1' } } });
    };
    const order = await shopify.getOrder('1');
    expect(calls).toBe(2);
    expect(order.name).toBe('#1');
    globalThis.fetch = real;
  });

  it('gives up on a Shopify 401 without retrying, because it will never succeed', async () => {
    const { shopify } = await import('./shopify.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return fail(401); };
    await expect(shopify.getOrder('1')).rejects.toThrow();
    expect(calls).toBe(1);
    globalThis.fetch = real;
  });

  it('treats a Shopify THROTTLED answer as a rate limit even though it arrives as HTTP 200', async () => {
    const { shopify } = await import('./shopify.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? okJson({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] })
        : okJson({ data: { order: { id: 'x', name: '#2' } } });
    };
    const order = await shopify.getOrder('1');
    expect(calls).toBe(2);
    expect(order.name).toBe('#2');
    globalThis.fetch = real;
  });
});

/*
 * Regression: closing a Razorpay payment link.
 *
 * Every successful prepaid conversion ends by cancelling the link, and by then
 * the link IS paid, so Razorpay refuses. That refusal was logged at ERROR,
 * counted as a SoftFailure and pushed through the error reporter, which emailed
 * AND WhatsApped the owner on the happy path. Live logs 23-24 Sept.
 */
describe('razorpay cancelLink is idempotent about a link that is already closed', () => {
  const refuse = (description) => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { description } }),
    text: async () => '{}',
  });

  async function cancelWith(response) {
    const { config } = await import('../config.mjs');
    const { razorpay } = await import('./razorpay.mjs');
    const realFetch = globalThis.fetch;
    const realDry = config.dryRun;
    config.dryRun = false;
    globalThis.fetch = async () => response;
    try {
      return await razorpay.cancelLink('plink_TfKl4KKqyc4wS5');
    } finally {
      globalThis.fetch = realFetch;
      config.dryRun = realDry;
    }
  }

  it('treats an already paid link as closed, not as a failure', async () => {
    const r = await cancelWith(refuse('cannot cancel or expire an already paid / partially paid link'));
    expect(r).toMatchObject({ ok: true, alreadyClosed: true });
  });

  it('treats an already cancelled link as closed', async () => {
    const r = await cancelWith(refuse('cannot cancel or expire a cancelled link'));
    expect(r).toMatchObject({ ok: true, alreadyClosed: true });
  });

  it('still throws on a refusal that is NOT a terminal link state', async () => {
    await expect(cancelWith(refuse('The api key provided is invalid'))).rejects.toThrow(/invalid/);
  });
})

/*
 * convertToPrepaid had no test of any kind, and it is the one place real money
 * moves. It reads calculatedOrder.lineItems itself, so the normalizeOrder fix
 * does not reach it.
 */
describe('convertToPrepaid never discounts a line the customer no longer has', () => {
  it('skips the removed line even when it ties on price and sorts first', async () => {
    // Order #1182's shape: XS removed, 2XL added, same product, same price. The
    // removed line keeps its original price and comes back first, so the
    // top-priced pick put the prepaid discount on the garment being returned to
    // stock, leaving the customer's actual line at full price.
    const realFetch = globalThis.fetch;
    const prevDry = config.dryRun;
    const prevVerified = process.env.CONVERSION_VERIFIED;
    config.dryRun = false;
    process.env.CONVERSION_VERIFIED = 'true';

    const seen = [];
    const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) });
    globalThis.fetch = async (_url, init) => {
      const { query, variables } = JSON.parse(init.body);
      seen.push({ query, variables });
      if (query.includes('orderEditBegin')) {
        return reply({ orderEditBegin: {
          calculatedOrder: {
            id: 'gid://shopify/CalculatedOrder/1',
            lineItems: { nodes: [
              { id: 'gid://CalculatedLineItem/REMOVED', quantity: 0, originalUnitPriceSet: { shopMoney: { amount: '1249.00' } } },
              { id: 'gid://CalculatedLineItem/KEPT', quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '1249.00' } } },
            ] },
            shippingLines: [],
          },
          userErrors: [],
        } });
      }
      if (query.includes('orderEditAddLineItemDiscount')) return reply({ orderEditAddLineItemDiscount: { userErrors: [] } });
      if (query.includes('orderEditCommit')) {
        return reply({ orderEditCommit: {
          order: { id: 'gid://shopify/Order/1', totalOutstandingSet: { shopMoney: { amount: '1149.00' } } },
          userErrors: [],
        } });
      }
      if (query.includes('orderMarkAsPaid')) {
        return reply({ orderMarkAsPaid: {
          order: { id: 'gid://shopify/Order/1', displayFinancialStatus: 'PAID', netPaymentSet: { shopMoney: { amount: '1149.00' } } },
          userErrors: [],
        } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 70)}`);
    };

    try {
      const r = await shopify.convertToPrepaid({
        order: { gid: 'gid://shopify/Order/1', numericId: '1' },
        amounts: { discountPaise: 10000, codFeePaise: 5000, newTotalPaise: 114900 },
        paymentId: 'pay_X',
      });
      expect(r.applied).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      config.dryRun = prevDry;
      if (prevVerified === undefined) delete process.env.CONVERSION_VERIFIED;
      else process.env.CONVERSION_VERIFIED = prevVerified;
    }

    const disc = seen.find((c) => c.query.includes('orderEditAddLineItemDiscount'));
    expect(disc).toBeTruthy();
    expect(disc.variables.lineItemId).toBe('gid://CalculatedLineItem/KEPT');
  });
});

/*
 * A JS COMMENT INSIDE A GRAPHQL DOCUMENT IS A SYNTAX ERROR, and nothing in
 * this suite would notice: the fakes never parse a query string, so the
 * document is only ever read by Shopify.
 *
 * Shipped exactly that on 2026-11-02. A `/* *\/` block was added inside
 * CHECKOUT_FIELDS to explain why the contact fields are selected; the Admin
 * API answered HTTP 200 with `PARSE_ERROR ... unexpected invalid token ("/")`,
 * listAbandonedCheckouts threw, and the whole five minute cart sweep went down
 * until the live logs showed it. Comments inside a document are `#`.
 */
describe('the GraphQL documents are documents, not JavaScript', () => {
  it('no query or mutation string carries a JS comment block', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./shopify.mjs', import.meta.url), 'utf8');
    // Every backtick-delimited literal in the file, then only the ones that
    // are GraphQL. Interpolations are left in place: a comment inside one of
    // those constants still shows up in the constant's own literal.
    const literals = src.match(/`[^`]*`/g) || [];
    const documents = literals.filter((l) => /\b(query|mutation|fragment)\b/.test(l) || /\{\s*\w+\s*\{/.test(l));
    expect(documents.length).toBeGreaterThan(5); // the regex still finds them
    const offenders = documents.filter((d) => d.includes('/*') || d.includes('*/'));
    expect(offenders.map((d) => d.slice(0, 120))).toEqual([]);
  });
});
