/*
 * replace.test.mjs: the /replace rules, with no courier and no Shopify in it.
 *
 * Two kinds of expensive mistake live in this module. The parser can
 * misunderstand a command and book a pickup for the wrong garment at a real
 * address, and validate can let a booking through that should have been done by
 * hand (no e-waybill, no HSN, a redacted address, a parcel already on its way
 * back to us). Both are decided here, so both are tested here.
 *
 * Assertions are on the stop CODE, never the wording: the orchestrator matches
 * codes and the sentences are free to be rewritten for the owner.
 */
import { describe, it, expect } from 'vitest';
import { RULES } from '../../messages/rules.mjs';
import { parseReplaceCommand, normaliseSize, resolveLine, resolveTarget, validate } from './replace.mjs';

const VAR = (n) => `gid://shopify/ProductVariant/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;

/** A normalized order line, in the shape normalizeOrder produces. */
const line = (over = {}) => ({
  id: LI(1),
  title: 'Noor Bagh',
  quantity: 1,
  productGid: 'gid://shopify/Product/9',
  productHandle: 'noor-bagh',
  variantGid: VAR(100),
  selectedOptions: [{ name: 'Size', value: 'M' }],
  unitPaise: 124900,
  discountPaise: 0,
  size: 'M',
  ...over,
});

const v = (id, opts, over = {}) => ({
  id: VAR(id),
  title: opts.map((o) => o.value).join(' / '),
  price: '1249.00',
  availableForSale: true,
  inventoryQuantity: 5,
  selectedOptions: opts,
  ...over,
});

const sizeOnly = (size) => [{ name: 'Size', value: size }];
const sizeColour = (size, colour) => [
  { name: 'Size', value: size },
  { name: 'Color', value: colour },
];

/** getProductVariants shape: the whole product, variants under variants.nodes. */
const product = (over = {}) => ({
  id: 'gid://shopify/Product/9',
  handle: 'noor-bagh',
  title: 'Noor Bagh',
  options: [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }],
  variants: { nodes: [v(99, sizeOnly('S')), v(100, sizeOnly('M')), v(101, sizeOnly('L')), v(102, sizeOnly('XL'))] },
  ...over,
});

const swapOf = (text) => parseReplaceCommand(`/replace 1234 ${text}`).swaps[0];

describe('reading the command', () => {
  it('reads the plain size swap, with and without the hash', () => {
    for (const text of ['/replace #1234 noor m xl', '/replace 1234 noor m xl']) {
      const c = parseReplaceCommand(text);
      expect(c.error).toBe(null);
      expect(c.verb).toBe('create');
      expect(c.orderName).toBe('1234');
      expect(c.swaps).toEqual([{ productWords: ['noor'], fromSize: 'M', targetWords: [], toSize: 'XL', qty: 1 }]);
    }
  });

  it('takes every alias, in any case', () => {
    for (const alias of ['/replace', '/replace-order', '/rp', '/REPLACE', '/Replace-Order', '/RP']) {
      const c = parseReplaceCommand(`${alias} #1234 noor m xl`);
      expect(c.error).toBe(null);
      expect(c.verb).toBe('create');
      expect(c.orderName).toBe('1234');
    }
  });

  /*
   * /replace is a prefix of /replace-order, so an alias list in the wrong order
   * reads this as the create verb with a sub-verb of "order" and refuses a
   * command that was typed correctly.
   */
  it('does not read /replace-order as /replace followed by the word order', () => {
    expect(parseReplaceCommand('/replace-order 1234 noor L noor XL').error).toBe(null);
  });

  it('survives any spacing, including a sloppy phone keyboard', () => {
    const c = parseReplaceCommand('  /replace    #1234    noor    m    xl   ');
    expect(c.error).toBe(null);
    expect(c.swaps[0]).toEqual({ productWords: ['noor'], fromSize: 'M', targetWords: [], toSize: 'XL', qty: 1 });
  });

  it('omits the product words when the order has one changeable line', () => {
    const c = parseReplaceCommand('/replace 1234 m xl');
    expect(c.error).toBe(null);
    expect(c.swaps[0]).toEqual({ productWords: [], fromSize: 'M', targetWords: [], toSize: 'XL', qty: 1 });
  });

  /*
   * "noor L noor XL" names the same product twice and means a size change. It
   * has to parse rather than being rejected as a self referential product
   * change, because it is how the owner types when they are being explicit.
   */
  it('reads the four word form, including the same product named twice', () => {
    expect(swapOf('noor L noor XL')).toEqual({ productWords: ['noor'], fromSize: 'L', targetWords: ['noor'], toSize: 'XL', qty: 1 });
    expect(swapOf('noor m indigo xl')).toEqual({ productWords: ['noor'], fromSize: 'M', targetWords: ['indigo'], toSize: 'XL', qty: 1 });
    expect(swapOf('noor m taana bagh xl')).toEqual({
      productWords: ['noor'],
      fromSize: 'M',
      targetWords: ['taana', 'bagh'],
      toSize: 'XL',
      qty: 1,
    });
  });

  it('reads a comma separated list of swaps', () => {
    const c = parseReplaceCommand('/replace #1234 noor m xl, bandhan s m, taana l indigo xl');
    expect(c.error).toBe(null);
    expect(c.swaps.map((s) => [s.productWords.join(' '), s.fromSize, s.targetWords.join(' '), s.toSize])).toEqual([
      ['noor', 'M', '', 'XL'],
      ['bandhan', 'S', '', 'M'],
      ['taana', 'L', 'indigo', 'XL'],
    ]);
  });

  it('refuses more swaps than one command may carry', () => {
    const many = Array.from({ length: RULES.replace.maxSwapsPerCommand + 1 }, (_, i) => `p${i} m l`).join(', ');
    expect(RULES.replace.maxSwapsPerCommand).toBe(5);
    expect(parseReplaceCommand(`/replace 1234 ${many}`).error).toBeTruthy();
    const ok = Array.from({ length: RULES.replace.maxSwapsPerCommand }, (_, i) => `p${i} m l`).join(', ');
    expect(parseReplaceCommand(`/replace 1234 ${ok}`).error).toBe(null);
  });

  it('reads every flag, in any order after the swap', () => {
    const c = parseReplaceCommand('/replace #1234 noor m xl x3 reason:damaged pays:customer force again');
    expect(c.error).toBe(null);
    expect(c.swaps[0].qty).toBe(3);
    expect(c.flags).toEqual({ reason: 'damaged', pays: 'customer', force: true, again: true, skipConfirm: false, notify: false });
    const b = parseReplaceCommand('/replace #1234 noor m xl again force pays:us x2');
    expect(b.error).toBe(null);
    expect(b.swaps[0].qty).toBe(2);
    expect(b.flags.force).toBe(true);
    expect(b.flags.again).toBe(true);
    expect(b.flags.pays).toBe('us');
  });

  it('reads a bare trailing bang as skip the preview, stuck on or spaced off', () => {
    expect(parseReplaceCommand('/replace 1234 noor m xl !').flags.skipConfirm).toBe(true);
    expect(parseReplaceCommand('/replace 1234 noor m xl!').flags.skipConfirm).toBe(true);
    expect(parseReplaceCommand('/replace 1234 noor m xl').flags.skipConfirm).toBe(false);
    // The bang must not eat the size it sits against.
    expect(parseReplaceCommand('/replace 1234 noor m xl!').swaps[0].toSize).toBe('XL');
  });

  /*
   * Who pays is recorded for the owner settling freight by hand, never charged:
   * there is no way to collect money on a reverse leg.
   */
  it('derives who pays from the reason, and lets it be overridden', () => {
    expect(parseReplaceCommand('/replace 1234 noor m xl').flags).toMatchObject({ reason: 'size', pays: 'customer' });
    expect(parseReplaceCommand('/replace 1234 noor m xl reason:damaged').flags.pays).toBe('us');
    expect(parseReplaceCommand('/replace 1234 noor m xl reason:wrong').flags.pays).toBe('us');
    expect(parseReplaceCommand('/replace 1234 noor m xl reason:other').flags.pays).toBe('us');
    expect(parseReplaceCommand('/replace 1234 noor m xl reason:size pays:us').flags.pays).toBe('us');
    expect(parseReplaceCommand('/replace 1234 noor m xl reason:damaged pays:customer').flags.pays).toBe('customer');
  });

  it('refuses a quantity or a flag value it does not understand, and keeps the default', () => {
    const q = parseReplaceCommand('/replace 1234 noor m xl x0');
    expect(q.error).toBeTruthy();
    expect(q.swaps[0].qty).toBe(1);
    const r = parseReplaceCommand('/replace 1234 noor m xl reason:bogus');
    expect(r.error).toBeTruthy();
    expect(r.flags.reason).toBe('size');
    const p = parseReplaceCommand('/replace 1234 noor m xl pays:someone');
    expect(p.error).toBeTruthy();
    expect(p.flags.pays).toBe('customer');
  });

  it('reads every sub-verb, before the swap grammar gets a look at it', () => {
    expect(parseReplaceCommand('/replace status #1234')).toMatchObject({ verb: 'status', orderName: '1234', error: null });
    expect(parseReplaceCommand('/rp retry 1234')).toMatchObject({ verb: 'retry', orderName: '1234', error: null });
    expect(parseReplaceCommand('/replace list')).toMatchObject({ verb: 'list', orderName: null, error: null });
    expect(parseReplaceCommand('/replace help')).toMatchObject({ verb: 'help', orderName: null, error: null });
    const c = parseReplaceCommand('/replace cancel #1234 notify');
    expect(c).toMatchObject({ verb: 'cancel', orderName: '1234', error: null });
    expect(c.flags.notify).toBe(true);
    expect(parseReplaceCommand('/replace cancel #1234').flags.notify).toBe(false);
  });

  it('wants an order number on the sub-verbs that act on one', () => {
    for (const verb of ['status', 'cancel', 'retry']) {
      const c = parseReplaceCommand(`/replace ${verb}`);
      expect(c.verb).toBe(verb);
      expect(c.orderName).toBe(null);
      expect(c.error).toBeTruthy();
    }
  });

  it('complains about a word it did not expect after a sub-verb', () => {
    expect(parseReplaceCommand('/replace status 1234 please').error).toBeTruthy();
    expect(parseReplaceCommand('/replace cancel 1234 loudly').error).toBeTruthy();
  });

  /*
   * Every one of these sets `error` and returns the rest best effort. A
   * replacement books two real courier movements, so a half understood command
   * is worth less than no command.
   */
  it('never throws, and never guesses a swap it is unsure of', () => {
    const cases = [
      '',
      '   ',
      'hello',
      'replace 1234 noor m xl',
      '/replacement 1234 noor m xl',
      '/replace noor m xl',
      '/replace 1234',
      '/replace 1234 noor',
      '/replace 1234 noor xl',
      '/replace 1234 noor m xxxxl',
      '/replace 1234 ,,,',
      '/replace 1234 x2',
      '/replace #abc noor m xl',
    ];
    for (const text of cases) {
      const c = parseReplaceCommand(text);
      expect(c.error, text).toBeTruthy();
      expect(['create', 'help', 'status', 'cancel', 'retry', 'list']).toContain(c.verb);
    }
    // @ts-expect-error deliberately not a string
    expect(parseReplaceCommand(null).error).toBeTruthy();
    // @ts-expect-error deliberately not a string
    expect(parseReplaceCommand(undefined).error).toBeTruthy();
    // @ts-expect-error deliberately not a string
    expect(parseReplaceCommand({}).error).toBeTruthy();
  });

  it('keeps the size it did read when the other one is missing', () => {
    const c = parseReplaceCommand('/replace 1234 noor xl');
    expect(c.error).toBeTruthy();
    expect(c.swaps[0]).toMatchObject({ productWords: ['noor'], fromSize: null, toSize: 'XL' });
  });
});

