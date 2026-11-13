/*
 * language.test.mjs — the customer's choice of English or Hindi.
 *
 * The three questions this file exists to answer, in order of how much they
 * would cost to get wrong:
 *
 *   does a Hindi message ever contain an English fragment, or the reverse
 *   does any path send nothing, or send twice
 *   does the picker ever appear a second time
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.mjs';
import { _resetMemory } from '../store/table.mjs';
import { _resetTimers, _peekTimers } from '../timers/schedule.mjs';
import { setOptOut, setLang, getLang, getProfile, langState, markLangAsked } from '../store/phoneProfile.mjs';
import { getState, ensureState, patchState, patchFlowA, recordMessage, getSide } from '../store/orderState.mjs';
import { realClients } from '../clients/index.mjs';
import { routes } from './index.mjs';
import { makeFakeClients } from '../clients/fakes/index.mjs';
import { fromISTWall } from '../lib/time.mjs';
import { RULES } from '../../messages/rules.mjs';
import { renderSession } from '../../messages/session.mjs';
import { TEMPLATES_HI } from '../../messages/templates.hi.mjs';
import { SESSION_HI } from '../../messages/session.hi.mjs';
import * as A from './flowA.run.mjs';
import * as language from './language.run.mjs';
import { langFor, _resetLangCache } from './send.mjs';

const NOW = fromISTWall(2026, 9, 20, 12, 0);
const PHONE = '+919812345678';
const OTHER_PHONE = '+919800000011';

/*
 * The shipped values, read at import so a leaked override from one test cannot
 * become another test's starting point. RULES.language ships ENTIRELY OFF and
 * most of this file turns it on, which is exactly the leak worth guarding.
 */
const SHIPPED_LANGUAGE = { ...RULES.language };
afterEach(() => { RULES.language = { ...SHIPPED_LANGUAGE }; });

/** Turn the feature on for one test, with any rule overridden. */
const withLanguage = (over = {}) => {
  RULES.language = { ...SHIPPED_LANGUAGE, enabled: true, ...over };
};

function codOrder(overrides = {}) {
  const { id = 'gid://shopify/Order/12345', name = '#1234', phone = '919812345678', ...rest } = overrides;
  return {
    id,
    name,
    tags: ['✅ COD-Verified', 'LOW RTO Risk'],
    test: false,
    createdAt: '2026-09-20T06:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    netPaymentSet: { shopMoney: { amount: '0.00' } },
    currentTotalPriceSet: { shopMoney: { amount: '1499.00' } },
    totalPriceSet: { shopMoney: { amount: '1499.00' } },
    customAttributes: [
      { key: '_otpVerifiedPhoneNumber', value: phone },
      { key: '_codkAmountType', value: 'cod' },
      { key: '_codkAmountValue', value: '50.0' },
    ],
    customer: { firstName: 'Aarav' },
    shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '50.00' } } }] },
    fulfillments: [],
    lineItems: {
      nodes: [
        {
          id: 'li1',
          title: 'Bandhan',
          quantity: 1,
          variantTitle: 'M / Indigo',
          variant: { selectedOptions: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Indigo' }] },
          image: { url: 'https://cdn.shopify.com/s/files/1/x/bandhan.jpg?v=1', width: 960, height: 1280 },
          originalUnitPriceSet: { shopMoney: { amount: '1449.00' } },
        },
      ],
    },
    ...rest,
  };
}

function setup(orders = [codOrder()], now = NOW) {
  const clients = makeFakeClients({ shopify: {} });
  for (const o of orders) clients.shopify.seed(o);
  return { clients, deps: { clients, now } };
}

/**
 * Make Meta refuse specific template NAMES, and only those.
 *
 * The shared fake can fail every template or none, and the whole point of the
 * fallback is that Hindi fails while English succeeds.
 */
function refuse(wa, names, waCode = 132001) {
  const real = wa.sendTemplate;
  wa.sendTemplate = async (a) => {
    if (names.includes(a.name)) {
      const e = new Error(`fake Meta refusal ${waCode} for ${a.name}`);
      /** @type {any} */ (e).waCode = waCode;
      throw e;
    }
    return real(a);
  };
}

