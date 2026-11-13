import { describe, it, expect } from 'vitest';
import { lazy, isLazy, resolveVars, resolveRows, resolveLazy, str, STR, LANGS, langFromText, langName, normalizeLang, NAME_FALLBACK } from './lang.mjs';
import { sanitizeParam } from './templates.mjs';
import { renderSession } from './session.mjs';

const DASH = /[–—]/;
const EMOJI = /\p{Extended_Pictographic}/u;

/*
 * THE ONE FAILURE MODE THAT COULD REACH A HANDSET UNNOTICED.
 *
 * A lazy value is a phrase waiting for a language. If one is ever rendered
 * without being resolved, String() turns it into the literal text
 * "[object Object]" and that goes out in the middle of a real customer's
 * message with nothing anywhere complaining. Every render path calls String()
 * on its values, so throwing from toString turns a missed resolve into a test
 * failure instead of a word in a parcel.
 */
describe('an unresolved lazy value cannot reach a message', () => {
  const z = lazy((l) => `resolved-${l}`);

  it('throws rather than becoming "[object Object]" in a template parameter', () => {
    expect(() => sanitizeParam(z)).toThrow(/unresolved lazy/);
  });
  it('throws rather than becoming "[object Object]" in a session body', () => {
    expect(() => renderSession('cancel_done', { order_number: z })).toThrow(/unresolved lazy/);
  });
  it('throws inside a plain template literal, which is how an owner alert builds text', () => {
    expect(() => `${z}`).toThrow(/unresolved lazy/);
  });
  it('throws rather than being written to DynamoDB as {}', () => {
    expect(() => JSON.stringify({ z })).toThrow(/cannot be stored/);
  });
  it('resolves to the right language when it is used properly', () => {
    expect(z.resolve('hi')).toBe('resolved-hi');
    expect(resolveLazy(z, 'en')).toBe('resolved-en');
    expect(resolveLazy('plain', 'hi')).toBe('plain');
  });
});

describe('resolveVars', () => {
  it('returns the SAME object when nothing in it is lazy, so the English path allocates nothing', () => {
    const vars = { a: '1', b: '2' };
    expect(resolveVars(vars, 'en')).toBe(vars);
  });
  it('resolves every lazy value and leaves the rest alone', () => {
    const out = resolveVars({ a: lazy((l) => l), b: 'plain' }, 'hi');
    expect(out).toEqual({ a: 'hi', b: 'plain' });
  });
  it('resolves row titles and descriptions but never a row action', () => {
    const rows = [{ action: 'rto_other', title: lazy((l) => `t-${l}`), description: lazy((l) => `d-${l}`) }];
    expect(resolveRows(rows, 'hi')).toEqual([{ action: 'rto_other', title: 't-hi', description: 'd-hi' }]);
  });
  it('tolerates null and a non-array where rows are expected', () => {
    expect(resolveVars(null, 'hi')).toBe(null);
    expect(resolveRows(undefined, 'hi')).toBe(undefined);
  });
  it('isLazy only says yes to a real one', () => {
    expect(isLazy(lazy(() => 'x'))).toBe(true);
    expect(isLazy({ fn: () => 'x' })).toBe(false);
  });
});

describe('the fragment table', () => {
  it('has the same keys in both languages, or a Hindi message keeps an English word', () => {
    expect(Object.keys(STR.hi).sort()).toEqual(Object.keys(STR.en).sort());
  });

  it('every key is the same KIND in both, so an argument cannot go missing', () => {
    for (const k of Object.keys(STR.en)) {
      expect(typeof STR.hi[k], k).toBe(typeof STR.en[k]);
      if (typeof STR.en[k] === 'function') expect(STR.hi[k].length, `${k} arity`).toBe(STR.en[k].length);
    }
  });

  /*
   * registry.test.mjs runs this over the registries. It never ran over the
   * fragments, and these are the strings most likely to be written quickly:
   * they are one line each, in a table, away from the copy.
   */
  it('contains no emoji and no en or em dash, in either language', () => {
    for (const l of LANGS) {
      for (const [k, v] of Object.entries(STR[l])) {
        const rendered = typeof v === 'function' ? v('X', 1, 2) : v;
        expect(EMOJI.test(String(rendered)), `${l}.${k}`).toBe(false);
        expect(DASH.test(String(rendered)), `${l}.${k}`).toBe(false);
      }
    }
  });

  it('falls back to English for a key Hindi has not got, rather than throwing', () => {
    // Nothing is missing today; this is the behaviour that makes adding one
    // Hindi fragment at a time safe.
    expect(str('hi', 'yourOrder')).toBe(STR.hi.yourOrder);
    expect(str('xx', 'yourOrder')).toBe(STR.en.yourOrder);
  });

  it('throws on a key that exists in neither, because that is a typo and not a language', () => {
    expect(() => str('en', 'noSuchFragment')).toThrow(/unknown fragment/);
  });
});