describe('canonicalising a size', () => {
  it('reaches the same token however it is typed', () => {
    expect(normaliseSize('m')).toBe('M');
    expect(normaliseSize(' M ')).toBe('M');
    expect(normaliseSize('Medium')).toBe('M');
    expect(normaliseSize('2xl')).toBe('XXL');
    expect(normaliseSize('XXL')).toBe('XXL');
    expect(normaliseSize('free')).toBe('Free Size');
    expect(normaliseSize('free size')).toBe('Free Size');
    expect(normaliseSize('FREE  SIZE')).toBe('Free Size');
  });

  /*
   * Spelling only. Whether the product has one is answered by its own Size
   * option values, which is why an unknown word is null rather than a guess.
   */
  it('returns null for anything it does not know', () => {
    for (const w of ['', '   ', 'xxxxl', '36', 'noor', null, undefined]) expect(normaliseSize(w)).toBe(null);
  });
});

describe('which line the words point at', () => {
  const noor = line();
  const bandhan = line({ id: LI(2), title: 'Bandhan', productHandle: 'bandhan', variantGid: VAR(200) });
  const bandhani = line({ id: LI(3), title: 'Bandhani Dupatta', productHandle: 'bandhani-dupatta', variantGid: VAR(300) });

  it('matches on a prefix of the title, the handle or the sku', () => {
    expect(resolveLine([noor, bandhan], ['noor']).line).toBe(noor);
    expect(resolveLine([noor, bandhan], ['noo']).line).toBe(noor);
    expect(resolveLine([noor, bandhan], ['bagh']).line).toBe(noor);
    expect(resolveLine([noor, bandhan], ['NOOR']).line).toBe(noor);
    const sku = line({ id: LI(4), title: 'Mystery', productHandle: 'mystery', sku: 'TAANA-XL' });
    expect(resolveLine([noor, sku], ['taana']).line).toBe(sku);
  });

  /*
   * normalizeOrder keeps no variantTitle, only selectedOptions, so a colour
   * word has to reach the line through the option values or "bandhan brown"
   * matches nothing at all.
   */
  it('matches a colour word through the line selected options', () => {
    const brown = line({ id: LI(5), title: 'Bandhan', selectedOptions: sizeColour('M', 'Brown') });
    const indigo = line({ id: LI(6), title: 'Bandhan', selectedOptions: sizeColour('M', 'Indigo') });
    expect(resolveLine([brown, indigo], ['bandhan', 'brown']).line).toBe(brown);
  });

  it('never guesses between two matches', () => {
    const r = resolveLine([bandhan, bandhani], ['bandhan']);
    expect(r.line).toBe(undefined);
    expect(r.candidates).toEqual([bandhan, bandhani]);
  });

  it('says so when nothing matches, and hands back the lines to quote', () => {
    const r = resolveLine([noor, bandhan], ['taana']);
    expect(r.none).toBe(true);
    expect(r.lines).toEqual([noor, bandhan]);
  });

  it('needs no words when there is exactly one line, and refuses to pick when there are several', () => {
    expect(resolveLine([noor], []).line).toBe(noor);
    expect(resolveLine([noor], undefined).line).toBe(noor);
    expect(resolveLine([noor, bandhan], []).candidates).toEqual([noor, bandhan]);
    expect(resolveLine([], []).none).toBe(true);
    expect(resolveLine(null, ['noor']).none).toBe(true);
  });

  it('wants every word to match, not just one of them', () => {
    expect(resolveLine([noor, bandhan], ['noor', 'bagh']).line).toBe(noor);
    expect(resolveLine([noor, bandhan], ['noor', 'taana']).none).toBe(true);
  });
});

