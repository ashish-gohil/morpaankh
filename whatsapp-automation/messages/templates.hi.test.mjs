import { describe, it, expect } from 'vitest';
import { TEMPLATES, LEGACY, NO_PRICE, placeholderOrder, renderTemplateDef } from './templates.mjs';
import { TEMPLATES_HI, PLAIN_HI } from './templates.hi.mjs';

const DASH = /[–—]/;
const EMOJI = /\p{Extended_Pictographic}/u;

/*
 * The keys that belong to the OWNER and get no Hindi. ops_* and pnl_* go to
 * the owner's own handset, and translating the thing that tells them a flow
 * has broken would make an incident harder to read, not easier.
 */
const OWNER_ONLY = ['ops_alert', 'ops_error', 'ops_digest', 'pnl_report_ready'];

/* The words that make Meta reclassify a UTILITY template as MARKETING. */
const OFFER_WORDS = ['बचत', 'छूट', 'ऑफर', 'ऑफ़र', 'डिस्काउंट', 'गिफ्ट', 'मुफ़्त', 'मुफ्त', 'फ्री'];

const btnShape = (b) => ({
  kind: b.kind,
  flow: b.flow ?? null,
  action: b.action ?? null,
  path: b.path ?? null,
  base: b.base ?? null,
  flowKey: b.flowKey ?? null,
});

describe('every customer key has Hindi, and no owner key does', () => {
  it('covers every customer-facing template and nothing else', () => {
    const want = Object.keys(TEMPLATES).filter((k) => !OWNER_ONLY.includes(k)).sort();
    expect(Object.keys(TEMPLATES_HI).sort()).toEqual(want);
  });

  it('leaves the owner own messages in English', () => {
    for (const k of OWNER_ONLY) expect(TEMPLATES_HI[k], k).toBeUndefined();
  });

  it('PLAIN_HI covers exactly the keys whose English path has a no-image or no-price version', () => {
    // send.mjs reaches NO_PRICE[key] || LEGACY[key] when there is no product
    // photo or no prepaid price. Hindi needs a twin for the same keys, and the
    // IMAGE-header ones are the keys that can hit it.
    const want = ['cart_final', 'cart_recovery', 'cod_confirm', 'cod_reminder', 'order_confirmed', 'subscriber_offer'];
    expect(Object.keys(PLAIN_HI).sort()).toEqual(want);
  });
});

describe('a Hindi template is its own template at Meta', () => {
  const all = [...Object.entries(TEMPLATES_HI), ...Object.entries(PLAIN_HI)];
  const englishNames = new Set(
    [...Object.values(TEMPLATES), ...Object.values(LEGACY), ...Object.values(NO_PRICE)].map((t) => t.name),
  );

  it('every name is new, distinct, marked _hi_ and declared language hi', () => {
    const seen = new Set();
    for (const [key, t] of all) {
      expect(t.language, `${key} language`).toBe('hi');
      expect(t.name, `${key} name`).toMatch(/_hi_v\d+$/);
      expect(englishNames.has(t.name), `${t.name} collides with an English template`).toBe(false);
      expect(seen.has(t.name), `${t.name} is declared twice`).toBe(false);
      seen.add(t.name);
    }
  });
});

