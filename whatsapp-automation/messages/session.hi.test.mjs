import { describe, it, expect } from 'vitest';
import { SESSION, renderSession } from './session.mjs';
import { SESSION_HI } from './session.hi.mjs';

const DASH = /[–—]/;
const EMOJI = /\p{Extended_Pictographic}/u;

/*
 * Session keys that go to the OWNER or to a /replace admin. No Hindi: these
 * are the messages that tell them a flow has broken, and translating an
 * incident report makes it harder to read, not easier.
 */
const OWNER_ONLY = [
  'ops_digest_session', 'ops_alert_session', 'ops_reply', 'replace_confirm',
  'pnl_working', 'pnl_summary', 'pnl_usage', 'pnl_running', 'pnl_ledger_saved', 'pnl_failed',
];

/*
 * DEAD, and left English on purpose. sess() returns null for type 'html'
 * (send.mjs), and ingest/pay-redirect.mjs builds its own three pages inline
 * without ever calling renderSession. Translating it would be translating code
 * nothing can reach.
 */
const DEAD = ['pay_link_expired_page'];

/* Added BY the language feature, so they have no English-only twin to skip. */
const NEW_KEYS = ['language_select', 'language_set'];

const names = (s) => [...String(s || '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

const SAMPLES = {
  customer_name: 'Aarav', order_number: '#1234', order_total: 'Rs 1,499', new_total: 'Rs 1,399',
  cod_total: 'Rs 1,499', prepaid_total: 'Rs 1,349', saving: 'Rs 150', valid_until: '21 Sep, 8:00 PM',
  amount_paid: 'Rs 1,399', cod_amount: 'Rs 1,499', refund_eta: '5 to 7 working days',
  delivered_date: '20 Sep', attempt_date: '20 Sep', code: 'MORPAANKHAARAV47', percent: '5',
  min_order: 'Rs 1,500', date: '20 Sep', item_line: 'Khili Dhoop, Size M', expires_at: 'tomorrow at 9:20 PM',
  time_left: '2 hours', top_picks: 'Khili Dhoop, Bandhan and Morani', gift_line: 'a gift from us',
  text: 'a line of copy', awb: '59152210001142', item_desc: 'Khili Dhoop, Size M',
  from_desc: 'Size M', to_desc: 'Size XL', pay_line: 'pay by UPI', payment_line: 'keep Rs 1,499 ready',
  return_item: 'Noor, Size M', new_item: 'Noor, Size XL', courier: 'Delhivery',
};
const sample = (n) => SAMPLES[n] ?? `[${n}]`;

const CTX = { orderId: '1234567890', url: 'https://dry.run/pay', token: 'TESTTOKEN16CHARS' };
const ROWS = [{ action: 'vcs:1:101', title: 'M' }, { action: 'vcs:1:102', title: 'L', description: 'in stock' }];

const renderHi = (key) => {
  const m = SESSION_HI[key];
  const vars = {};
  for (const n of [...names(m.body), ...names(m.ctaText)]) vars[n] = sample(n);
  const actions = Object.fromEntries((m.buttons || []).filter((b) => !b.action).map((b) => [b.id, 'vcok:1:101']));
  return renderSession(key, vars, { ...CTX, lang: 'hi', rows: m.type === 'list' ? ROWS : undefined, actions });
};

describe('every customer session message has Hindi, and no owner one does', () => {
  it('covers exactly the customer-facing keys, plus the two the feature adds', () => {
    const want = [...Object.keys(SESSION).filter((k) => !OWNER_ONLY.includes(k) && !DEAD.includes(k)), ...NEW_KEYS];
    expect(Object.keys(SESSION_HI).sort()).toEqual([...new Set(want)].sort());
  });

  it('leaves the owner messages and the dead page in English', () => {
    for (const k of [...OWNER_ONLY, ...DEAD]) expect(SESSION_HI[k], k).toBeUndefined();
  });

  it('the two new keys exist in English too, or there is nothing to fall back to', () => {
    for (const k of NEW_KEYS) expect(SESSION[k], `SESSION.${k}`).toBeTruthy();
  });
});

describe('parity with the English session message', () => {
  for (const key of Object.keys(SESSION_HI)) {
    const hi = SESSION_HI[key];
    const en = SESSION[key];
    describe(key, () => {
      it('same type', () => {
        expect(hi.type).toBe(en.type);
      });
      it('same placeholder set in the body', () => {
        expect(names(hi.body)).toEqual(names(en.body));
      });
      it('same placeholder set in the cta text', () => {
        expect(names(hi.ctaText)).toEqual(names(en.ctaText));
      });
      it('same buttons: same ids, flows and actions, in the same order', () => {
        const shape = (b) => ({ id: b.id, flow: b.flow, action: b.action ?? null });
        expect((hi.buttons || []).map(shape)).toEqual((en.buttons || []).map(shape));
      });
      it('same list shape and the same flow for its rows', () => {
        expect(Boolean(hi.listButton)).toBe(Boolean(en.listButton));
        expect(hi.flow ?? null).toBe(en.flow ?? null);
      });
    });
  }
});

describe('Meta caps, over the rendered Hindi', () => {
  for (const key of Object.keys(SESSION_HI)) {
    const m = SESSION_HI[key];
    it(`${key}: body <= 4096, <= 3 buttons with titles <= 20, list button <= 20`, () => {
      expect(m.body.length).toBeLessThanOrEqual(4096);
      if (m.buttons) {
        expect(m.buttons.length).toBeLessThanOrEqual(3);
        for (const b of m.buttons) expect(b.title.length, b.title).toBeLessThanOrEqual(20);
      }
      if (m.type === 'list') {
        expect(m.listButton, `${key} needs a listButton`).toBeTruthy();
        expect(m.listButton.length, m.listButton).toBeLessThanOrEqual(20);
        expect(m.buttons, `${key} is a list, it cannot also carry buttons`).toBeUndefined();
      }
    });
    /*
     * RENDERED, not declared. The English suite only length-checks two of the
     * seven cta texts, and a cta carrying an amount ("Pay {{new_total}}") is
     * longer once it has a number in it. Hindi is typically longer than
     * English, so this is the cap most likely to bite.
     */
    it(`${key}: renders, and its cta stays <= 20 with real values in it`, () => {
      const r = renderHi(key);
      expect(r.body.length).toBeGreaterThan(0);
      if (r.buttonText) expect(r.buttonText.length, `${key} cta: ${r.buttonText}`).toBeLessThanOrEqual(20);
    });
  }
});

describe('no emoji, no en/em dash, and it is actually Devanagari', () => {
  for (const key of Object.keys(SESSION_HI)) {
    const m = SESSION_HI[key];
    it(key, () => {
      for (const s of [m.body, m.ctaText || '', m.listButton || '', ...(m.buttons || []).map((b) => b.title)]) {
        expect(EMOJI.test(s), JSON.stringify(s).slice(0, 60)).toBe(false);
        expect(DASH.test(s), JSON.stringify(s).slice(0, 60)).toBe(false);
      }
      expect(/[ऀ-ॿ]/.test(m.body), `${key} body has no Devanagari in it`).toBe(true);
    });
  }
});

describe('renderSession picks the Hindi body only when asked', () => {
  it('lang hi takes the Hindi twin', () => {
    const r = renderSession('optout_done', {}, { ...CTX, lang: 'hi' });
    expect(r.body).toBe(SESSION_HI.optout_done.body);
  });
  it('no lang, and lang en, both take the English one', () => {
    expect(renderSession('optout_done', {}, CTX).body).toBe(SESSION.optout_done.body);
    expect(renderSession('optout_done', {}, { ...CTX, lang: 'en' }).body).toBe(SESSION.optout_done.body);
  });
  it('a key with no Hindi twin falls back to English rather than throwing', () => {
    const r = renderSession('ops_reply', { text: 'hello' }, { ...CTX, lang: 'hi' });
    expect(r.body).toContain('hello');
  });
});
