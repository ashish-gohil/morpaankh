import { describe, it, expect } from 'vitest';
import { classifyOrder, normaliseFromGraphql, STATES } from './classify.mjs';

describe('classifyOrder', () => {
  it('classifies a freshly placed COD order as PLACED', () => {
    const r = classifyOrder({ id: 5001, note: '', tags: ['LOW RTO Risk'], netPayment: 0, fulfillments: [] });
    expect(r.state).toBe(STATES.PLACED);
    expect(r.eventId).toBe('5001');
    expect(r.value).toBe(0);
    expect(r.currency).toBe('INR');
  });

  it('classifies a cancelled-on-call order (Shopify cancelledAt) as CANCELLED_ON_CALL', () => {
    const r = classifyOrder({ id: 5002, cancelledAt: '2026-08-20T10:00:00Z', note: '', fulfillments: [] });
    expect(r.state).toBe(STATES.CANCELLED_ON_CALL);
  });

  it('classifies the COD-Cancelled tag (no cancelledAt) as CANCELLED_ON_CALL', () => {
    const r = classifyOrder({ id: 5003, tags: ['COD-Cancelled'], note: '', fulfillments: [] });
    expect(r.state).toBe(STATES.CANCELLED_ON_CALL);
  });

  it('reads tags as a REST comma string too', () => {
    const r = classifyOrder({ id: 5004, tags: 'MEDIUM RTO Risk, COD-Cancelled', note: '', fulfillments: [] });
    expect(r.state).toBe(STATES.CANCELLED_ON_CALL);
  });

  it('classifies a dispatched, in-transit order as IN_TRANSIT', () => {
    const r = classifyOrder({ id: 5005, note: 'Shipment picked up', fulfillments: [{ displayStatus: 'IN_TRANSIT' }] });
    expect(r.state).toBe(STATES.IN_TRANSIT);
  });

  it('classifies DELIVERED with net payment > 0 as DELIVERED_PAID and carries the collected value', () => {
    const r = classifyOrder({ id: 5006, note: 'Delivered', netPayment: 1499, fulfillments: [{ displayStatus: 'DELIVERED' }] });
    expect(r.state).toBe(STATES.DELIVERED_PAID);
    expect(r.value).toBe(1499);
    expect(r.eventId).toBe('5006');
  });

  it('does NOT mark a DELIVERED scan with zero collected as DELIVERED_PAID (COD not reconciled)', () => {
    const r = classifyOrder({ id: 5007, note: 'Delivered', netPayment: 0, fulfillments: [{ displayStatus: 'DELIVERED' }] });
    expect(r.state).toBe(STATES.IN_TRANSIT);
  });

  it('classifies ATTEMPTED_DELIVERY as RTO', () => {
    const r = classifyOrder({ id: 5008, note: '', fulfillments: [{ displayStatus: 'ATTEMPTED_DELIVERY' }] });
    expect(r.state).toBe(STATES.RTO);
  });

  it('classifies an in-transit-for-return note as RTO', () => {
    const r = classifyOrder({ id: 5009, note: 'In Transit For Return', fulfillments: [{ displayStatus: 'IN_TRANSIT' }] });
    expect(r.state).toBe(STATES.RTO);
  });

  // The case the merchant explicitly flagged: DELIVERED in Shopify, but the
  // courier note says it was returned. Must be RTO, never DELIVERED_PAID.
  it('classifies DELIVERED-in-Shopify-but-note-says-returned as RTO, not DELIVERED_PAID', () => {
    const r = classifyOrder({
      id: 5010,
      note: 'This shipment has been Returned',
      netPayment: 1799,
      fulfillments: [{ displayStatus: 'DELIVERED' }],
    });
    expect(r.state).toBe(STATES.RTO);
    expect(r.state).not.toBe(STATES.DELIVERED_PAID);
  });

  it('RTO wins even if the order was later cancelled/restocked', () => {
    const r = classifyOrder({
      id: 5011,
      cancelledAt: '2026-08-29T12:00:00Z',
      note: 'Shipment has been Returned to origin',
      fulfillments: [{ displayStatus: 'DELIVERED' }],
    });
    expect(r.state).toBe(STATES.RTO);
  });

  it('is defensive against a null note and missing fulfillments', () => {
    const r = classifyOrder({ id: 5012, note: null });
    expect(r.state).toBe(STATES.PLACED);
  });

  it('honours a custom return regex from config', () => {
    const r = classifyOrder(
      { id: 5013, note: 'parcel undelivered - RTO initiated', fulfillments: [{ displayStatus: 'IN_TRANSIT' }] },
      { returnRegex: /rto initiated/i },
    );
    expect(r.state).toBe(STATES.RTO);
  });

  it('eventId is always the numeric order id as a string', () => {
    expect(classifyOrder({ id: 987654321 }).eventId).toBe('987654321');
  });
});

describe('normaliseFromGraphql', () => {
  it('flattens a GraphQL order into the classifier shape', () => {
    const gql = {
      id: 'gid://shopify/Order/5555',
      cancelledAt: null,
      tags: ['HIGH RTO Risk'],
      note: 'This shipment has been Returned',
      currencyCode: 'INR',
      netPaymentSet: { shopMoney: { amount: '2100.00', currencyCode: 'INR' } },
      fulfillments: [{ displayStatus: 'DELIVERED' }],
    };
    const n = normaliseFromGraphql(gql);
    expect(n.id).toBe('5555');
    expect(n.netPayment).toBe(2100);
    const r = classifyOrder(n);
    expect(r.state).toBe(STATES.RTO); // delivered + returned note -> RTO
    expect(r.eventId).toBe('5555');
  });
});
