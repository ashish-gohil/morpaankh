/*
 * The Delhivery adapter books a real courier movement off a payload nobody has
 * been able to check against a published reference, so the payload itself is
 * the thing under test: what goes on the wire for each leg, and what we make of
 * every answer that is not a clean success.
 *
 * No network. Every test stubs global.fetch and asserts on what was handed to
 * it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config } from '../../config.mjs';
import { delhivery, _internals } from './delhivery.mjs';
import { makeLogistics } from './index.mjs';

/* A spec with every character Delhivery refuses, in the places a real order
 * puts them: a trade name with an ampersand, a house number with a hash. */
const SPEC = {
  ref: 'RPL1234-1R',
  invoiceRef: '#1234',
  customer: {
    name: 'Rhea & Co #7',
    phone: '+91 98123-45678',
    address1: 'Flat #3, Plot 9 & 10, M%G Road',
    address2: 'near the big water tank; behind the temple',
    city: 'New Delhi',
    state: 'Delhi',
    pin: '110 001',
    country: 'India',
  },
  items: [{ sku: 'NOOR-M', name: 'Noor kurta set', qty: 1, unitValueInr: 1249, hsn: '6204' }],
  parcel: { weightGrams: 500, lengthCm: 30, breadthCm: 24, heightCm: 6 },
  mode: 'surface',
  declaredValueInr: 1249,
};

let seen = [];
let realFetch;
const saved = {};

/** Queue of responses; the last one repeats. */
function stub(...responses) {
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    const r = responses[Math.min(seen.length - 1, responses.length - 1)];
    return {
      ok: r.status ? r.status < 300 : true,
      status: r.status || 200,
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
    };
  };
}

const okCreate = (awb = '1234567890123') => ({
  json: { success: true, package_count: 1, packages: [{ status: 'Success', waybill: awb, refnum: SPEC.ref, remarks: [] }] },
});
const refused = (remark) => ({
  json: { success: false, package_count: 0, packages: [{ status: 'Fail', waybill: '', remarks: [remark] }], rmk: '' },
});

/** The shipment document the adapter actually posted. */
function postedShipment(i = 0) {
  const body = new URLSearchParams(seen[i].init.body);
  return JSON.parse(body.get('data')).shipments[0];
}

beforeEach(() => {
  seen = [];
  realFetch = globalThis.fetch;
  saved.dryRun = config.dryRun;
  saved.replaceMode = config.replaceMode;
  saved.pickup = config.delhiveryPickupLocation;
  saved.gstin = config.sellerGstin;
  saved.mode = config.delhiveryShippingMode;
  saved.returnTo = config.replaceReturnTo;
  // Live, so the writes are exercised. Shadow gets its own test.
  config.dryRun = false;
  config.replaceMode = 'live';
  config.delhiveryPickupLocation = 'Morpaankh Studio';
  config.sellerGstin = '24ABCDE1234F1Z5';
  config.delhiveryShippingMode = 'Surface';
  config.replaceReturnTo = { name: '', address1: '', city: '', state: '', pin: '', phone: '' };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  config.dryRun = saved.dryRun;
  config.replaceMode = saved.replaceMode;
  config.delhiveryPickupLocation = saved.pickup;
  config.sellerGstin = saved.gstin;
  config.delhiveryShippingMode = saved.mode;
  config.replaceReturnTo = saved.returnTo;
});