describe('parity with the English twin', () => {
  const pairs = [
    ...Object.keys(TEMPLATES_HI).map((k) => [`TEMPLATES_HI.${k}`, TEMPLATES_HI[k], TEMPLATES[k]]),
    ...Object.keys(PLAIN_HI).map((k) => [`PLAIN_HI.${k}`, PLAIN_HI[k], NO_PRICE[k] || LEGACY[k]]),
  ];

  for (const [label, hi, en] of pairs) {
    describe(label, () => {
      it('has an English twin to be parity with', () => {
        expect(en, `${label} has no English counterpart`).toBeTruthy();
      });
      it('same category', () => {
        expect(hi.category).toBe(en.category);
      });
      it('same header format', () => {
        expect(hi.header?.format ?? null).toBe(en.header?.format ?? null);
        if (hi.header?.format === 'IMAGE') expect(hi.header.sample).toMatch(/^https:\/\//);
      });
      it('same placeholder set, in any order', () => {
        expect(placeholderOrder(hi.body).sort()).toEqual(placeholderOrder(en.body).sort());
      });
      it('same footer presence', () => {
        expect(Boolean(hi.footer)).toBe(Boolean(en.footer));
      });
      it('same buttons: count, kind, flow, action, url path or base', () => {
        expect((hi.buttons || []).map(btnShape)).toEqual((en.buttons || []).map(btnShape));
      });
      it('renders, with every placeholder given an example', () => {
        for (const n of placeholderOrder(hi.body)) expect(hi.examples[n], `example for ${n}`).toBeDefined();
        const r = renderTemplateDef(hi, hi.examples, {
          orderId: '998',
          token: 'TESTTOKEN16CHARS',
          flowToken: 'ft.exp.sig',
          imageUrl: 'https://cdn.shopify.com/s/files/1/x/sample.jpg?width=800&height=800&crop=center',
        });
        expect(r.language).toBe('hi');
        expect(r.name).toBe(hi.name);
      });
    });
  }
});

describe('Meta shape rules, over the Hindi registries', () => {
  const all = [...Object.entries(TEMPLATES_HI), ...Object.entries(PLAIN_HI)];
  for (const [key, t] of all) {
    describe(`${key} (${t.name})`, () => {
      it('body <= 1024', () => {
        expect(t.body.length).toBeLessThanOrEqual(1024);
      });
      it('footer <= 60, button text <= 25, <= 10 buttons', () => {
        if (t.footer) expect(t.footer.length).toBeLessThanOrEqual(60);
        expect((t.buttons || []).length).toBeLessThanOrEqual(10);
        for (const b of t.buttons || []) expect(b.text.length, b.text).toBeLessThanOrEqual(25);
      });
      it('no placeholder at the very start or end, none adjacent', () => {
        expect(/^\s*\{\{/.test(t.body)).toBe(false);
        expect(/\}\}[\s।.,;:!?)"']*$/.test(t.body)).toBe(false);
        expect(/\}\}\s*\{\{/.test(t.body)).toBe(false);
      });
      it('no emoji and no en/em dash', () => {
        for (const s of [t.body, t.footer || '', ...(t.buttons || []).map((b) => b.text), ...Object.values(t.examples)]) {
          expect(EMOJI.test(s), JSON.stringify(s).slice(0, 60)).toBe(false);
          expect(DASH.test(s), JSON.stringify(s).slice(0, 60)).toBe(false);
        }
      });
      it('is written in Devanagari, not transliterated English', () => {
        // A body with no Devanagari at all is a copy mistake, not Hindi.
        expect(/[ऀ-ॿ]/.test(t.body), t.name).toBe(true);
      });
    });
  }

  /*
   * A UTILITY template that talks about a saving invites Meta to reclassify it
   * as MARKETING, which puts opt-in, a per-customer cap and about seven times
   * the price on every order confirmation. The English registry has carried
   * this rule in prose since cod_confirm_v3; here it is a test.
   */
  for (const [key, t] of all) {
    if (t.category !== 'UTILITY') continue;
    it(`${key} is UTILITY and carries no offer wording`, () => {
      for (const w of OFFER_WORDS) expect(t.body.includes(w), `${t.name} contains ${w}`).toBe(false);
    });
  }

  it('the marketing footer keeps STOP in Latin, so the keyword still works', () => {
    for (const [, t] of all) {
      if (!t.footer) continue;
      expect(t.footer).toContain('STOP');
    }
  });
});

/*
 * A body that names a button has to name the Hindi one. "Tap Change or cancel"
 * translated while the button still reads something else is an instruction the
 * customer cannot follow.
 */
describe('a body that names a button uses that button\'s Hindi text', () => {
  const NAMED = {
    cod_confirm: 'बदलें या रद्द करें',
    cod_reminder: 'बदलें या रद्द करें',
    prepaid_offer: 'COD ही रखें',
  };
  for (const [key, title] of Object.entries(NAMED)) {
    it(`${key} names ${title}`, () => {
      const t = TEMPLATES_HI[key];
      expect(t.body).toContain(title);
      expect(t.buttons.some((b) => b.text === title), `${key} has no button titled ${title}`).toBe(true);
    });
  }
});

/*
 * order_shipped fires on a Shopify fulfillment, which means a label and a
 * waybill exist and nothing has moved. The English twin has a test for this
 * because four real orders were told their parcel had left while Delhivery
 * still read MANIFESTED. The Hindi one can make the same false claim in
 * different words, so it gets the same test.
 */
describe('the Hindi dispatch message does not claim the parcel has moved', () => {
  it('makes no claim of movement', () => {
    const body = TEMPLATES_HI.order_shipped.body;
    for (const claim of ['निकल चुका', 'रास्ते में', 'भेज दिया', 'डिस्पैच हो गया', 'रवाना']) {
      expect(body.includes(claim), `order_shipped_hi says "${claim}"`).toBe(false);
    }
  });
  it('and it says tracking only starts once the courier collects it', () => {
    expect(TEMPLATES_HI.order_shipped.body).toContain('उठा लेने के बाद');
  });
});
