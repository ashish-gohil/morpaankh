/*
 * phoneProfile.mjs — PHONE#<e164>/PROFILE: opt-out, 24h window, awaiting-state,
 * human takeover, and the per-phone caps (marketing, review asks).
 */
import { table, VersionConflict } from './table.mjs';
import { withinDays } from '../lib/time.mjs';
import { RULES } from '../../messages/rules.mjs';
import { config } from '../config.mjs';
import { LANGS, normalizeLang, DEFAULT_LANG } from '../../messages/lang.mjs';
import { log, maskPhone, metric } from '../log.mjs';

const pk = (phone) => `PHONE#${phone}`;
const DAY = 86400 * 1000;

/*
 * STRONGLY CONSISTENT, and that is a decision rather than a default.
 *
 * This row holds the opt-out, the undeliverable flag, the marketing cap and
 * now the language, and every one of those is read moments after something
 * else wrote it. The language case is the one that forced it: onPick writes
 * the customer's choice and then, in the same invocation, the send path reads
 * it back to pick a registry. An eventually consistent read there sends
 * English seconds after they tapped Hindi, and the gate's own ordering fix
 * depends on seeing that write.
 *
 * It costs twice the read units on a row this service reads a few thousand
 * times a month, which at this volume is cents. The same change quietly
 * closes a narrower window on the opt-out: STOP written by one record and read
 * by another seconds later.
 */
export async function getProfile(phone) {
  return (await table.get(pk(phone), 'PROFILE', { consistent: true })) || { PK: pk(phone), SK: 'PROFILE', phone };
}
/**
 * Merge fields into the profile. Retries once on a version conflict.
 *
 * This used to read the whole profile and put it back wholesale, with no
 * version check, so two writers for the same phone silently lost one of the two
 * writes. That is not theoretical: the queue serializes by ORDER, not by phone,
 * so a customer with two open orders has two records in flight at once. The
 * write that loses is arbitrary, and the one that matters most is the smallest:
 * a customer sends STOP (setOptOut) while a timer for their other order stamps
 * lastMarketingAt, the stamp is written over the opt-out, and we keep marketing
 * to someone who asked us to stop. Same shape erases `undeliverable` and
 * `awaiting`. table.update is conditional on the version it read, so the loser
 * now throws and retries against the winner's row instead of overwriting it.
 */
async function patch(phone, fields) {
  const attrs = { ...fields, phone };
  try {
    return await table.update(pk(phone), 'PROFILE', attrs);
  } catch (e) {
    if (e instanceof VersionConflict) return table.update(pk(phone), 'PROFILE', attrs);
    throw e;
  }
}

// opt-out
export const isOptedOut = async (phone) => Boolean((await getProfile(phone)).optOut);
export const setOptOut = (phone, optOut) => patch(phone, { optOut, optOutAt: optOut ? new Date().toISOString() : null });

// inbound / 24h session window
/**
 * Record an inbound message, and take the number off the undeliverable list.
 *
 * An inbound message is the strongest proof there is that this number receives
 * WhatsApp: it just sent us one. Without this clear, a number that bounced once
 * with 131026 stayed blocked even after its owner installed WhatsApp and wrote
 * to us by hand, and every later order of theirs went unanswered.
 */
export async function touchInbound(phone, now = new Date()) {
  const p = await getProfile(phone);
  const fields = { lastInboundAt: now.toISOString() };
  if (p.undeliverable) {
    fields.undeliverable = false;
    fields.undeliverableAt = null;
    log.info('phone: inbound message clears the undeliverable flag', {});
  }
  return patch(phone, fields);
}
export async function windowOpen(phone, now = new Date(), safetyMinutes = 10) {
  const p = await getProfile(phone);
  if (!p.lastInboundAt) return false;
  const elapsed = now.getTime() - new Date(p.lastInboundAt).getTime();
  return elapsed < DAY - safetyMinutes * 60 * 1000;
}

// awaiting free-text (address / other reason)
/**
 * Open a question against ONE ORDER, without closing the others.
 *
 * `awaiting` was a single slot, so a customer with two orders in trouble lost
 * one of the two questions silently: the NDR address question for order X was
 * overwritten by the RTO "why" question for order Y, and their next message
 * was then read as the answer to whichever question happened to survive. On
 * the address path that means an address pushed to the courier against the
 * wrong waybill.
 *
 * Keyed by order id now. The legacy single `awaiting` field is still READ by
 * getAwaiting, so questions open at deploy time are not dropped.
 */
