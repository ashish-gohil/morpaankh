/*
 * The NDR action payload, asserted against Delhivery's documented shape.
 *
 * On 2026-10-26 a real customer tapped "deliver tomorrow" on an NDR prompt and
 * the re-attempt was never booked. Delhivery answered "Invalid data provided",
 * the customer got the handoff message saying a person would call, and the only
 * other trace was one ERROR line. The cause was the request body: this client
 * posted a FLAT object, { waybill, act }, while /api/p/update takes a `data`
 * ARRAY of action items and carries the per-action fields in a nested
 * `action_data`. The field names had never been checked against the docs, which
 * is why the module carried "TODO(Phase 7): confirm NDR endpoint + action
 * names" directly above the call.
 *
 * Documented body (staging and production take the same shape):
 *   { "data": [ { "waybill": "...", "act": "RE-ATTEMPT" },
 *               { "waybill": "...", "act": "EDIT_DETAILS",
 *                 "action_data": { "name": "...", "add": "...", "phone": "..." } },
 *               { "waybill": "...", "act": "DEFER_DLV",
 *                 "action_data": { "deferred_date": "YYYY-MM-DD" } } ] }
 *
 * These assert the WIRE, not an internal shape, because the wire is the part
 * that was wrong and the part no unit test could have caught by reading our own
 * code back to itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { courier } from './courier.mjs';

let posts;
let gets;
/**
 * What the status API answers, per test. Default: the waybill succeeded, which
 * is what every pre-existing body assertion below needs to get past the
 * confirmation step and reach its `expect`.
 */
let statusReplies;
const dryRunWas = config.dryRun;
const tokenWas = process.env.DELHIVERY_TOKEN;
const UPL = 'UPL3791812044752097771';

const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const succeeded = (waybill, action) => ({
  status: 'Success',
  remark: '1 waybill affected',
  request_id: UPL,
  failed_wbns: [],
  success_wbns: [{ waybill, message: '', action }],
});

