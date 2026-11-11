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

import { RULES } from './rules.mjs';

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
    // --- itemLine (domain/order.mjs)
    itemSize: (sz) => `, size ${sz}`,
    itemPieces: (q) => `, ${q} pieces`,
    itemMore: (n) => ` and ${n} more item${n === 1 ? '' : 's'}`,
    yourOrder: 'Your order',
    yourBag: 'your bag',

    // --- the name we use when the order carries none
    there: 'there',

    // --- Flow A
    keepReady: (amount) => `please keep ${amount} ready`,
    nothingToPay: 'nothing to pay, this order is prepaid',
    totalSplit: (total, paid, due) => `${total} (${paid} paid online, ${due} at delivery)`,
    /*
     * The two gift lines. They used to live in session.mjs as
     * OFFER_GIFT_LINE / OFFER_NO_GIFT_LINE; that file now re-exports these, so
     * there is one copy of the words and registry.test.mjs still finds them
     * where it always did.
     */
    giftLine: '*A gift from us*, wrapped in with your order',
    noGiftLine: '*Nothing to arrange* at the door on the day',
    // From RULES, so this cannot drift from the figure the owner edits.
    refundEta: RULES.refundEtaText,

    // --- closing times and countdowns (domain/cart.mjs)
    expiresToday: (clock) => `today at ${clock}`,
    expiresTomorrow: (clock) => `tomorrow at ${clock}`,
    expiresOn: (date, clock) => `${date} at ${clock}`,
    minutesLeft: (m) => `${m} minute${m === 1 ? '' : 's'}`,
    hoursLeft: (h) => `${h} hour${h === 1 ? '' : 's'}`,
    hoursMinutesLeft: (hours, m) => `${hours} ${m} minutes`,

    // --- Flow W
    bestSellers: 'our best sellers',
    listAnd: 'and',

    // --- variant change
    sizeOption: 'Size',
    colourOption: 'Colour',
    describeSize: (sz) => `size ${sz}`,

    // --- /replace
    payByQr: 'You can pay by UPI using the QR below.',
    payByNumber: 'Please pay by UPI to the number you have for us.',
    theItem: 'the item',
    theReplacement: 'the replacement',
    yourReplacement: 'your replacement',
    itemQty: (name, qty) => `${name} x ${qty}`,

    // --- Flow C list rows and quick replies. The keys are the RTO_REASONS ids
    // and the NDR actions, so a row is translated by its id and never by its
    // English label.
    rto_not_available: 'I was not available',
    rto_changed_mind: 'Changed my mind',
    rto_size_fit: 'Size or fit concern',
    rto_delivery_late: 'Delivery took too long',
    rto_did_not_order: 'I did not order this',
    rto_other: 'Other reason',
    ndr_reattempt: 'Deliver tomorrow',
    ndr_address: 'Change address',
    ndr_cancel: 'Cancel order',

    // --- the /r/ redirect pages (messages/pages.mjs)
    pageClosedHeading: 'Your private code has closed, but your bag is still saved.',
    pageClosedButton: 'Continue to my bag',
    pageOrderedHeading: 'Your order is placed. Thank you for choosing Morpaankh.',
    pageOrderedButton: 'Visit Morpaankh',
  },

  hi: {
    // Size stays Latin: it is what is printed on the label and shown on the
    // website, and a shopper comparing the two must see the same letter.
    itemSize: (sz) => `, Size ${sz}`,
    itemPieces: (q) => `, ${q} पीस`,
    itemMore: (n) => ` और ${n} अन्य आइटम`,
    yourOrder: 'आपका Order',
    yourBag: 'आपका बैग',

    /*
     * Not a translation of "there". Hindi has no neutral stand-in for a name
     * in this position, so the greeting takes the honorific instead: "Hello
     * जी" reads as politely impersonal, which is exactly what the English is
     * doing.
     */
    there: 'जी',

    keepReady: (amount) => `कृपया ${amount} तैयार रखें`,
    nothingToPay: 'कुछ नहीं देना है, यह Order Prepaid है',
    totalSplit: (total, paid, due) => `${total} (${paid} ऑनलाइन चुकाया, ${due} डिलीवरी पर)`,
    giftLine: '*हमारी तरफ़ से एक गिफ्ट*, आपके पार्सल के साथ',
    noGiftLine: '*दरवाज़े पर कुछ भी* तय करने की ज़रूरत नहीं',
    refundEta: '5 से 7 कार्य दिवस',

    // The clock itself stays as formatIST renders it, 12 hour with AM or PM:
    // it is how phones in India show the time, and a 24 hour clock here would
    // disagree with the one the customer is reading it on.
    expiresToday: (clock) => `आज ${clock}`,
    expiresTomorrow: (clock) => `कल ${clock}`,
    expiresOn: (date, clock) => `${date}, ${clock}`,
    minutesLeft: (m) => `${m} मिनट`,
    hoursLeft: (h) => `${h} घंटे`,
    hoursMinutesLeft: (hours, m) => `${hours} ${m} मिनट`,

    bestSellers: 'हमारे सबसे पसंदीदा',
    listAnd: 'और',

    sizeOption: 'Size',
    colourOption: 'रंग',
    describeSize: (sz) => `Size ${sz}`,

    payByQr: 'नीचे दिए QR से आप UPI पर पेमेंट कर सकते हैं।',
    payByNumber: 'कृपया हमारे उस नंबर पर UPI से पेमेंट करें जो आपके पास है।',
    theItem: 'वह आइटम',
    theReplacement: 'रिप्लेसमेंट',
    yourReplacement: 'आपका रिप्लेसमेंट',
    itemQty: (name, qty) => `${name} x ${qty}`,

    /*
     * Every one of these is genderless about the customer. Hindi first person
     * past tense carries gender ("मैं उपलब्ध नहीं था" assumes a man), and this
     * is a list a customer picks from, so the wording cannot assume.
     */
    rto_not_available: 'घर पर कोई नहीं था',
    rto_changed_mind: 'मैंने मन बदल लिया',
    rto_size_fit: 'Size ठीक नहीं था',
    rto_delivery_late: 'डिलीवरी में बहुत देर हुई',
    rto_did_not_order: 'मैंने यह Order नहीं किया',
    rto_other: 'कोई और कारण',
    ndr_reattempt: 'कल डिलीवरी करें',
    ndr_address: 'Address बदलें',
    ndr_cancel: 'Order रद्द करें',

    pageClosedHeading: 'आपका निजी कोड बंद हो गया है, लेकिन आपका बैग अब भी सहेजा हुआ है।',
    pageClosedButton: 'मेरे बैग पर जाएँ',
    pageOrderedHeading: 'आपका Order दर्ज हो गया है। Morpaankh चुनने के लिए Thank you।',
    pageOrderedButton: 'Morpaankh देखें',
  },
};

/*
 * The name an order carries when Shopify gave us none.
 *
 * normalizeOrder applies this fallback the moment the order is read, long
 * before anything knows which language the message will go out in, so by the
 * time a var is built the English word is already in `n.firstName`. Exported
 * as a constant and compared against, rather than left as a bare literal in
 * three files, so langName below is explicit about what it is doing instead of
 * matching a magic string.
 */
export const NAME_FALLBACK = 'there';

/**
 * A customer's first name, or the greeting we use when there is none.
 *
 * Call this wherever `customer_name` is built from a normalised order, inside
 * a lazy(), so a Hindi message does not open with an English "there".
 */
export const langName = (lang, name) => (!name || name === NAME_FALLBACK ? str(lang, 'there') : name);

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
