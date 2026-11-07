/*
 * pnl/sources/delhivery.mjs — the parcels, and what they cost.
 *
 * TWO THINGS HERE ARE CORRECTNESS, NOT TUNING.
 *
 * 1. TRACKING IS CHUNKED AT 25. courier.track() does `.slice(0, 25)` and says
 *    nothing, so one call with 60 waybills answers for the first 25 and the
 *    other 35 parcels simply have no freight, no outcome and no RTO on the
 *    report. Nothing errors. RULES.pnl.trackingBatchSize is that limit and the
 *    chunking below is the only thing standing between a 60-parcel month and a
 *    report that silently covers 25 of them.
 *
 * 2. ss=RTO IS BOTH LEGS. The charges API returns charge_DL and charge_RTO in
 *    one row for ss=RTO (DECISIONS V, verified on #1170), so an RTO parcel is
 *    ONE call and a second ss=Delivered call on top would double its forward
 *    freight. Every RTO in the month, every month.
 *
 * WHY THE RAW TRACKING READ LIVES HERE. courier.track maps Delhivery's payload
 * down to six status fields, which is everything its callers need and none of
 * what the P&L needs: no Consignee.PinCode (no destination, so no freight
 * quote), no CODAmount, no OrderType, no RTOStartedDate. Widening it would put
 * a consignee block into every poll and reconcile pass in the service, for a
 * monthly report. This is the same GET, read-only, asked once a month, and the
 * STATUS MAPPING IS STILL mapCourierStatus(): there is exactly one mapper in
 * this service and the comments in it are three production incidents long.
 *
 * Failures throw. The engine owns SourceStatus and records them there.
 */
import { getSecrets } from '../../secrets.mjs';
import { deadline, TIMEOUT_MS } from '../../lib/timeout.mjs';
import { log } from '../../log.mjs';
import { withRetry } from '../../lib/resilience.mjs';
import { toPaise, rupeesToPaise } from '../../lib/money.mjs';
import { mapCourierStatus } from '../../domain/courier-status.mjs';
import { chargesBreakdown } from '../../clients/logistics/delhivery.mjs';
import { RULES } from '../../../messages/rules.mjs';

const BASE = () =>
  process.env.DELHIVERY_STAGING === 'true' ? 'https://staging-express.delhivery.com' : 'https://track.delhivery.com';

/** Delhivery timestamps carry no offset and are IST. */
const istStamp = (v) => (v ? `${String(v)}+05:30` : null);

/**
 * The raw ShipmentData for up to `trackingBatchSize` waybills.
 *
 * Read-only and idempotent, so withRetry may repeat it. No CourierError metric:
 * that one feeds the wa-courier-failures alarm, which exists for the flows that
 * serve a customer, and a monthly report failing to read tracking is a line on
 * the report rather than something to wake the owner for.
 */
export async function trackRaw(awbs) {
  const list = (Array.isArray(awbs) ? awbs : [awbs]).map(String);
  if (!list.length) return [];
  if (list.length > RULES.pnl.trackingBatchSize) {
    throw new Error(
      `pnl delhivery: ${list.length} waybills in one call, the API truncates past ${RULES.pnl.trackingBatchSize}`,
    );
  }
  const s = await getSecrets();
  if (!s.delhiveryToken) throw new Error('pnl delhivery: no DELHIVERY_TOKEN, tracking cannot be read');
  const url = `${BASE()}/api/v1/packages/json/?waybill=${encodeURIComponent(list.join(','))}`;
  return withRetry(
    'pnl.delhivery.track',
    async () => {
      const res = await fetch(url, {
        headers: { Authorization: `Token ${s.delhiveryToken}` },
        ...deadline(TIMEOUT_MS.delhiveryTrack),
      });
      const text = await res.text();
      if (!res.ok) {
        const e = /** @type {any} */ (new Error(`pnl delhivery track HTTP ${res.status}: ${text.slice(0, 200)}`));
        e.status = res.status;
        throw e;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`pnl delhivery track non-JSON: ${text.slice(0, 200)}`);
      }
      return (json.ShipmentData || []).map((sd) => sd.Shipment || {}).filter((sh) => sh.AWB);
    },
    { idempotent: true },
  );
}

