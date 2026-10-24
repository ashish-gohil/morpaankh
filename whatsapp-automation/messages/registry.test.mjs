import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TEMPLATES, LEGACY, renderTemplate, toPositionalBody, placeholderOrder } from './templates.mjs';
import { SESSION, renderSession, OFFER_GIFT_LINE, OFFER_NO_GIFT_LINE } from './session.mjs';
import * as labels from './labels.mjs';
import { CART_PAGES } from './pages.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const flowJson = readFileSync(join(HERE, 'flows', 'review.flow.json'), 'utf8');

const DASH = /[–—]/; // en dash / em dash
const EMOJI = /\p{Extended_Pictographic}/u;
const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];

describe('template registry shape (Meta rules)', () => {
  for (const [key, t] of [...Object.entries(TEMPLATES), ...Object.entries(LEGACY)]) {
    describe(key, () => {
      it('body <= 1024 and valid category', () => {
        expect(t.body.length).toBeLessThanOrEqual(1024);
        expect(CATEGORIES).toContain(t.category);
      });
      it('no placeholder at the very start or end, none adjacent', () => {
        expect(/^\s*\{\{/.test(t.body)).toBe(false);
        // Trailing punctuation does not rescue a trailing variable: Meta
        // rejects "...open until {{valid_until}}." with error_subcode 2388299,
        // "Variables can't be at the start or end of the template".
        expect(/\}\}[\s.,;:!?)"']*$/.test(t.body)).toBe(false);
        expect(/\}\}\s*\{\{/.test(t.body)).toBe(false);
      });
      it('every placeholder has an example', () => {
        for (const name of placeholderOrder(t.body)) expect(t.examples[name], `example for ${name}`).toBeDefined();
      });
      it('footer <= 60; button text <= 25; <= 10 buttons', () => {
        if (t.footer) expect(t.footer.length).toBeLessThanOrEqual(60);
        expect((t.buttons || []).length).toBeLessThanOrEqual(10);
        for (const b of t.buttons || []) expect(b.text.length, b.text).toBeLessThanOrEqual(25);
      });
    });
  }
});

describe('session registry shape', () => {
  for (const [key, m] of Object.entries(SESSION)) {
    it(`${key}: body <= 4096, buttons <= 3 with titles <= 20`, () => {
      expect(m.body.length).toBeLessThanOrEqual(4096);
      if (m.buttons) {
        expect(m.buttons.length).toBeLessThanOrEqual(3);
        for (const b of m.buttons) expect(b.title.length, b.title).toBeLessThanOrEqual(20);
      }
      // A list message's own caps, from Meta's Cloud API docs: the list button
      // text is 20 characters, and a list with no button cannot be opened at
      // all. Rows are per-order so they are checked where they are built.
      if (m.type === 'list') {
        expect(m.listButton, `${key} needs a listButton`).toBeTruthy();
        expect(m.listButton.length, m.listButton).toBeLessThanOrEqual(20);
        expect(m.buttons, `${key} is a list, it cannot also carry buttons`).toBeUndefined();
      }
    });
  }
  it('cta display text stays <= 20 when rendered', () => {
    for (const key of ['confirmed_with_offer', 'pay_online_offer']) {
      const r = renderSession(key, sampleVars(key), { url: 'https://x' });
      expect(r.buttonText.length, `${key} cta`).toBeLessThanOrEqual(20);
    }
  });
});

describe('the dispatch message does not claim the parcel has moved', () => {
  /*
   * order_shipped fires on Shopify fulfillments/create, which only means a
   * label and an AWB exist. The courier has not collected anything yet, so any
   * wording that says the parcel has left, is on its way, or is out for
   * delivery is false for as long as it sits at MANIFESTED. Four live orders
   * (#1176, #1177, #1180, #1182) were told it had left while Delhivery still
   * read MANIFESTED.
   */
  it('TEMPLATES.order_shipped makes no claim of movement', () => {
    const body = TEMPLATES.order_shipped.body.toLowerCase();
    for (const claim of ['left us', 'on its way to you', 'out for delivery', 'dispatched', 'has shipped']) {
      expect(body).not.toContain(claim);
    }
  });

  it('and it warns that tracking is not live yet', () => {
    expect(TEMPLATES.order_shipped.body.toLowerCase()).toContain('once the courier collects it');
  });
});

/*
 * A session twin is the free-form version of a template, sent whenever the 24
 * hour window is open. Two files hold the same sentences, so the only thing
 * keeping them honest is this check: a customer must not be told two different
 * stories about the same parcel depending on which door the message went
 * through. Add a key here whenever a template gains a twin.
 */
describe('a template and its session twin say the same thing', () => {
  for (const key of ['replacement_raised', 'subscriber_offer']) {
    it(`${key} is word for word in both files`, () => {
      expect(SESSION[key], `SESSION.${key}`).toBeTruthy();
      expect(SESSION[key].body).toBe(TEMPLATES[key].body);
    });
  }
});

describe('no em/en dash and no emoji anywhere in customer copy', () => {
  const strings = [];
  for (const t of [...Object.values(TEMPLATES), ...Object.values(LEGACY)]) {
    strings.push(t.body, t.footer || '', ...(t.buttons || []).map((b) => b.text), ...Object.values(t.examples));
  }
  for (const m of Object.values(SESSION)) {
    strings.push(m.body, m.ctaText || '', ...(m.buttons || []).map((b) => b.title));
  }
  strings.push(
    ...labels.RTO_REASONS.map((r) => r.label),
    ...labels.NDR_OPTIONS.map((o) => o.label),
    ...Object.values(labels.COURIER_STATUS_TEXT),
    OFFER_GIFT_LINE,
    OFFER_NO_GIFT_LINE,
    labels.THEME_WHATSAPP_NOTICE,
    ...Object.values(CART_PAGES).flatMap((pg) => [pg.heading, pg.button]),
    labels.ORDER_EDIT_DISCOUNT_DESCRIPTION,
    flowJson,
  );
  it('contains no en/em dash', () => {
    for (const s of strings) expect(DASH.test(s), JSON.stringify(s).slice(0, 80)).toBe(false);
  });
  it('contains no emoji', () => {
    for (const s of strings) expect(EMOJI.test(s), JSON.stringify(s).slice(0, 80)).toBe(false);
  });
});

describe('rendering', () => {
  it('toPositionalBody maps names to {{1}}..{{n}} in order', () => {
    expect(toPositionalBody('Hi {{a}} and {{b}} then {{a}}')).toBe('Hi {{1}} and {{2}} then {{1}}');
  });
  it('renderTemplate throws on a missing var but tolerates an extra one', () => {
    expect(() => renderTemplate('cod_confirm', { customer_name: 'A' }, { orderId: '1', imageUrl: IMG })).toThrow(/missing vars/);
    // Extras are allowed on purpose: callers pass the union of the current
    // template's placeholders and its LEGACY fallback's, and only one of the
    // two is actually rendered.
    expect(() =>
      renderTemplate('cod_confirm', { ...TEMPLATES.cod_confirm.examples, extra: 'x' }, { orderId: '1', imageUrl: IMG }),
    ).not.toThrow();
  });
  it('renderTemplate builds header, body and quick-reply payloads', () => {
    const r = renderTemplate('cod_confirm', TEMPLATES.cod_confirm.examples, { orderId: '998', imageUrl: IMG });
    const header = r.components.find((c) => c.type === 'header');
    expect(header.parameters[0].image.link).toBe(IMG);
    const body = r.components.find((c) => c.type === 'body');
    expect(body.parameters).toHaveLength(5);
    const buttons = r.components.filter((c) => c.type === 'button');
    expect(buttons[0].parameters[0].payload).toBe('v1|A|998|pay_online');
  });
  it('an image-header template refuses to render without an image', () => {
    expect(() => renderTemplate('cod_confirm', TEMPLATES.cod_confirm.examples, { orderId: '1' })).toThrow(/imageUrl/);
  });
  it('renderSession builds button ids and validates vars', () => {
    const r = renderSession('cancel_check', { order_number: '#12' }, { orderId: '55' });
    expect(r.buttons[0].id).toBe('v1|A|55|cancel_yes');
    expect(() => renderSession('cancel_done', {})).toThrow(/missing vars/);
  });
});

describe('the LEGACY fallback contract that send.mjs relies on', () => {
  it('every image-header template has a fallback to send when there is no image', () => {
    for (const [key, t] of Object.entries(TEMPLATES)) {
      if (t.header?.format === 'IMAGE') expect(LEGACY[key], `${key} needs a LEGACY fallback`).toBeDefined();
    }
  });
  it('no fallback is orphaned, and none reuses its replacement name', () => {
    for (const [key, t] of Object.entries(LEGACY)) {
      expect(TEMPLATES[key], `LEGACY.${key} has no current version`).toBeDefined();
      expect(t.name).not.toBe(TEMPLATES[key].name);
    }
  });
  it('every image header carries a sample for the create-time upload', () => {
    for (const t of Object.values(TEMPLATES)) {
      if (t.header?.format === 'IMAGE') expect(t.header.sample).toMatch(/^https:\/\//);
    }
  });
});

/*
 * Flow W: the 24 hour private welcome offer.
 *
 * The body is asserted BYTE FOR BYTE rather than by keyword. It is the only
 * message a brand new customer ever gets from us, it carries a Rs 200 code and
 * a gift promise, and every sentence in it was written to a brief. A reworded
 * line is a decision, not a refactor, so it should have to be made here first.
 */
describe('the subscriber welcome offer copy', () => {
  const BODY =
    'Hello {{customer_name}}, thank you for joining Morpaankh.\n\n' +
    'To welcome you, we have made a special code just for you:\n\n' +
    '*{{code}}*\n\n' +
    'It takes *{{saving}} off* any order above {{min_order}}, and *a gift from us* comes wrapped in your parcel. ' +
    'It is yours alone, works once, and closes *{{expires_at}}*.\n\n' +
    'Most loved right now: {{top_picks}}.\n\n' +
    'Every piece is checked by hand before it leaves us, and what you see is exactly what arrives. ' +
    'Prepaid orders ship free.\n\n' +
    'Tap below and your code is applied for you.';

  it('says exactly what it was written to say', () => {
    expect(TEMPLATES.subscriber_offer.body).toBe(BODY);
  });

  it('is MARKETING, in English, with the opt-out footer that makes it legal', () => {
    const t = TEMPLATES.subscriber_offer;
    expect(t.name).toBe('subscriber_offer_v1');
    expect(t.language).toBe('en');
    // It carries an offer and a code, so it is MARKETING and it is capped by
    // marketingCapDays like every other one.
    expect(t.category).toBe('MARKETING');
    expect(t.footer).toBe('Reply STOP to stop these messages');
  });

  it('leads with the collection image, and has a plain twin for when there is none', () => {
    expect(TEMPLATES.subscriber_offer.header).toMatchObject({ format: 'IMAGE' });
    expect(TEMPLATES.subscriber_offer.header.sample).toMatch(/^https:\/\//);
    expect(LEGACY.subscriber_offer.name).toBe('subscriber_offer_plain_v1');
    expect(LEGACY.subscriber_offer.header).toBeUndefined();
    expect(LEGACY.subscriber_offer.body).toBe(BODY);
  });

  it('carries the /w/ link button and the Talk to us quick reply, in that order', () => {
    expect(TEMPLATES.subscriber_offer.buttons).toEqual([
      { kind: 'url', text: 'Shop best sellers', path: 'w', urlPattern: '{{public}}/w/{{token}}' },
      { kind: 'quick_reply', text: 'Talk to us', flow: 'W', action: 'help' },
    ]);
    // Same buttons on the plain twin, or the fallback silently drops the link.
    expect(LEGACY.subscriber_offer.buttons).toEqual(TEMPLATES.subscriber_offer.buttons);
  });

  /*
   * NO COPY_CODE BUTTON, for the same reason as Flow R: Meta caps that
   * button's code at 15 characters and MORPAANKH + a name + four digits is
   * always longer. The code sits in the body in bold instead.
   */
  it('does not try to use a copy-code button', () => {
    for (const b of TEMPLATES.subscriber_offer.buttons) expect(b.kind).not.toBe('copy_code');
  });

  it('shows the owner real examples, in rupees, with the SPEC figures', () => {
    expect(TEMPLATES.subscriber_offer.examples).toEqual({
      customer_name: 'Priya',
      code: 'MORPAANKHPRIYA4729',
      saving: '₹200',
      min_order: '₹1,500',
      expires_at: 'tomorrow at 11:00 AM',
      top_picks: 'Khili Dhoop, Bandhan and Morani',
    });
  });

  it('takes the same six placeholders in both versions', () => {
    const want = ['customer_name', 'code', 'saving', 'min_order', 'expires_at', 'top_picks'];
    expect(placeholderOrder(TEMPLATES.subscriber_offer.body)).toEqual(want);
    expect(placeholderOrder(LEGACY.subscriber_offer.body)).toEqual(want);
  });

  it('renders with an image header, body parameters and a url button parameter', () => {
    const r = renderTemplate('subscriber_offer', TEMPLATES.subscriber_offer.examples, { orderId: '25164544835956', token: 'tok_w', imageUrl: IMG });
    expect(r.name).toBe('subscriber_offer_v1');
    expect(r.components.find((c) => c.type === 'header').parameters[0].image.link).toBe(IMG);
    expect(r.components.find((c) => c.type === 'body').parameters).toHaveLength(6);
    const buttons = r.components.filter((c) => c.type === 'button');
    expect(buttons[0]).toMatchObject({ sub_type: 'url', index: '0' });
    expect(buttons[0].parameters[0].text).toBe('tok_w');
    expect(buttons[1].parameters[0].payload).toBe('v1|W|25164544835956|help');
  });

  /*
   * The session twin is what goes out inside an open 24 hour window, which is
   * also the only channel Meta's per-user marketing cap (131049) cannot
   * throttle. The registry field is `ctaText` with `type: 'cta_url'`; the URL
   * arrives at render time as ctx.url.
   */
  it('has a session twin shaped the way renderSession expects', () => {
    expect(SESSION.subscriber_offer.type).toBe('cta_url');
    expect(SESSION.subscriber_offer.ctaText).toBe('Shop best sellers');
    expect(SESSION.subscriber_offer.ctaText.length).toBeLessThanOrEqual(20);
    const r = renderSession('subscriber_offer', TEMPLATES.subscriber_offer.examples, { url: 'https://api.example/w/tok_w' });
    expect(r.type).toBe('cta_url');
    expect(r.url).toBe('https://api.example/w/tok_w');
    expect(r.body).toContain('MORPAANKHPRIYA4729');
  });
});

/*
 * The email is the same offer for somebody WhatsApp cannot reach, so it is
 * held to the same copy rules: no en or em dash, no emoji, and the same
 * promise in the same words.
 */
describe('the subscriber welcome email copy', () => {
  /*
   * Loaded per test rather than imported at the top of the file: a static
   * import of a module that does not exist yet would fail COLLECTION and take
   * every other test in this file with it.
   */
  const copy = async () => (await import('./email.mjs')).EMAIL.subscriber_offer;

  it('has the subject, the preheader, the heading and the small print', async () => {
    const EMAIL = { subscriber_offer: await copy() };
    expect(EMAIL.subscriber_offer.subject).toBe('{{first_name}}, your private welcome code closes tomorrow');
    expect(EMAIL.subscriber_offer.subjectNoName).toBe('Your private welcome code closes tomorrow');
    expect(EMAIL.subscriber_offer.preheader).toBe('₹200 off any order above ₹1,500, plus a gift in your parcel.');
    expect(EMAIL.subscriber_offer.heading).toBe('A private welcome, for the next 24 hours');
    expect(EMAIL.subscriber_offer.button).toBe('Shop best sellers');
    expect(EMAIL.subscriber_offer.smallPrint).toBe(
      'Single use. Valid on orders above ₹1,500 until {{expires_at}} IST. ' +
      'Cannot be combined with other codes. ' +
      'You are receiving this because you joined us at morpaankh.in.',
    );
  });

  it('says the same thing as the WhatsApp message, word for word', async () => {
    expect((await copy()).body).toBe(TEMPLATES.subscriber_offer.body);
  });

  it('contains no en or em dash and no emoji', async () => {
    for (const s of Object.values(await copy())) {
      expect(DASH.test(s), JSON.stringify(s).slice(0, 80)).toBe(false);
      expect(EMOJI.test(s), JSON.stringify(s).slice(0, 80)).toBe(false);
    }
  });

  it('never writes "Rs" where the rest of the copy writes the rupee symbol', async () => {
    for (const s of Object.values(await copy())) expect(s).not.toMatch(/\bRs\.?\s?\d/);
  });
});

const IMG = 'https://cdn.shopify.com/s/files/1/x/sample.jpg?width=800&height=800&crop=center';

// sample vars for session cta rendering
function sampleVars(key) {
  const base = { customer_name: 'A', order_number: '#1', new_total: 'Rs 1,499', order_total: 'Rs 1,599', saving: 'Rs 150', gift_line: 'a gift from us', valid_until: '21 Sep' };
  return base;
}
