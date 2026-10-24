#!/usr/bin/env node
/*
 * subscriber-offer — inspect and hand-run Flow W, the 24 hour welcome offer.
 *
 *   node scripts/subscriber-offer.mjs preview  --date 2026-10-23
 *   node scripts/subscriber-offer.mjs run      --date 2026-10-23 --live
 *   node scripts/subscriber-offer.mjs backfill --from 2026-10-18 --to 2026-10-23 --live
 *   node scripts/subscriber-offer.mjs status   <customerId>
 *
 * `preview` writes NOTHING and sends nothing. It reads that IST day's new
 * customers, prints each one with the gate that would stop them, and shows the
 * message as the customer would read it. IT IGNORES FLOW_W_START_AT on purpose
 * and says so, because the question it answers is "who is out there", not "who
 * would we message today". Use it first, always.
 *
 * `run` goes through the REAL sweep and the REAL worker, so what it exercises
 * is production and not a copy of it. Every gate still applies, including
 * maxPerRun, the send window and FLOW_W_ALLOWLIST.
 *
 * `backfill` is the ONLY way past FLOW_W_START_AT: it runs a day at a time
 * with the start date wound back to that day. Everything else still applies.
 * It exists because the flow goes live mid-week and the people who joined on
 * Monday are not less welcome than the ones who join on Thursday.
 */
import { config } from '../src/config.mjs';
import { RULES } from '../messages/rules.mjs';
import { realClients } from '../src/clients/index.mjs';
import {
  istYesterdayWindow, normalizeCustomer, subscriberEligible, chooseChannel, phoneSkipReason,
  subscriberOfferGuard, subscriberCode, minimumPaise, shopifyMinimumInr, topPicks,
} from '../src/domain/subscriberOffer.mjs';
import { formatExpiresAt } from '../src/domain/cart.mjs';
import { formatINR } from '../src/lib/money.mjs';
import { fromISTWall, withinWindow, addHours } from '../src/lib/time.mjs';
import { TEMPLATES } from '../messages/templates.mjs';
import { getSubRec, getSweepDay, getPhoneOfferLock, getEmailOfferLock } from '../src/store/subscriberOffer.mjs';
import { sweepNewSubscribers } from '../src/timers/subscriber-sweep.mjs';
import { maskPhone } from '../src/log.mjs';

const argv = process.argv.slice(2);
const [cmd, arg] = argv;
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] || null;
};
const live = argv.includes('--live');

if (!['preview', 'run', 'backfill', 'status'].includes(cmd)) {
  console.error('usage: subscriber-offer.mjs <preview|run|backfill|status> [--date YYYY-MM-DD] [--from D --to D] [--live]');
  process.exit(1);
}

const now = new Date();
const fill = (body, vars) => body.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `[${k}]`);

/**
 * The IST day to work on, as the sweep itself computes it.
 *
 * `--date` is the day customers JOINED, and it is read as 11:00 IST on the day
 * AFTER it, because that is the moment the real cron would have looked at it.
 * Without the +1 a `--date` of yesterday would ask for the day before.
 */
function dayOf(dateStr) {
  if (!dateStr) return { at: now, window: istYesterdayWindow(now) };
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) {
    console.error(`bad --date ${dateStr}, expected YYYY-MM-DD`);
    process.exit(1);
  }
  const at = fromISTWall(y, m - 1, d + 1, 11, 0);
  return { at, window: istYesterdayWindow(at) };
}

// ---- status ----------------------------------------------------------------
if (cmd === 'status') {
  if (!arg) {
    console.error('usage: subscriber-offer.mjs status <customerId>');
    process.exit(1);
  }
  const rec = await getSubRec(arg);
  if (!rec) {
    console.log(`no welcome offer record for customer ${arg}`);
    process.exit(0);
  }
  console.log(`\ncustomer ${arg}`);
  for (const k of [
    'channel', 'phoneSkipReason', 'code', 'codeEndsAt', 'firstSentAt', 'outcome', 'outcomeAt',
    'clicks', 'firstClickAt', 'orderId', 'codeUsed', 'deliveryFailed', 'deliveryError', 'lastStatus',
  ]) {
    if (rec[k] !== undefined && rec[k] !== null) console.log(`  ${k.padEnd(16)} ${rec[k]}`);
  }
  console.log(`  ${'phone'.padEnd(16)} ${rec.phone ? maskPhone(rec.phone) : '(none)'}`);
  if (rec.token) console.log(`  ${'link'.padEnd(16)} ${config.publicBaseUrl}/w/${rec.token}`);
  console.log(`  ${'phone lock'.padEnd(16)} ${rec.phone && (await getPhoneOfferLock(rec.phone)) ? 'HELD (once ever)' : 'free'}`);
  console.log(`  ${'email lock'.padEnd(16)} ${rec.emailKey && (await getEmailOfferLock(rec.emailKey)) ? 'HELD (once ever)' : 'free'}`);
  process.exit(0);
}