/** Delhivery's OrderType vocabulary -> ours. */
function orderTypeOf(raw) {
  const t = String(raw || '').toLowerCase();
  if (t.includes('pickup')) return 'pickup';
  if (t.includes('cod')) return 'cod';
  return 'prepaid';
}

/**
 * One raw Shipment -> NormShipment.
 * @param {any} sh
 * @returns {import('../../domain/pnl/types.mjs').NormShipment}
 */
export function normaliseShipment(sh) {
  const st = sh.Status || {};
  return {
    awb: String(sh.AWB),
    state: mapCourierStatus({
      status: st.Status,
      statusType: st.StatusType,
      instructions: st.Instructions,
      statusCode: st.StatusCode,
    }),
    rawStatus: String(st.Status || ''),
    statusType: String(st.StatusType || ''),
    statusCode: String(st.StatusCode || ''),
    statusAt: istStamp(st.StatusDateTime),
    orderType: orderTypeOf(sh.OrderType),
    codAmountPaise: toPaise(sh.CODAmount ?? 0),
    invoiceAmountPaise: toPaise(sh.InvoiceAmount ?? 0),
    // A NUMBER in the payload (641002), and the type wants a string.
    destPin: sh.Consignee?.PinCode ? String(sh.Consignee.PinCode) : null,
    originName: sh.Origin || null,
    pickedUpAt: istStamp(sh.PickedupDate || sh.PickUpDate),
    /*
     * ON AN RTO THIS IS THE RETURN-ACCEPTED TIME, NOT A CUSTOMER DELIVERY.
     * #1170's DeliveryDate is identical to its "RETURN Accepted" scan, so
     * reading it without checking `state` first books a return as a sale.
     */
    deliveredAt: istStamp(sh.DeliveryDate),
    rtoStartedAt: istStamp(sh.RTOStartedDate),
    returnedAt: istStamp(sh.ReturnedDate),
    reverseInTransit: Boolean(sh.ReverseInTransit),
    // Null on 89 of 89 shipments this account has ever had. Only the uploaded
    // ledger can fill it, which is what makes the upload worth asking for.
    // Number(null) is 0 and 0 is finite, so the null has to be tested FIRST or
    // every parcel reports a scanned weight of zero grams.
    chargedWeightGrams: sh.ChargedWeight == null || !Number.isFinite(Number(sh.ChargedWeight))
      ? null
      : Number(sh.ChargedWeight),
    refs: sh.ReferenceNo ? [String(sh.ReferenceNo)] : [],
  };
}

/**
 * Every parcel in the month, chunked past Delhivery's silent limit.
 *
 * @param {string[]} awbs
 * @param {{clients?: any}} [deps] clients.courier.trackRaw overrides the reader,
 *        which is how a test proves the chunking without a network.
 * @returns {Promise<import('../../domain/pnl/types.mjs').NormShipment[]>}
 */
export async function fetchShipments(awbs, { clients } = {}) {
  const unique = [...new Set((awbs || []).map(String).filter(Boolean))];
  const size = RULES.pnl.trackingBatchSize;
  const read = clients?.courier?.trackRaw || trackRaw;
  /** @type {import('../../domain/pnl/types.mjs').NormShipment[]} */
  const out = [];
  for (let i = 0; i < unique.length; i += size) {
    const chunk = unique.slice(i, i + size);
    const raw = await read(chunk);
    out.push(...raw.map(normaliseShipment));
  }
  const missing = unique.length - out.length;
  log.info('pnl delhivery: tracking read', {
    asked: unique.length,
    got: out.length,
    calls: Math.ceil(unique.length / size),
    ...(missing ? { notFound: missing } : {}),
  });
  return out;
}

