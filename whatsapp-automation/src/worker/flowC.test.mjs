import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { _resetSecrets } from '../secrets.mjs';
import { getAwaiting, setOptOut } from '../store/phoneProfile.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import * as C from './flowC.run.mjs';
import { COD_BLOCK_REASONS } from '../../messages/labels.mjs';
import { getState } from '../store/orderState.mjs';

const NOW = fromISTWall(2026, 9, 21, 12, 0); // inside the 08:00-21:00 NDR window
const PHONE = '+919812345678';

function order(overrides = {}) {
  return {
    id: 'gid://shopify/Order/12345',
    name: '#1234',
    tags: [],
    test: false,
    createdAt: '2026-09-15T06:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    netPaymentSet: { shopMoney: { amount: '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: [{ key: '_otpVerifiedPhoneNumber', value: '919812345678' }],
    customer: { id: 'gid://shopify/Customer/9', firstName: 'Aarav' },
    shippingAddress: { zip: '302001', city: 'Jaipur' },
    shippingLines: { nodes: [] },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }],
    lineItems: { nodes: [{ id: 'li1', title: 'Bandhan', quantity: 1, product: { id: 'gid://shopify/Product/1' }, originalUnitPriceSet: { shopMoney: { amount: '1499.00' } } }] },
    ...overrides,
  };
}

function setup(o = order()) {
  const clients = makeFakeClients({});
  clients.shopify.seed(o);
  return { clients, deps: { clients, now: NOW } };
}

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  _resetSecrets();
  config.ownerAlertPhones = ['+919999999999'];
  config.flows.C = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
});

const tagsAdded = (sh) => sh.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags);
const courierCalls = (co) => co.calls;
const sentText = (wa, re) => wa.sent.some((s) => re.test(s.body || ''));
const sentTemplate = (wa, name) => wa.sent.some((s) => s.type === 'template' && s.name === name);

describe('Flow C: the off switch', () => {
  // FLOW_C_ENABLED used to be read by nothing in this flow or in the worker's
  // router, so turning Flow C off left it running: it tagged three real orders
  // `RTO` in Shopify and force-stopped Flow A on them on 2026-09-29.
  it('does not start NDR or RTO, or tag anything, while disabled', async () => {
    config.flows.C = { enabled: false, startAt: '2020-01-01T00:00:00Z' };
    const { clients, deps } = setup();

    await C.onNdr('12345', deps);
    await C.onRto('12345', deps);
    await C.onRtoTimer('12345', deps);

    expect(tagsAdded(clients.shopify)).toEqual([]);
    expect(clients.whatsapp.sent).toEqual([]);
    expect(_peekTimers()).toEqual([]);
  });
});