export async function setAwaiting(phone, awaiting) {
  const orderId = String(awaiting?.orderId || '');
  if (!orderId) return patch(phone, { awaiting });
  const cur = (await getProfile(phone)).awaitingBy || {};
  return patch(phone, { awaitingBy: { ...cur, [orderId]: { ...awaiting, orderId } }, awaiting: null });
}

/**
 * Close one order's question, or all of them when no order is named.
 */
export async function clearAwaiting(phone, orderId) {
  if (!orderId) return patch(phone, { awaiting: null, awaitingBy: {} });
  const cur = (await getProfile(phone)).awaitingBy || {};
  const next = { ...cur };
  delete next[String(orderId)];
  return patch(phone, { awaitingBy: next, awaiting: null });
}

/**
 * Every question this phone still owes an answer to.
 *
 * `until` was written by every setAwaiting caller and read by NONE, so an
 * unanswered question stayed open forever: a customer asked for their address
 * after a failed delivery, never replied, and then months later sent an
 * unrelated "hi" that was read as the address for a long-closed order (and
 * pushed to the courier as an address edit). Expiring it here means every
 * caller gets it, which is the only place that is true.
 */
export async function listAwaiting(phone, now = new Date()) {
  const p = await getProfile(phone);
  const all = Object.values(p.awaitingBy || {});
  // The pre-deploy single slot, so a question open at deploy time still works.
  if (p.awaiting) all.push(p.awaiting);
  return all.filter((a) => a && (!a.until || new Date(a.until).getTime() > now.getTime()));
}

/**
 * The ONE open question, or null when there are none or more than one.
 *
 * Null for "more than one" on purpose: with two open, no reading of a free-text
 * reply is safe, and the router asks rather than guesses.
 */
export async function getAwaiting(phone, now = new Date()) {
  const live = await listAwaiting(phone, now);
  return live.length === 1 ? live[0] : null;
}

/*
 * human takeover (coexistence echoes)
 *
 * WIRED UP (N2, 2026-11-07). This number is in COEXISTENCE mode: the owner
 * answers customers from the WhatsApp Business app on their phone, and until
 * now the service could not see those messages at all, so it would drop a
 * template into the middle of a conversation somebody was having by hand.
 *
 * The missing piece was the `smb_message_echoes` webhook field, which Meta
 * only sends once the app is subscribed to it. The ingest reads those echoes
 * now and the worker calls setHumanTakeover on each one; tpl() refuses a
 * business-initiated template to a phone in takeover.
 *
 * M6 is still required: this does nothing until the field is subscribed in the
 * Meta App Dashboard. The code is inert rather than wrong without it.
 */
export const setHumanTakeover = (phone, until) => patch(phone, { humanTakeoverUntil: until });
export async function inHumanTakeover(phone, now = new Date()) {
  const p = await getProfile(phone);
  return Boolean(p.humanTakeoverUntil && new Date(p.humanTakeoverUntil).getTime() > now.getTime());
}

/*
 * N10. A customer turning marketing off INSIDE WhatsApp.
 *
 * They never sent us STOP, so nothing in this service knew: it would keep
 * sending marketing templates, Meta would refuse each one, and the refusals
 * would read as a throttle rather than as a person who asked us to stop. Which
 * is worse than it sounds, because every refusal looks like the thing we
 * already tolerate.
 *
 * SEPARATE from optOut, deliberately. optOut is this service's own record of
 * someone replying STOP here, and it blocks everything we start; this blocks
 * MARKETING only, which is what the customer actually turned off, and it is
 * theirs to turn back on.
 */
export const setMarketingOptOut = (phone, off, now = new Date()) =>
  patch(phone, { marketingOptOut: Boolean(off), marketingOptOutAt: off ? now.toISOString() : null });

// caps
export async function canSendMarketing(phone, now, days) {
  const p = await getProfile(phone);
  // Their own choice, made in WhatsApp rather than to us. See setMarketingOptOut.
  if (p.marketingOptOut) return false;
  return !withinDays(p.lastMarketingAt, now, days);
}
export const markMarketing = (phone, now = new Date()) => patch(phone, { lastMarketingAt: now.toISOString() });
/*
 * Give the cap back when the message never arrived.
 *
 * markMarketing is called at SEND time, because that is the only moment the
 * flow still has the phone in hand. A delivery failure arrives seconds later
 * and means the customer received NOTHING, so the stamp is then recording a
 * message that does not exist, and it bars that person from marketing for
 * marketingCapDays over something they never saw.
 *
 * Measured on this store: Meta's 131049 throttle rejected two of the first
 * three cart recovery sends, and each rejection silently cost that customer
 * the next seven days.
 */
