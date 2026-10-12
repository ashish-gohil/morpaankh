#!/usr/bin/env node
/*
 * cart-recovery — inspect and hand-run Flow R against one checkout.
 *
 *   node scripts/cart-recovery.mjs preview <checkoutId>
 *   node scripts/cart-recovery.mjs send    <checkoutId> --live [--force]
 *   node scripts/cart-recovery.mjs final   <checkoutId> --live
 *
 * `preview` writes NOTHING and sends nothing: it reads the checkout, prices it
 * against the live public codes, shows the code it would make and both messages
 * as the customer would read them, and prints the link. Use it first, always.
 *
 * The two live commands go through the REAL onFirst / onFinal, so what they
 * exercise is production and not a copy of it. They refuse outright unless the
 * checkout's phone is in FLOW_R_ALLOWLIST, which is what keeps this tool from
 * ever reaching a customer by accident.
 *
 * The ONLY thing `send --live` relaxes is the twenty-minute wait: it advances
 * its own clock to the moment the checkout becomes old enough, which can only
 * move time FORWARD, and it still refuses if that moment is outside the send
 * window. Nothing else is bypassed.
 */
import { config } from '../src/config.mjs';
import { RULES } from '../messages/rules.mjs';
import { realClients } from '../src/clients/index.mjs';
import { normalizeCheckout, cartEligible, computeCartOffer, personalCodeName, cartCode, recoveryTimes, formatExpiresAt, formatTimeLeft } from '../src/domain/cart.mjs';
import { itemLine, heroImageUrl } from '../src/domain/order.mjs';
import { formatINR } from '../src/lib/money.mjs';
import { withinWindow } from '../src/lib/time.mjs';
import { TEMPLATES } from '../messages/templates.mjs';
import { getRec, releasePhoneLock, getPhoneLock } from '../src/store/cartRecovery.mjs';
import * as cartRecovery from '../src/worker/cartRecovery.run.mjs';
import { maskPhone } from '../src/log.mjs';

const [cmd, checkoutId] = process.argv.slice(2);
const live = process.argv.includes('--live');
const force = process.argv.includes('--force');

if (!['preview', 'send', 'final'].includes(cmd) || !checkoutId) {
  console.error('usage: cart-recovery.mjs <preview|send|final> <checkoutId> [--live] [--force]');
  process.exit(1);
}

const raw = await realClients.shopify.getAbandonedCheckout(checkoutId);
const n = normalizeCheckout(raw);
if (!n) {
  console.error(`no abandoned checkout ${checkoutId}. Note this reads node(id:), not a query: a query by id returns nothing for a checkout that is definitely there.`);
  process.exit(2);
}

const now = new Date();
const fill = (body, vars) => body.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `[${k}]`);

console.log(`\ncheckout ${n.name}  (${checkoutId})`);
console.log(`  created   ${n.createdAt}  (${Math.round((now - new Date(n.createdAt)) / 60000)} min ago)`);
console.log(`  phone     ${n.verifiedPhone ? maskPhone(n.verifiedPhone) : 'NONE (not messageable)'}`);
console.log(`  name      ${n.firstName}`);
console.log(`  bag       ${formatINR(n.bagPaise)} over ${n.quantity} item(s), already off: ${formatINR(n.ownDiscountPaise)}`);
console.log(`  item      ${itemLine(n)}`);
console.log(`  photo     ${heroImageUrl(n) ? 'yes' : 'NO (the plain template would be used)'}`);
console.log(`  codk      ${n.codkAmountType}/${n.codkAmountValue}`);

const eligible = cartEligible(n, { now, startAt: config.flows.R.startAt, rules: RULES });
console.log(`  eligible  ${eligible.ok ? 'yes' : `NO (${eligible.reason})`}`);
console.log(`  flow R    ${config.flows.R.enabled ? 'on' : 'OFF'}, startAt ${config.flows.R.startAt || '(unset: nothing qualifies)'}`);
console.log(`  allowlist ${config.cartRecoveryAllowlist.length ? config.cartRecoveryAllowlist.map(maskPhone).join(' ') : '(empty: live to everyone)'}`);
console.log(`  window    ${RULES.cartRecovery.sendWindow.start} to ${RULES.cartRecovery.sendWindow.end} IST, now ${withinWindow(now, RULES.cartRecovery.sendWindow) ? 'inside' : 'OUTSIDE'}`);

let publicCodes = [];
try {
  publicCodes = await realClients.shopify.publicCodeDiscounts();
  console.log(`  public    ${publicCodes.map((c) => c.code).join(', ') || '(none)'}`);
} catch (e) {
  console.log(`  public    FAILED to read: ${e.message.slice(0, 160)}`);
  console.log('            Flow R refuses to offer blind, so every checkout would be skipped as no-public-codes.');
  console.log('            The app needs read_discounts.');
}

