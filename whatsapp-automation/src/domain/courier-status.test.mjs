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

/*
 * Every case below is a VERBATIM scan from order #1165, pulled from Delhivery
 * on 2026-10-16. That parcel went out for delivery, was refused at the door,
 * and came back as an RTO without the customer ever being asked a thing,
 * because NDR was unreachable: the mapper was reading Shipment.NSLCode, which
 * this API does not return, and nothing else carried the outcome.
 */
describe('a failed delivery attempt, from the real payloads', () => {
  const scan = (status, statusType, statusCode) => mapCourierStatus({ status, statusType, statusCode });

  it('reads the refusal at the door as NDR', () => {
    // {"Instructions":"Code verified cancellation","Scan":"Pending","ScanType":"UD","StatusCode":"EOD-6O"}
    expect(scan('Pending', 'UD', 'EOD-6O')).toBe('NDR');
  });

  it('is what the old mapper got wrong: the same scan used to read as PENDING', () => {
    // Without the code there is nothing to distinguish it from a hub scan, and
    // PENDING has no branch in onDelhivery, so the event died there.
    expect(scan('Pending', 'UD', undefined)).toBe('PENDING');
  });

  it('leaves every movement scan on that parcel alone', () => {
    expect(scan('Manifested', 'UD', 'X-UCI')).toBe('MANIFESTED');
    expect(scan('In Transit', 'UD', 'X-PPOM')).toBe('IN_TRANSIT');
    expect(scan('In Transit', 'UD', 'X-IBD3F')).toBe('IN_TRANSIT');
    expect(scan('In Transit', 'UD', 'X-OLL2F')).toBe('IN_TRANSIT');
    expect(scan('Pending', 'UD', 'X-IBD3F')).toBe('PENDING');
    expect(scan('Dispatched', 'UD', 'X-DDD3FD')).toBe('OUT_FOR_DELIVERY');
  });

  it('does not read our own warehouse being shut as the customer refusing', () => {
    // EOD-148 "Recipient unavailable.Establishment closed" is on the RETURN
    // leg: the courier could not hand the parcel back to US. Reading it as an
    // NDR would ask the customer to rescue a delivery that is not happening to
    // them, so the RT test above has to keep claiming it first.
    expect(scan('Pending', 'RT', 'EOD-148')).toBe('RTO_INITIATED');
    expect(scan('Dispatched', 'RT', 'X-DDD3FD')).toBe('RTO_INITIATED');
    expect(scan('In Transit', 'RT', 'RT-108')).toBe('RTO_INITIATED');
  });

  it('keeps the delivered and return-accepted dispositions out of NDR', () => {
    expect(scan('Delivered', 'DL', 'EOD-38')).toBe('DELIVERED');
    expect(scan('RTO', 'DL', 'RD-AC')).toBe('RTO_INITIATED');
    // A contradictory UD payload for the delivered code must not ask someone
    // to rescue a parcel they are holding.
    expect(scan('Delivered', 'UD', 'EOD-38')).toBe('DELIVERED');
  });

  it('does not treat the UD umbrella on its own as a failed delivery', () => {
    // 'UD' is on every in-transit scan above. Mapping the umbrella would have
    // messaged every customer with a parcel in motion.
    for (const code of ['', undefined, 'X-UCI', 'X-DDD3FD', 'CS-CSL']) {
      expect(scan('In Transit', 'UD', code)).not.toBe('NDR');
    }
  });
});
