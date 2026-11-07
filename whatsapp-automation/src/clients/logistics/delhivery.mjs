/*
 * clients/logistics/delhivery.mjs: the Delhivery adapter behind the neutral
 * logistics interface used by /replace (DECISIONS T6).
 *
 * Everything Delhivery-shaped lives in this file: endpoint paths, the
 * form-encoded create body, the `payment_mode` vocabulary, the Y/N pin-code
 * answers, the remark strings. What leaves this file is provider-neutral, so a
 * second courier is a second file next to this one and nothing else.
 *
 * Nothing here is verified against the live API. Delhivery publishes no
 * reference for /api/cmu/create.json (their help pages document the dashboard
 * only), so every field name below is an educated guess at a document that
 * books a real courier movement and prints a GST label. That is precisely why
 * REPLACE_MODE defaults to shadow: the whole path runs and the two writes are
 * described instead of sent until one live booking confirms the names.
 *
 * Reads (serviceability, quote, findByRef, label, track) are safe and run for
 * real in shadow, because knowing a pin is not serviceable BEFORE the owner
 * taps Confirm is the entire value of the preview.
 */
import { config } from '../../config.mjs';
import { deadline, TIMEOUT_MS } from '../../lib/timeout.mjs';
import { getSecrets } from '../../secrets.mjs';
import { log, metric, maskPhone } from '../../log.mjs';
import { withRetry } from '../../lib/resilience.mjs';
import { courier } from '../courier.mjs';

/*
 * Read the staging switch exactly the way courier.mjs reads it, straight from
 * process.env rather than config. One variable has to move both clients at
 * once: a staging test where this adapter books on staging and courier.track
 * polls production would look like a shipment that vanished.
 */
const BASE = () =>
  process.env.DELHIVERY_STAGING === 'true' ? 'https://staging-express.delhivery.com' : 'https://track.delhivery.com';

const CREATE_PATH = '/api/cmu/create.json';
const EDIT_PATH = '/api/p/edit';
const TRACK_PATH = '/api/v1/packages/json/';
const PIN_PATH = '/c/api/pin-codes/json/';
const CHARGES_PATH = '/api/kinko/v1/invoice/charges/.json';
const SLIP_PATH = '/api/p/packing_slip';

// Field lengths are unverified too. These are the limits Delhivery's own
// dashboard enforces on the manual booking form, which is the closest thing to
// a published spec that exists.
const MAX = { name: 100, add: 255, desc: 255 };

/**
 * One HTTP call, same conventions as courier.mjs req(): withRetry, a
 * dimensionless CourierError metric on a non-2xx so it feeds the existing
 * wa-courier-failures alarm, and a plain Error carrying .status.
 *
 * It takes `form` as well as `body` because create.json is the only
 * form-encoded endpoint in the account and req() in courier.mjs only speaks
 * JSON, with three live callers depending on that.
 */