/** Make one template name come back as a skipped send, the way a dry run does. */
function skip(wa, name, reason = 'dry_run') {
  const real = wa.sendTemplate;
  wa.sendTemplate = async (a) => (a.name === name ? { skipped: reason } : real(a));
}

const templateNames = (wa) => wa.sent.filter((s) => s.type === 'template').map((s) => s.name);
const sentTemplate = (wa, name) => wa.sent.find((s) => s.type === 'template' && s.name === name);
/** The body placeholder values of one sent template, in order. */
const bodyParams = (s) => (s?.components || []).find((c) => c.type === 'body')?.parameters.map((p) => p.text) || [];
const timerNames = () => _peekTimers().map((t) => t.name);

beforeEach(() => {
  _resetMemory();
  _resetTimers();
  /*
   * The refused-Hindi cache lives at module scope, which is the point of it:
   * one Lambda container holds it across invocations. Tests share that module,
   * so without this one test's refusal silently suppresses the next test's
   * Hindi attempt and the next test passes for the wrong reason.
   */
  _resetLangCache();
  config.flows.A = { enabled: true, startAt: '2020-01-01T00:00:00Z' };
  config.orderAllowlist = [];
  config.ownerAlertPhones = [];
});

/* ------------------------------------------------------------------ */

describe('with the feature off, which is how it ships', () => {
  it('sends the English confirmation in the same call, and asks nothing', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
    expect(timerNames()).not.toContain('A-12345-lang_wait');
  });

  /*
   * Not a style point. langFor returns English WITHOUT reading the profile
   * when the feature is off, so the path every order confirmation takes gains
   * no DynamoDB read. A stored Hindi language must be ignored entirely.
   */
  it('ignores a language that is already stored, rather than acting on it', async () => {
    await setLang(PHONE, 'hi');
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
  });
});

/* ------------------------------------------------------------------ */

describe('when Meta will not take the Hindi template', () => {
  beforeEach(async () => {
    withLanguage();
    await setLang(PHONE, 'hi');
  });

  it('sends the Hindi one when it works, with Hindi fragments in it', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_hi_v1']);
    // ", Size M" is the Hindi joiner. The product title is never translated.
    expect(bodyParams(sentTemplate(clients.whatsapp, 'cod_confirm_hi_v1'))).toContain('Bandhan, Size M');
  });

  /*
   * THE MOST IMPORTANT TEST IN THIS FILE.
   *
   * When the Hindi template is refused and English is sent instead, the vars
   * must be resolved AGAIN in English. If they are not, the customer gets the
   * English body with Hindi fragments dropped into it, which is worse than
   * either language on its own and is invisible to every other test here.
   */
  it('falls back to English, and the English body carries ENGLISH fragments', async () => {
    const { clients, deps } = setup();
    refuse(clients.whatsapp, ['cod_confirm_hi_v1']);
    await A.onCodTimer('12345', deps);

    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
    const params = bodyParams(sentTemplate(clients.whatsapp, 'cod_confirm_v3'));
    expect(params).toContain('Bandhan, size M');
    expect(params).not.toContain('Bandhan, Size M');
  });

  it('reaches the LEGACY version when Hindi and the current English are both unusable', async () => {
    const { clients, deps } = setup();
    refuse(clients.whatsapp, ['cod_confirm_hi_v1', 'cod_confirm_v3']);
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v2']);
  });

  /*
   * 131026 is a fact about the RECIPIENT, not about the template. If the Hindi
   * branch swallowed it the number would never be flagged undeliverable and we
   * would keep paying to message a handset that cannot receive WhatsApp.
   */
  it('does not swallow an error that is about the recipient rather than the template', async () => {
    const { clients, deps } = setup();
    refuse(clients.whatsapp, ['cod_confirm_hi_v1'], 131026);
    await expect(A.onCodTimer('12345', deps)).rejects.toThrow(/131026/);
    expect(templateNames(clients.whatsapp)).toEqual([]);
  });

  it('stops retrying a refused Hindi template for the next ten minutes', async () => {
    const { clients, deps } = setup([codOrder(), codOrder({ id: 'gid://shopify/Order/12346', name: '#1235' })]);
    let attempts = 0;
    const real = clients.whatsapp.sendTemplate;
    clients.whatsapp.sendTemplate = async (a) => {
      if (a.name === 'cod_confirm_hi_v1') {
        attempts += 1;
        const e = new Error('pending review');
        /** @type {any} */ (e).waCode = 132001;
        throw e;
      }
      return real(a);
    };
    await A.onCodTimer('12345', deps);
    await A.onCodTimer('12346', deps);
    // Tried once, not once per order: a template in Meta review would
    // otherwise cost every send a wasted round trip and a guaranteed failure.
    expect(attempts).toBe(1);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3', 'cod_confirm_v3']);
  });

  it('hiDisabledKeys forces one key back to English without touching Meta', async () => {
    withLanguage({ hiDisabledKeys: ['cod_confirm'] });
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
  });

  it('allowPhones keeps everyone else on English even with Hindi stored', async () => {
    withLanguage({ allowPhones: [OTHER_PHONE] });
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
  });

  /*
   * langFor directly, rather than through onCodTimer. Breaking every PROFILE
   * read would also break isOptedOut, which has never had a guard and is not
   * this feature's to add: the point here is narrower, that a failed read of
   * the LANGUAGE degrades to English instead of failing the message.
   */
  it('answers English, and does not throw, when the profile cannot be read', async () => {
    const { table } = await import('../store/table.mjs');
    const realGet = table.get;
    table.get = async () => { throw new Error('dynamo is having a moment'); };
    try {
      await expect(langFor(PHONE)).resolves.toBe('en');
    } finally {
      table.get = realGet;
    }
  });
});