describe('which variant the swap resolves to', () => {
  it('finds another size on the product they already have', () => {
    const r = resolveTarget({ line: line(), swap: swapOf('noor m xl'), variants: product() });
    expect(r.variant.id).toBe(VAR(102));
    expect(r.product.handle).toBe('noor-bagh');
  });

  it('reads the same product named twice as a size change', () => {
    const r = resolveTarget({ line: line(), swap: swapOf('noor m noor xl'), variants: product() });
    expect(r.variant.id).toBe(VAR(102));
  });

  it('takes the product as a bare variant array as well as the whole product', () => {
    const r = resolveTarget({ line: line(), swap: swapOf('m xl'), variants: product().variants.nodes });
    expect(r.variant.id).toBe(VAR(102));
    expect(r.product).toBe(null);
  });

  describe('colour', () => {
    const colours = product({
      options: [{ name: 'Size', values: ['M', 'XL'] }, { name: 'Color', values: ['Brown', 'Indigo'] }],
      variants: {
        nodes: [
          v(100, sizeColour('M', 'Brown')),
          v(101, sizeColour('XL', 'Brown')),
          v(102, sizeColour('M', 'Indigo')),
          v(103, sizeColour('XL', 'Indigo')),
        ],
      },
    });
    const brownM = line({ selectedOptions: sizeColour('M', 'Brown') });

    it('changes the colour and the size together', () => {
      const r = resolveTarget({ line: brownM, swap: swapOf('noor m indigo xl'), variants: colours });
      expect(r.variant.id).toBe(VAR(103));
    });

    it('changes the colour on its own', () => {
      const r = resolveTarget({ line: brownM, swap: swapOf('noor m indigo m'), variants: colours });
      expect(r.variant.id).toBe(VAR(102));
    });

    /*
     * A size change must keep the colour. Letting it float offers every colour
     * at that size, so the commonest command there is would come back ambiguous
     * on any two colour product.
     */
    it('pins a plain size change to the colour they already own', () => {
      const r = resolveTarget({ line: brownM, swap: swapOf('noor m xl'), variants: colours });
      expect(r.variant.id).toBe(VAR(101));
    });

    it('never guesses between two colours that both match the word', () => {
      const two = product({
        options: [{ name: 'Size', values: ['XL'] }, { name: 'Color', values: ['Blue Jade', 'Blue Mist'] }],
        variants: { nodes: [v(100, sizeColour('M', 'Brown')), v(104, sizeColour('XL', 'Blue Jade')), v(105, sizeColour('XL', 'Blue Mist'))] },
      });
      const r = resolveTarget({ line: line({ selectedOptions: sizeColour('M', 'Brown') }), swap: swapOf('noor m blue xl'), variants: two });
      expect(r.reason).toBe('ambiguous');
      expect(r.candidates.length).toBe(2);
    });
  });

  describe('a different product', () => {
    const catalog = [
      {
        title: 'Taana Bana',
        handle: 'taana-bana',
        variants: [v(500, sizeOnly('M')), v(501, sizeOnly('XL'))],
      },
      {
        title: 'Phoolwari',
        handle: 'phoolwari',
        variants: [v(600, sizeColour('XL', 'Indigo')), v(601, sizeColour('XL', 'Rose'))],
      },
    ];

    it('resolves against the catalog when the words name something else', () => {
      const r = resolveTarget({ line: line(), swap: swapOf('noor m taana xl'), variants: product(), catalog });
      expect(r.variant.id).toBe(VAR(501));
      expect(r.product.handle).toBe('taana-bana');
    });

    it('matches a catalog product by handle too', () => {
      const r = resolveTarget({ line: line(), swap: swapOf('noor m taana-bana xl'), variants: product(), catalog });
      expect(r.variant.id).toBe(VAR(501));
    });

    it('takes a colour inside the other product', () => {
      const r = resolveTarget({ line: line(), swap: swapOf('noor m phoolwari rose xl'), variants: product(), catalog });
      expect(r.variant.id).toBe(VAR(601));
    });

    it('refuses to pick a colour the owner did not name', () => {
      const r = resolveTarget({ line: line(), swap: swapOf('noor m phoolwari xl'), variants: product(), catalog });
      expect(r.reason).toBe('ambiguous');
    });

    it('is unresolved when nothing in the catalog is named', () => {
      expect(resolveTarget({ line: line(), swap: swapOf('noor m mehrab xl'), variants: product(), catalog }).reason).toBe('unresolved');
      expect(resolveTarget({ line: line(), swap: swapOf('noor m mehrab xl'), variants: product() }).reason).toBe('unresolved');
    });
  });

  it('calls the swap identical when it asks for what they already have', () => {
    expect(resolveTarget({ line: line(), swap: swapOf('noor m m'), variants: product() }).reason).toBe('identical');
    expect(resolveTarget({ line: line(), swap: swapOf('m m'), variants: product() }).reason).toBe('identical');
  });

  /*
   * Checked before the stock filter: an out of stock source variant would
   * otherwise be reported as a size that is not stocked, sending the owner
   * hunting for stock of the size the customer is already wearing.
   */
  it('still says identical when the variant they own is out of stock', () => {
    const p = product({ variants: { nodes: [v(100, sizeOnly('M'), { inventoryQuantity: 0 })] } });
    expect(resolveTarget({ line: line(), swap: swapOf('noor m m'), variants: p }).reason).toBe('identical');
  });

  it('never assumes a size exists on the product', () => {
    const r = resolveTarget({ line: line(), swap: swapOf('noor m xxxl'), variants: product() });
    expect(r.reason).toBe('size-not-stocked');
    expect(r.variant).toBe(undefined);
  });

  it('refuses a size the product lists but has no stock of', () => {
    const p = product({
      variants: { nodes: [v(100, sizeOnly('M')), v(102, sizeOnly('XL'), { inventoryQuantity: 0 })] },
    });
    expect(resolveTarget({ line: line(), swap: swapOf('noor m xl'), variants: p }).reason).toBe('size-not-stocked');
    const unavailable = product({
      variants: { nodes: [v(100, sizeOnly('M')), v(102, sizeOnly('XL'), { availableForSale: false })] },
    });
    expect(resolveTarget({ line: line(), swap: swapOf('noor m xl'), variants: unavailable }).reason).toBe('size-not-stocked');
  });

  it('matches 2XL on the command against XXL in Shopify', () => {
    const p = product({ options: [{ name: 'Size', values: ['M', 'XXL'] }], variants: { nodes: [v(100, sizeOnly('M')), v(103, sizeOnly('XXL'))] } });
    expect(resolveTarget({ line: line(), swap: swapOf('noor m 2xl'), variants: p }).variant.id).toBe(VAR(103));
  });

  it('is unresolved with nothing to work from', () => {
    expect(resolveTarget({}).reason).toBe('unresolved');
    expect(resolveTarget({ line: line(), swap: { toSize: null, targetWords: [] } }).reason).toBe('unresolved');
    expect(resolveTarget({ line: line(), swap: swapOf('noor m xl'), variants: null }).reason).toBe('size-not-stocked');
  });
});

