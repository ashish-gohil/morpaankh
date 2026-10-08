/*
 * variantChange.test.mjs — the rules, with no WhatsApp and no Shopify in sight.
 *
 * The expensive mistakes this feature can make are all decisions: swapping in
 * something that costs more, offering a product we do not understand, editing
 * an order that is already on a van. They are all decided here.
 */
import { describe, it, expect } from 'vitest';
import { RULES } from '../../messages/rules.mjs';
import {
  orderChangeable,
  lineChangeable,
  changeableLines,
  targetsFor,
  coloursFor,
  sizesFor,
  hasOtherColours,
  resolveTarget,
  describeVariant,
} from './variantChange.mjs';

const VAR = (n) => `gid://shopify/ProductVariant/${n}`;
const LI = (n) => `gid://shopify/LineItem/${n}`;

const line = (over = {}) => ({
  id: LI(1),
  title: 'Khili Dhoop',
  quantity: 1,
  productGid: 'gid://shopify/Product/9',
  productHandle: 'khili-dhoop',
  variantGid: VAR(100),
  unitPaise: 124900,
  discountPaise: 0,
  variant: { id: VAR(100), selectedOptions: [{ name: 'Size', value: 'XS' }] },
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

const product = (over = {}) => ({
  id: 'gid://shopify/Product/9',
  handle: 'khili-dhoop',
  title: 'Khili Dhoop',
  options: [{ name: 'Size', values: ['XS', 'M', 'L'] }],
  variants: { nodes: [v(100, sizeOnly('XS')), v(101, sizeOnly('M')), v(102, sizeOnly('L'))] },
  ...over,
});

const order = (over = {}) => ({
  gid: 'gid://shopify/Order/1',
  numericId: '1',
  name: '#1234',
  tags: [],
  isTest: false,
  cancelledAt: null,
  verifiedPhone: '+919812345678',
  receivedPaise: 0,
  currentTotalPaise: 129900,
  delhiveryAwb: null,
  fulfillments: [],
  lineItems: [line()],
  ...over,
});

const COD = { class: 'COD' };
const PHONE = '+919812345678';

describe('who may change an order', () => {
  it('lets a plain unshipped COD order through', () => {
    expect(orderChangeable(order(), COD, PHONE)).toEqual({ ok: true });
  });

  it('refuses once an AWB exists, because the label carries the old SKU', () => {
    expect(orderChangeable(order({ delhiveryAwb: 'AWB1' }), COD, PHONE).reason).toBe('awb-exists');
  });

  it('refuses a fulfilled order', () => {
    expect(orderChangeable(order({ fulfillments: [{ status: 'SUCCESS' }] }), COD, PHONE).reason).toBe('fulfilled');
  });

  it('refuses once money has been received, because a refund is a person job', () => {
    expect(orderChangeable(order({ receivedPaise: 1 }), COD, PHONE).reason).toBe('money-received');
    expect(orderChangeable(order({ receivedPaise: 129900 }), COD, PHONE).reason).toBe('money-received');
  });

  it('refuses anything that is not a stored COD order', () => {
    expect(orderChangeable(order(), { class: 'PREPAID' }, PHONE).reason).toBe('not-cod');
    expect(orderChangeable(order(), { class: 'PARTIAL' }, PHONE).reason).toBe('not-cod');
    expect(orderChangeable(order(), { class: 'UNKNOWN' }, PHONE).reason).toBe('not-cod');
    expect(orderChangeable(order(), {}, PHONE).reason).toBe('not-cod');
  });

  it('refuses a cancelled order', () => {
    expect(orderChangeable(order({ cancelledAt: '2026-10-01T00:00:00Z' }), COD, PHONE).reason).toBeTruthy();
  });

  /*
   * Strict, unlike the shared ownsOrder gate which lets an order with no stored
   * verified phone through. Fail-open is defensible for a read; this edits
   * someone's order.
   */
  it('refuses a phone that is not the order owner, and refuses an unknown owner', () => {
    expect(orderChangeable(order(), COD, '+919800000000').reason).toBe('not-owner');
    expect(orderChangeable(order({ verifiedPhone: null }), COD, PHONE).reason).toBe('not-owner');
    expect(orderChangeable(order(), COD, null).reason).toBe('not-owner');
  });

  it('allows exactly one change per order, then refuses', () => {
    expect(RULES.variantChangeMaxPerOrder).toBe(1);
    expect(orderChangeable(order(), { ...COD, flowA: { variantChanges: 0 } }, PHONE).ok).toBe(true);
    expect(orderChangeable(order(), { ...COD, flowA: { variantChanges: 1 } }, PHONE).reason).toBe('limit-reached');
  });

  it('refuses a test order', () => {
    expect(orderChangeable(order({ isTest: true }), COD, PHONE).reason).toBe('test-order');
  });

  it('refuses a COD-Cancelled order', () => {
    expect(orderChangeable(order({ tags: ['COD-Cancelled'] }), COD, PHONE).reason).toBe('cod-cancelled-tag');
  });
});

describe('which lines may be changed', () => {
  it('takes a single-quantity line with a product and a variant', () => {
    expect(lineChangeable(line())).toBe(true);
  });

  it('refuses a multi-quantity line, which is a split rather than a swap', () => {
    expect(lineChangeable(line({ quantity: 2 }))).toBe(false);
  });

  it('refuses a line with no variant, which a deleted variant produces', () => {
    expect(lineChangeable(line({ variantGid: null }))).toBe(false);
  });

  /*
   * The COD King helper product. The option rule below also excludes it,
   * because its only option is "Payment Type", but that is a coincidence:
   * rename the option to "Size" and the guard would evaporate.
   */
  it('refuses the partial-payment product by handle, not only by its option name', () => {
    expect(lineChangeable(line({ productHandle: 'partial-payment' }))).toBe(false);
    expect(targetsFor(line({ productHandle: 'partial-payment' }), product())).toEqual([]);
    expect(
      targetsFor(line(), product({ handle: 'partial-payment' })),
    ).toEqual([]);
  });

  it('picks the changeable lines out of a mixed order', () => {
    const n = order({ lineItems: [line(), line({ id: LI(2), quantity: 3 }), line({ id: LI(3) })] });
    expect(changeableLines(n).map((l) => l.id)).toEqual([LI(1), LI(3)]);
  });
});

describe('what they may change to', () => {
  it('offers the other in-stock sizes and never the one they already have', () => {
    const t = targetsFor(line(), product());
    expect(t.map((x) => x.id)).toEqual([VAR(101), VAR(102)]);
  });

  it('never offers an out-of-stock variant', () => {
    const p = product({
      variants: { nodes: [v(100, sizeOnly('XS')), v(101, sizeOnly('M'), { inventoryQuantity: 0 }), v(102, sizeOnly('L'), { availableForSale: false })] },
    });
    expect(targetsFor(line(), p)).toEqual([]);
  });

  /*
   * Every variant of every product in this catalogue shares one price today, so
   * a swap moves no money. That is a fact about the catalogue, not a guarantee,
   * so a differently priced target is simply not offered.
   */
  it('never offers a variant at a different price', () => {
    const p = product({
      variants: { nodes: [v(100, sizeOnly('XS')), v(101, sizeOnly('M'), { price: '1399.00' })] },
    });
    expect(targetsFor(line(), p)).toEqual([]);
  });

  it('refuses a product carrying an option it does not understand', () => {
    const p = product({ options: [{ name: 'Size', values: ['XS'] }, { name: 'Fit', values: ['Regular'] }] });
    expect(targetsFor(line(), p)).toEqual([]);
    const pp = product({ options: [{ name: 'Payment Type', values: ['PartPayment'] }] });
    expect(targetsFor(line(), pp)).toEqual([]);
  });

  it('accepts Colour spelled either way', () => {
    for (const name of ['Color', 'Colour']) {
      const p = product({
        options: [{ name: 'Size', values: ['XS', 'M'] }, { name, values: ['Indigo'] }],
        variants: {
          nodes: [
            v(100, [{ name: 'Size', value: 'XS' }, { name, value: 'Indigo' }]),
            v(101, [{ name: 'Size', value: 'M' }, { name, value: 'Indigo' }]),
          ],
        },
      });
      expect(targetsFor(line(), p).map((x) => x.id)).toEqual([VAR(101)]);
    }
  });
});

describe('sizes and colours offered', () => {
  const multi = product({
    options: [{ name: 'Size', values: ['M', 'L'] }, { name: 'Color', values: ['Brown', 'Indigo'] }],
    variants: {
      nodes: [
        v(100, sizeColour('M', 'Brown')),
        v(101, sizeColour('L', 'Brown')),
        v(102, sizeColour('M', 'Indigo')),
        v(103, sizeColour('L', 'Indigo')),
      ],
    },
  });
  const brownM = line({ variantGid: VAR(100), variant: { id: VAR(100), selectedOptions: sizeColour('M', 'Brown') } });

  it('offers only the other colours, each once', () => {
    const t = targetsFor(brownM, multi);
    expect(coloursFor(t, 'Brown').map((c) => c.colour)).toEqual(['Indigo']);
    expect(hasOtherColours(t, 'Brown')).toBe(true);
  });

  it('says there are no other colours when the product has one', () => {
    expect(hasOtherColours(targetsFor(line(), product()), null)).toBe(false);
  });

  it('pins sizes to the chosen colour', () => {
    const t = targetsFor(brownM, multi);
    expect(sizesFor(t, 'Brown').map((s) => s.size)).toEqual(['L']);
    expect(sizesFor(t, 'Indigo').map((s) => s.size)).toEqual(['M', 'L']);
  });

  /*
   * Meta allows 10 rows for ALL sections combined. One product in this
   * catalogue has 10 colours, so a colour list can consume the entire budget
   * and there is no room for an extra row.
   */
  it('stays inside a 10 row list for the widest product in the catalogue', () => {
    const colours = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const p = product({
      options: [{ name: 'Size', values: ['M'] }, { name: 'Color', values: colours }],
      variants: { nodes: colours.map((c, i) => v(200 + i, sizeColour('M', c))) },
    });
    const cur = line({ variantGid: VAR(200), variant: { id: VAR(200), selectedOptions: sizeColour('M', 'A') } });
    expect(coloursFor(targetsFor(cur, p), 'A').length).toBeLessThanOrEqual(10);
  });
});

describe('a tapped id is looked up, never trusted', () => {
  /*
   * Button payloads are clear text and carry no signature, so the final step
   * re-derives the candidate set and looks the tapped id up inside it. Without
   * this, a crafted payload could name any variant in the store.
   */
  it('resolves a genuine candidate', () => {
    expect(resolveTarget(line(), product(), VAR(101)).id).toBe(VAR(101));
  });

  it('refuses a variant of a DIFFERENT product', () => {
    expect(resolveTarget(line(), product(), VAR(999))).toBe(null);
  });

  it('refuses the variant they already have', () => {
    expect(resolveTarget(line(), product(), VAR(100))).toBe(null);
  });

  it('refuses an out-of-stock or differently priced target even if it is on this product', () => {
    const p = product({
      variants: { nodes: [v(100, sizeOnly('XS')), v(101, sizeOnly('M'), { inventoryQuantity: 0 }), v(102, sizeOnly('L'), { price: '99.00' })] },
    });
    expect(resolveTarget(line(), p, VAR(101))).toBe(null);
    expect(resolveTarget(line(), p, VAR(102))).toBe(null);
  });

  it('refuses nothing at all', () => {
    expect(resolveTarget(line(), product(), null)).toBe(null);
  });
});

describe('how a variant reads to the customer', () => {
  it('names the size, and the colour when there is one', () => {
    expect(describeVariant('Khili Dhoop', v(101, sizeOnly('2XL')))).toBe('Khili Dhoop, size 2XL');
    expect(describeVariant('Bandhan', v(101, sizeColour('XL', 'Brown')))).toBe('Bandhan, Brown, size XL');
  });

  it('falls back to the title alone when there are no options', () => {
    expect(describeVariant('Taana', v(101, []))).toBe('Taana');
  });
});
