/*
 * Fake logistics: seedable pin answers, quotes and AWBs; records every write.
 *
 * `calls` is the assertion surface, same as the courier fake. A flow test
 * should say "a reverse leg was booked for this ref at this pin", never "the
 * form body was shaped like this": that belongs to the adapter's own test.
 *
 * `fail` injects the real adapter's error shape (remark, permanent, duplicate,
 * code) so the FAILED and adopt-the-duplicate branches of the state machine
 * can be driven without a provider.
 */
export function makeFakeLogistics({
  pins = {},
  quoteInr = 70,
  byRef = {},
  statuses = {},
  labelUrl = 'https://fake.delhivery/label.pdf',
  fail = {},
  cancelRefusal = '',
} = {}) {
  const calls = [];
  const refs = new Map(Object.entries(byRef)); // ref -> { awb, status }
  const state = new Map(Object.entries(statuses)); // awb -> { status, ... }
  let seq = 0;

  /** Throw the shape the Delhivery adapter throws, so branches are real. */
  function maybeFail(op) {
    const f = fail[op];
    if (!f) return;
    const e = /** @type {any} */ (new Error(f.message || `fake logistics ${op} refused: ${f.remark || 'nope'}`));
    e.remark = f.remark || '';
    e.code = f.code || (f.duplicate ? 'duplicate' : 'validation');
    e.duplicate = !!f.duplicate;
    e.permanent = f.permanent !== false;
    throw e;
  }

  async function book(op, spec) {
    calls.push({ op, ref: spec?.ref, pin: spec?.customer?.pin, mode: spec?.mode, spec });
    maybeFail(op);
    seq += 1;
    const awb = `FAKEAWB${seq}`;
    refs.set(spec?.ref, { awb, status: 'Manifested' });
    state.set(awb, { status: 'Manifested', statusType: 'UD' });
    return { ref: spec?.ref, awb, status: 'Manifested' };
  }

  return {
    name: 'fake',
    capabilities: { quote: true, label: true, findByRef: true },
    calls,
    refs,
    state,
    setStatus(awb, s) {
      state.set(awb, s);
    },

    async serviceability(pin) {
      const seeded = pins[String(pin)];
      // Unseeded pins are serviceable: a test that cares says so explicitly.
      const pc = seeded || { reversePickup: true, prepaidDelivery: true, oda: false };
      return { reversePickup: !!pc.reversePickup, prepaidDelivery: !!pc.prepaidDelivery, oda: !!pc.oda, raw: pc };
    },

    // No throwing seam here: the real adapter answers a failed quote with null,
    // so `quoteInr: null` is the only way a quote can go wrong.
    async quote() {
      return quoteInr == null ? null : { amountInr: quoteInr };
    },

    createReverse: (spec) => book('createReverse', spec),
    createForward: (spec) => book('createForward', spec),

    async findByRef(ref) {
      return refs.get(ref) || null;
    },

    async label(awb) {
      return labelUrl ? { url: labelUrl } : null;
    },

    async cancel(awb) {
      calls.push({ op: 'cancel', awb });
      if (cancelRefusal) return { ok: false, cancelled: false, reason: cancelRefusal };
      return { ok: true, cancelled: true };
    },

    async track(awbs) {
      return (Array.isArray(awbs) ? awbs : [awbs]).map((awb) => ({
        awb,
        ...(state.get(awb) || { status: 'UNKNOWN' }),
      }));
    },
  };
}