describe('Flow C: NDR', () => {
  it('sends ndr_action inside the window', async () => {
    const { clients, deps } = setup();
    await C.onNdr('12345', deps);
    expect(sentTemplate(clients.whatsapp, 'ndr_action_v2')).toBe(true);
  });

  it('change address -> asks, then same-pincode edit saves', async () => {
    const { clients, deps } = setup();
    await C.onNdrAddressStart('12345', deps);
    expect(sentText(clients.whatsapp, /full address in one message/)).toBe(true);
    expect((await getAwaiting(PHONE, NOW)).type).toBe('address');

    await C.onAddressText('12345', 'New flat 5, MG Road, Jaipur 302001', deps);
    expect(courierCalls(clients.courier).some((c) => c.op === 'ndrAction' && c.action === 'EDIT_DETAILS')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('wa-ndr-address');
    expect(await getAwaiting(PHONE, NOW)).toBeNull();
  });

  it('different pincode -> pincode_changed + alert, no courier edit', async () => {
    const { clients, deps } = setup();
    await C.onNdrAddressStart('12345', deps);
    await C.onAddressText('12345', 'shifted to Bengaluru 560001', deps);
    expect(sentText(clients.whatsapp, /different pincode/)).toBe(true);
    expect(courierCalls(clients.courier).some((c) => c.op === 'ndrAction')).toBe(false);
    expect(sentTemplate(clients.whatsapp, 'ops_alert_v2')).toBe(true);
  });

  it('no pincode -> retry once, then alert', async () => {
    const { clients, deps } = setup();
    await C.onNdrAddressStart('12345', deps);
    await C.onAddressText('12345', 'my street near the temple', deps);
    expect(sentText(clients.whatsapp, /could not find a 6 digit pincode/)).toBe(true);
    await C.onAddressText('12345', 'still no pin', deps);
    expect(sentTemplate(clients.whatsapp, 'ops_alert_v2')).toBe(true);
  });

  it('deliver tomorrow -> RE-ATTEMPT + ok', async () => {
    const { clients, deps } = setup();
    await C.onNdrReattempt('12345', deps);
    expect(courierCalls(clients.courier).some((c) => c.action === 'RE-ATTEMPT')).toBe(true);
    expect(sentText(clients.whatsapp, /will try again on the next working day/)).toBe(true);
  });
});

describe('Flow C: RTO', () => {
  it('RTO_INITIATED tags RTO and schedules the reason ask', async () => {
    const { clients, deps } = setup();
    await C.onRto('12345', deps);
    expect(tagsAdded(clients.shopify)).toContain('RTO');
    expect(_peekTimers().map((t) => t.name)).toContain('C-12345-rto_reason');
  });

  it('reason changed_mind -> metafield, tags, cod-block, thanks', async () => {
    const { clients, deps } = setup();
    await C.onRtoReason('12345', 'changed_mind', deps);
    expect(clients.shopify.calls.some((c) => c.op === 'metafieldsSet')).toBe(true);
    expect(tagsAdded(clients.shopify)).toContain('rto-reason-changed-mind');
    expect(tagsAdded(clients.shopify)).toContain('cod-block'); // changed_mind forces it
    expect(sentText(clients.whatsapp, /Thank you for telling us/)).toBe(true);
  });

  it('reason other -> asks for text and awaits it', async () => {
    const { deps } = setup();
    await C.onRtoReason('12345', 'other', deps);
    expect((await getAwaiting(PHONE, NOW)).type).toBe('rto_other');
  });
});

/*
 * Flow A checks opt-out in five places and Flow B in three. Flow C checked it
 * in none, so a customer who had sent STOP still got NDR and RTO templates.
 */
describe('Flow C honours opt-out', () => {
  it('does not send ndr_action to a phone that opted out', async () => {
    const { clients, deps } = setup();
    await setOptOut(PHONE, true);
    await C.onNdr('12345', deps);
    expect(sentTemplate(clients.whatsapp, 'ndr_action_v2')).toBe(false);
    expect(sentTemplate(clients.whatsapp, 'ndr_action_v1')).toBe(false);
  });

  it('does not ask an opted-out customer why the parcel came back', async () => {
    const { clients, deps } = setup();
    await setOptOut(PHONE, true);
    await C.onRtoTimer('12345', deps);
    expect(clients.whatsapp.sent.filter((s) => String(s.name || '').startsWith('rto_reason'))).toHaveLength(0);
  });

  it('still sends to a customer who has not opted out', async () => {
    const { clients, deps } = setup();
    await C.onNdr('12345', deps);
    expect(sentTemplate(clients.whatsapp, 'ndr_action_v2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/*
 * What Flow C hands the courier, as opposed to whether it called it.
 *
 * On 2026-10-26 a real customer tapped "deliver tomorrow" on order
 * 12712549155188 and Delhivery refused the booking with "Invalid data
 * provided". Every test above asserts the ACTION name and passed throughout,
 * because the action name was never the problem: the fields beside it were.
 * The address edit sent `address` and `pin`, and the endpoint documents neither
 * (it takes `add`, `name` and `phone`, and has no pincode field at all).
 *
 * Flow C only edits an address whose pincode is unchanged, so there is nothing
 * for a pincode field to carry even if one existed.
 */
describe('Flow C hands the courier the fields Delhivery documents', () => {
  const ndr = (clients) => courierCalls(clients.courier).find((c) => c.op === 'ndrAction');

  it('an address edit sends `add`, and no `address` or `pin`', async () => {
    const { clients, deps } = setup();
    await C.onNdrAddressStart('12345', deps);
    await C.onAddressText('12345', 'New flat 5, MG Road, Jaipur 302001', deps);

    const call = ndr(clients);
    expect(call.action).toBe('EDIT_DETAILS');
    expect(call.opts.add).toBe('New flat 5, MG Road, Jaipur 302001');
    expect(call.opts).not.toHaveProperty('address');
    expect(call.opts).not.toHaveProperty('pin');
  });

  it('a re-attempt sends nothing but the action', async () => {
    const { clients, deps } = setup();
    await C.onNdrReattempt('12345', deps);

    const call = ndr(clients);
    expect(call.action).toBe('RE-ATTEMPT');
    expect(call.opts === undefined || Object.keys(call.opts).length === 0).toBe(true);
  });
});

/*
 * A refused NDR action must never be reported to the customer as done.
 *
 * ndrAction used to return as soon as Delhivery answered 201 with a UPL id, and
 * that id is a receipt for QUEUEING only: whether the waybill was actioned is
 * decided afterwards and published on the status API. Proven on 2026-10-26 by
 * submitting waybill 00000000000000, which cannot exist and still got a 201;
 * polling that id on 2026-10-27 returned "Failure" / "Incorrect waybill".
 *
 * So a package in the wrong status, the likeliest refusal by far, left the
 * customer holding "Done. Our courier partner will try again on the next
 * working day." for a re-attempt that was never going to happen, with no tag,
 * no owner alert and no error. ndrAction now confirms before returning and
 * throws otherwise, which lands in the handoff branch these two assert.
 */
describe('Flow C: Delhivery refuses the action after accepting the request', () => {
  const refuse = (clients) => {
    clients.courier.ndrAction = async (awb, action) => {
      clients.courier.calls.push({ op: 'ndrAction', awb, action });
      throw new Error(`delhivery refused ${action} on ${awb}: Package in incorrect status (UPL123)`);
    };
  };

  it('tells the customer a person will call, not that it is done', async () => {
    const { clients, deps } = setup();
    refuse(clients);

    await C.onNdrReattempt('12345', deps);

    expect(sentText(clients.whatsapp, /Done\. Our courier partner will try again/)).toBe(false);
    expect(sentText(clients.whatsapp, /arrange this by hand and call you shortly/)).toBe(true);
    // The tag claims a booking, so it must not be written either.
    expect(tagsAdded(clients.shopify)).not.toContain('wa-ndr-reattempt');
  });

  it('alerts the owner, so the refusal reaches a human', async () => {
    const { clients, deps } = setup();
    refuse(clients);

    await C.onNdrReattempt('12345', deps);

    expect(clients.whatsapp.sent.some((s) => s.type === 'template' && /ops_alert/.test(s.name || ''))).toBe(true);
  });

  it('does not claim the courier has a new address when the edit was refused', async () => {
    const { clients, deps } = setup();
    refuse(clients);

    // Same pincode as the order, so this reaches the EDIT_DETAILS branch.
    await C.onAddressText('12345', 'New flat 5, MG Road, Jaipur 302001', deps);

    expect(sentText(clients.whatsapp, /has the new address/)).toBe(false);
    expect(sentText(clients.whatsapp, /arrange this by hand and call you shortly/)).toBe(true);
    expect(tagsAdded(clients.shopify)).not.toContain('wa-ndr-address');
  });
});

/*
 * F9. THE FLOW C DELIVERY-FAILURE SEQUENCE.
 *
 * The guard was `if (st.flowC.ndrAskedAt) return`, which is per ORDER.
 * Delhivery attempts up to three times, so attempts 2 and 3 got nothing and
 * the parcel went to RTO with the customer never asked again.
 */
describe('Flow C delivery failures, one prompt per attempt', () => {
  const ndrNames = (wa) => wa.sent.filter((s) => s.type === 'template' && s.name.startsWith('ndr_action')).length;
  const attemptDates = (wa) =>
    wa.sent.filter((s) => s.type === 'template' && s.name.startsWith('ndr_action')).map((s) => JSON.stringify(s.components));
  const day = (d) => new Date(d).toISOString();

  it('prompts on attempt 1, attempt 2 and attempt 3', async () => {
    const { clients, deps } = setup();
    await C.onNdr('12345', deps, { attemptAt: day('2026-10-21T06:00:00Z') });
    await C.onNdr('12345', { ...deps, now: fromISTWall(2026, 9, 22, 12, 0) }, { attemptAt: day('2026-10-22T06:00:00Z') });
    await C.onNdr('12345', { ...deps, now: fromISTWall(2026, 9, 23, 12, 0) }, { attemptAt: day('2026-10-23T06:00:00Z') });
    expect(ndrNames(clients.whatsapp)).toBe(3);
  });

  it('gives one prompt when the poller and Shopify both report the same attempt', async () => {
    const { clients, deps } = setup();
    const attemptAt = day('2026-10-21T06:00:00Z');
    await C.onNdr('12345', deps, { attemptAt });
    // The same failure, seen an hour later through the other source.
    await C.onNdr('12345', { ...deps, now: fromISTWall(2026, 9, 21, 13, 0) }, { attemptAt });
    expect(ndrNames(clients.whatsapp)).toBe(1);
  });

  it('stops at the cap and tells the owner to call instead', async () => {
    config.ownerAlertPhones = ['+919999999999'];
    const { clients, deps } = setup();
    for (const d of [21, 22, 23, 24]) {
      await C.onNdr('12345', { ...deps, now: fromISTWall(2026, 9, d, 12, 0) }, { attemptAt: day(`2026-10-${d}T06:00:00Z`) });
    }
    expect(ndrNames(clients.whatsapp)).toBe(3);
    const alerts = clients.whatsapp.sent.filter((s) => s.name && s.name.startsWith('ops_alert'));
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0].components)).toContain('repeated failed delivery');
  });

  it('quotes the day the delivery was attempted, not the day we got round to asking', async () => {
    // Attempted at 19:30 IST, outside nothing, but prompted the next morning.
    const { clients, deps } = setup();
    await C.onNdr('12345', { ...deps, now: fromISTWall(2026, 9, 22, 9, 0) }, { attemptAt: day('2026-10-21T14:00:00Z') });
    expect(attemptDates(clients.whatsapp)[0]).toContain('21 Oct');
  });

  it('carries the attempt date through an out-of-window deferral', async () => {
    // 23:00 IST is outside the 08:00-21:00 NDR window, so this defers.
    const { clients, deps } = setup();
    await C.onNdr('12345', { ...deps, now: fromISTWall(2026, 9, 21, 23, 0) }, { attemptAt: day('2026-10-21T14:00:00Z') });
    expect(clients.whatsapp.sent).toHaveLength(0);
    const timer = _peekTimers().find((t) => t.name === 'C-12345-ndr');
    expect(timer.message.attemptAt).toBe(day('2026-10-21T14:00:00Z'));
  });

  it('tags the order on the first prompt, so the digest can count failures', async () => {
    const { clients, deps } = setup();
    await C.onNdr('12345', deps, { attemptAt: day('2026-10-21T06:00:00Z') });
    expect(clients.shopify.calls.filter((c) => c.op === 'tagsAdd').flatMap((c) => c.tags)).toContain('wa-ndr');
  });

  it('books one re-attempt however many times they tap', async () => {
    const { clients, deps } = setup();
    await C.onNdrReattempt('12345', deps);
    await C.onNdrReattempt('12345', deps);
    expect(clients.courier.calls.filter((c) => c.op === 'ndrAction')).toHaveLength(1);
  });
});

/*
 * F10. markRto lived in onRtoReason, the BUTTON TAP, which got the count wrong
 * in both directions: a customer who ignored the question was never counted, so
 * a repeat silent RTO never reached the cod-block it exists for, and a double
 * tap counted twice, so one RTO produced rto-count-2 and blocked a first
 * offence.
 */
describe('Flow C counts an RTO when it happens', () => {
  const custTags = (sh) =>
    sh.calls.filter((c) => c.op === 'tagsAdd' && c.orderGid === 'gid://shopify/Customer/9').flatMap((c) => c.tags);

  it('counts a silent RTO, where the customer never answers', async () => {
    const { clients, deps } = setup();
    await C.onRto('12345', deps);
    expect(custTags(clients.shopify)).toContain('rto-count-1');
    expect(custTags(clients.shopify)).not.toContain('cod-block');
  });

  it('counts one return once, however many times the event is redelivered', async () => {
    const { clients, deps } = setup();
    await C.onRto('12345', deps);
    await C.onRto('12345', deps);
    expect(custTags(clients.shopify).filter((t) => t.startsWith('rto-count-'))).toEqual(['rto-count-1']);
  });

  it('blocks COD on the second silent RTO, which is the case the block is for', async () => {
    const first = setup();
    await C.onRto('12345', first.deps);
    // A different parcel, same shopper.
    const second = setup(order({ id: 'gid://shopify/Order/99999', name: '#1299' }));
    await C.onRto('99999', second.deps);
    expect(custTags(second.clients.shopify)).toContain('rto-count-2');
    expect(custTags(second.clients.shopify)).toContain('cod-block');
  });

  it('does not count again when they tap a reason, and tapping twice changes nothing', async () => {
    const { clients, deps } = setup();
    await C.onRto('12345', deps);
    await C.onRtoReason('12345', 'not_needed', deps);
    await C.onRtoReason('12345', 'not_needed', deps);
    expect(custTags(clients.shopify).filter((t) => t.startsWith('rto-count-'))).toEqual(['rto-count-1']);
    // and they are thanked both times, because they tapped both times
    expect(clients.whatsapp.sent.filter((s) => (s.body || '').length > 0).length).toBeGreaterThan(1);
  });

  it('still blocks COD for a reason that warrants it, on a first offence', async () => {
    const { clients, deps } = setup();
    await C.onRto('12345', deps);
    await C.onRtoReason('12345', COD_BLOCK_REASONS[0], deps);
    expect(custTags(clients.shopify)).toContain('cod-block');
  });

  it('records when the return happened, which the digest needs', async () => {
    const { deps } = setup();
    await C.onRto('12345', deps);
    expect((await getState('12345')).flowC.rtoAt).toBeTruthy();
  });
});

/*
 * F16. Both NDR actions need a Delhivery waybill, and both sent their "Done"
 * message whether or not there was one. So an order shipped by someone else, or
 * fulfilled before its tracking number arrived, told the customer their
 * delivery had been rescheduled or their address saved when nothing had been
 * asked of anybody and the owner was not told either.
 */
describe('Flow C never confirms an NDR action it could not take', () => {
  const noAwb = () => order({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [] }] });
  const bodies = (wa) => wa.sent.filter((s) => s.type === 'text' || s.type === 'buttons').map((s) => s.body).join(' | ');
  const alerts = (wa) => wa.sent.filter((s) => s.name && s.name.startsWith('ops_alert'));

  beforeEach(() => { config.ownerAlertPhones = ['+919999999999']; });

  it('hands a re-attempt request to a person instead of confirming it', async () => {
    const { clients, deps } = setup(noAwb());
    await C.onNdrReattempt('12345', deps);
    expect(clients.courier.calls.filter((c) => c.op === 'ndrAction')).toHaveLength(0);
    expect(bodies(clients.whatsapp)).not.toContain('rescheduled');
    expect(alerts(clients.whatsapp)).toHaveLength(1);
    expect(JSON.stringify(alerts(clients.whatsapp)[0].components)).toContain('no Delhivery waybill');
  });

  it('hands an address correction to a person instead of saying it was saved', async () => {
    const { clients, deps } = setup(noAwb());
    await C.onAddressText('12345', 'Flat 4, Ring Road, Surat 302001', deps);
    expect(clients.courier.calls.filter((c) => c.op === 'ndrAction')).toHaveLength(0);
    expect(alerts(clients.whatsapp)).toHaveLength(1);
    // and the question is closed, so their next message is not read as an address
    expect(await getAwaiting(PHONE)).toBeFalsy();
  });

  it('still books and confirms when there is a waybill', async () => {
    const { clients, deps } = setup();
    await C.onNdrReattempt('12345', deps);
    expect(clients.courier.calls.filter((c) => c.op === 'ndrAction')).toHaveLength(1);
    expect(alerts(clients.whatsapp)).toHaveLength(0);
  });
});