/* ------------------------------------------------------------------ */

describe('the gate: asked once, waited on for five minutes, then sent regardless', () => {
  beforeEach(() => withLanguage());

  it('asks a new phone and holds the confirmation', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);

    expect(templateNames(clients.whatsapp)).toEqual(['language_select_v1']);
    expect(timerNames()).toContain('A-12345-lang_wait');
    const st = await getState('12345');
    // Neither sent nor decided: the reconcile sweep must still see this order
    // as one it has to come back to.
    expect(st.flowA?.codConfirmAt).toBeFalsy();
    expect(st.flowA?.codSkip).toBeFalsy();
    expect(st.flowA?.langAskAt).toBeTruthy();
  });

  it('a tap then sends the confirmation once, in Hindi, and the later timers send nothing more', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await language.onPick(PHONE, 'lang_hi', '12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['language_select_v1', 'cod_confirm_hi_v1']);

    // The lang_wait timer still fires, because it was armed before the tap
    // arrived. It must not produce a second confirmation.
    await A.onCodTimer('12345', { ...deps, now: new Date(NOW.getTime() + 6 * 60 * 1000) });
    expect(templateNames(clients.whatsapp)).toEqual(['language_select_v1', 'cod_confirm_hi_v1']);
  });

  it('and the six hour reminder that follows is in Hindi too, without being asked again', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await language.onPick(PHONE, 'lang_hi', '12345', deps);
    await A.onReminder('12345', { ...deps, now: new Date(NOW.getTime() + 7 * 60 * 60 * 1000) });
    // The reminder is a real, separate message and SHOULD go out. The point is
    // that it inherits the language without any flow knowing about languages.
    expect(templateNames(clients.whatsapp)).toEqual([
      'language_select_v1', 'cod_confirm_hi_v1', 'cod_reminder_hi_v1',
    ]);
  });

  it('no tap: the confirmation goes out in English when the wait is up', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    const later = { ...deps, now: new Date(NOW.getTime() + 6 * 60 * 1000) };
    await A.onCodTimer('12345', later);
    expect(templateNames(clients.whatsapp)).toEqual(['language_select_v1', 'cod_confirm_v3']);
  });

  it('does not ask again before the wait is up, and does not send twice either', async () => {
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    await A.onCodTimer('12345', { ...deps, now: new Date(NOW.getTime() + 60 * 1000) });
    expect(templateNames(clients.whatsapp)).toEqual(['language_select_v1']);
  });

  it('never asks a phone that has already chosen', async () => {
    await setLang(PHONE, 'en');
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
  });

  it('stops asking at maxAsks, across all of that phone orders', async () => {
    withLanguage({ maxAsks: 1 });
    await markLangAsked(PHONE, new Date(NOW.getTime() - 60 * 60 * 1000));
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
  });

  /*
   * The queue serialises by ORDER, not by phone, so two orders placed minutes
   * apart are two records in flight at once. Without the borrowed deadline
   * they would both send a picker and the customer would be asked the same
   * question twice, seconds apart.
   */
  it('two orders minutes apart ask once, and the second waits behind the first', async () => {
    const { clients, deps } = setup([codOrder(), codOrder({ id: 'gid://shopify/Order/12346', name: '#1235' })]);
    await A.onCodTimer('12345', deps);
    await A.onCodTimer('12346', { ...deps, now: new Date(NOW.getTime() + 60 * 1000) });

    expect(templateNames(clients.whatsapp)).toEqual(['language_select_v1']);
    expect(timerNames()).toContain('A-12346-lang_wait');
    // And one tap answers both.
    await language.onPick(PHONE, 'lang_hi', '12345', deps);
    await A.onCodTimer('12346', { ...deps, now: new Date(NOW.getTime() + 2 * 60 * 1000) });
    expect(templateNames(clients.whatsapp)).toEqual(['language_select_v1', 'cod_confirm_hi_v1', 'cod_confirm_hi_v1']);
  });

  /*
   * A skipped send is not a send. Stamping it would mean the picker is never
   * asked again once the staged rollout that skipped it is lifted, and the
   * confirmation would have been delayed for nothing.
   */
  it('a picker that was skipped rather than sent stamps nothing', async () => {
    const { clients, deps } = setup();
    skip(clients.whatsapp, 'language_select_v1');
    await A.onCodTimer('12345', deps);

    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
    const st = await getState('12345');
    expect(st.flowA?.langAskAt).toBeFalsy();
    expect((await langState(PHONE)).askCount).toBe(0);
  });

  /*
   * Both picker versions are new, so both sit in Meta review at first. This is
   * the expected path on day one and it must not hold a confirmation.
   */
  it('a picker Meta refuses outright still lets the confirmation go', async () => {
    const { clients, deps } = setup();
    refuse(clients.whatsapp, ['language_select_v1', 'language_select_plain_v1']);
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
    expect((await getState('12345')).flowA?.codConfirmAt).toBeTruthy();
  });

  it('runs after the other gates, so an opted-out order is not delayed by it', async () => {
    await setOptOut(PHONE, true);
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual([]);
    expect((await getState('12345')).flowA?.codSkip).toBe('opted-out');
  });

  it('does not ask on an order that has already shipped', async () => {
    const shipped = codOrder();
    shipped.fulfillments = [{ id: 'f1', status: 'SUCCESS', trackingInfo: [{ number: '59152210001142', company: 'Delhivery' }] }];
    const { clients, deps } = setup([shipped]);
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual([]);
    expect((await getState('12345')).flowA?.codSkip).toBe('already-fulfilled');
  });

  it('askMode off means no picker, but a stored language is still honoured', async () => {
    withLanguage({ askMode: 'off' });
    await setLang(PHONE, 'hi');
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_hi_v1']);
  });
});

