import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { handler as shopifyHandler } from './shopify.mjs';
import { handler as whatsappHandler } from './whatsapp.mjs';
import { razorpayIngest } from './razorpay.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _drainQueue } from '../queue.mjs';
import { _resetSecrets } from '../secrets.mjs';

const WEBHOOK_SECRET = 'shop-webhook-secret';
const VERIFY_TOKEN = 'verify-tok';

beforeEach(() => {
  _resetMemory();
  _drainQueue();
  _resetSecrets();
  process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.WA_VERIFY_TOKEN = VERIFY_TOKEN;
});

function shopifyEvent(bodyObj, { webhookId = 'wh-1', topic = 'orders/create', secret = WEBHOOK_SECRET } = {}) {
  const body = JSON.stringify(bodyObj);
  const hmac = createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
  return {
    requestContext: { http: { method: 'POST' } },
    isBase64Encoded: false,
    body,
    headers: {
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Topic': topic,
      'X-Shopify-Webhook-Id': webhookId,
    },
  };
}

describe('shopify ingest', () => {
  it('verifies, enqueues one order-grouped item, returns 200', async () => {
    const res = await shopifyHandler(shopifyEvent({ id: 12345 }));
    expect(res.statusCode).toBe(200);
    const q = _drainQueue();
    expect(q).toHaveLength(1);
    expect(q[0].groupId).toBe('order:12345');
    expect(q[0].message).toMatchObject({ kind: 'shopify', topic: 'orders/create', orderId: '12345' });
  });

  it('drops a duplicate webhook id (no second enqueue)', async () => {
    await shopifyHandler(shopifyEvent({ id: 12345 }, { webhookId: 'dup' }));
    _drainQueue();
    const res = await shopifyHandler(shopifyEvent({ id: 12345 }, { webhookId: 'dup' }));
    expect(res.statusCode).toBe(200);
    expect(_drainQueue()).toHaveLength(0);
  });

  it('rejects a bad signature with 401 and enqueues nothing', async () => {
    const res = await shopifyHandler(shopifyEvent({ id: 12345 }, { secret: 'wrong' }));
    expect(res.statusCode).toBe(401);
    expect(_drainQueue()).toHaveLength(0);
  });

  it('maps a fulfillment topic via order_id', async () => {
    const res = await shopifyHandler(
      shopifyEvent({ order_id: 777, id: 999 }, { topic: 'fulfillments/create', webhookId: 'f1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(_drainQueue()[0].groupId).toBe('order:777');
  });
});

describe('whatsapp GET verification', () => {
  it('echoes the challenge for the right verify token', async () => {
    const res = await whatsappHandler({
      requestContext: { http: { method: 'GET' } },
      queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '4242' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('4242');
  });
  it('forbids a wrong verify token', async () => {
    const res = await whatsappHandler({
      requestContext: { http: { method: 'GET' } },
      queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '4242' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('razorpay payment_link.paid carries the real payment id', () => {
  it('uses pay_... not plink_... so a refund can actually succeed', () => {
    const body = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_abc', notes: { shopify_order_id: '123' } } },
        payment: { entity: { id: 'pay_xyz', amount: 104900 } },
      },
    };
    const [item] = razorpayIngest.toItems({ 'x-razorpay-event-id': 'evt_1' }, body);
    expect(item.message.entity.payment_id).toBe('pay_xyz');
    expect(item.message.entity.amount_paid).toBe(104900);
    expect(item.groupId).toBe('order:123');
  });
});