describe('the forward leg is prepaid by construction', () => {
  it('sends Prepaid, a zero COD amount and the configured shipping mode', async () => {
    stub(okCreate());
    const r = await delhivery.createForward({ ...SPEC, ref: 'RPL1234-1F' });

    const sh = postedShipment();
    expect(sh.payment_mode).toBe('Prepaid');
    expect(sh.cod_amount).toBe(0);
    expect(sh.shipping_mode).toBe('Surface');
    expect(sh.seller_gst_tin).toBe('24ABCDE1234F1Z5');
    expect(sh.hsn_code).toBe('6204');
    expect(sh.total_amount).toBe(1249);
    expect(sh.quantity).toBe(1);
    expect(sh.weight).toBe(500);
    expect(sh).toMatchObject({ shipment_length: 30, shipment_width: 24, shipment_height: 6 });
    expect(sh.address_type).toBe('home');
    expect(sh.order_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(r).toMatchObject({ ref: 'RPL1234-1F', awb: '1234567890123', status: 'Success' });
  });

  it('posts form-encoded, not JSON, with the warehouse name beside the shipment', async () => {
    stub(okCreate());
    await delhivery.createForward(SPEC);

    const { url, init } = seen[0];
    expect(url).toContain('/api/cmu/create.json');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Authorization).toMatch(/^Token /);
    expect(init.body.startsWith('format=json&data=')).toBe(true);
    // The JSON must be URL-encoded inside the form value, not raw.
    expect(init.body).not.toContain('{"shipments"');

    const parsed = JSON.parse(new URLSearchParams(init.body).get('data'));
    expect(parsed.pickup_location).toEqual({ name: 'Morpaankh Studio' });
    expect(parsed.shipments).toHaveLength(1);
  });

  it('carries the reference through untouched, because findByRef has to match it', async () => {
    stub(okCreate());
    await delhivery.createForward({ ...SPEC, ref: 'RPL1234-2F' });
    expect(postedShipment().order).toBe('RPL1234-2F');
    expect(postedShipment().seller_inv).toBe('#1234');
  });

  it('omits the return block entirely when no return address is configured', async () => {
    stub(okCreate());
    await delhivery.createForward(SPEC);
    expect(Object.keys(postedShipment()).filter((k) => k.startsWith('return_'))).toEqual([]);
  });

  it('sends the return block when one is configured', async () => {
    config.replaceReturnTo = {
      name: 'Morpaankh Returns',
      address1: 'Shop 4, Ring Road',
      city: 'Surat',
      state: 'Gujarat',
      pin: '395007',
      phone: '9876543210',
    };
    stub(okCreate());
    await delhivery.createForward(SPEC);
    expect(postedShipment()).toMatchObject({
      return_name: 'Morpaankh Returns',
      return_pin: '395007',
      return_phone: '9876543210',
      return_country: 'India',
    });
  });
});

describe('the reverse leg is a pickup from the customer', () => {
  it('sends Pickup, with the customer as the address the rider visits', async () => {
    stub(okCreate('9999000011112'));
    const r = await delhivery.createReverse(SPEC);

    const sh = postedShipment();
    expect(sh.payment_mode).toBe('Pickup');
    expect(sh.pin).toBe('110001');
    expect(sh.city).toBe('New Delhi');
    expect(sh.phone).toBe('9812345678');
    // Not invoicing anyone for a parcel coming back.
    expect(sh.seller_gst_tin).toBeUndefined();
    expect(sh.cod_amount).toBeUndefined();
    // The destination is the warehouse, named once at body level.
    const parsed = JSON.parse(new URLSearchParams(seen[0].init.body).get('data'));
    expect(parsed.pickup_location.name).toBe('Morpaankh Studio');
    expect(r.awb).toBe('9999000011112');
  });

  it('never asks for a pickup: the courier schedules a Pickup shipment itself', async () => {
    stub(okCreate());
    await delhivery.createReverse(SPEC);
    await delhivery.createForward({ ...SPEC, ref: 'RPL1234-1F' });
    expect(seen).toHaveLength(2);
    for (const c of seen) {
      expect(c.url).toContain('/api/cmu/create.json');
      expect(c.url).not.toMatch(/pickup/i);
    }
  });
});

