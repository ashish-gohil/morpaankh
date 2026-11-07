import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { handler as shopifyHandler } from './shopify.mjs';
import { handler as whatsappHandler } from './whatsapp.mjs';
import { razorpayIngest } from './razorpay.mjs';
import { whatsappIngest } from './whatsapp.mjs';
import { delhiveryIngest } from './delhivery.mjs';
import { setAwbMap } from '../store/maps.mjs';
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

/*
 * Meta announces a template rejection, pause or quality disable through this
 * same webhook. The ingest only read `messages` and `statuses`, so every one of
 * those was acked and dropped, and a paused template became a silent outage.
 */
describe('whatsapp ingest: template status changes', () => {
  const body = (event, name = 'order_shipped_v1', reason = null) => ({
    entry: [
      {
        time: 1790000000,
        changes: [
          {
            field: 'message_template_status_update',
            value: { event, message_template_name: name, message_template_language: 'en', reason },
          },
        ],
      },
    ],
  });

  it('turns a PAUSED notice into a message for the worker', () => {
    const items = whatsappIngest.toItems({}, body('PAUSED', 'order_shipped_v1', 'QUALITY'));
    expect(items).toHaveLength(1);
    expect(items[0].message).toMatchObject({
      kind: 'wa_template_status',
      name: 'order_shipped_v1',
      event: 'PAUSED',
      reason: 'QUALITY',
    });
  });

  it('dedupes on name plus event', () => {
    const a = whatsappIngest.toItems({}, body('REJECTED'))[0];
    const b = whatsappIngest.toItems({}, body('REJECTED'))[0];
    expect(a.dedupId).toBe(b.dedupId);
    expect(whatsappIngest.toItems({}, body('APPROVED'))[0].dedupId).not.toBe(a.dedupId);
  });

  it('still reads messages and statuses from the same payload', () => {
    const mixed = {
      entry: [
        {
          time: 1790000000,
          changes: [
            { field: 'messages', value: { messages: [{ id: 'wamid.1', from: '919812345678', type: 'text', text: { body: 'hi' } }] } },
            { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: 'cod_confirm_v2' } },
          ],
        },
      ],
    };
    const kinds = whatsappIngest.toItems({}, mixed).map((i) => i.message.kind);
    expect(kinds).toEqual(['wa_inbound', 'wa_template_status']);
  });
});

/*
 * F27. The FIFO queue serialises by GROUP, and every other handler for an order
 * uses `order:<id>`. The Delhivery push used `awb:<awb>`, so a DELIVERED push
 * and the orders/updated for the same order sat in different groups and could
 * run at once: both read the state row, both write it, and the loser's write is
 * lost. That is the shape that erases a conversion stamp or a review schedule.
 *
 * It has never bitten because Delhivery has not enabled the push for this
 * account. This is the thing to have fixed BEFORE it is switched on.
 */
describe('the Delhivery push shares the order s queue group', () => {
  const push = (awb) => ({
    Shipments: [{ AWB: awb, Status: { Status: 'Delivered', StatusType: 'DL', StatusDateTime: '2026-11-06T10:00:00' } }],
  });

  it('groups by order when the waybill is known', async () => {
    await setAwbMap('AWB77', '12345');
    const items = await delhiveryIngest.toItems({}, push('AWB77'));
    expect(items).toHaveLength(1);
    expect(items[0].groupId).toBe('order:12345');
    // The dedup id is unchanged: AWB + status + time is still the event's identity.
    expect(items[0].dedupId).toBe('dl-AWB77-Delivered-2026-11-06T10:00:00');
  });

  it('falls back to the waybill rather than losing an unmapped event', async () => {
    const items = await delhiveryIngest.toItems({}, push('AWB-UNKNOWN'));
    expect(items[0].groupId).toBe('awb:AWB-UNKNOWN');
  });

  it('skips a shipment with no waybill at all', async () => {
    const items = await delhiveryIngest.toItems({}, { Shipments: [{ Status: { Status: 'Delivered' } }] });
    expect(items).toEqual([]);
  });
});
