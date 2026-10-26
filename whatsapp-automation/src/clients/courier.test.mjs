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
const dryRunWas = config.dryRun;
const tokenWas = process.env.DELHIVERY_TOKEN;

const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  posts = [];
  config.dryRun = false;
  process.env.DELHIVERY_TOKEN = 'test-token';
  vi.stubGlobal('fetch', async (url, init) => {
    posts.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return reply({ message: 'Request submitted successfully!', request_id: 'UPL3791812044752097771' });
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