/* ------------------------------------------------------------------ */

const DELIVERED_AT = '2026-10-20T06:00:00Z';
const NOW = '2026-10-22T06:00:00Z';

const order = (over = {}) => ({
  gid: 'gid://shopify/Order/5555',
  numericId: '5555',
  name: '#1234',
  isTest: false,
  tags: ['LOW RTO Risk'],
  cancelledAt: null,
  financialStatus: 'PAID',
  gateways: ['Razorpay'],
  lineItems: [line()],
  ...over,
});

const address = (over = {}) => ({
  name: 'Aarav Shah',
  address1: '14 Mill Road',
  address2: '',
  city: 'Surat',
  state: 'Gujarat',
  pin: '395007',
  country: 'India',
  phone: '+919812345678',
  ...over,
});

/** Everything green, so each test below flips exactly one thing. */
const vin = (over = {}) => ({
  n: order(),
  st: { class: 'PREPAID', courierStatus: 'DELIVERED' },
  shipping: { scopeProblem: false, address: address(), lines: [] },
  resolved: [{ line: line(), swap: swapOf('noor m xl'), qty: 1, variant: v(102, sizeOnly('XL')) }],
  flags: { reason: 'size', pays: 'customer', force: false, again: false, skipConfirm: false, notify: false },
  serviceability: { reversePickup: true, prepaidDelivery: true, oda: false },
  delivered: { at: DELIVERED_AT, pin: '395007' },
  existing: null,
  courierAwb: 'AWB12345',
  rules: RULES,
  now: NOW,
  testOrders: [],
  configPresent: { pickupLocation: 'Morpaankh Studio', gstin: '24ABCDE1234F1Z5', hsn: '6204' },
  customer: { verifiedPhone: '+919812345678', optedOut: false, undeliverable: false },
  ...over,
});