export const clearMarketing = (phone) => patch(phone, { lastMarketingAt: null });

export async function canAskReview(phone, now, days) {
  return !withinDays((await getProfile(phone)).lastReviewAskAt, now, days);
}
export const markReviewAsk = (phone, now = new Date()) => patch(phone, { lastReviewAskAt: now.toISOString() });

export const setUndeliverable = (phone) => patch(phone, { undeliverable: true, undeliverableAt: new Date().toISOString() });
/** A delivered message, or an inbound one, proves the number works after all. */
export const clearUndeliverable = (phone) => patch(phone, { undeliverable: false, undeliverableAt: null });

/**
 * Meta has told us (131026) this number cannot receive WhatsApp, recently.
 *
 * 131026 is NOT a permanent verdict. Meta returns it when the number has no
 * WhatsApp account, when its owner has not accepted the current terms, and when
 * their app is too old to render the message. All three get fixed by the
 * customer without telling us. Treating the first bounce as final meant one bad
 * moment silenced that customer across every future order, for good, including
 * their dispatch and delivery updates. Expire it instead, so the number gets
 * one more chance later, and the flag still does its job in the window that
 * matters: no repeat billing and no quality-rating damage today.
 */
export async function isUndeliverable(phone, now = new Date()) {
  const p = await getProfile(phone);
  if (!p.undeliverable) return false;
  if (!p.undeliverableAt) return true; // flagged before we recorded a time: stay safe
  return withinDays(p.undeliverableAt, now, RULES.undeliverableRetryDays);
}

/** Increment and return the RTO count for a phone (drives rto-count-<n> + cod-block). */
export async function markRto(phone) {
  // Read-increment-write, so it needs the version it read as the condition:
  // patch() alone would retry with a count computed from the losing row and
  // two RTOs landing together would count as one, which is the difference
  // between a cod-block and none.
  for (let i = 0; i < 3; i += 1) {
    const p = await getProfile(phone);
    try {
      const next = await table.update(pk(phone), 'PROFILE', { phone, rtoCount: (p.rtoCount || 0) + 1 }, p.version || 0);
      return next.rtoCount;
    } catch (e) {
      if (!(e instanceof VersionConflict) || i === 2) throw e;
    }
  }
  throw new Error('markRto: unreachable');
}

/*
 * THE CUSTOMER'S LANGUAGE. Chosen once, on the profile, forever.
 *
 * PROFILE rows carry NO TTL, deliberately and already: backfill-ttl.mjs names
 * this sort key as one it will not touch, because an expired opt-out is
 * marketing to somebody who said stop. A stored language inherits that, which
 * is what it needs: a customer who picked Hindi in January and orders again in
 * December gets Hindi, not the picker a second time.
 *
 *   lang         'en' | 'hi', absent means not chosen and sends go in English
 *   langSetAt    when they chose
 *   langSource   'picker' | 'keyword' | 'owner', so a wrong language can be
 *                traced to the thing that set it
 *   langAskCount how many times we have asked, across all their orders
 *   langAskedAt  when we last asked, which is what stops two orders minutes
 *                apart asking twice
 */
export async function getLang(phone) {
  return normalizeLang((await getProfile(phone)).lang);
}

/** Has this phone ever chosen? Distinct from getLang, which answers 'en' for both. */
export async function hasLang(phone) {
  return LANGS.includes(String((await getProfile(phone)).lang));
}

/**
 * WHICH LANGUAGE THIS PHONE READS. The one place that decides, for every
 * customer message this service sends.
 *
 * Lives beside the field it reads rather than in the send helpers, because the
 * /p/ and /r/ redirect handlers need it too and importing worker/send.mjs
 * pulled both template registries, both session registries and the order
 * domain into two Lambdas whose whole job is a 302. It is deliberately NOT in
 * src/lib/: that folder is type-checked (see jsconfig.json) and is for pure
 * logic with no I/O, and this reads DynamoDB.
 *
 * Three ways out, all of them English:
 *   the feature is off           no read at all, so no added cost or failure
 *   allowPhones is set and this phone is not on it   the G4 pilot switch
 *   the profile read failed      a DynamoDB blip must cost a word, not a message
 *
 * The read failure is log.warn and NOT soft(): soft logs at ERROR, the alert
 * wiring emails the owner on any error line, and "we sent English" is not an
 * incident.
 */