/* ------------------------------------------------------------------ */

describe('a tap is never met with silence', () => {
  beforeEach(() => withLanguage());

  it('sets the language of the tapping phone and nothing else', async () => {
    const { deps } = setup();
    await language.onPick(PHONE, 'lang_hi', '12345', deps);
    expect(await getLang(PHONE)).toBe('hi');
    expect(await getLang(OTHER_PHONE)).toBe('en');
    expect((await getProfile(PHONE)).langSource).toBe('picker');
  });

  /*
   * Flow L is dispatched BEFORE the ownership gate, so this payload reaches
   * onPick. A clear-text payload carrying somebody else's order must set the
   * TAPPER'S language, which is theirs to set, and touch that order not at all.
   */
  it('a tap carrying a stranger order sets the tapper language and leaves that order alone', async () => {
    const { clients, deps } = setup();
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: OTHER_PHONE, name: '#1234' });

    await language.onPick(PHONE, 'lang_hi', '12345', deps);

    expect(await getLang(PHONE)).toBe('hi');
    expect(await getLang(OTHER_PHONE)).toBe('en');
    expect(templateNames(clients.whatsapp)).toEqual([]);
    const st = await getState('12345');
    expect(st.flowA?.codConfirmAt).toBeFalsy();
    // The tapper still got an answer, on their own phone.
    expect(clients.whatsapp.sent.some((x) => x.to === PHONE && x.type === 'text')).toBe(true);
  });

  it('a late tap, after the English confirmation already went, resends it once in Hindi', async () => {
    const { clients, deps } = setup();
    await setLang(PHONE, 'en');
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);

    await language.onPick(PHONE, 'lang_hi', '12345', deps);
    // cod_reminder, not cod_confirm: "we are still holding your order" is true
    // of an order that has been confirmed-to but not tapped, and
    // "ready to be packed" has already been said.
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3', 'cod_reminder_hi_v1']);
  });

  it('tapping the same thing twice does not send a third copy, and is still answered', async () => {
    const { clients, deps } = setup();
    await setLang(PHONE, 'en');
    await A.onCodTimer('12345', deps);
    await language.onPick(PHONE, 'lang_hi', '12345', deps);
    const after = clients.whatsapp.sent.length;

    await language.onPick(PHONE, 'lang_hi', '12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3', 'cod_reminder_hi_v1']);
    // Something came back. Silence after a button press is the failure here.
    expect(clients.whatsapp.sent.length).toBeGreaterThan(after);
  });

  it('answers with the receipt when there is no order to speak of', async () => {
    const { clients, deps } = setup();
    await language.onPick(PHONE, 'lang_hi', 'owner', deps);
    expect(clients.whatsapp.sent).toHaveLength(1);
    expect(clients.whatsapp.sent[0].body).toBe(renderSession('language_set', {}, { lang: 'hi' }).body);
  });

  it('ignores an action it does not recognise rather than guessing a language', async () => {
    const { clients, deps } = setup();
    await language.onPick(PHONE, 'lang_fr', '12345', deps);
    await language.onPick(PHONE, 'nonsense', '12345', deps);
    expect(await getLang(PHONE)).toBe('en');
    expect(clients.whatsapp.sent).toEqual([]);
  });

  it('an opted-out customer can still choose, and still gets the acknowledgement', async () => {
    await setOptOut(PHONE, true);
    const { clients, deps } = setup();
    await language.onPick(PHONE, 'lang_hi', 'owner', deps);
    expect(await getLang(PHONE)).toBe('hi');
    expect(clients.whatsapp.sent).toHaveLength(1);
  });

  it('a typed keyword switches both ways and says so in the new language', async () => {
    const { clients, deps } = setup();
    await language.onKeyword(PHONE, 'hi', deps);
    expect(await getLang(PHONE)).toBe('hi');
    expect(clients.whatsapp.sent.at(-1).body).toBe(renderSession('language_set', {}, { lang: 'hi' }).body);

    await language.onKeyword(PHONE, 'en', deps);
    expect(await getLang(PHONE)).toBe('en');
    expect(clients.whatsapp.sent.at(-1).body).toBe(renderSession('language_set', {}, { lang: 'en' }).body);
    expect((await getProfile(PHONE)).langSource).toBe('keyword');
  });

  it('shows the picker, with a greeting rather than a hole, when they ask for it', async () => {
    const { clients, deps } = setup();
    await language.onShowPicker(PHONE, deps);
    const sent = clients.whatsapp.sent.at(-1);
    expect(sent.type).toBe('buttons');
    expect(sent.body).not.toMatch(/Hello\s*,/);
    expect(sent.buttons.map((b) => b.id)).toEqual(['v1|L|undefined|lang_en', 'v1|L|undefined|lang_hi']);
  });
});

