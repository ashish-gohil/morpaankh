#!/usr/bin/env node
/*
 * sync-offers.selfcheck.mjs — does toOffer refuse every private code?
 *
 * This repo has no test runner, and the function it checks decides whether
 * somebody's single-use discount code ends up offered to strangers on the cart
 * page, so it gets a check that runs with plain node and no dependencies:
 *
 *   node scripts/sync-offers.selfcheck.mjs
 *
 * Importing sync-offers.mjs is safe because main() is guarded to run only when
 * that file is the entry point. If that guard is ever removed, this check will
 * push the live theme, which is its own loud failure.
 */
import assert from 'node:assert/strict';
import { toOffer } from './sync-offers.mjs';

const basic = (over = {}) => ({
  __typename: 'DiscountCodeBasic',
  title: 'Buy 2 get 10%',
  status: 'ACTIVE',
  usageLimit: null,
  appliesOncePerCustomer: false,
  codes: { nodes: [{ code: 'BUY2' }] },
  customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.1 } },
  minimumRequirement: { __typename: 'DiscountMinimumQuantity', greaterThanOrEqualToQuantity: '2' },
  customerSelection: { __typename: 'DiscountCustomerAll' },
  ...over,
});

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok    ${name}`); }
  catch (e) { failures += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

// The public codes that belong in the panel.
check('keeps BUY2', () => assert.equal(toOffer(basic())?.code, 'BUY2'));
check('keeps BUY3', () => {
  const o = toOffer(basic({ codes: { nodes: [{ code: 'BUY3' }] }, minimumRequirement: { __typename: 'DiscountMinimumQuantity', greaterThanOrEqualToQuantity: '3' } }));
  assert.equal(o.code, 'BUY3');
  assert.equal(o.minQty, 3);
});
check('keeps WELCOME150', () => {
  const o = toOffer(basic({
    title: 'Welcome 150',
    codes: { nodes: [{ code: 'WELCOME150' }] },
    customerGets: { value: { __typename: 'DiscountAmount', amount: { amount: '150.0' } } },
    minimumRequirement: { __typename: 'DiscountMinimumSubtotal', greaterThanOrEqualToSubtotal: { amount: '1500.0' } },
  }));
  assert.equal(o.code, 'WELCOME150');
  assert.equal(o.minSubtotal, 1500);
});

// Every shape the WhatsApp service mints. Any one of these reaching a slot
// would hand one customer's single-use code to the next shopper.
check('refuses a cart recovery code by title', () =>
  assert.equal(toOffer(basic({ title: 'Cart recovery #66743166239092', codes: { nodes: [{ code: 'MORPAANKHBHARTI77' }] } })), null));
check('refuses a subscriber offer by title', () =>
  assert.equal(toOffer(basic({ title: 'Subscriber offer #25296554525044' })), null));
check('refuses a review thanks code by title', () =>
  assert.equal(toOffer(basic({ title: 'Review thanks #1234' })), null));
check('refuses a single-use code whatever it is called', () =>
  assert.equal(toOffer(basic({ title: 'A friendly name', usageLimit: 1 })), null));
check('refuses a once-per-customer code', () =>
  assert.equal(toOffer(basic({ appliesOncePerCustomer: true })), null));
check('refuses a code aimed at named customers', () =>
  assert.equal(toOffer(basic({ customerSelection: { __typename: 'DiscountCustomerSegments' } })), null));

// Pre-existing rules that must survive the new ones.
check('refuses an inactive code', () => assert.equal(toOffer(basic({ status: 'EXPIRED' })), null));
check('refuses a free-shipping discount', () => assert.equal(toOffer(basic({ __typename: 'DiscountCodeFreeShipping' })), null));
check('tolerates a discount that reports no buyer selection at all', () =>
  assert.equal(toOffer(basic({ customerSelection: undefined }))?.code, 'BUY2'));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
