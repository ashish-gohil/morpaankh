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

  it('treats an exact "RTO" tag (merchant-applied) as a genuine loss', () => {
    const r = classifyOrder({ id: 5014, tags: ['MEDIUM RTO Risk', 'RTO'], fulfillments: [{ displayStatus: 'IN_TRANSIT' }] });
    expect(r.state).toBe(STATES.RTO);
  });

  it('treats the Shiprocket "RTO Initiated via Shiprocket" tag as RTO', () => {
    const r = classifyOrder({ id: 5015, tags: ['HIGH RTO Risk', 'RTO Initiated via Shiprocket'], fulfillments: [{ displayStatus: 'NOT_DELIVERED' }] });
    expect(r.state).toBe(STATES.RTO);
  });

  it('does NOT mistake the "HIGH RTO Risk" score tag for a real RTO', () => {
    const r = classifyOrder({ id: 5016, tags: ['HIGH RTO Risk', '✅ COD-Verified'], netPayment: 1499, fulfillments: [{ displayStatus: 'DELIVERED' }] });
    expect(r.state).toBe(STATES.DELIVERED_PAID); // risk tag ignored; cash decides
  });

  // Merchant policy: a courier "return" note is a customer-requested
  // replacement, NOT a lost sale. It must never force RTO.
  it('does NOT treat a return/replacement note as a loss: in-transit stays IN_TRANSIT', () => {
    const r = classifyOrder({ id: 5009, note: 'In Transit For Return', fulfillments: [{ displayStatus: 'IN_TRANSIT' }] });
    expect(r.state).toBe(STATES.IN_TRANSIT);
    expect(r.state).not.toBe(STATES.RTO);
  });

  it('does NOT demote a paid order because the note mentions a return', () => {
    const r = classifyOrder({
      id: 5010,
      note: 'This shipment has been Returned',
      netPayment: 1799,
      fulfillments: [{ displayStatus: 'DELIVERED' }],
    });
    expect(r.state).toBe(STATES.DELIVERED_PAID);
    expect(r.value).toBe(1799);
  });

  it('a DELIVERED scan with a return note but no cash collected is IN_TRANSIT (not RTO, not paid)', () => {
    const r = classifyOrder({
      id: 5011,
      note: 'This shipment has been Returned',
      netPayment: 0,
      fulfillments: [{ displayStatus: 'DELIVERED' }],
    });
    expect(r.state).toBe(STATES.IN_TRANSIT);
  });

  it('is defensive against a null note and missing fulfillments', () => {
    const r = classifyOrder({ id: 5012, note: null });
    expect(r.state).toBe(STATES.PLACED);
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
    // delivered + cash collected -> paid; the "Returned" note (a replacement) does not demote it
    expect(r.state).toBe(STATES.DELIVERED_PAID);
    expect(r.eventId).toBe('5555');
  });
});
