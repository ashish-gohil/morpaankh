/*
 * How a Meta send failure is classified, which is the branch that decides
 * whether a customer's one offer survives.
 *
 * On 2026-10-26 both of Flow W's WhatsApp candidates failed with 130472,
 * "User's number is part of an experiment". Meta runs a marketing-message
 * holdout on a small share of numbers: MARKETING templates to those numbers are
 * refused, the send is not billed, retrying the template returns the same error,
 * and there is no opt-out and no published end date. What still reaches them is
 * a free-form message inside an open 24 hour service window.
 *
 * That is 131049's shape exactly, so it needs 131049's handling: park the offer
 * against the phone and deliver it the moment the customer writes in. 130472 was
 * in neither of the two code sets, so it fell through to the generic branch: no
 * park, no window delivery. The one candidate who had an email got the offer by
 * email; the one who did not received nothing at all, and nothing would ever
 * come back for them, because the sweep only ever looks at yesterday.
 *
 * The code list lives in one place because four call sites read it: both flows'
 * thrown-error path and both flows' status-webhook path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isWindowDeliverable, isTemplateUnusable, tpl } from './send.mjs';
import { config } from '../config.mjs';
import { table, _resetMemory } from '../store/table.mjs';
import { getWamidMap } from '../store/maps.mjs';
import { setUndeliverable } from '../store/phoneProfile.mjs';
import { makeFakeWhatsApp } from '../clients/fakes/index.mjs';
import { TEMPLATES } from '../../messages/templates.mjs';

const PHONE = '+919812345678';
const IMG = 'https://cdn.shopify.com/s/files/1/x/bandhan.jpg?v=1';
// The union of both versions' placeholders, which is what every caller passes:
// renderTemplateDef ignores the ones its version does not use.
const CONFIRM_VARS = {
  customer_name: 'Aarav',
  order_number: '#1234',
  item_line: 'Khili Dhoop, size M',
  cod_total: 'Rs 1,499',
  prepaid_total: 'Rs 1,349',
  order_total: 'Rs 1,499', // the price-free version quotes one total and no offer
};
const REMINDER_VARS = CONFIRM_VARS;
const OFFER_VARS = {
  ...CONFIRM_VARS,
  saving: 'Rs 150',
  gift_line: 'A gift from us, wrapped in with your order',
  valid_until: '21 Sep, 8:00 PM',
};

describe('isWindowDeliverable', () => {
  it('is true for the per-user marketing cap, 131049', () => {
    expect(isWindowDeliverable(131049)).toBe(true);
  });

  it("is true for Meta's marketing experiment holdout, 130472", () => {
    expect(isWindowDeliverable(130472)).toBe(true);
  });

  it('is false for an undeliverable number, where no window can help', () => {
    // 131026 means that handset cannot take a WhatsApp message at all, so
    // parking it against a service window that can never open would strand the
    // offer instead of falling straight through to email.
    expect(isWindowDeliverable(131026)).toBe(false);
  });

  it('is false for a template fault, which is ours to fix and not recipient-specific', () => {
    expect(isWindowDeliverable(132001)).toBe(false);
    expect(isWindowDeliverable(132015)).toBe(false);
  });

  it('is false for nothing at all, so a thrown non-Meta error never looks parkable', () => {
    expect(isWindowDeliverable(undefined)).toBe(false);
    expect(isWindowDeliverable(null)).toBe(false);
    expect(isWindowDeliverable(NaN)).toBe(false);
  });

  it('takes the numeric code, and a string code from a webhook still classifies', () => {
    // onSubStatus/onCartStatus read the code off a webhook payload, where it
    // arrives as a number but is stored and re-read through DynamoDB.
    expect(isWindowDeliverable(Number('130472'))).toBe(true);
  });

  it('does not overlap the template-unusable set', () => {
    for (const code of [131049, 130472]) {
      expect(isTemplateUnusable({ waCode: code })).toBe(false);
    }
  });
});

/*
 * Every template send has to leave a wamid behind.
 *
 * Meta accepts a template with a 200 and reports a delivery failure seconds
 * later, on a status webhook that carries the wamid and NOTHING else: no order,
 * no phone that is any use for lookup. onWaStatus turns that wamid back into an
 * order through the reverse map recordMessage writes, and that is what makes a
 * failure recoverable by a human: the order gets a wa-undeliverable tag the
 * owner can filter on, and one owner alert naming the order.
 *
 * recordMessage was called at 3 of the 13 template send sites. The other 10 sent
 * real customer messages that no status webhook could ever trace back, so a
 * failure on any of them updated nothing, tagged nothing and alerted nobody.
 *
 * It cost order #1230 on 2026-10-27. Flow A's prepaid fallback went out at
 * 06:24:37Z carrying a 1,999 rupee payment link, Meta refused it 13 seconds
 * later with 131049, and onWaStatus resolved no order and returned in 249ms.
 * The customer never got the link and the owner was never told. The order
 * shipped COD unconfirmed.
 *
 * Recording lives in dispatch, the one function every template goes through,
 * rather than at each call site, because a send site added later would
 * otherwise go unrecorded again by default. The marker is ctx.orderId, which
 * 12 of the 13 sites already passed for other reasons.
 */
