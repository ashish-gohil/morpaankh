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