const offer = computeCartOffer({
  bagPaise: n.bagPaise, ownDiscountPaise: n.ownDiscountPaise, quantity: n.quantity, publicCodes, rules: RULES,
});
console.log(`\noffer`);
console.log(`  floor     ${formatINR(offer.floorPaise)}  (best public ${formatINR(offer.publicBestPaise)}, already applied ${formatINR(n.ownDiscountPaise)})`);
console.log(`  want/cap  ${formatINR(offer.wantPaise)} / ${formatINR(offer.capPaise)}`);
console.log(`  OFFER     ${formatINR(offer.offerPaise)} ${offer.ok ? '' : '-> NOT SENT (public-offer-better)'}`);
console.log(`  min cart  Rs ${offer.minSubtotalInr}`);

const rec = await getRec(checkoutId);
const lock = n.verifiedPhone ? await getPhoneLock(n.verifiedPhone) : null;
console.log(`\nstate`);
console.log(`  record    ${rec ? `yes (outcome ${rec.outcome || 'none'}, firstSentAt ${rec.firstSentAt || 'none'}, clicks ${rec.clicks || 0})` : 'none'}`);
console.log(`  phone lock ${lock ? `held until ${lock.lockUntil} by checkout ${lock.checkoutId}` : 'free'}`);

if (cmd === 'preview') {
  const times = recoveryTimes(now, RULES);
  const vars = {
    customer_name: n.firstName,
    item_line: itemLine(n) || 'your bag',
    code: rec?.code || cartCode(personalCodeName(n.rawFirstName, RULES), 2, RULES),
    saving: formatINR(offer.offerPaise),
    expires_at: formatExpiresAt(times.codeEndsAt, now),
    time_left: formatTimeLeft(RULES.cartRecovery.finalBeforeEndMin * 60000),
  };
  console.log(`\ncode would be  ${vars.code}   (name part from "${n.rawFirstName || '(none)'}" -> ${personalCodeName(n.rawFirstName, RULES)})`);
  console.log(`closes         ${times.codeEndsAt.toISOString()}  (${vars.expires_at})`);
  console.log(`reminder       ${times.reminderAt.toISOString()}`);
  console.log(`link           ${config.publicBaseUrl}/r/<token>`);
  for (const key of ['cart_recovery', 'cart_final']) {
    console.log(`\n--- ${TEMPLATES[key].name} ---`);
    console.log(fill(TEMPLATES[key].body, vars));
    console.log(`(footer) ${TEMPLATES[key].footer}`);
  }
  console.log('\npreview only: nothing was created, sent or written.');
  process.exit(0);
}

// ---- live commands ---------------------------------------------------------
if (!live) {
  console.error(`\nrefusing: ${cmd} needs --live. Run preview first.`);
  process.exit(1);
}
if (!n.verifiedPhone) {
  console.error('\nrefusing: this checkout has no OTP-verified phone, which is the only number this service may message.');
  process.exit(3);
}
if (!config.cartRecoveryAllowlist.includes(n.verifiedPhone)) {
  console.error(`\nrefusing: ${maskPhone(n.verifiedPhone)} is not in FLOW_R_ALLOWLIST. This tool will not message anyone outside it.`);
  process.exit(3);
}

if (cmd === 'send') {
  /*
   * Advance the clock only as far as the twenty-minute wait, and only forward.
   * Everything else, including the send window, is then checked against this
   * same moment, so nothing is skipped, only brought forward.
   */
  const ready = new Date(new Date(n.createdAt).getTime() + RULES.cartRecovery.firstAfterMin * 60000 + 1000);
  const when = ready > now ? ready : now;
  if (when > now) console.log(`\nclock advanced ${Math.round((when - now) / 1000)}s to clear the ${RULES.cartRecovery.firstAfterMin} minute wait`);
  if (!withinWindow(when, RULES.cartRecovery.sendWindow)) {
    console.error('refusing: that moment is outside the send window.');
    process.exit(4);
  }
  if (force && lock) {
    console.log(`--force: releasing the phone lock held by checkout ${lock.checkoutId}`);
    await releasePhoneLock(n.verifiedPhone);
  }
  const out = await cartRecovery.onFirst(checkoutId, { clients: realClients, now: when });
  console.log('\nonFirst ->', JSON.stringify(out));
  const after = await getRec(checkoutId);
  console.log('record  ->', JSON.stringify({
    code: after?.code, offer: after?.offerPaise, firstSentAt: after?.firstSentAt,
    codeEndsAt: after?.codeEndsAt, reminderAt: after?.reminderAt, outcome: after?.outcome,
  }));
  if (after?.token) console.log('link    ->', `${config.publicBaseUrl}/r/${after.token}`);
  process.exit(0);
}

if (cmd === 'final') {
  const out = await cartRecovery.onFinal(checkoutId, { clients: realClients, now });
  console.log('\nonFinal ->', JSON.stringify(out));
  const after = await getRec(checkoutId);
  console.log('record  ->', JSON.stringify({ finalSentAt: after?.finalSentAt, finalSkipped: after?.finalSkipped }));
}