beforeEach(() => {
  posts = [];
  gets = [];
  statusReplies = null; // null means "derive a success from the submitted body"
  config.dryRun = false;
  process.env.DELHIVERY_TOKEN = 'test-token';
  vi.stubGlobal('fetch', async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (method === 'GET') {
      gets.push({ url: u, headers: init?.headers });
      if (statusReplies) return reply(statusReplies.length > 1 ? statusReplies.shift() : statusReplies[0]);
      const last = posts[posts.length - 1]?.body?.data?.[0] || {};
      return reply(succeeded(last.waybill, last.act));
    }
    posts.push({ url: u, method, headers: init.headers, body: JSON.parse(init.body) });
    return reply({ message: 'Request submitted successfully!', request_id: UPL });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  config.dryRun = dryRunWas;
  if (tokenWas === undefined) delete process.env.DELHIVERY_TOKEN;
  else process.env.DELHIVERY_TOKEN = tokenWas;
});

describe('courier.ndrAction speaks Delhivery NDR', () => {
  it('wraps a RE-ATTEMPT in the data array the endpoint actually takes', async () => {
    await courier.ndrAction('59152210001794', 'RE-ATTEMPT');

    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe('POST');
    expect(posts[0].url).toMatch(/\/api\/p\/update$/);
    expect(posts[0].headers.Authorization).toBe('Token test-token');
    expect(posts[0].body).toEqual({
      data: [{ waybill: '59152210001794', act: 'RE-ATTEMPT' }],
    });
  });

  it('never posts the flat body that Delhivery rejected', async () => {
    await courier.ndrAction('59152210001794', 'RE-ATTEMPT');
    // The exact shape of the 2026-10-26 failure: waybill at the top level.
    expect(posts[0].body.waybill).toBeUndefined();
    expect(posts[0].body.act).toBeUndefined();
    expect(Array.isArray(posts[0].body.data)).toBe(true);
  });

  it('RE-ATTEMPT carries no action_data, because the endpoint takes none', async () => {
    await courier.ndrAction('59152210001794', 'RE-ATTEMPT');
    expect(posts[0].body.data[0]).not.toHaveProperty('action_data');
  });

  it('nests an address edit under action_data as `add`, not `address`', async () => {
    await courier.ndrAction('59152210001794', 'EDIT_DETAILS', { add: '12 Dangigev society, Surat', phone: '+919812345678' });

    expect(posts[0].body).toEqual({
      data: [{
        waybill: '59152210001794',
        act: 'EDIT_DETAILS',
        action_data: { add: '12 Dangigev society, Surat', phone: '+919812345678' },
      }],
    });
  });

  it('drops a pincode instead of inventing a field for it', async () => {
    /*
     * The endpoint documents name, phone and add for EDIT_DETAILS and NOTHING
     * for the pincode, and Flow C only ever edits an address whose pincode is
     * unchanged, so there is nothing to send. Passing `pin` as a top-level key
     * is what the old caller did, and an unknown key is how a body gets
     * rejected whole.
     */
    await courier.ndrAction('59152210001794', 'EDIT_DETAILS', { add: 'same pincode, new lane', pin: '395010' });
    expect(posts[0].body.data[0].action_data).toEqual({ add: 'same pincode, new lane' });
  });

  it('returns the UPL request id, which is the only handle on an async action', async () => {
    const r = await courier.ndrAction('59152210001794', 'RE-ATTEMPT');
    expect(r.requestId).toBe('UPL3791812044752097771');
  });

  it('treats a 200 with no request id as a failure, not a booking', async () => {
    /*
     * The endpoint is asynchronous: a 200 means "queued", and the UPL id is the
     * receipt. A 200 carrying no id means nothing was queued, and the caller
     * would otherwise tell the customer their delivery is re-booked and tag the
     * order, on the strength of an empty reply.
     */
    vi.stubGlobal('fetch', async (url, init) => {
      posts.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return reply({ message: 'Invalid data provided' });
    });

    await expect(courier.ndrAction('59152210001794', 'RE-ATTEMPT')).rejects.toThrow(/delhivery/i);
    expect(posts.length).toBeGreaterThanOrEqual(1);
  });

  it('sends nothing at all under DRY_RUN', async () => {
    config.dryRun = true;
    const r = await courier.ndrAction('59152210001794', 'RE-ATTEMPT');
    expect(posts).toHaveLength(0);
    expect(r.skipped).toBe('dry_run');
  });
});

/*
 * A REQUEST ID IS A RECEIPT FOR QUEUEING, NOT FOR A RE-ATTEMPT.
 *
 * /api/p/update is asynchronous. It validates the SCHEMA and answers 201 with a
 * UPL id; whether the waybill was actually actioned is decided afterwards and
 * published only on the status API. Proven on 2026-10-26 by submitting waybill
 * 00000000000000, fourteen zeros and not a real AWB: production still answered
 * 201 with a request_id. So Flow C told the customer "Done. Our courier partner
 * will try again on the next working day." on the strength of a queued request,
 * and an ineligible package, the single most likely refusal, failed in silence.
 *
 * Measured against production on 2026-10-27 by polling that same UPL id:
 *
 *   GET /api/cmu/get_bulk_upl/UPL14271544014443516401?verbose=true
 *   200 { "status": "Failure", "remark": "Zero waybills affected",
 *         "failed_wbns": [ { "waybill": "00000000000000",
 *                            "message": "Incorrect waybill",
 *                            "action": "RE-ATTEMPT" } ],
 *         "success_wbns": [] }
 *
 * The re-attempt had failed all along. A fresh submission was then timed: the
 * status reads "Preload" for the first second or so and is definitive by ~2s,
 * which is why confirmation happens INLINE here rather than on a timer. There
 * is no new state and no new schedule.
 *
 * ndrAction now throws unless the waybill comes back in success_wbns, and both
 * Flow C call sites already catch a throw, send the handoff and alert the
 * owner. "Unconfirmed" is therefore treated as failure on purpose: the copy is
 * a firm claim ("Done", "has the new address"), and for a delivery the safe
 * direction is to put a human on it. A false negative costs one owner alert; a
 * false positive costs a customer their parcel.
 */
describe('courier.ndrAction confirms the action instead of trusting the receipt', () => {
  const failed = (waybill, action, message) => ({
    status: 'Failure',
    remark: 'Zero waybills affected',
    request_id: UPL,
    failed_wbns: [{ waybill, message, action }],
    success_wbns: [],
  });
  const preload = { status: 'Preload', remark: null, request_id: UPL, failed_wbns: [], success_wbns: [] };
  const fast = { delayMs: 0, attempts: 4 };

  it('polls the status API on the UPL id the submission returned', async () => {
    await courier.ndrAction('59152210001794', 'RE-ATTEMPT', {}, fast);

    expect(gets).toHaveLength(1);
    // The exact documented path, including the verbose flag. This is the wire,
    // which is the half no test of our own code could have caught.
    expect(gets[0].url).toBe(`https://track.delhivery.com/api/cmu/get_bulk_upl/${UPL}?verbose=true`);
    expect(gets[0].headers.Authorization).toBe('Token test-token');
  });

  it('returns the request id once the waybill is in success_wbns', async () => {
    const r = await courier.ndrAction('59152210001794', 'RE-ATTEMPT', {}, fast);
    expect(r).toMatchObject({ requestId: UPL, confirmed: true });
  });

  it('throws carrying Delhivery reason when the package is in the wrong status', async () => {
    // The refusal Flow C will actually meet: RE-ATTEMPT needs the package
    // pending on one of a listed set of status codes.
    statusReplies = [failed('59152210001794', 'RE-ATTEMPT', 'Package in incorrect status')];
    await expect(courier.ndrAction('59152210001794', 'RE-ATTEMPT', {}, fast))
      .rejects.toThrow(/Package in incorrect status/);
  });

  it('throws for an EDIT_DETAILS refusal too, so the address path hands off', async () => {
    statusReplies = [failed('59152210001794', 'EDIT_DETAILS', 'Package in incorrect status')];
    await expect(courier.ndrAction('59152210001794', 'EDIT_DETAILS', { add: '12 Ring Road' }, fast))
      .rejects.toThrow(/Package in incorrect status/);
  });

  it('waits through Preload and resolves when the answer lands', async () => {
    statusReplies = [preload, preload, succeeded('59152210001794', 'RE-ATTEMPT')];
    const r = await courier.ndrAction('59152210001794', 'RE-ATTEMPT', {}, fast);
    expect(r.confirmed).toBe(true);
    expect(gets).toHaveLength(3);
  });

  it('throws rather than claim a booking that never resolved', async () => {
    statusReplies = [preload];
    await expect(courier.ndrAction('59152210001794', 'RE-ATTEMPT', {}, fast))
      .rejects.toThrow(/not confirmed/i);
    expect(gets).toHaveLength(4); // every attempt used, then gave up
  });

  it('throws when the waybill is in neither list, which is not a confirmation', async () => {
    statusReplies = [{ status: 'Success', remark: '1 waybill affected', request_id: UPL, failed_wbns: [], success_wbns: [{ waybill: '99999999999999', message: '', action: 'RE-ATTEMPT' }] }];
    await expect(courier.ndrAction('59152210001794', 'RE-ATTEMPT', {}, fast))
      .rejects.toThrow(/not confirmed/i);
  });

  it('confirms nothing and calls nothing under DRY_RUN', async () => {
    config.dryRun = true;
    const r = await courier.ndrAction('59152210001794', 'RE-ATTEMPT', {}, fast);
    expect(r.skipped).toBe('dry_run');
    expect(posts).toHaveLength(0);
    expect(gets).toHaveLength(0);
  });
});

describe('courier.ndrStatus', () => {
  it('reads the documented path and splits the two lists', async () => {
    statusReplies = [{
      status: 'Partial',
      remark: '2 waybills affected',
      request_id: UPL,
      failed_wbns: [{ waybill: '111', message: 'Package in incorrect status', action: 'RE-ATTEMPT' }],
      success_wbns: [{ waybill: '222', message: '', action: 'DEFER_DLV' }],
    }];
    const r = await courier.ndrStatus(UPL);
    expect(gets[0].url).toBe(`https://track.delhivery.com/api/cmu/get_bulk_upl/${UPL}?verbose=true`);
    expect(r.status).toBe('Partial');
    expect(r.failed).toEqual([{ waybill: '111', message: 'Package in incorrect status', action: 'RE-ATTEMPT' }]);
    expect(r.success).toEqual([{ waybill: '222', message: '', action: 'DEFER_DLV' }]);
  });

  it('is a read, so it runs under DRY_RUN', async () => {
    config.dryRun = true;
    statusReplies = [{ status: 'Success', remark: '', request_id: UPL, failed_wbns: [], success_wbns: [] }];
    await expect(courier.ndrStatus(UPL)).resolves.toMatchObject({ status: 'Success' });
    expect(gets).toHaveLength(1);
  });
});