describe('free text is sanitised before it reaches the label', () => {
  it('spells out the characters Delhivery rejects and collapses the gaps', async () => {
    stub(okCreate());
    await delhivery.createReverse(SPEC);
    const sh = postedShipment();
    expect(sh.name).toBe('Rhea and Co No.7');
    expect(sh.add).toBe('Flat No.3, Plot 9 and 10, M G Road, near the big water tank behind the temple');
    for (const v of [sh.name, sh.add, sh.city, sh.products_desc]) {
      expect(v).not.toMatch(/[&#%;\\`]/);
    }
  });

  it('drops whole trailing address segments rather than cutting a landmark in half', () => {
    const long = Array.from({ length: 12 }, (_, i) => `landmark number ${i} on the long road`).join(', ');
    const out = _internals.addressField(long, '');
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out.startsWith('landmark number 0 on the long road')).toBe(true);
    // Every kept segment is whole.
    for (const seg of out.split(', ')) expect(seg).toMatch(/on the long road$/);
  });

  it('leaves non-Latin script alone instead of transliterating it silently', () => {
    expect(_internals.clean('रिया & कंपनी')).toBe('रिया and कंपनी');
  });
});

describe('the phone number is normalised, or the booking is refused', () => {
  for (const [raw, want] of [
    ['+91 98123-45678', '9812345678'],
    ['919812345678', '9812345678'],
    ['09812345678', '9812345678'],
    ['98123 45678', '9812345678'],
  ]) {
    it(`normalises ${raw}`, () => {
      expect(_internals.tenDigit(raw, 'consignee phone')).toBe(want);
    });
  }

  for (const bad of ['12345 67890', '98123456', '+1 415 555 2671', '']) {
    it(`refuses ${bad || '(empty)'} as a permanent validation stop`, () => {
      try {
        _internals.tenDigit(bad, 'consignee phone');
        throw new Error('should have refused');
      } catch (e) {
        expect(e.message).toMatch(/not a 10 digit Indian mobile/);
        expect(e.permanent).toBe(true);
        expect(e.code).toBe('validation');
      }
    });
  }

  it('masks the number in the refusal, because it reaches a log line', () => {
    try {
      _internals.tenDigit('911234567890', 'consignee phone');
    } catch (e) {
      expect(e.message).not.toContain('1234567890');
      expect(e.message).toContain('x');
    }
  });

  it('refuses the booking before sending anything', async () => {
    stub(okCreate());
    await expect(delhivery.createForward({ ...SPEC, customer: { ...SPEC.customer, phone: '12345' } })).rejects.toThrow(
      /not a 10 digit Indian mobile/,
    );
    expect(seen).toHaveLength(0);
  });

  it('refuses when no warehouse is configured, in shadow as well as live', async () => {
    config.delhiveryPickupLocation = '';
    config.replaceMode = 'shadow';
    stub(okCreate());
    await expect(delhivery.createForward(SPEC)).rejects.toThrow(/DELHIVERY_PICKUP_LOCATION/);
    expect(seen).toHaveLength(0);
  });
});

describe('HTTP 200 is not success', () => {
  async function failWith(response) {
    stub(response);
    try {
      await delhivery.createForward(SPEC);
      throw new Error('should have thrown');
    } catch (e) {
      return e;
    }
  }

  it('accepts only success true, a Success package and a waybill', async () => {
    // success true but no waybill: nothing to track, so nothing was booked.
    const e = await failWith({ json: { success: true, packages: [{ status: 'Success', waybill: '', remarks: [] }] } });
    expect(e.permanent).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('surfaces the remark verbatim on a 200 that carries a failure', async () => {
    const e = await failWith(refused('ClientWarehouse matching query does not exist.'));
    expect(e.remark).toBe('ClientWarehouse matching query does not exist.');
    expect(e.code).toBe('validation');
    expect(e.permanent).toBe(true);
    expect(e.duplicate).toBe(false);
  });

  it('flags a duplicate reference so the caller adopts the parcel instead of booking a second', async () => {
    const e = await failWith(refused('Duplicate order id: RPL1234-1F'));
    expect(e.duplicate).toBe(true);
    expect(e.code).toBe('duplicate');
    expect(e.permanent).toBe(true);
    expect(e.remark).toContain('Duplicate order id');
  });

  it('reads a remark that only arrives in rmk', async () => {
    const e = await failWith({ json: { success: false, packages: [{ status: 'Fail' }], rmk: 'Pincode not serviceable' } });
    expect(e.remark).toBe('Pincode not serviceable');
    expect(e.code).toBe('not_serviceable');
    expect(e.permanent).toBe(true);
  });

  it('calls an empty wallet permanent, because only a top up fixes it', async () => {
    const e = await failWith(refused('Insufficient balance in your wallet. Please recharge.'));
    expect(e.code).toBe('wallet');
    expect(e.permanent).toBe(true);
  });

  it('calls a provider internal error transient, and does not retry it blind', async () => {
    const e = await failWith(refused('Internal error, please try again'));
    expect(e.code).toBe('provider_error');
    expect(e.permanent).toBe(false);
    // One attempt only: the request may already have booked a parcel.
    expect(seen).toHaveLength(1);
  });

  it('calls an auth refusal permanent whether it arrives as a remark or a 401', async () => {
    const byRemark = await failWith(refused('Unauthorized access'));
    expect(byRemark.code).toBe('auth');
    expect(byRemark.permanent).toBe(true);

    seen = [];
    const byStatus = await failWith({ status: 401, json: { message: 'Invalid token' } });
    expect(byStatus.code).toBe('auth');
    expect(byStatus.permanent).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('calls a 5xx transient and leaves the outcome unknown', async () => {
    const e = await failWith({ status: 500, json: { rmk: 'server exploded' } });
    expect(e.code).toBe('provider_error');
    expect(e.permanent).toBe(false);
    expect(e.remark).toBe('server exploded');
    expect(e.status).toBe(500);
    // A 500 may have been processed, so withRetry must not send it again.
    expect(seen).toHaveLength(1);
  });
});

describe('serviceability', () => {
  const pinRow = (postal_code) => ({ json: { delivery_codes: [{ postal_code }] } });

  it('reads pickup, pre_paid and is_oda', async () => {
    stub(pinRow({ pin: 110001, pickup: 'Y', pre_paid: 'Y', cod: 'Y', is_oda: 'N', remarks: '' }));
    const s = await delhivery.serviceability('110001');
    expect(s).toMatchObject({ reversePickup: true, prepaidDelivery: true, oda: false });
    expect(s.raw.pin).toBe(110001);
    expect(seen[0].url).toContain('filter_codes=110001');
  });

  it('believes an N', async () => {
    stub(pinRow({ pin: 799001, pickup: 'N', pre_paid: 'Y', is_oda: 'Y', remarks: '' }));
    expect(await delhivery.serviceability('799001')).toMatchObject({
      reversePickup: false,
      prepaidDelivery: true,
      oda: true,
    });
  });

  it('treats an unknown pin (no delivery_codes) as not serviceable', async () => {
    stub({ json: { delivery_codes: [] } });
    expect(await delhivery.serviceability('999999')).toEqual({
      reversePickup: false,
      prepaidDelivery: false,
      oda: false,
      raw: null,
    });
  });

  it('treats an embargo as not serviceable even though the flags still say Y', async () => {
    stub(pinRow({ pin: 190001, pickup: 'Y', pre_paid: 'Y', is_oda: 'N', remarks: 'Embargo till further notice' }));
    const s = await delhivery.serviceability('190001');
    expect(s.reversePickup).toBe(false);
    expect(s.prepaidDelivery).toBe(false);
    expect(s.raw.remarks).toMatch(/Embargo/);
  });
});

describe('a missing quote or label never fails the job', () => {
  it('reads total_amount from the charges array', async () => {
    stub({ json: [{ total_amount: 84.5, charge_DL: 60 }] });
    const q = await delhivery.quote({ fromPin: '110001', toPin: '395007', weightGrams: 500, mode: 'surface', leg: 'forward' });
    expect(q).toEqual({ amountInr: 84.5 });
    expect(seen[0].url).toContain('md=S');
    expect(seen[0].url).toContain('ss=Delivered');
    expect(seen[0].url).toContain('cgm=500');
  });

  it('asks for DTO on the reverse leg and E for express', async () => {
    stub({ json: [{ total_amount: 70 }] });
    await delhivery.quote({ fromPin: '1', toPin: '2', weightGrams: 400, mode: 'express', leg: 'reverse' });
    expect(seen[0].url).toContain('ss=DTO');
    expect(seen[0].url).toContain('md=E');
  });

  it('returns null on a shape it cannot read, rather than throwing', async () => {
    stub({ json: { error: 'no rate for this lane' } });
    expect(await delhivery.quote({ fromPin: '1', toPin: '2', weightGrams: 400 })).toBeNull();
  });

  it('returns null when the charges call fails outright', async () => {
    stub({ status: 400, json: {} });
    expect(await delhivery.quote({ fromPin: '1', toPin: '2', weightGrams: 400 })).toBeNull();
  });

  it('returns the label link when there is one', async () => {
    stub({ json: { packages: [{ pdf_download_link: 'https://delhivery.test/slip.pdf' }] } });
    expect(await delhivery.label('1234567890123')).toEqual({ url: 'https://delhivery.test/slip.pdf' });
  });

  it('returns null when the label comes back without a link, or not at all', async () => {
    stub({ json: { packages: [{}] } });
    expect(await delhivery.label('1234567890123')).toBeNull();
    stub({ status: 400, json: {} });
    expect(await delhivery.label('1234567890123')).toBeNull();
  });
});

describe('findByRef is how an ambiguous booking is recovered', () => {
  it('returns the awb and status for our own reference', async () => {
    stub({ json: { ShipmentData: [{ Shipment: { AWB: '1234567890123', Status: { Status: 'Manifested' } } }] } });
    expect(await delhivery.findByRef('RPL1234-1F')).toEqual({ awb: '1234567890123', status: 'Manifested' });
    expect(seen[0].url).toContain('ref_ids=RPL1234-1F');
  });

  it('returns null when the reference booked nothing', async () => {
    stub({ json: { ShipmentData: [] } });
    expect(await delhivery.findByRef('RPL1234-1F')).toBeNull();
  });
});

describe('cancel answers with a value, refusal included', () => {
  it('cancels before pickup', async () => {
    stub({ json: { status: true, remark: '' } });
    expect(await delhivery.cancel('1234567890123')).toEqual({ ok: true, cancelled: true });
  });

  it('reports a refusal plainly instead of throwing', async () => {
    stub({ json: { status: false, remark: 'Shipment already picked up' } });
    expect(await delhivery.cancel('1234567890123')).toEqual({
      ok: false,
      cancelled: false,
      reason: 'Shipment already picked up',
    });
  });

  it('reports a transport failure the same way', async () => {
    stub({ status: 500, json: { rmk: 'edit api down' } });
    const r = await delhivery.cancel('1234567890123');
    expect(r).toMatchObject({ ok: false, cancelled: false });
    expect(r.reason).toBe('edit api down');
  });
});

describe('shadow mode performs no write at all', () => {
  for (const [mode, dryRun, skipped] of [
    ['shadow', false, 'shadow'],
    ['live', true, 'dry_run'],
    ['off', false, 'shadow'],
  ]) {
    it(`replaceMode=${mode} dryRun=${dryRun} books nothing and describes what it would send`, async () => {
      config.replaceMode = mode;
      config.dryRun = dryRun;
      stub(okCreate());

      const rev = await delhivery.createReverse(SPEC);
      const fwd = await delhivery.createForward({ ...SPEC, ref: 'RPL1234-1F' });
      const can = await delhivery.cancel('1234567890123');

      expect(seen).toHaveLength(0);
      expect(rev).toMatchObject({ ref: 'RPL1234-1R', awb: null, skipped });
      expect(fwd.skipped).toBe(skipped);
      expect(can).toMatchObject({ ok: true, cancelled: false, skipped });
      // The preview needs the real document, so it comes back rather than going
      // to a log line.
      expect(rev.would.path).toBe('/api/cmu/create.json');
      expect(rev.would.body.shipments[0].payment_mode).toBe('Pickup');
      expect(fwd.would.body.shipments[0]).toMatchObject({ payment_mode: 'Prepaid', cod_amount: 0 });
      expect(fwd.would.body.pickup_location.name).toBe('Morpaankh Studio');
    });
  }

  it('still answers reads for real in shadow, because the preview depends on them', async () => {
    config.replaceMode = 'shadow';
    stub({ json: { delivery_codes: [{ postal_code: { pickup: 'Y', pre_paid: 'Y', is_oda: 'N' } }] } });
    expect(await delhivery.serviceability('110001')).toMatchObject({ reversePickup: true });
    expect(seen).toHaveLength(1);
  });
});

describe('the registry keeps the orchestrator provider neutral', () => {
  it('hands back the configured adapter with the frozen surface', () => {
    const l = makeLogistics('delhivery');
    expect(l.name).toBe('delhivery');
    expect(l.capabilities).toEqual({ quote: true, label: true, findByRef: true });
    for (const fn of ['serviceability', 'quote', 'createReverse', 'createForward', 'findByRef', 'label', 'cancel', 'track']) {
      expect(typeof l[fn]).toBe('function');
    }
    // No provider field name may leak out of the adapter file.
    expect(Object.keys(l)).not.toContain('waybill');
  });

  it('throws on a provider nobody implemented, rather than shipping with the wrong courier', () => {
    expect(() => makeLogistics('bluedart')).toThrow(/unknown logistics provider: bluedart/);
    expect(() => makeLogistics('')).toThrow(/unknown logistics provider/);
  });
});
