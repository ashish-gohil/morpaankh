/*
 * lang.mjs — the language mechanism. Which languages exist, how a customer
 * asks for one in words, the English phrases that are built in CODE rather
 * than in a registry, and the lazy wrapper that lets a caller hand the send
 * helper a phrase it has not chosen the language of yet.
 *
 * No message copy lives here. Template bodies are in templates.mjs and
 * templates.hi.mjs, session bodies in session.mjs and session.hi.mjs. What
 * lives here is the handful of fragments that are assembled in JavaScript and
 * passed in as a variable, because those are the ones that would otherwise
 * stay English inside a Hindi body.
 */

export const LANGS = ['en', 'hi'];
export const DEFAULT_LANG = 'en';

/** 'en' for anything we do not recognise, so a bad stored value cannot break a send. */
export const normalizeLang = (v) => (LANGS.includes(String(v)) ? String(v) : DEFAULT_LANG);

/*
 * The words a customer may type to switch, matched on the WHOLE trimmed and
 * upper-cased message and never on a substring. "HINDI" inside a sentence is
 * somebody talking about Hindi, not asking for it, and switching their
 * language mid-conversation because of it would be worse than doing nothing.
 *
 * toUpperCase() leaves Devanagari untouched (it is caseless), so the Hindi
 * spellings are listed exactly as they are typed. Both the nukta and no-nukta
 * forms of अंग्रेज़ी are here because phone keyboards disagree about it.
 */
export const LANG_KEYWORDS = {
  hi: new Set(['HINDI', 'हिंदी', 'हिन्दी']),
  en: new Set(['ENGLISH', 'इंग्लिश', 'अंग्रेजी', 'अंग्रेज़ी']),
};
/** Typing this asks to be SHOWN the picker rather than naming a language. */
export const LANG_PICK_KEYWORDS = new Set(['LANGUAGE', 'भाषा']);

/**
 * Which language a typed message is asking for: 'en', 'hi', 'pick' or null.
 *
 * One function so the router and its tests cannot disagree about what counts.
 */
export function langFromText(text) {
  const t = String(text || '').trim().toUpperCase();
  if (!t) return null;
  if (LANG_PICK_KEYWORDS.has(t)) return 'pick';
  for (const l of LANGS) if (LANG_KEYWORDS[l].has(t)) return l;
  return null;
}

/*
 * A VALUE WHOSE LANGUAGE IS NOT KNOWN YET.
 *
 * Callers build their vars before the send helper has read the recipient's
 * profile, so a phrase assembled in code cannot be rendered at the call site
 * without the call site guessing a language. Wrap it instead: the send helper
 * resolves every lazy var once it knows, and resolves them AGAIN in English if
 * the Hindi template turns out to be unusable and the English one is sent.
 *
 * toJSON throws on purpose. A lazy value must never be written to DynamoDB:
 * it would serialise to `{}` and reappear later as an empty string in the
 * middle of a message. A parked offer or a cart row has to store the inputs
 * and build the phrase at send time, so this makes getting it wrong loud.
 */
class Lazy {
  constructor(fn) {
    if (typeof fn !== 'function') throw new TypeError('lazy() needs a function');
    this.fn = fn;
  }

  resolve(lang) {
    return this.fn(normalizeLang(lang));
  }

  toJSON() {
    throw new Error('a lazy value cannot be stored: resolve it at send time, not at park time');
  }
}

/** Defer a phrase until the send helper knows the language. */
export const lazy = (fn) => new Lazy(fn);
export const isLazy = (v) => v instanceof Lazy;

/** One value, resolved. Anything that is not lazy comes back untouched. */
export const resolveLazy = (v, lang) => (isLazy(v) ? v.resolve(lang) : v);

/**
 * A flat record of vars, with every lazy value resolved for `lang`.
 *
 * Returns the SAME object when there is nothing lazy in it, so the English
 * path allocates nothing and cannot differ from what it did before.
 */
export function resolveVars(vars, lang) {
  if (!vars) return vars;
  let found = false;
  for (const k in vars) {
    if (isLazy(vars[k])) {
      found = true;
      break;
    }
  }
  if (!found) return vars;
  const out = {};
  for (const k in vars) out[k] = resolveLazy(vars[k], lang);
  return out;
}

/**
 * List rows and buttons, with their titles and descriptions resolved.
 *
 * A row's `action` is a payload and is never language-dependent, so it is
 * copied through untouched.
 */
export function resolveRows(rows, lang) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => (r && typeof r === 'object' ? resolveVars(r, lang) : r));
}

/*
 * THE FRAGMENT TABLE.
 *
 * STR[lang][key] is either a string or a function of its arguments. The
 * English side must reproduce today's output exactly, character for
 * character, because messages/golden.snapshot.json is asserting it does.
 *
 * Kept the same in BOTH languages, deliberately: digits, rupee amounts, dates
 * and month abbreviations (they come from formatIST* and are read the same
 * way), product titles, sizes, colour names, discount codes, and the word
 * Delhivery. Translating a product name or a size would make the message
 * disagree with the website and with the parcel.
 */
export const STR = {
  en: {
    // itemLine
    itemSize: (s) => `, size ${s}`,
    itemPieces: (q) => `, ${q} pieces`,
    itemMore: (n) => ` and ${n} more item${n === 1 ? '' : 's'}`,
    yourOrder: 'Your order',
    yourBag: 'your bag',
    // name fallbacks
    there: 'there',
    // subscriber offer
    bestSellers: 'our best sellers',
    listAnd: 'and',
    // variant change
    sizeOption: 'Size',
    colourOption: 'Colour',
    describeSize: (s) => `size ${s}`,
    describeColour: (c) => c,
  },
  hi: {
    // Size stays Latin (it is on the label and on the website), the joiner is
    // Devanagari. "साइज़ M" reads as one phrase to a Hindi reader.
    itemSize: (s) => `, Size ${s}`,
    itemPieces: (q) => `, ${q} पीस`,
    itemMore: (n) => ` और ${n} अन्य आइटम`,
    yourOrder: 'आपका Order',
    yourBag: 'आपका बैग',
    there: 'जी',
    bestSellers: 'हमारे सबसे पसंदीदा',
    listAnd: 'और',
    sizeOption: 'Size',
    colourOption: 'रंग',
    describeSize: (s) => `Size ${s}`,
    describeColour: (c) => c,
  },
};

/**
 * One fragment, in one language, with English as the backstop.
 *
 * A key missing from the Hindi table falls back to English rather than
 * throwing: a missing fragment is a word in the wrong language, and an
 * exception here is a customer who hears nothing at all.
 */
export function str(lang, key, ...args) {
  const l = normalizeLang(lang);
  const v = STR[l]?.[key] ?? STR[DEFAULT_LANG][key];
  if (v === undefined) throw new Error(`unknown fragment: ${key}`);
  return typeof v === 'function' ? v(...args) : v;
}