/**
 * The G4 pilot list: whose phone the language picker and Hindi may reach.
 *
 * ONE HELPER BECAUSE THERE ARE THREE GATES. langFor here, languageGate in
 * flowA.run and offerPickerAfterTap in language.run each used to inline
 * `L.allowPhones?.length && !L.allowPhones.includes(phone)`, so a pilot that
 * was not applied identically in all three would leak Hindi down one path.
 *
 * `pilotOwnerPhonesOnly` resolves to OWNER_ALERT_PHONES rather than to a list
 * in messages/rules.mjs, because rules.mjs is committed and this repo is
 * PUBLIC: hardcoding the owner's number there publishes it again. The owner's
 * handsets are already configured, which is exactly the set the pilot wants.
 *
 * An explicit allowPhones still wins, for piloting on a number that is not an
 * owner handset. Empty list with the flag off means everyone, which is G5.
 */
export function langAllowList() {
  const L = RULES.language || {};
  if (L.allowPhones?.length) return L.allowPhones;
  if (L.pilotOwnerPhonesOnly) return config.ownerAlertPhones || [];
  return [];
}

/**
 * True when this phone may be offered the picker and Hindi.
 *
 * FAILS CLOSED WHILE A PILOT IS ON. An empty list read as "everyone" is how a
 * pilot turns into a full rollout without anyone choosing it: with
 * pilotOwnerPhonesOnly set and OWNER_ALERT_PHONES unset or misspelled, every
 * customer would get Hindi. Caught by the Flow A suite, which runs with no
 * owner phones configured and so had the picker firing for every order.
 *
 * Only G5, both knobs clear, means everyone.
 */
export function langPilotAllows(phone) {
  const L = RULES.language || {};
  const scoped = Boolean(L.allowPhones?.length || L.pilotOwnerPhonesOnly);
  if (!scoped) return true;
  return langAllowList().includes(phone);
}

export async function langFor(phone) {
  const L = RULES.language || {};
  if (!L.enabled) return DEFAULT_LANG;
  if (!langPilotAllows(phone)) return DEFAULT_LANG;
  try {
    return normalizeLang((await getProfile(phone)).lang);
  } catch (e) {
    log.warn('language: profile read failed, sending English', { err: e.message, phone: maskPhone(phone) });
    metric('LangReadFailed', 1, {});
    return DEFAULT_LANG;
  }
}

/**
 * Everything the Flow A gate needs about this phone's language, in ONE read.
 *
 * `chosen` is the distinction getLang cannot make: an unset language and a
 * deliberate 'en' both read as English when sending, but only one of them
 * means we still have to ask.
 */
export async function langState(phone) {
  const p = await getProfile(phone);
  return {
    chosen: LANGS.includes(String(p.lang)) ? normalizeLang(p.lang) : null,
    askedAt: p.langAskedAt || null,
    askCount: Number(p.langAskCount) || 0,
  };
}

export const setLang = (phone, lang, source = 'picker', now = new Date()) =>
  patch(phone, { lang: normalizeLang(lang), langSetAt: now.toISOString(), langSource: source });

/**
 * Record that we asked, and return the new count.
 *
 * Read-increment-write against the version it read, for the same reason
 * markRto is: two orders for one phone can be in flight at once, and a count
 * computed from the losing row would let maxAsks be exceeded.
 */
export async function markLangAsked(phone, now = new Date()) {
  for (let i = 0; i < 3; i += 1) {
    const p = await getProfile(phone);
    try {
      const next = await table.update(
        pk(phone),
        'PROFILE',
        { phone, langAskCount: (p.langAskCount || 0) + 1, langAskedAt: now.toISOString() },
        p.version || 0,
      );
      return next.langAskCount;
    } catch (e) {
      if (!(e instanceof VersionConflict) || i === 2) throw e;
    }
  }
  throw new Error('markLangAsked: unreachable');
}

/**
 * CLAIM the right to ask this phone which language it reads.
 *
 * The borrow-the-deadline check in the Flow A gate can only see a write that
 * has already landed, and the queue serialises by ORDER: two orders placed
 * seconds apart are two message groups running in parallel, so both read
 * `langAskedAt: null` and both send a picker. The customer is asked the same
 * question twice, which is the one thing the design says must not happen.
 *
 * So the slot is CLAIMED before the send, with a version-conditioned write.
 * Concurrent callers serialise on that condition: one wins, the other retries,
 * re-reads, now sees a recent `langAskedAt` and is told to wait behind it.
 *
 * Returns `{ claimed: true, prev }` to the winner, where `prev` is what to put
 * back if the send then turns out to be skipped, and `{ claimed: false,
 * reason, askedAt }` to everybody else.
 */