describe('reading a language out of what the customer typed', () => {
  it('takes the whole message, in either script, in any case, with spaces around it', () => {
    for (const t of ['HINDI', 'hindi', '  Hindi  ', 'हिंदी', 'हिन्दी']) expect(langFromText(t), t).toBe('hi');
    for (const t of ['ENGLISH', 'english', 'इंग्लिश', 'अंग्रेजी', 'अंग्रेज़ी']) expect(langFromText(t), t).toBe('en');
    for (const t of ['LANGUAGE', 'भाषा']) expect(langFromText(t), t).toBe('pick');
  });

  /*
   * The important half. Somebody writing "my daughter speaks Hindi at home"
   * is talking about Hindi, not asking for it, and switching their language
   * over it would be worse than doing nothing.
   */
  it('ignores a keyword that is only part of a sentence', () => {
    for (const t of ['I speak HINDI at home', 'english please', 'hindi?', 'is this in Hindi', '']) {
      expect(langFromText(t), t).toBe(null);
    }
  });

  it('normalizeLang never returns anything a registry cannot be keyed by', () => {
    for (const v of [null, undefined, '', 'xx', 'HI', 'en-IN', 42]) expect(LANGS).toContain(normalizeLang(v));
    expect(normalizeLang('hi')).toBe('hi');
  });
});

describe('the name we use when the order carries none', () => {
  it('swaps the English fallback for the greeting of the language being sent', () => {
    expect(langName('en', NAME_FALLBACK)).toBe('there');
    expect(langName('hi', NAME_FALLBACK)).toBe(STR.hi.there);
    expect(langName('hi', null)).toBe(STR.hi.there);
    expect(langName('hi', '')).toBe(STR.hi.there);
  });
  it('leaves a real name exactly as the customer wrote it', () => {
    for (const name of ['Aarav', 'D\'Souza', 'McKay', 'प्रिया']) {
      expect(langName('hi', name)).toBe(name);
      expect(langName('en', name)).toBe(name);
    }
  });
});

/*
 * The fragments that become LIST ROW TITLES and QUICK REPLY BUTTONS.
 *
 * These are the tightest caps in the whole registry and the only thing that
 * was enforcing them was a .slice() at the call site, which does not fail, it
 * truncates: and truncating Devanagari at a fixed offset can cut a combining
 * mark away from the character it belongs to. Two of the RTO reasons were
 * sitting on exactly 24 characters with no headroom.
 */
describe('the fragments that have to fit inside a WhatsApp control', () => {
  const RTO = ['rto_not_available', 'rto_changed_mind', 'rto_size_fit', 'rto_delivery_late', 'rto_did_not_order', 'rto_other'];
  const NDR = ['ndr_reattempt', 'ndr_address', 'ndr_cancel'];

  it('every RTO reason fits a 24 character list row title, in both languages', () => {
    for (const l of LANGS) {
      for (const k of RTO) {
        const v = str(l, k);
        expect(v.length, `${l}.${k} = ${JSON.stringify(v)}`).toBeLessThanOrEqual(24);
        // And leaves room for one more character, so a copy edit is not a cliff.
        expect(v.length, `${l}.${k} has no headroom`).toBeLessThanOrEqual(23);
      }
    }
  });

  it('every NDR option fits a 20 character session button title, in both languages', () => {
    for (const l of LANGS) {
      for (const k of NDR) expect(str(l, k).length, `${l}.${k}`).toBeLessThanOrEqual(20);
    }
  });

  it('the RTO keys are exactly the reason ids, so a row is translated by id and never by label', async () => {
    const { RTO_REASONS } = await import('./labels.mjs');
    for (const r of RTO_REASONS) {
      for (const l of LANGS) expect(() => str(l, `rto_${r.id}`), `rto_${r.id}`).not.toThrow();
    }
    expect(RTO_REASONS.map((r) => `rto_${r.id}`).sort()).toEqual([...RTO].sort());
  });
});