// ---- preview ---------------------------------------------------------------
if (cmd === 'preview') {
  const { at, window } = dayOf(flag('date'));
  console.log(`\nwelcome offers for the IST day ${window.date}`);
  console.log(`  window    ${window.startISO} to ${window.endISO}`);
  console.log(`  as if run ${at.toISOString()} (11:00 IST the next morning)`);
  console.log(`  flow W    ${config.flows.W.enabled ? 'on' : 'OFF'}, startAt ${config.flows.W.startAt || '(unset: nothing qualifies)'}`);
  console.log('  NOTE      this preview IGNORES FLOW_W_START_AT, so it shows who is out there');
  console.log('            rather than who would be messaged today. `run` does not ignore it.');
  console.log(`  allowlist ${config.subscriberOfferAllowlist.length ? config.subscriberOfferAllowlist.map(maskPhone).join(' ') : '(empty: live to everyone)'}`);
  console.log(`  send win  ${RULES.subscriberOffer.sendWindow.start} to ${RULES.subscriberOffer.sendWindow.end} IST, 11:00 is ${withinWindow(at, RULES.subscriberOffer.sendWindow) ? 'inside' : 'OUTSIDE'}`);
  console.log(`  day mark  ${(await getSweepDay(window.date)) ? 'WRITTEN (a run would be a no-op)' : 'not written'}`);

  let nodes = [];
  let after = null;
  try {
    for (;;) {
      const page = await realClients.shopify.listNewCustomers({ sinceISO: window.startISO, untilISO: window.endISO, after });
      if (!page.nodes.length) break;
      nodes.push(...page.nodes);
      if (!page.cursor) break;
      after = page.cursor;
    }
  } catch (e) {
    console.error(`\nthe customer search FAILED: ${e.message.slice(0, 200)}`);
    console.error('The sweep fails closed on this, so nothing would be sent and no day marker written.');
    process.exit(2);
  }
  console.log(`\n${nodes.length} new customer(s) with no orders, per orders_count:0`);

  let publicCodes = [];
  try {
    publicCodes = await realClients.shopify.publicCodeDiscounts();
    console.log(`public codes: ${publicCodes.map((c) => c.code).join(', ') || '(none)'}`);
  } catch (e) {
    console.log(`public codes: FAILED to read (${e.message.slice(0, 120)})`);
    console.log('  Flow W fails CLOSED on this: every candidate would be skipped as no-public-codes.');
  }
  const guard = subscriberOfferGuard({
    amountPaise: RULES.subscriberOffer.amountInr * 100,
    minimumPaise: minimumPaise(RULES),
    publicCodes,
    rules: RULES,
  });
  // The minimum is the only figure here that is not whole rupees, so it goes
  // through formatINR too rather than being printed raw beside one that did:
  // the preview is read by the owner, and 'Rs 1500.01' beside '₹200' reads as
  // two different currencies.
  console.log(`\noffer ${formatINR(RULES.subscriberOffer.amountInr * 100)} on orders above ${formatINR(Math.round(shopifyMinimumInr(RULES) * 100))}`);
  console.log(`  floor   ${formatINR(guard.floorPaise)} (best public ${formatINR(guard.publicBestPaise)} + beat by ${formatINR(RULES.cartRecovery.beatPublicByInr * 100)})`);
  console.log(`  ceiling ${formatINR(guard.capPaise)}`);
  console.log(`  GUARD   ${guard.ok ? 'passes' : `REFUSES EVERYTHING (${guard.reason})`}`);

  for (const node of nodes) {
    const n = normalizeCustomer(node);
    if (!n) {
      console.log('\n  (a null node)');
      continue;
    }
    // startAt is deliberately wound back to the window itself, so the only
    // thing this reports is the gates that are about the CUSTOMER.
    const e = subscriberEligible(n, { now: at, startAt: window.startISO, rules: RULES });
    const ch = chooseChannel(n, { rules: RULES });
    const rec = await getSubRec(n.numericId);
    console.log(`\n  ${n.numericId}  ${n.firstName}`);
    console.log(`    joined   ${n.createdAt}   orders ${n.numberOfOrders}   tags [${n.tags.join(', ')}]`);
    console.log(`    phone    ${n.phone ? maskPhone(n.phone) : `unusable (${phoneSkipReason(n)})`}`);
    console.log(`    email    ${n.email ? `${n.email.slice(0, 2)}***@${n.email.split('@')[1] || ''} (${n.emailMarketingState})` : '(none)'}`);
    console.log(`    channel  ${ch.channel}${ch.reason ? ` (${ch.reason})` : ''}`);
    console.log(`    verdict  ${e.ok ? 'CANDIDATE' : `skipped: ${e.reason}`}`);
    if (rec) console.log(`    record   outcome ${rec.outcome || 'none'}, firstSentAt ${rec.firstSentAt || 'none'} -> a run would skip as already-started`);
  }

  const codeEndsAt = addHours(at, RULES.subscriberOffer.codeValidHours);
  const vars = {
    customer_name: 'Priya',
    code: subscriberCode('Priya', RULES),
    saving: formatINR(RULES.subscriberOffer.amountInr * 100),
    min_order: formatINR(RULES.subscriberOffer.minOrderAboveInr * 100),
    expires_at: formatExpiresAt(codeEndsAt, at),
    top_picks: topPicks(await realClients.shopify.collectionBestSellers(RULES.subscriberOffer.collectionHandle, 6).catch(() => [])),
  };
  console.log(`\n--- ${TEMPLATES.subscriber_offer.name} ---`);
  console.log(fill(TEMPLATES.subscriber_offer.body, vars));
  console.log(`(footer) ${TEMPLATES.subscriber_offer.footer}`);
  console.log(`\nlink     ${config.publicBaseUrl}/w/<token>`);
  console.log('\npreview only: nothing was created, sent or written.');
  process.exit(0);
}