/*
 * WHICH LEG TO ASK FOR, AND WHEN NOT TO ASK AT ALL.
 *
 * A reverse pickup is a DTO whatever stage it has reached, because that is the
 * only leg it will ever have. An RTO is one ss=RTO call carrying both legs. A
 * parcel still moving has a real forward charge already incurred, quoted as
 * ss=Delivered and flagged so the report does not present it as final.
 *
 * MANIFESTED and CANCELLED get NO call and no number. A waybill that was
 * generated and never collected has probably never been billed, and "probably"
 * is not a figure to put in a cost column: it is flagged `not_picked_up` and
 * stays null so the owner can check it against the ledger.
 */
const FORWARD_STATES = new Set(['DELIVERED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'NDR', 'PENDING', 'LOST']);
const FINAL_STATES = new Set(['DELIVERED']);

/** @param {import('../../domain/pnl/types.mjs').NormShipment} sh */
export function legFor(sh) {
  if (sh.orderType === 'pickup') return { ss: 'DTO', flags: sh.state === 'DELIVERED' ? [] : ['leg_not_final'] };
  if (sh.state === 'RTO_INITIATED' || sh.state === 'RTO_DELIVERED') {
    /*
     * FINALITY COMES OFF ReturnedDate, NOT OFF THE STATE. mapCourierStatus
     * answers RTO_INITIATED for every RTO this account has ever had, because
     * Delhivery's Status string is the bare word "RTO" at every stage of the
     * return (#1170 reads RTO/DL/RD-AC "RETURN Accepted" with the parcel back
     * in Surat). Writing a second mapper to tell them apart is how a service
     * ends up with two disagreeing ones, so the date that only exists once the
     * parcel is back is read instead.
     */
    const back = Boolean(sh.returnedAt) || sh.state === 'RTO_DELIVERED';
    return { ss: 'RTO', flags: back ? ['rto_both_legs'] : ['rto_both_legs', 'leg_not_final'] };
  }
  if (FORWARD_STATES.has(sh.state)) {
    const flags = FINAL_STATES.has(sh.state) ? [] : ['leg_not_final'];
    if (sh.state === 'LOST') flags.push('lost');
    return { ss: 'Delivered', flags };
  }
  return { ss: null, flags: ['not_picked_up'] };
}

/**
 * A charges row -> the per-leg paise the report shows.
 *
 * THE HEADS MUST ADD UP TO THE TOTAL, because the engine sums them into one
 * cost. Delhivery's row does not: charge_DL + charge_RTO + charge_COD is
 * `gross_amount` MINUS the surcharges (DPH, PEAK, FS, ROV, INS...), which have
 * no column on this report and no sensible home of their own. They are put on
 * the leg that caused the parcel to move, so forward + rto + dto + cod + gst
 * reconciles to total_amount exactly, which is a thing a test can hold.
 */
export function splitCharges(row) {
  const gross = toPaise(row.gross_amount);
  const total = toPaise(row.total_amount);
  const cod = toPaise(row.charge_COD);
  const rto = toPaise(row.charge_RTO);
  const dto = toPaise(row.charge_DTO);
  // Whichever leg moved the parcel outward absorbs the surcharges. On a pure
  // reverse pickup there is no forward leg at all, so DTO takes them.
  const carried = gross - cod - rto - dto;
  const isReverseOnly = dto > 0 && toPaise(row.charge_DL) === 0;
  return {
    forwardPaise: isReverseOnly ? null : carried,
    rtoPaise: rto || null,
    dtoPaise: isReverseOnly ? dto + carried : dto || null,
    codChargePaise: cod || null,
    gstPaise: total - gross,
    totalPaise: total,
    zone: row.zone ? String(row.zone) : null,
    chargedWeightGrams: row.charged_weight == null || !Number.isFinite(Number(row.charged_weight))
      ? null
      : Number(row.charged_weight),
  };
}

/** @returns {import('../../domain/pnl/types.mjs').CourierCharge} */
function missingCharge(awb, flags) {
  return {
    awb,
    source: 'missing',
    forwardPaise: null,
    rtoPaise: null,
    dtoPaise: null,
    codChargePaise: null,
    gstPaise: null,
    totalPaise: null,
    zone: null,
    chargedWeightGrams: null,
    weightAssumed: true,
    variancePaise: null,
    flags,
  };
}

/**
 * What every parcel cost, computed from the rate card.
 *
 * One call per distinct (o_pin, d_pin, cgm, ss, pt, cod) tuple, memoised, so a
 * month of parcels to the same pin at the same weight is one HTTP call. The
 * cache is per invocation on purpose: a rate card change between months must
 * not be served from a warm Lambda.
 *
 * EVERY ROW IS `weightAssumed: true`. ChargedWeight is null on every shipment
 * this account has ever had and `charged_weight` in the response is just the
 * cgm echoed back, so there is no API source anywhere for Delhivery's real
 * scanned weight. The only exact source is the owner's ledger upload.
 *
 * @param {{shipments: import('../../domain/pnl/types.mjs').NormShipment[],
 *          orders?: import('../../domain/pnl/types.mjs').NormOrder[],
 *          config?: any, charges?: typeof chargesBreakdown}} args
 * @returns {Promise<import('../../domain/pnl/types.mjs').CourierCharge[]>}
 */
/*
 * Delhivery rate-limits the charges API, and says so with HTTP 200 and an XML
 * body: <root><detail>Request was throttled. Expected available in 25 seconds.
 * </detail></root>. The client turns that into a throw, so withRetry sees it,
 * but withRetry backs off in hundreds of milliseconds and gives up after three
 * attempts. A throttle asks for TWENTY FIVE SECONDS, so every attempt lands
 * inside the same closed window and the lane degrades to "missing".
 *
 * Measured on the first live October run: a month has around forty distinct
 * lanes, the first handful answer, and then every remaining one was throttled
 * and dropped. The whole month's freight went missing, which blocks every row
 * from the totals. That is the correct behaviour for an unknown cost and the
 * wrong outcome for a cost we can simply wait for.
 *
 * So the throttle gets its own waiter: read the number of seconds Delhivery
 * names, sleep that long, try again. Capped, and bounded by an attempt budget,
 * because a report that never finishes is also a report that never arrives.
 */
const THROTTLE_RE = /throttled.*?available in (\d+)\s*second/i;
const MAX_THROTTLE_WAIT_MS = 35000;

export function throttleWaitMs(err) {
  const m = THROTTLE_RE.exec(String(/** @type {any} */ (err)?.message || ''));
  if (!m) return 0;
  // A second of headroom: "available in 25" means not yet at 25.
  return Math.min((Number(m[1]) + 1) * 1000, MAX_THROTTLE_WAIT_MS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call `fn`, waiting out a Delhivery throttle rather than treating it as a failure. */
export async function awaitingThrottle(fn, { attempts = 3, onWait = null } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const wait = throttleWaitMs(e);
      if (!wait || i === attempts) throw e;
      if (onWait) onWait(wait, i);
      await sleep(wait);
    }
  }
  throw last;
}

export async function fetchCharges({ shipments, orders = [], config = {}, charges = chargesBreakdown }) {
  const originPin = config.originPin || RULES.pnl.originPin;
  const mode = config.shippingMode || RULES.pnl.shippingMode;
  const cgm = config.assumedWeightGrams || RULES.pnl.assumedWeightGrams;
  const manualPaise = config.manualCourierCostPaise || null;
  const manualInr = RULES.pnl.manualCourierCostInr || {};

  /** @type {Map<string, import('../../domain/pnl/types.mjs').NormOrder>} */
  const byAwb = new Map();
  for (const o of orders) for (const awb of o.awbs || []) if (!byAwb.has(awb)) byAwb.set(awb, o);

  /** @type {Map<string, any>} */
  const cache = new Map();
  /** @type {import('../../domain/pnl/types.mjs').CourierCharge[]} */
  const out = [];

  for (const sh of shipments) {
    /*
     * A parcel the owner sent by some other courier, priced by hand. It wins
     * over everything below: no Delhivery rate card applies to it at all.
     */
    const manual = manualPaise?.[sh.awb] ?? (sh.awb in manualInr ? rupeesToPaise(manualInr[sh.awb]) : null);
    if (manual != null) {
      out.push({
        ...missingCharge(sh.awb, ['manual']),
        source: 'manual',
        forwardPaise: manual,
        totalPaise: manual,
        chargedWeightGrams: null,
      });
      continue;
    }

    const { ss, flags } = legFor(sh);
    if (!ss) {
      out.push(missingCharge(sh.awb, flags));
      continue;
    }

    const ord = byAwb.get(sh.awb) || null;
    const destPin = sh.destPin || ord?.pin || null;
    if (!destPin) {
      out.push(missingCharge(sh.awb, [...flags, 'no_dest_pin']));
      continue;
    }

    /*
     * COD is decided by whether there is cash to collect, not by the Shopify
     * gateway: a COD King partial order reads 'partial' in Shopify (Cashfree
     * gateway, 'Standard' shipping line) while Delhivery carries the balance as
     * COD and bills charge_COD for collecting it. The waybill's own CODAmount
     * is the amount being collected.
     *
     * THE WAYBILL OVERRULES SHOPIFY, AND THE FALLBACK ONLY FILLS A GAP.
     * #1236 is a Shopify COD order that was manifested Pre-paid with
     * CODAmount 0, so Delhivery will collect no cash and bill no collection
     * fee. Taking the order's total there quoted it as COD and put a 40.00 COD
     * charge on a parcel beside the word "Prepaid" in the Courier Ledger: a
     * cost Delhivery never charged. So the order's total is read only when the
     * waybill itself says COD, which leaves the fallback doing its real job
     * (a COD waybill whose CODAmount came back empty) and nothing else.
     */
    const codPaise =
      sh.codAmountPaise || (sh.orderType === 'cod' && ord?.paymentType === 'cod' ? ord.currentTotalPaise : 0);
    const codInr = Math.round(codPaise / 100);
    const pt = codInr > 0 ? 'COD' : 'Pre-paid';
    const key = [originPin, destPin, cgm, ss, pt, codInr].join('|');

    let row = cache.get(key);
    if (row === undefined) {
      try {
        row = await awaitingThrottle(
          () =>
            charges({
              fromPin: originPin,
              toPin: destPin,
              weightGrams: cgm,
              mode,
              ss: /** @type {any} */ (ss),
              paymentType: pt,
              codAmountInr: codInr,
            }),
          {
            onWait: (ms, attempt) =>
              log.info('pnl delhivery: charges throttled, waiting it out', {
                ms,
                attempt,
                lane: `${originPin}->${destPin} ${ss} ${pt}`,
              }),
          },
        );
      } catch (e) {
        // One lane failing must not cost the other 88 parcels their freight.
        log.warn('pnl delhivery: charges unavailable for a lane', {
          awb: sh.awb,
          ss,
          err: /** @type {any} */ (e).message,
        });
        row = null;
      }
      cache.set(key, row);
    }
    if (!row) {
      out.push(missingCharge(sh.awb, [...flags, 'charges_call_failed']));
      continue;
    }

    out.push({
      awb: sh.awb,
      source: 'computed',
      ...splitCharges(row),
      weightAssumed: true,
      variancePaise: null,
      flags,
    });
  }

  log.info('pnl delhivery: charges computed', {
    parcels: shipments.length,
    lanes: cache.size,
    missing: out.filter((c) => c.source === 'missing').length,
  });
  return out;
}

export const _internals = { istStamp, orderTypeOf };