/* ------------------------------------------------------------------ */

describe('the owner setting a language by hand', () => {
  beforeEach(() => withLanguage());

  it('sets the ORDER customer language, not the owner own handset', async () => {
    const { deps } = setup();
    const r = await language.onOwnerRequest('1234 hi', deps, OTHER_PHONE);
    expect(r.reply).toMatch(/#1234/);
    expect(await getLang(PHONE)).toBe('hi');
    expect(await getLang(OTHER_PHONE)).toBe('en');
    expect((await getProfile(PHONE)).langSource).toBe('owner');
  });

  it('refuses a language it does not have, and says what it does have', async () => {
    const { deps } = setup();
    const r = await language.onOwnerRequest('1234 fr', deps, OTHER_PHONE);
    expect(r.reply).toMatch(/en and hi|hi/);
    expect(await getLang(PHONE)).toBe('en');
  });

  it('explains itself when the arguments are missing', async () => {
    const { deps } = setup();
    expect((await language.onOwnerRequest('', deps, OTHER_PHONE)).reply).toMatch(/\/lang 1214 hi/);
    expect((await language.onOwnerRequest('1234', deps, OTHER_PHONE)).reply).toMatch(/\/lang 1214 hi/);
  });

  it('says so when it cannot find the order', async () => {
    const { deps } = setup();
    expect((await language.onOwnerRequest('9999 hi', deps, OTHER_PHONE)).reply).toMatch(/cannot find/);
  });
});

/* ------------------------------------------------------------------ */

describe('rendering a session message in Hindi', () => {
  const CTX = { orderId: '12345' };

  /*
   * ctx.actions was keyed by BUTTON TITLE TEXT, which is the one thing about a
   * button that a translation changes. These two messages carry per-order ids
   * in their payloads, so a lookup that misses finds a null action and throws:
   * the customer taps and nothing whatsoever happens.
   */
  it('vc_pick_option carries the same actions in Hindi as in English', () => {
    const vars = { item_desc: 'Bandhan, Size M' };
    const actions = { pick_size: 'vcos:1', pick_colour: 'vcoc:1' };
    const en = renderSession('vc_pick_option', { item_desc: 'Bandhan, size M' }, { ...CTX, actions });
    const hi = renderSession('vc_pick_option', vars, { ...CTX, lang: 'hi', actions });

    expect(hi.buttons.map((b) => b.id)).toEqual(en.buttons.map((b) => b.id));
    // And the titles really did change, or this test proves nothing.
    expect(hi.buttons.map((b) => b.title)).not.toEqual(en.buttons.map((b) => b.title));
  });

  it('vc_confirm routes correctly in Hindi', () => {
    const vars = { customer_name: 'Aarav', order_number: '#1234', from_desc: 'a', to_desc: 'b', order_total: 'Rs 1,499' };
    const actions = { confirm_change: 'vcok:1:101' };
    const en = renderSession('vc_confirm', vars, { ...CTX, actions });
    const hi = renderSession('vc_confirm', vars, { ...CTX, lang: 'hi', actions });
    expect(hi.buttons.map((b) => b.id)).toEqual(en.buttons.map((b) => b.id));
    expect(hi.buttons[0].id).toBe('v1|A|12345|vcok:1:101');
  });

  it('a Hindi button title still throws loudly if a call site forgets its action', () => {
    expect(() => renderSession('vc_confirm', {
      customer_name: 'Aarav', order_number: '#1', from_desc: 'a', to_desc: 'b', order_total: 'Rs 1',
    }, { ...CTX, lang: 'hi' })).toThrow(/needs ctx.actions/);
  });

  it('rto_reason_session rows carry Hindi titles and unchanged actions', () => {
    const rows = [
      { action: 'rto_not_available', title: 'घर पर कोई नहीं था' },
      { action: 'rto_other', title: 'कोई और कारण' },
    ];
    const hi = renderSession('rto_reason_session', { customer_name: 'Aarav', order_number: '#1234' }, { ...CTX, lang: 'hi', rows });
    expect(hi.rows.map((r) => r.id)).toEqual(['v1|C|12345|rto_not_available', 'v1|C|12345|rto_other']);
    expect(hi.rows.map((r) => r.title)).toEqual(['घर पर कोई नहीं था', 'कोई और कारण']);
  });

  /*
   * Meta's caps are measured on the RENDERED string. Hindi is typically longer
   * than English, and the values that get interpolated are the longest things
   * in the message: a product title and an amount.
   */
  it('every Hindi button, row title and cta survives the longest real values', () => {
    const LONG = 'Khili Dhoop Chanderi Silk Anarkali';
    const vars = {
      customer_name: 'Aarav', order_number: '#12345', item_line: `${LONG}, Size XXL, 3 पीस`,
      item_desc: `${LONG}, Size XXL`, from_desc: `${LONG}, Size M`, to_desc: `${LONG}, Size XXL`,
      order_total: 'Rs 1,49,999', cod_total: 'Rs 1,49,999', prepaid_total: 'Rs 1,34,999',
      new_total: 'Rs 1,34,999', saving: 'Rs 15,000', code: 'MORPAANKHAARAV4729',
      expires_at: 'कल रात 11:59 बजे', time_left: '23 घंटे 55 मिनट', min_order: 'Rs 1,500',
      top_picks: `${LONG}, Bandhan और Morani`, gift_line: 'x', valid_until: '21 Sep, 8:00 PM',
      amount_paid: 'Rs 1,34,999', cod_amount: 'Rs 1,49,999', refund_eta: '5 से 7 कार्य दिवस',
      delivered_date: '20 Sep', attempt_date: '20 Sep', awb: '59152210001142', pay_line: 'x',
      return_item: `${LONG}, Size M`, new_item: `${LONG}, Size XXL`, payment_line: 'x',
      courier: 'Delhivery', text: 'x', percent: '5', date: '20 Sep', total: 'Rs 500', amount: 'Rs 200',
    };
    for (const key of Object.keys(SESSION_HI)) {
      const m = SESSION_HI[key];
      const actions = Object.fromEntries((m.buttons || []).filter((b) => !b.action).map((b) => [b.id, 'a:1']));
      const rows = m.type === 'list' ? [{ action: 'r1', title: 'XXL' }] : undefined;
      const r = renderSession(key, vars, { ...CTX, lang: 'hi', actions, rows, url: 'https://x' });
      for (const b of r.buttons || []) expect(b.title.length, `${key} button "${b.title}"`).toBeLessThanOrEqual(20);
      for (const row of r.rows || []) expect(row.title.length, `${key} row "${row.title}"`).toBeLessThanOrEqual(24);
      if (r.buttonText) expect(r.buttonText.length, `${key} cta "${r.buttonText}"`).toBeLessThanOrEqual(20);
      expect(r.body.length, `${key} body`).toBeLessThanOrEqual(4096);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('through the router, where a real tap and a real text arrive', () => {
  let quiet;
  beforeEach(async () => {
    withLanguage();
    config.ownerAlertPhones = ['+919999999999'];
    config.replaceAdminPhones = [];
    // The downstream flow handlers reach the REAL Shopify client, which
    // rejects. Every call below is wrapped in soft(), so the noise is the
    // point of failure being logged rather than thrown.
    quiet = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    vi.spyOn(realClients.whatsapp, 'sendText').mockImplementation(async () => ({ messageId: 'x' }));
    vi.spyOn(realClients.whatsapp, 'sendButtons').mockImplementation(async () => ({ messageId: 'x' }));
  });
  afterEach(() => {
    for (const s of quiet) s.mockRestore();
    vi.restoreAllMocks();
  });

  const tap = (from, payload) => routes.wa_inbound({ kind: 'wa_inbound', from, msg: { button: { payload } } });
  const text = (from, body) => routes.wa_inbound({ kind: 'wa_inbound', from, msg: { text: { body } } });

  it('dispatches an L tap, before the ownership gate that would have refused it', async () => {
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: OTHER_PHONE, name: '#1234' });
    // ownsOrder would refuse this tap outright. Flow L is dispatched above it.
    await tap(PHONE, 'v1|L|12345|lang_hi');
    expect(await getLang(PHONE)).toBe('hi');
  });

  it('switches on a typed keyword, in either script', async () => {
    await text(PHONE, 'HINDI');
    expect(await getLang(PHONE)).toBe('hi');
    await text(PHONE, 'अंग्रेजी');
    expect(await getLang(PHONE)).toBe('en');
    await text(PHONE, '  हिंदी  ');
    expect(await getLang(PHONE)).toBe('hi');
  });

  /*
   * The half that matters. Somebody writing about Hindi is not asking for it,
   * and switching their language over a passing mention would be worse than
   * doing nothing at all.
   */
  it('does nothing at all for a keyword buried in a sentence', async () => {
    await text(PHONE, 'my daughter speaks HINDI at home');
    await text(PHONE, 'english please');
    expect((await getProfile(PHONE)).lang).toBeUndefined();
  });

  it('STOP still wins over everything, including a language keyword in the same breath', async () => {
    await text(PHONE, 'STOP');
    expect((await getProfile(PHONE)).optOut).toBe(true);
    // And they can still choose a language afterwards: an opt-out stops what
    // we start, not what they ask for.
    await text(PHONE, 'HINDI');
    expect(await getLang(PHONE)).toBe('hi');
  });
});

/* ------------------------------------------------------------------ */

describe('a picker that WhatsApp accepted and then failed to deliver', () => {
  let quiet;
  beforeEach(async () => {
    withLanguage();
    config.ownerAlertPhones = ['+919999999999'];
    quiet = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    await ensureState('12345', {});
    await patchState('12345', { verifiedPhone: PHONE, name: '#1234' });
    await patchFlowA('12345', { langAskAt: NOW.toISOString() });
    await recordMessage('12345', 'wamid.LANG', { key: 'language_select', template: 'language_select_v1' });
  });
  afterEach(() => {
    for (const s of quiet) s.mockRestore();
    vi.restoreAllMocks();
  });

  const failed = (code) => routes.wa_status({
    kind: 'wa_status',
    status: { id: 'wamid.LANG', status: 'failed', recipient_id: '919812345678', errors: [{ code, title: 'undeliverable' }] },
  });

  /*
   * Nothing had been said about the ORDER yet, so the usual treatment, tag it
   * wa-undeliverable and tell the owner "this customer has not been told", is
   * simply false here. What matters is that the confirmation stops waiting.
   */
  it('records that the picker failed, so the confirmation stops waiting on it', async () => {
    await failed(131026);
    expect((await getState('12345')).flowA?.langAskFailed).toBe(131026);
  });

  it('raises no owner alert and stamps no undeliverable, because the order is fine', async () => {
    await failed(131026);
    expect(await getSide('12345', 'send-failed:language_select')).toBeNull();
    expect((await getState('12345')).flowA?.undeliverableAt).toBeFalsy();
  });

  /*
   * 131049 and not 131026 here, deliberately. 131026 means the HANDSET cannot
   * receive WhatsApp at all, so it also parks the number as undeliverable and
   * the confirmation is then correctly skipped with an owner alert instead,
   * which is the next test. 131049 is a cap on this one message, so the
   * confirmation can and must still go.
   */
  it('and the gate then lets the confirmation through on the next pass', async () => {
    await failed(131049);
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    expect(templateNames(clients.whatsapp)).toEqual(['cod_confirm_v3']);
  });

  it('but a picker refused with 131026 parks the number, so the owner is told to phone them', async () => {
    config.ownerAlertPhones = [];
    await failed(131026);
    const { clients, deps } = setup();
    await A.onCodTimer('12345', deps);
    // Nothing sent to the customer, and the order records WHY, so the
    // reconcile sweep does not re-arm it three times and then alert.
    expect(templateNames(clients.whatsapp)).toEqual([]);
    expect((await getState('12345')).flowA?.codSkip).toBe('undeliverable');
  });

  it('a confirmation that fails is still treated as a customer who was not told', async () => {
    await recordMessage('12345', 'wamid.COD', { key: 'cod_confirm', template: 'cod_confirm_v3' });
    await routes.wa_status({
      kind: 'wa_status',
      status: { id: 'wamid.COD', status: 'failed', recipient_id: '919812345678', errors: [{ code: 131026, title: 'x' }] },
    });
    expect((await getState('12345')).flowA?.undeliverableAt).toBeTruthy();
  });
});