// ---- the live commands -----------------------------------------------------
if (!live) {
  console.error(`\nrefusing: ${cmd} needs --live. Run preview first.`);
  process.exit(1);
}
if (!config.flows.W.enabled) {
  console.error('\nrefusing: FLOW_W_ENABLED is false, so the sweep would do nothing anyway.');
  process.exit(3);
}

if (cmd === 'run') {
  const { at, window } = dayOf(flag('date'));
  console.log(`\nrunning the real sweep for ${window.date}, as of ${at.toISOString()}`);
  const out = await sweepNewSubscribers(realClients, at);
  console.log('sweep ->', JSON.stringify(out));
  console.log('\nThe queued messages are handled by the worker Lambda, not by this script.');
  console.log('A re-run of the same day is a no-op once the marker is written, and the');
  console.log('dedup id is stable, so a re-run before that costs nothing either.');
  process.exit(0);
}

if (cmd === 'backfill') {
  const from = flag('from');
  const to = flag('to');
  if (!from || !to) {
    console.error('usage: subscriber-offer.mjs backfill --from YYYY-MM-DD --to YYYY-MM-DD --live');
    process.exit(1);
  }
  /*
   * THE ONLY WAY PAST FLOW_W_START_AT, and it is done by winding the START
   * DATE back rather than by skipping the check: every other gate, including
   * maxPerRun, the lifetime locks, the cart and order gates and the allowlist,
   * applies to every single candidate exactly as it does on a normal day.
   */
  const original = config.flows.W.startAt;
  let day = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || !Number.isFinite(last.getTime()) || day > last) {
    console.error('bad --from/--to range');
    process.exit(1);
  }
  try {
    while (day <= last) {
      const iso = day.toISOString().slice(0, 10);
      const { at, window } = dayOf(iso);
      config.flows.W.startAt = window.startISO;
      console.log(`\n--- ${window.date} (startAt wound back to ${window.startISO}) ---`);
      const out = await sweepNewSubscribers(realClients, at);
      console.log('sweep ->', JSON.stringify(out));
      day = new Date(day.getTime() + 86400 * 1000);
    }
  } finally {
    config.flows.W.startAt = original;
  }
  console.log('\nbackfill done. The worker Lambda sends what was queued.');
  process.exit(0);
}
