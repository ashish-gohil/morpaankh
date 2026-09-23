import { describe, it, expect } from 'vitest';
import { whatsapp } from './whatsapp.mjs';
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