async function call(method, path, { body, form, idempotent = false } = {}) {
  const s = await getSecrets();
  /** @type {Record<string,string>} */
  const headers = { Authorization: `Token ${s.delhiveryToken}` };
  let payload;
  if (form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  /*
   * A fixed label per operation, not the path. See labelFor in
   * clients/courier.mjs: a path in a metric label opens a CloudWatch series
   * per distinct path, and these carry waybills and ids.
   */
  const label = `delhivery.${String(path).split('?')[0].split('/').filter(Boolean).slice(-2).join('/') || 'call'}`;
  return withRetry(label, async () => {
    // Booking a parcel is never retried, so it gets the longer deadline.
    const res = await fetch(`${BASE()}${path}`, { method, headers, body: payload, ...deadline(TIMEOUT_MS.delhiveryWrite) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /*
       * /api/p/edit ANSWERS XML, AND IT ANSWERS HTTP 200 WHEN IT REFUSES.
       * Observed against production on 2026-10-27 with this adapter's own
       * cancel body for an impossible waybill:
       *
       *   200 <root><error>Incorrect Waybill/OrderID, please try again</error>
       *       <status>Failure</status>...</root>
       *
       * This was `res.json().catch(() => ({}))`, so that body became {} and
       * cancel()'s refusal test, which reads json.status === false and
       * json.remark, saw nothing to refuse and reported the parcel cancelled.
       * In /replace that is the call that undoes a mis-booked leg, so the owner
       * was told a parcel had been pulled back while it kept moving.
       *
       * Normalised to the JSON shape the callers already expect, so their
       * refusal handling is left exactly as it was.
       */
      const tag = (name) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1]?.trim();
      const st = tag('status');
      const remark = tag('error') || tag('remark') || '';
      json = { status: st ? !/fail/i.test(st) : !remark, remark, raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      metric('CourierError', 1);
      const e = /** @type {any} */ (new Error(`delhivery ${method} ${path} failed: ${JSON.stringify(json).slice(0, 200)}`));
      e.status = res.status;
      e.body = json;
      throw e;
    }
    return json;
  }, { idempotent });
}

/* ---------------------------------------------------------------- failures */

/*
 * The orchestrator branches on three things and never on a message string:
 *   err.permanent  retrying will fail the same way, so stop and tell the owner.
 *   err.duplicate  this reference is already booked, so findByRef and adopt it
 *                  instead of retrying, because a blind retry is how one
 *                  replacement becomes two parcels.
 *   err.code       a coarse label for the owner-facing wording.
 * err.remark is the provider's own words, verbatim, never reworded: if
 * Delhivery refuses a Devanagari consignee name we want the owner to read what
 * it actually said, not our guess at it.
 */
const DUPLICATE_RE = /duplicat|already\s*exist/i;
const WALLET_RE = /balance|insufficient|recharge|wallet/i;
const TRANSIENT_RE = /internal (server )?error|try again|temporar|timed? ?out|timeout|unavailable/i;
const NOT_SERVICEABLE_RE = /not serviceable|non.?serviceable|embargo|pincode.*(not|invalid)|no service/i;
const AUTH_RE = /unauthori[sz]ed|invalid token|authentication|forbidden/i;

/** Classify a remark into one code. Order matters: duplicate wins. */
function codeFor(remark) {
  if (DUPLICATE_RE.test(remark)) return 'duplicate';
  if (AUTH_RE.test(remark)) return 'auth';
  if (WALLET_RE.test(remark)) return 'wallet';
  if (NOT_SERVICEABLE_RE.test(remark)) return 'not_serviceable';
  if (TRANSIENT_RE.test(remark)) return 'provider_error';
  return 'validation';
}

/** A refusal that arrived as HTTP 200 with a failed package. */
function refusal(path, remark) {
  const e = /** @type {any} */ (new Error(`delhivery ${path} refused: ${remark || 'no remark given'}`));
  e.remark = remark;
  e.code = codeFor(remark);
  e.duplicate = e.code === 'duplicate';
  // Only a provider-side wobble is worth another attempt. Everything else
  // (validation, not serviceable, auth, an empty wallet) needs a human.
  e.permanent = e.code !== 'provider_error';
  return e;
}

/** A transport failure: flag it the same way so the caller has one branch. */
function annotateTransport(err) {
  const e = /** @type {any} */ (err);
  const body = e.body || {};
  const remark = String(body.rmk || body.error || body.detail || '').trim();
  if (e.status === 401 || e.status === 403) e.code = 'auth';
  else if (e.status === 400 || e.status === 422) e.code = 'validation';
  else e.code = 'provider_error'; // 5xx, 429, and anything the network ate
  e.permanent = e.code !== 'provider_error';
  e.duplicate = DUPLICATE_RE.test(remark);
  if (e.duplicate) {
    e.code = 'duplicate';
    e.permanent = true;
  }
  if (remark) e.remark = remark;
  return e;
}

/** Our own refusal, before anything is sent. Always permanent. */
function invalid(message) {
  const e = /** @type {any} */ (new Error(message));
  e.code = 'validation';
  e.permanent = true;
  e.duplicate = false;
  return e;
}

/* ------------------------------------------------------------- sanitising */

/*
 * Delhivery rejects a shipment outright if a free-text value contains & # % ;
 * \ or a backtick, and the refusal names none of them. `&` and `#` carry
 * meaning in an address so they are spelled out; the rest are noise.
 *
 * Nothing here touches non-Latin script. If Delhivery refuses a Devanagari
 * name the remark is surfaced verbatim and the owner retypes it: a silent
 * transliteration would put a name on a parcel that the recipient does not
 * recognise, which is worse than a refusal.
 */
function clean(v) {
  return String(v ?? '')
    .replace(/&/g, ' and ')
    .replace(/#/g, 'No.')
    .replace(/[%;\\`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut to a length at a word boundary, so a label never ends mid-word. */
function clamp(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * Build the `add` field. Over the limit we drop whole trailing comma segments
 * rather than truncating: a label missing "near the water tank" still gets
 * delivered, a label reading "near the water ta" sends the rider nowhere.
 */
function addressField(address1, address2) {
  const segments = [address1, address2]
    .map(clean)
    .filter(Boolean)
    .join(', ')
    .split(/,\s*/)
    .filter(Boolean);
  const kept = [];
  let used = 0;
  for (const seg of segments) {
    const extra = (kept.length ? 2 : 0) + seg.length;
    if (used + extra > MAX.add) break;
    kept.push(seg);
    used += extra;
  }
  if (!kept.length) return clamp(segments[0] || '', MAX.add);
  // Count only. The address itself never reaches a log line.
  if (kept.length < segments.length) {
    log.warn('delhivery address trimmed to fit the label', { kept: kept.length, of: segments.length });
  }
  return kept.join(', ');
}

/** Delhivery wants a bare 10-digit Indian mobile, no country code. */
function tenDigit(raw, what) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  let ten = digits;
  if (digits.length === 12 && digits.startsWith('91')) ten = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) ten = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(ten)) {
    throw invalid(`${what} is not a 10 digit Indian mobile: ${maskPhone(digits)}`);
  }
  return ten;
}

const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');

/* ----------------------------------------------------------------- payload */

const SHIPPING_MODE = { surface: 'Surface', express: 'Express' };
/** spec.mode when the caller stated one, otherwise the configured default. */
const shippingMode = (mode) =>
  SHIPPING_MODE[String(mode || '').toLowerCase()] || config.delhiveryShippingMode || 'Surface';

/*
 * India keeps no DST, so the warehouse clock is UTC+5:30 all year and one
 * offset is the whole conversion. An order_date in UTC would date every
 * evening booking to the previous day on the manifest.
 */
function orderDate(now = Date.now()) {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function consignee(c = {}) {
  return {
    name: clamp(clean(c.name), MAX.name),
    add: addressField(c.address1, c.address2),
    pin: digitsOnly(c.pin),
    city: clamp(clean(c.city), MAX.name),
    state: clamp(clean(c.state), MAX.name),
    country: clean(c.country) || 'India',
    phone: tenDigit(c.phone, 'consignee phone'),
  };
}

/*
 * Delhivery defaults the return address to the pickup warehouse when the
 * return_* keys are absent, and an empty `replaceReturnTo.name` is exactly how
 * config says "use the warehouse". So absent is what we send, rather than a
 * half-filled block that would print a broken address on the label.
 */
function returnKeys() {
  const r = config.replaceReturnTo || {};
  if (!r.name) return {};
  return {
    return_name: clamp(clean(r.name), MAX.name),
    return_add: addressField(r.address1, ''),
    return_city: clamp(clean(r.city), MAX.name),
    return_state: clamp(clean(r.state), MAX.name),
    return_country: 'India',
    return_pin: digitsOnly(r.pin),
    return_phone: tenDigit(r.phone, 'return phone'),
  };
}

function parcelFields(p = {}) {
  return {
    weight: Number(p.weightGrams) || 0,
    shipment_length: Number(p.lengthCm) || 0,
    shipment_width: Number(p.breadthCm) || 0,
    shipment_height: Number(p.heightCm) || 0,
  };
}

function itemFields(spec) {
  const items = spec.items || [];
  return {
    products_desc: clamp(items.map((i) => clean(i.name || i.sku)).filter(Boolean).join(', '), MAX.desc),
    quantity: items.reduce((n, i) => n + (Number(i.qty) || 0), 0) || 1,
    /*
     * One hsn_code per shipment, not per line: the label is a single invoice
     * and Delhivery's form has one box. A replacement is one garment in
     * practice, so the first line's code is the shipment's. An empty HSN is
     * refused upstream by RULES.replace.hsn, which exists because guessing a
     * tariff code would put a wrong tax declaration on a GST document.
     */
    hsn_code: clean(items[0]?.hsn || ''),
    total_amount: Number(spec.declaredValueInr) || 0,
  };
}

function pickupName() {
  const name = config.delhiveryPickupLocation;
  // Matched as a plain string against the registered warehouse, case included,
  // so an empty value fails with "ClientWarehouse matching query does not
  // exist" after the request. Saying so before it is sent is cheaper, and it
  // also surfaces in shadow, which is where a missing variable should surface.
  if (!name) throw invalid('DELHIVERY_PICKUP_LOCATION is not set, so there is no warehouse to book against');
  return name;
}

/** The forward leg: a new prepaid parcel going out at our cost. */
function forwardShipment(spec) {
  return {
    ...consignee(spec.customer),
    order: String(spec.ref || ''),
    order_date: orderDate(),
    // Prepaid with an explicit zero. A replacement was paid for on the
    // original order, and a missing cod_amount on a COD-enabled account is
    // exactly the mistake that collects money twice.
    payment_mode: 'Prepaid',
    cod_amount: 0,
    shipping_mode: shippingMode(spec.mode),
    address_type: 'home',
    seller_inv: String(spec.invoiceRef || ''),
    seller_gst_tin: clean(config.sellerGstin),
    // Empty asks Delhivery to allot a waybill from the account series.
    waybill: '',
    ...itemFields(spec),
    ...parcelFields(spec.parcel),
    ...returnKeys(),
  };
}

/**
 * The reverse leg: collect the wrong garment from the customer. The consignee
 * block IS the customer, because on a Pickup shipment they are the address the
 * rider visits; the destination is the pickup_location warehouse.
 *
 * No seller_gst_tin: we are not invoicing anybody for a parcel coming back.
 */
function reverseShipment(spec) {
  return {
    ...consignee(spec.customer),
    order: String(spec.ref || ''),
    order_date: orderDate(),
    payment_mode: 'Pickup',
    shipping_mode: shippingMode(spec.mode),
    address_type: 'home',
    seller_inv: String(spec.invoiceRef || ''),
    waybill: '',
    ...itemFields(spec),
    ...parcelFields(spec.parcel),
    ...returnKeys(),
  };
}

/* -------------------------------------------------------------- write gate */

/**
 * Every write passes both gates: the /replace mode and the global DRY_RUN.
 * Neither performs any HTTP, and both hand back the document they would have
 * sent so the owner's preview can describe it exactly.
 *
 * The payload is returned, never logged: it carries a full name, address and
 * phone number.
 */
function writeGate(op, would, digest) {
  if (config.replaceMode !== 'live') {
    log.info(`delhivery ${op} skipped (shadow)`, digest);
    return { skipped: 'shadow', would };
  }
  if (config.dryRun) {
    log.info(`delhivery ${op} skipped (dry_run)`, digest);
    return { skipped: 'dry_run', would };
  }
  return null;
}

/* ------------------------------------------------------------- classifying */

/** Collect the provider's own words: packages[].remarks first, then rmk. */
function remarkOf(pkg = {}, json = {}) {
  const fromPkg = Array.isArray(pkg.remarks)
    ? pkg.remarks.filter(Boolean).join('; ')
    : String(pkg.remarks || '');
  return (fromPkg || String(json.rmk || '')).trim();
}

/*
 * HTTP 200 is not success. create.json answers 200 for a rejected shipment and
 * puts the reason in packages[].remarks, so success is only the full house:
 * success true, the package status Success, and a waybill to track.
 */
function classifyCreate(json) {
  const pkg = (json?.packages || [])[0] || {};
  const remark = remarkOf(pkg, json);
  const ok = json?.success === true && /^success$/i.test(String(pkg.status || '')) && !!pkg.waybill;
  return { ok, awb: pkg.waybill ? String(pkg.waybill) : null, status: String(pkg.status || ''), remark };
}

async function createShipment(leg, spec) {
  // Built before the gate on purpose: a missing warehouse or an unusable phone
  // number has to fail in shadow too, or shadow proves nothing.
  const shipment = leg === 'reverse' ? reverseShipment(spec) : forwardShipment(spec);
  const body = { shipments: [shipment], pickup_location: { name: pickupName() } };
  const digest = { leg, ref: spec.ref, pin: shipment.pin, weightGrams: shipment.weight, paymentMode: shipment.payment_mode };

  const skipped = writeGate(`create ${leg}`, { path: CREATE_PATH, body }, digest);
  if (skipped) return { ref: spec.ref, awb: null, status: skipped.skipped, ...skipped };

  let json;
  try {
    /*
     * Not idempotent, deliberately. A 500 here may already have booked a
     * parcel, so withRetry must not send it again; the orchestrator calls
     * findByRef and adopts whatever exists.
     */
    json = await call('POST', CREATE_PATH, {
      form: `format=json&data=${encodeURIComponent(JSON.stringify(body))}`,
    });
  } catch (e) {
    throw annotateTransport(e);
  }

  const r = classifyCreate(json);
  if (!r.ok) throw refusal(CREATE_PATH, r.remark);
  log.info('delhivery shipment booked', { leg, ref: spec.ref, awb: r.awb, pin: shipment.pin });
  return { ref: spec.ref, awb: r.awb, status: r.status };
}

/* ----------------------------------------------------------------- adapter */

const yes = (v) => v === true || /^(y|yes|true)$/i.test(String(v ?? ''));

export const delhivery = {
  name: 'delhivery',
  capabilities: { quote: true, label: true, findByRef: true },

  /**
   * Can this pin take a reverse pickup and a prepaid delivery? An unknown pin
   * and a pin under embargo both come back as "no" rather than an error: the
   * caller only ever asks "can we ship here", and a false is the answer to
   * that in both cases.
   */
  async serviceability(pin) {
    const json = await call('GET', `${PIN_PATH}?filter_codes=${encodeURIComponent(digitsOnly(pin))}`, {
      idempotent: true,
    });
    const pc = (json?.delivery_codes || [])[0]?.postal_code;
    // No row at all means Delhivery has never heard of the pin.
    if (!pc) return { reversePickup: false, prepaidDelivery: false, oda: false, raw: null };
    // An embargo is a live suspension of the whole pin (flood, strike, riot).
    // The Y/N flags stay Y through it, so the remark is the only signal.
    if (/embargo/i.test(String(pc.remarks || ''))) {
      log.warn('delhivery pin under embargo', { pin: digitsOnly(pin), remarks: String(pc.remarks).slice(0, 120) });
      return { reversePickup: false, prepaidDelivery: false, oda: yes(pc.is_oda), raw: pc };
    }
    return {
      reversePickup: yes(pc.pickup),
      prepaidDelivery: yes(pc.pre_paid),
      oda: yes(pc.is_oda),
      raw: pc,
    };
  },

  /**
   * Freight estimate, best effort. It is a number in a preview, so a courier
   * that will not quote must never be the reason a replacement is not booked:
   * every failure here is a null.
   */
  async quote({ fromPin, toPin, weightGrams, mode, leg } = {}) {
    try {
      const qs = new URLSearchParams({
        md: String(mode || '').toLowerCase() === 'express' ? 'E' : 'S',
        cgm: String(Number(weightGrams) || 0),
        o_pin: digitsOnly(fromPin),
        d_pin: digitsOnly(toPin),
        // DTO is Delhivery's name for a pickup coming back to the warehouse.
        ss: leg === 'reverse' ? 'DTO' : 'Delivered',
        pt: 'Pre-paid',
      });
      const json = await call('GET', `${CHARGES_PATH}?${qs}`, { idempotent: true });
      const row = Array.isArray(json) ? json[0] : json;
      const amount = Number(row?.total_amount);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return { amountInr: amount };
    } catch (e) {
      log.warn('delhivery quote unavailable, continuing without it', { leg, err: /** @type {any} */ (e).message });
      return null;
    }
  },

  /**
   * Book the pickup of the wrong garment. We never call the pickup request
   * API: on a Pickup shipment the courier schedules the visit itself, and a
   * manual request would raise a second, empty pickup against the warehouse.
   */
  async createReverse(spec) {
    return createShipment('reverse', spec);
  },

  /** Book the replacement going out. Manifested, never pickup-requested. */
  async createForward(spec) {
    return createShipment('forward', spec);
  },

  /**
   * Look a shipment up by our own reference. This is what makes a duplicate or
   * an ambiguous timeout recoverable: adopt the parcel that exists instead of
   * booking a second one.
   */
  async findByRef(ref) {
    const json = await call('GET', `${TRACK_PATH}?ref_ids=${encodeURIComponent(String(ref || ''))}`, {
      idempotent: true,
    });
    const sh = (json?.ShipmentData || [])[0]?.Shipment;
    if (!sh?.AWB) return null;
    return { awb: String(sh.AWB), status: sh.Status?.Status || '' };
  },

  /** The label is a convenience in a WhatsApp message, never a job blocker. */
  async label(awb) {
    try {
      const json = await call('GET', `${SLIP_PATH}?wbns=${encodeURIComponent(String(awb || ''))}&pdf=true`, {
        idempotent: true,
      });
      const pkg = (json?.packages || [])[0] || {};
      const url = [pkg.pdf_download_link, pkg.pdf_link, json?.pdf_download_link].find(
        (u) => typeof u === 'string' && /^https?:\/\//.test(u),
      );
      return url ? { url } : null;
    } catch (e) {
      log.warn('delhivery label unavailable', { awb, err: /** @type {any} */ (e).message });
      return null;
    }
  },

  /**
   * Cancel works only before the parcel is picked up, and after that Delhivery
   * refuses. A refusal is an answer, not a failure, so it comes back as a
   * value: the owner needs to read "already picked up" rather than a stack
   * trace, and there is nothing to retry either way.
   *
   * Not courier.cancel: that one throws on a refusal and cannot see a refusal
   * that arrives as HTTP 200 with a false status, which is the common shape.
   */
  async cancel(awb) {
    const body = { waybill: String(awb || ''), cancellation: 'true' };
    const skipped = writeGate('cancel', { path: EDIT_PATH, body }, { awb });
    if (skipped) return { ok: true, cancelled: false, ...skipped };
    try {
      const json = await call('POST', EDIT_PATH, { body });
      const reason = String(json?.remark || json?.rmk || json?.error || '').trim();
      // `status` false, or absent with a remark, both mean it was refused.
      const refused = json?.status === false || (json?.status === undefined && !!reason);
      if (refused) {
        log.info('delhivery refused a cancellation', { awb, reason: reason.slice(0, 160) });
        return { ok: false, cancelled: false, reason: reason || 'delhivery refused the cancellation' };
      }
      return { ok: true, cancelled: true };
    } catch (e) {
      const err = annotateTransport(e);
      return { ok: false, cancelled: false, reason: err.remark || err.message };
    }
  },

  /**
   * Tracking is courier.track, not a copy of it. It is the one Delhivery
   * endpoint that is verified against live AWBs, including the StatusCode
   * trap it documents, and /replace status wants the same answer the pollers
   * get.
   */
  async track(awbs) {
    return courier.track(awbs);
  },
};

/**
 * The WHOLE charges row, per head, for the monthly P&L.
 *
 * `quote` above answers the one question /replace asks ("roughly what will this
 * leg cost"), so it returns total_amount and nothing else and swallows every
 * failure as null. The P&L needs the breakdown instead: forward, RTO, DTO and
 * COD separately, gross against total so GST is its own line, and the zone for
 * the Data Checks sheet. Hence a second function rather than a wider `quote`,
 * whose three callers want exactly the number they get today.
 *
 * `ss` IS THE LEG AND IT IS NOT A FREE CHOICE. Verified against production on
 * 2026-11-03 (DECISIONS V): `ss=RTO` returns charge_DL AND charge_RTO in ONE
 * row, so asking for ss=Delivered as well and adding them doubles the forward
 * freight on every return. ss=DTO is a reverse pickup.
 *
 * It THROWS on a provider failure, unlike `quote`. A missing cost on a report
 * has to read as missing, and a null that means "Delhivery was down" is
 * indistinguishable from a null that means "no charge" by the time it reaches a
 * spreadsheet cell.
 *
 * @param {{fromPin?:string, toPin?:string, weightGrams?:number, mode?:string,
 *          ss?:'Delivered'|'RTO'|'DTO', paymentType?:string, codAmountInr?:number}} args
 * @returns {Promise<any|null>} the row, or null when Delhivery returned none
 */
export async function chargesBreakdown({ fromPin, toPin, weightGrams, mode, ss, paymentType, codAmountInr } = {}) {
  const md = /^(e|express)$/i.test(String(mode || '')) ? 'E' : 'S';
  const qs = new URLSearchParams({
    md,
    ss: String(ss || 'Delivered'),
    o_pin: digitsOnly(fromPin),
    d_pin: digitsOnly(toPin),
    cgm: String(Number(weightGrams) || 0),
    pt: String(paymentType || '').toUpperCase() === 'COD' ? 'COD' : 'Pre-paid',
    cod: String(Number(codAmountInr) || 0),
  });
  const json = await call('GET', `${CHARGES_PATH}?${qs}`, { idempotent: true });
  const row = Array.isArray(json) ? json[0] : json;
  // An empty body is an answer ("no rate for this lane"), not a transport
  // failure, so it is a null rather than a throw.
  if (!row || !Number.isFinite(Number(row.total_amount))) return null;
  return row;
}

/* Test seam: the sanitisers and the classifier are the risky pure bits. */
export const _internals = { clean, clamp, addressField, tenDigit, classifyCreate, codeFor, orderDate };
