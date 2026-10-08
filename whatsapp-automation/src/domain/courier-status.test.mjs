/*
 * courier-status.test.mjs — this mapper had NO test of any kind, and it is what
 * decides whether a customer is told their parcel arrived. onDelhivery routes
 * its DELIVERED straight into flowB.onDelivered.
 */
import { describe, it, expect } from 'vitest';
import { mapCourierStatus, isCourierEditable, isBeforePickup } from './courier-status.mjs';

const map = (status, statusType) => mapCourierStatus({ status, statusType });

describe('a return that reaches the seller is never a delivery', () => {
  /*
   * Delhivery reports an RTO that gets back to the warehouse as a DELIVERY:
   * StatusType 'DL' with an RTO Status string. The old code tested DL first, so
   * this returned DELIVERED. Orders #1097, #1103 and #1133 each went
   * RTO_INITIATED and were then overwritten to DELIVERED in production, which
   * is only reachable that way.
   */
  it('maps StatusType DL with an RTO status as RTO_DELIVERED, not DELIVERED', () => {
    expect(map('RTO Delivered', 'DL')).toBe('RTO_DELIVERED');
    expect(map('RTO Received', 'DL')).toBe('RTO_DELIVERED');
  });

  it('maps the same thing under StatusType RT too', () => {
    expect(map('RTO Delivered', 'RT')).toBe('RTO_DELIVERED');
  });

  it('treats an RTO still on its way back as RTO_INITIATED', () => {
    expect(map('RTO In Transit', 'RT')).toBe('RTO_INITIATED');
    expect(map('RTO Initiated', 'UD')).toBe('RTO_INITIATED');
    expect(map('In Transit', 'RT')).toBe('RTO_INITIATED');
  });

  it('never reports a state that onDelhivery would turn into a review ask', () => {
    // onDelhivery: `if (state === 'DELIVERED') return flowB.onDelivered(...)`.
    for (const [status, type] of [['RTO Delivered', 'DL'], ['RTO Delivered', 'RT'], ['RTO In Transit', 'RT']]) {
      expect(map(status, type)).not.toBe('DELIVERED');
    }
  });
});

describe('a FAILED delivery is never a delivery either', () => {
  /*
   * 'undelivered' and 'not delivered' both contain the substring 'delivered',
   * so the old bare /delivered/ test matched them and the NDR branch below it
   * was unreachable for the exact two strings it existed for. flowC.onNdr
   * could therefore never fire from the courier path, which is why Flow C had
   * never messaged a customer, and why 53 stored states held zero NDR while
   * three orders went all the way to RTO.
   */
  it('maps the two obvious NDR strings to NDR, not DELIVERED', () => {
    expect(map('Undelivered', 'UD')).toBe('NDR');
    expect(map('Not Delivered', 'UD')).toBe('NDR');
  });

  it('maps the other failure wordings to NDR as well', () => {
    expect(map('Delivery Failed', 'UD')).toBe('NDR');
    expect(map('No Attempt', 'UD')).toBe('NDR');
  });

  it('reads an undelivered status as NDR even if the type claims DL', () => {
    // Contradictory payload. The status string is specific and DL is an
    // umbrella, and NDR opens a helpful conversation where DELIVERED would ask
    // for a review of a parcel that never arrived.
    expect(map('Undelivered', 'DL')).toBe('NDR');
  });
});

describe('a genuine delivery still maps as before', () => {
  it('honours StatusType DL', () => {
    expect(map('Delivered', 'DL')).toBe('DELIVERED');
  });
  it('honours the status string when the type is the UD umbrella', () => {
    expect(map('Delivered', 'UD')).toBe('DELIVERED');
  });
});

describe('the rest of the mapping is unchanged', () => {
  it('reads the status string, because UD covers transit, OFD and NDR alike', () => {
    expect(map('Manifested', 'UD')).toBe('MANIFESTED');
    expect(map('Out for Delivery', 'UD')).toBe('OUT_FOR_DELIVERY');
    expect(map('Dispatched', 'UD')).toBe('OUT_FOR_DELIVERY');
    expect(map('Picked Up', 'UD')).toBe('PICKED_UP');
    expect(map('In Transit', 'UD')).toBe('IN_TRANSIT');
    expect(map('Pending', 'UD')).toBe('PENDING');
    expect(map('Lost', 'UD')).toBe('LOST');
    expect(map('Canceled', 'UD')).toBe('CANCELLED');
  });

  it('says UNKNOWN rather than guessing at an unrecognised status', () => {
    expect(map('Something New', 'XX')).toBe('UNKNOWN');
    expect(mapCourierStatus()).toBe('UNKNOWN');
    expect(mapCourierStatus({})).toBe('UNKNOWN');
  });

  it('keeps the cancel and convert window to before the courier has it', () => {
    expect(isBeforePickup('MANIFESTED')).toBe(true);
    for (const s of ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_DELIVERED']) {
      expect(isBeforePickup(s)).toBe(false);
    }
    expect(isCourierEditable('MANIFESTED')).toBe(true);
    expect(isCourierEditable('OUT_FOR_DELIVERY')).toBe(false);
    expect(isCourierEditable('RTO_DELIVERED')).toBe(false);
  });
});