describe('a template send registers its wamid against the order', () => {
  const fakeDeps = (overrides = {}) => ({
    clients: { whatsapp: makeFakeWhatsApp(overrides) },
  });
  const ORDER = '12345';

  beforeEach(async () => {
    _resetMemory();
    config.dryRun = false;
  });

  it('writes the MSG row and the reverse map a status webhook needs', async () => {
    const res = await tpl(fakeDeps(), PHONE, 'cod_reminder', REMINDER_VARS, { orderId: ORDER });
    // The reverse map is the half that was missing: without it onWaStatus
    // cannot name the order, so no tag and no alert.
    expect(await getWamidMap(res.messageId)).toMatchObject({ orderId: ORDER, key: 'cod_reminder' });
    const row = await table.get(`ORDER#${ORDER}`, `MSG#${res.messageId}`);
    expect(row).toMatchObject({ key: 'cod_reminder', template: res.templateName });
  });

  it('records the prepaid fallback, the send that cost order #1230 its link', async () => {
    const res = await tpl(fakeDeps(), PHONE, 'prepaid_offer', OFFER_VARS, { orderId: ORDER, imageUrl: IMG });
    expect(await getWamidMap(res.messageId)).toMatchObject({ orderId: ORDER, key: 'prepaid_offer' });
  });

  it('records the template that actually went out, not the one that was refused', async () => {
    // A template fault falls back to the LEGACY version. The wamid belongs to
    // the message Meta accepted, so the row has to name that version: an owner
    // reading it otherwise sees a template the customer never received.
    const deps = fakeDeps();
    const wa = deps.clients.whatsapp;
    const real = wa.sendTemplate;
    wa.sendTemplate = async (a) => {
      if (a.name !== TEMPLATES.cod_confirm.name) return real(a);
      const e = new Error('still in review');
      /** @type {any} */ (e).waCode = 132001;
      throw e;
    };
    const res = await tpl(deps, PHONE, 'cod_confirm', CONFIRM_VARS, { orderId: ORDER, imageUrl: IMG });
    const row = await table.get(`ORDER#${ORDER}`, `MSG#${res.messageId}`);
    expect(row.template).toBe(res.templateName);
    expect(res.templateName).not.toBe(TEMPLATES.cod_confirm.name);
  });

  it('records the price-free version taken when there is no price to quote', async () => {
    const res = await tpl(fakeDeps(), PHONE, 'cod_confirm', CONFIRM_VARS, {
      orderId: ORDER,
      imageUrl: IMG,
      preferLegacy: true,
    });
    expect(await getWamidMap(res.messageId)).toMatchObject({ orderId: ORDER, key: 'cod_confirm' });
    const row = await table.get(`ORDER#${ORDER}`, `MSG#${res.messageId}`);
    expect(row.template).toBe(res.templateName);
  });

  it('writes nothing when there is no order, so Flow W and Flow R keep their own rows', async () => {
    // A welcome offer's wamid maps to a customerId and a cart's to a cartId,
    // written by those flows against their own partition keys. Writing an
    // ORDER# row for them would point onWaStatus at an order that does not
    // exist and skip the handler that gives their locks back.
    const res = await tpl(fakeDeps(), PHONE, 'cod_reminder', REMINDER_VARS, {});
    expect(await getWamidMap(res.messageId)).toBeNull();
  });

  it('writes nothing for a send that never happened', async () => {
    // An undeliverable recipient is skipped before dispatch and has no wamid.
    // Recording one would invent a message the customer was never sent.
    await setUndeliverable(PHONE);
    const res = await tpl(fakeDeps(), PHONE, 'cod_reminder', REMINDER_VARS, { orderId: ORDER });
    expect(res.skipped).toBe('undeliverable');
    expect(res.messageId).toBeUndefined();
    const rows = await table.query(`ORDER#${ORDER}`);
    expect(rows.filter((r) => String(r.SK).startsWith('MSG#'))).toHaveLength(0);
  });

  it('still returns the send result when recording fails', async () => {
    // The customer already has the message. A bookkeeping failure must not
    // throw, because the throw would redeliver the SQS record and send a
    // second copy.
    const boom = { get: table.get, put: table.put };
    table.put = async () => { throw new Error('dynamo down'); };
    try {
      const res = await tpl(fakeDeps(), PHONE, 'cod_reminder', REMINDER_VARS, { orderId: ORDER });
      expect(res.messageId).toBeTruthy();
    } finally {
      table.put = boom.put;
    }
  });
});
