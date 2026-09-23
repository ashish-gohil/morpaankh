import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TEMPLATES, LEGACY, renderTemplate, toPositionalBody, placeholderOrder } from './templates.mjs';
import { SESSION, renderSession } from './session.mjs';
import * as labels from './labels.mjs';

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
    });
  }
  it('cta display text stays <= 20 when rendered', () => {
    for (const key of ['confirmed_with_offer', 'pay_online_offer']) {
      const r = renderSession(key, sampleVars(key), { url: 'https://x' });
      expect(r.buttonText.length, `${key} cta`).toBeLessThanOrEqual(20);
    }
  });
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
    labels.THEME_WHATSAPP_NOTICE,
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

const IMG = 'https://cdn.shopify.com/s/files/1/x/sample.jpg?width=800&height=800&crop=center';

// sample vars for session cta rendering
function sampleVars(key) {
  const base = { customer_name: 'A', order_number: '#1', new_total: 'Rs 1,499', order_total: 'Rs 1,599', saving: 'Rs 100', valid_until: '21 Sep' };
  return base;
}