const codes = (r) => r.stops.map((s) => s.code);
const hardCodes = (r) => r.stops.filter((s) => s.kind === 'hard').map((s) => s.code);
const softCodes = (r) => r.stops.filter((s) => s.kind === 'soft').map((s) => s.code);
const warnCodes = (r) => r.warnings.map((w) => w.code);

describe('validate', () => {
  it('passes a routine replacement with nothing to say', () => {
    const r = validate(vin());
    expect(r.stops).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('gives every stop a stable kebab-case code and a sentence', () => {
    const r = validate(vin({ n: null }));
    for (const s of r.stops) {
      expect(s.code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.message.length).toBeGreaterThan(10);
      expect(['hard', 'soft']).toContain(s.kind);
    }
  });

  describe('hard stops, which nothing overrides', () => {
    it('order not found, and says nothing else about an order it cannot read', () => {
      const r = validate(vin({ n: null }));
      expect(codes(r)).toEqual(['order-not-found']);
    });

    it('cancelled, voided and fully refunded', () => {
      expect(hardCodes(validate(vin({ n: order({ cancelledAt: '2026-10-21T00:00:00Z' }) })))).toContain('order-cancelled');
      expect(hardCodes(validate(vin({ n: order({ financialStatus: 'VOIDED' }) })))).toContain('order-voided');
      expect(hardCodes(validate(vin({ n: order({ financialStatus: 'REFUNDED' }) })))).toContain('order-refunded');
      // A partial refund is not a fully refunded order.
      expect(hardCodes(validate(vin({ n: order({ financialStatus: 'PARTIALLY_REFUNDED' }) })))).toEqual([]);
    });

    it('a test order, unless it is named in REPLACE_TEST_ORDERS', () => {
      const test = order({ isTest: true });
      expect(hardCodes(validate(vin({ n: test })))).toContain('test-order');
      expect(hardCodes(validate(vin({ n: test, testOrders: ['5555'] })))).not.toContain('test-order');
      expect(hardCodes(validate(vin({ n: test, testOrders: ['1234'] })))).not.toContain('test-order');
      expect(hardCodes(validate(vin({ n: test, testOrders: ['9999'] })))).toContain('test-order');
    });

    /*
     * The other half of REPLACE_TEST_ORDERS, and the half that protects a real
     * customer: while the list is set, a LIVE run may book the orders on it and
     * nothing else. Shadow is exempt because it books nothing and messages
     * nobody, so a rehearsal has to stay runnable on any order.
     */
    it('any order off the list, once REPLACE_TEST_ORDERS is set and the mode is live', () => {
      expect(hardCodes(validate(vin({ mode: 'live', testOrders: ['9999'] })))).toContain('order-not-in-test-list');
      expect(hardCodes(validate(vin({ mode: 'live', testOrders: ['1234'] })))).not.toContain('order-not-in-test-list');
      expect(hardCodes(validate(vin({ mode: 'live', testOrders: [] })))).not.toContain('order-not-in-test-list');
      expect(hardCodes(validate(vin({ mode: 'shadow', testOrders: ['9999'] })))).not.toContain('order-not-in-test-list');
    });

    /*
     * hasRtoTag, not a substring test for 'RTO': COD King tags every order
     * "LOW/MEDIUM/HIGH RTO Risk", so a substring test would call every order in
     * the store an RTO and refuse the feature outright.
     */
    it('a parcel that went RTO or back to origin, without tripping over the risk tags', () => {
      expect(hardCodes(validate(vin({ st: { courierStatus: 'RTO_INITIATED' } })))).toContain('shipment-rto');
      expect(hardCodes(validate(vin({ st: { courierStatus: 'RTO_DELIVERED' } })))).toContain('shipment-rto');
      expect(hardCodes(validate(vin({ n: order({ tags: ['RTO'] }) })))).toContain('shipment-rto');
      for (const tag of ['LOW RTO Risk', 'MEDIUM RTO Risk', 'HIGH RTO Risk']) {
        expect(hardCodes(validate(vin({ n: order({ tags: [tag] }) }))), tag).not.toContain('shipment-rto');
      }
    });

    it('a swap that did not resolve, or resolved to what they already have', () => {
      expect(hardCodes(validate(vin({ resolved: [{ line: line(), reason: 'unresolved' }] })))).toContain('swap-unresolved');
      expect(hardCodes(validate(vin({ resolved: [{ line: line(), reason: 'ambiguous' }] })))).toContain('swap-unresolved');
      expect(hardCodes(validate(vin({ resolved: [{ line: line(), reason: 'size-not-stocked' }] })))).toContain('swap-unresolved');
      expect(hardCodes(validate(vin({ resolved: [{ line: line(), reason: 'identical' }] })))).toContain('swap-identical');
      expect(hardCodes(validate(vin({ resolved: [] })))).toContain('swap-unresolved');
    });

    it('a quantity above what was bought, counting what was already replaced', () => {
      const one = { line: line({ quantity: 1 }), qty: 2, variant: v(102, sizeOnly('XL')) };
      expect(hardCodes(validate(vin({ resolved: [one] })))).toContain('swap-quantity-exceeds-purchased');
      const two = { line: line({ quantity: 2 }), qty: 2, variant: v(102, sizeOnly('XL')) };
      expect(hardCodes(validate(vin({ resolved: [two] })))).not.toContain('swap-quantity-exceeds-purchased');
      expect(hardCodes(validate(vin({ resolved: [{ ...two, alreadyReplaced: 1 }] })))).toContain('swap-quantity-exceeds-purchased');
      expect(
        hardCodes(
          validate(
            vin({
              resolved: [two],
              st: { class: 'PREPAID', replace: { replacedByLine: { [LI(1)]: 1 } } },
            }),
          ),
        ),
      ).toContain('swap-quantity-exceeds-purchased');
    });

    it('an open replacement on the same line, which `again` is the way past', () => {
      const existing = { status: 'AWAITING_CONFIRMATION', lineIds: [LI(1)] };
      expect(hardCodes(validate(vin({ existing })))).toContain('replacement-already-active');
      expect(hardCodes(validate(vin({ existing, flags: { again: true } })))).not.toContain('replacement-already-active');
      // A different garment on the same order is not a clash.
      expect(hardCodes(validate(vin({ existing: { status: 'AWAITING_CONFIRMATION', lineIds: [LI(9)] } })))).not.toContain(
        'replacement-already-active',
      );
      // An open request we cannot pin to a line is treated as covering it.
      expect(hardCodes(validate(vin({ existing: { status: 'AWAITING_CONFIRMATION' } })))).toContain('replacement-already-active');
      /*
       * But a preview past its OWN deadline is not an open replacement. Nothing
       * was booked on it and a tap on it is refused as stale, so blocking the
       * line on it left the owner retyping a command that could never work until
       * they cancelled a dead preview by hand.
       */
      const stale = { ...existing, confirmBy: '2026-10-22T05:50:00.000Z' };
      expect(hardCodes(validate(vin({ existing: stale })))).not.toContain('replacement-already-active');
      // One still inside its window keeps blocking, which is the whole point.
      const live = { ...existing, confirmBy: '2026-10-22T06:30:00.000Z' };
      expect(hardCodes(validate(vin({ existing: live })))).toContain('replacement-already-active');
    });

    it('a request that is already running, which `again` does not open', () => {
      for (const status of ['CONFIRMED', 'RETURN_CREATED', 'FORWARD_CREATED', 'CUSTOMER_NOTIFIED', 'FAILED']) {
        const r = validate(vin({ existing: { status, lineIds: [LI(1)] }, flags: { again: true, force: true } }));
        expect(hardCodes(r), status).toContain('replacement-in-progress');
      }
      // Terminal states leave the order free.
      for (const status of ['REJECTED', 'EXPIRED', 'CANCELLED', 'DONE']) {
        const r = validate(vin({ existing: { status, lineIds: [LI(1)] } }));
        expect(hardCodes(r), status).not.toContain('replacement-in-progress');
        expect(hardCodes(r), status).not.toContain('replacement-already-active');
      }
    });

    it('an address that is missing a field a courier needs', () => {
      for (const key of ['name', 'address1', 'city', 'pin', 'phone']) {
        const shipping = { scopeProblem: false, address: address({ [key]: '' }), lines: [] };
        expect(hardCodes(validate(vin({ shipping }))), key).toContain('shipping-address-incomplete');
      }
      // address2 and state are not on that list.
      expect(hardCodes(validate(vin({ shipping: { address: address({ address2: '', state: '' }) } })))).not.toContain(
        'shipping-address-incomplete',
      );
      expect(hardCodes(validate(vin({ shipping: { address: null } })))).toContain('shipping-address-incomplete');
      expect(hardCodes(validate(vin({ shipping: null })))).toContain('shipping-address-incomplete');
    });

    /*
     * A redacted order carries asterisks rather than an empty string, and a
     * label printed with "***" as the street is a parcel that never arrives.
     */
    it('an address that is redacted rather than empty', () => {
      expect(hardCodes(validate(vin({ shipping: { address: address({ address1: '***' }) } })))).toContain('shipping-address-incomplete');
      expect(hardCodes(validate(vin({ shipping: { address: address({ name: 'redacted' }) } })))).toContain('shipping-address-incomplete');
    });

    /*
     * Said distinctly, because this one is an app permissions problem with
     * protected customer data and no amount of retyping the address fixes it.
     */
    it('an address Shopify would not hand over, distinctly from a missing one', () => {
      const r = validate(vin({ shipping: { scopeProblem: true, address: null, lines: [] } }));
      expect(hardCodes(r)).toContain('shipping-address-no-access');
      expect(hardCodes(r)).not.toContain('shipping-address-incomplete');
    });

    it('a pin the courier will not pick up from or deliver prepaid to', () => {
      const reverse = validate(vin({ serviceability: { reversePickup: false, prepaidDelivery: true, oda: false } }));
      expect(hardCodes(reverse)).toContain('reverse-pickup-not-serviceable');
      const prepaid = validate(vin({ serviceability: { reversePickup: true, prepaidDelivery: false, oda: false } }));
      expect(hardCodes(prepaid)).toContain('prepaid-delivery-not-serviceable');
      // The owner has to be told what to do instead, because we cannot do it.
      for (const r of [reverse, prepaid]) {
        expect(r.stops.find((s) => s.code.endsWith('-not-serviceable')).message).toContain('ask the customer to self-ship, or handle by hand');
      }
    });

    it('a declared value at or above the e-waybill threshold', () => {
      expect(RULES.replace.ewaybillThresholdInr).toBe(50000);
      const dear = { line: line({ unitPaise: 5000000 }), qty: 1, variant: v(102, sizeOnly('XL'), { price: '50000.00' }) };
      expect(hardCodes(validate(vin({ resolved: [dear] })))).toContain('ewaybill-threshold');
      expect(hardCodes(validate(vin({ declaredValueInr: RULES.replace.ewaybillThresholdInr })))).toContain('ewaybill-threshold');
      expect(hardCodes(validate(vin({ declaredValueInr: RULES.replace.ewaybillThresholdInr - 1 })))).not.toContain('ewaybill-threshold');
      // Quantity counts: two of a Rs 30,000 piece is over the line.
      const two = { line: line({ quantity: 2, unitPaise: 3000000 }), qty: 2, variant: v(102, sizeOnly('XL'), { price: '30000.00' }) };
      expect(hardCodes(validate(vin({ resolved: [two] })))).toContain('ewaybill-threshold');
    });

    /*
     * The HSN code goes on a GST document in the owner's name, so the stop
     * names the key and the first command refuses until a real value is set.
     */
    /*
     * Only the warehouse name blocks. It is a per-shipment field, one account
     * can hold several registered pickup locations, and the courier exposes no
     * way to list them, so nothing but a human can say which one. GSTIN and
     * HSN already live on the courier account the token belongs to, so blocking
     * on them made the owner re-enter details Delhivery already had.
     */
    it('a missing warehouse name is the only config that refuses', () => {
      const full = { pickupLocation: 'Morpaankh Studio', gstin: '24ABCDE1234F1Z5', hsn: '6204' };
      for (const empty of ['', false]) {
        expect(hardCodes(validate(vin({ configPresent: { ...full, pickupLocation: empty } })))).toContain(
          'config-missing-pickup-location',
        );
      }
      expect(hardCodes(validate(vin({ configPresent: {} })))).toEqual(['config-missing-pickup-location']);
      // Presence may be passed as a flag rather than a value.
      expect(hardCodes(validate(vin({ configPresent: { pickupLocation: true, gstin: true, hsn: true } })))).toEqual([]);
    });

    it('a missing GSTIN or HSN warns in the preview instead, and never guesses one', () => {
      const codes = warnCodes(validate(vin({ configPresent: { pickupLocation: 'Morpaankh Studio' } })));
      expect(codes).toContain('config-missing-gstin');
      expect(codes).toContain('config-missing-hsn');
      // RULES still ships hsn empty: an invented tariff code would be a wrong
      // tax declaration on a GST document in the owner's name.
      expect(RULES.replace.hsn).toBe('');
    });
  });

  describe('soft stops, which force is the orchestrator way past', () => {
    it('a delivery the courier never confirmed, and an order with no waybill', () => {
      expect(softCodes(validate(vin({ delivered: null })))).toContain('delivery-unconfirmed');
      expect(softCodes(validate(vin({ courierAwb: null })))).toContain('awb-missing');
      expect(softCodes(validate(vin({ courierAwb: null, delivered: null })))).toEqual(['awb-missing', 'delivery-unconfirmed']);
    });

    it('a delivery the courier confirmed without a time still counts as delivered', () => {
      // The shape the older state rows are in: DELIVERED, no courierStatusAt.
      const codes = softCodes(validate(vin({ delivered: { confirmed: true, at: null } })));
      expect(codes).not.toContain('delivery-unconfirmed');
      // No time means no age, so the routine window cannot be measured either.
      expect(codes).not.toContain('outside-replacement-window');
    });

    it('a delivery older than the routine window', () => {
      expect(RULES.replace.windowDays).toBe(7);
      const old = { at: '2026-10-10T06:00:00Z', pin: '395007' };
      expect(softCodes(validate(vin({ delivered: old })))).toContain('outside-replacement-window');
      // Exactly on the window is still routine.
      const edge = { at: '2026-10-15T06:00:00Z', pin: '395007' };
      expect(softCodes(validate(vin({ delivered: edge })))).not.toContain('outside-replacement-window');
    });

    it('an out of delivery area pin', () => {
      expect(softCodes(validate(vin({ serviceability: { reversePickup: true, prepaidDelivery: true, oda: true } })))).toContain('oda-pin');
    });

    /*
     * The orchestrator owns the policy (hard refuses, soft refuses unless
     * force), so `force` must NOT change what comes back from here. Dropping
     * soft stops on force would put the same decision in two places and the
     * preview would stop printing what was overridden.
     */
    it('still reports the soft stop when force was typed', () => {
      const forced = validate(vin({ delivered: null, flags: { force: true } }));
      expect(softCodes(forced)).toContain('delivery-unconfirmed');
      expect(hardCodes(validate(vin({ n: order({ cancelledAt: NOW }), flags: { force: true } })))).toContain('order-cancelled');
    });
  });

  describe('warnings, which never block', () => {
    it('a new garment dearer than the one that was paid for', () => {
      const dearer = { line: line({ unitPaise: 124900 }), qty: 1, variant: v(102, sizeOnly('XL'), { price: '1499.00' }) };
      const r = validate(vin({ resolved: [dearer] }));
      expect(warnCodes(r)).toContain('price-above-paid');
      expect(r.stops).toEqual([]);
      // Cheaper or equal says nothing: nobody is owed a refund on a swap.
      const cheaper = { line: line({ unitPaise: 124900 }), qty: 1, variant: v(102, sizeOnly('XL'), { price: '999.00' }) };
      expect(warnCodes(validate(vin({ resolved: [cheaper] })))).not.toContain('price-above-paid');
    });

    it('an original order that was COD, from the stored class or the gateway', () => {
      expect(warnCodes(validate(vin({ st: { class: 'COD' } })))).toContain('original-order-cod');
      expect(warnCodes(validate(vin({ n: order({ gateways: ['Cash on Delivery (COD)'] }) })))).toContain('original-order-cod');
      expect(warnCodes(validate(vin()))).not.toContain('original-order-cod');
    });

    it('a courier pin that disagrees with the Shopify pin', () => {
      const r = validate(vin({ delivered: { at: DELIVERED_AT, pin: '400001' } }));
      expect(warnCodes(r)).toContain('delivered-pin-mismatch');
      expect(r.stops).toEqual([]);
    });

    /*
     * None of these three stop the logistics. Both parcels go either way; what
     * changes is that the customer hears nothing from us.
     */
    it('a customer we cannot message, who is never a reason to stop', () => {
      const no = validate(vin({ customer: { verifiedPhone: null } }));
      expect(warnCodes(no)).toContain('customer-no-verified-phone');
      expect(no.stops).toEqual([]);
      const out = validate(vin({ customer: { verifiedPhone: '+919812345678', optedOut: true } }));
      expect(warnCodes(out)).toContain('customer-opted-out');
      expect(out.stops).toEqual([]);
      const dead = validate(vin({ customer: { verifiedPhone: '+919812345678', undeliverable: true } }));
      expect(warnCodes(dead)).toContain('customer-undeliverable');
      expect(dead.stops).toEqual([]);
    });
  });

  it('reads every figure from RULES rather than carrying its own', () => {
    const rules = { ...RULES, replace: { ...RULES.replace, windowDays: 1, ewaybillThresholdInr: 1000 } };
    const r = validate(vin({ rules }));
    expect(softCodes(r)).toContain('outside-replacement-window');
    expect(hardCodes(r)).toContain('ewaybill-threshold');
  });

  it('survives being handed nothing at all', () => {
    expect(codes(validate({}))).toEqual(['order-not-found']);
    // @ts-expect-error deliberately no input
    expect(codes(validate())).toEqual(['order-not-found']);
  });
});