export async function claimLangAsk(phone, now = new Date(), waitMs = 0, maxAsks = 2) {
  for (let i = 0; i < 3; i += 1) {
    const p = await getProfile(phone);
    if (LANGS.includes(String(p.lang))) return { claimed: false, reason: 'chosen' };
    const count = Number(p.langAskCount) || 0;
    const askedAt = p.langAskedAt ? new Date(p.langAskedAt).getTime() : 0;
    // Somebody else is mid-wait on this phone. Wait behind their deadline.
    if (askedAt && now.getTime() - askedAt < waitMs) {
      return { claimed: false, reason: 'asked-recently', askedAt: p.langAskedAt };
    }
    if (count >= maxAsks) return { claimed: false, reason: 'max-asks' };
    try {
      await table.update(
        pk(phone),
        'PROFILE',
        { phone, langAskCount: count + 1, langAskedAt: now.toISOString() },
        p.version || 0,
      );
      return { claimed: true, prev: { langAskCount: count, langAskedAt: p.langAskedAt || null } };
    } catch (e) {
      if (!(e instanceof VersionConflict) || i === 2) throw e;
    }
  }
  throw new Error('claimLangAsk: unreachable');
}

/**
 * Give the claim back, because the picker was never actually sent.
 *
 * A dry run, a send allowlist or a human takeover returns a SKIP rather than a
 * send, and spending the per-phone budget on a question nobody was asked would
 * mean they are never asked once the gate that skipped it is lifted.
 */
export const releaseLangAsk = (phone, prev) =>
  patch(phone, { langAskCount: prev?.langAskCount || 0, langAskedAt: prev?.langAskedAt || null });

/*
 * PHONE#<e164> / OFFERWAIT — a prepaid offer Meta refused, waiting for a window.
 *
 * Flows R and W both park a refused MARKETING send against the phone and
 * deliver it free-form when the customer next writes in. Flow A was the one
 * that did not: a prepaid_offer refused with 131049 or 130472 was simply gone,
 * and the order was tagged wa-undeliverable and reported to the owner as a
 * customer who had not been told, which was false. They had been told. The
 * cod_confirm reached them; it was the optional discount that bounced.
 *
 * Its own sort key rather than a field on PROFILE, because patch() merges and
 * two orders for one phone can be in flight at once; and keyed by phone rather
 * than by order because the thing we are waiting for is the PHONE's window.
 *
 * `until` is the payment link's own expiry, so the park dies with the offer it
 * is holding. expiresAt is a separate 7 day floor purely so the row cannot
 * outlive its usefulness in the table: never derived from the business
 * deadline, which is what `until` is for.
 */
const OFFERWAIT = 'OFFERWAIT';

export async function parkOffer(phone, orderId, until, now = new Date()) {
  await table.put({
    PK: pk(phone),
    SK: OFFERWAIT,
    phone,
    orderId: String(orderId),
    until: until ? new Date(until).toISOString() : null,
    parkedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + 7 * 86400,
  });
}

export const getParkedOffer = (phone) => table.get(pk(phone), OFFERWAIT);
export const clearParkedOffer = (phone) => table.del(pk(phone), OFFERWAIT);

/*
 * N9. WACOUNT#<yyyy-mm> — what WhatsApp cost this month, and what Meta refused.
 *
 * Nothing said what this service spends. The owner could read it in WhatsApp
 * Manager, which is a different screen from everything else they look at and
 * does not appear in the daily digest or the P&L, so the single largest
 * variable cost in the automation was invisible next to freight and COGS.
 *
 * ONE ROW A MONTH, many counters on it, incremented atomically: the queue
 * serialises by order and not by month, so a read-modify-write would lose
 * increments and a cost meter that under-reports is worse than none.
 *
 * Sort keys:
 *   <category>#billable   delivered and charged (marketing, utility, service)
 *   <category>#free       delivered inside an allowance
 *   SERVICE               O8's free-form sends, for the 1,000 a month allowance
 *   REFUSED#<code>        131049, 130472, 131026: not billed, but the share of
 *                         sends Meta turns away is the number that explains why
 *                         a flow "is not working"
 */
const countPk = (month) => `WACOUNT#${month}`;

export async function countWaMessage(month, sk, now = new Date()) {
  return table.addCount(countPk(month), sk, 'count', 1, {
    month,
    expiresAt: Math.floor(now.getTime() / 1000) + 400 * 86400,
  });
}

/** Every counter for a month, as { [sk]: count }. */
export async function waCounts(month) {
  const rows = await table.query(countPk(month));
  return Object.fromEntries(rows.map((r) => [String(r.SK), Number(r.count) || 0]));
}
