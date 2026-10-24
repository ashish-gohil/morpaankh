/*
 * worker/index.mjs — the single SQS FIFO consumer (batch size 1, reserved
 * concurrency 5). Routes each message by kind, re-validating against a fresh
 * Shopify read before any side effect (in the flow handlers). Per-record
 * failures are reported so SQS redelivers only what threw.
 */
import { log, metric } from '../log.mjs';
import { config } from '../config.mjs';
import { realClients } from '../clients/index.mjs';
import { decodePayload, verifyToken } from '../lib/ids.mjs';
import { hasTag } from '../domain/order.mjs';
import { mapCourierStatus } from '../domain/courier-status.mjs';
import { getSecrets } from '../secrets.mjs';
import { getState, runOnce, updateMessageStatus } from '../store/orderState.mjs';
import { getAwbMap, getWamidMap } from '../store/maps.mjs';
import { isOptedOut, setOptOut, touchInbound, setUndeliverable, clearUndeliverable, clearMarketing, getAwaiting } from '../store/phoneProfile.mjs';
import { renderSession } from '../../messages/session.mjs';
import { TEMPLATES, LEGACY } from '../../messages/templates.mjs';
import { ownerAlert } from './send.mjs';
import { soft } from '../lib/resilience.mjs';
import * as flowA from './flowA.run.mjs';
import * as flowB from './flowB.run.mjs';
import * as flowC from './flowC.run.mjs';
import * as variantChange from './variantChange.run.mjs';
import * as cartRecovery from './cartRecovery.run.mjs';
import * as subscriberOffer from './subscriberOffer.run.mjs';
import * as replace from './replace.run.mjs';

// Derived from the registry, never hand-listed, so adding a template without a
// legacy version cannot silently drop off this list.
const NO_FALLBACK = new Set(
  Object.keys(TEMPLATES).filter((k) => !LEGACY[k]).map((k) => TEMPLATES[k].name),
);

const OPT_OUT = new Set(['STOP', 'UNSUBSCRIBE', 'OPT OUT']);
const OPT_IN = new Set(['START']);

function deps() {
  return { clients: realClients, now: new Date() };
}

async function sendSessionTo(phone, key, vars = {}, ctx = {}) {
  const r = renderSession(key, vars, ctx);
  const wa = realClients.whatsapp;
  if (r.type === 'text') return wa.sendText({ to: phone, body: r.body });
  if (r.type === 'buttons') return wa.sendButtons({ to: phone, body: r.body, buttons: r.buttons });
  if (r.type === 'cta_url') return wa.sendCtaUrl({ to: phone, body: r.body, buttonText: r.buttonText, url: r.url });
  // Without this line a 'list' would render and then be dropped by the
  // `return null` below, which is exactly what happens to 'html' today.
  if (r.type === 'list') return wa.sendList({ to: phone, body: r.body, buttonText: r.buttonText, rows: r.rows });
  return null;
}

// ---- Shopify webhooks -------------------------------------------------------
async function onShopify(m) {
  const { topic, orderId, payload } = m;
  if (topic === 'orders/create') {
    /*
     * Flow A runs FIRST and its result is what this returns. The cart hook is
     * soft and comes after, because attributing a recovery is bookkeeping and
     * an order confirmation is not: letting the hook throw would redeliver the
     * record and re-run a handler that has already messaged the customer.
     */
    const out = await flowA.onOrderCreate(orderId, deps());
    await soft('cartRecovery:onOrderCreated', () => cartRecovery.onOrderCreated(payload, deps()), { orderId });
    // Flow W, for the same reason and with the same discipline: attributing a
    // welcome offer is bookkeeping and an order confirmation is not.
    await soft('subscriberOffer:onOrderCreated', () => subscriberOffer.onOrderCreated(payload, deps()), { orderId });
    return out;
  }
  if (topic === 'orders/cancelled') return flowA.onStop(orderId, deps());
  if (topic === 'orders/updated') {
    const tags = String(payload?.tags || '').split(',').map((t) => t.trim());
    if (hasTag(tags, 'COD-Cancelled')) return flowA.onStop(orderId, deps());
    return;
  }
  // Both topics, because Shopify often creates a fulfillment first and attaches
  // the tracking number in a later update. Handling only create meant those
  // orders never got their AWB mapped and never got a dispatch message. The
  // handler is idempotent (setAwbMap is a put, the rest is runOnce-guarded).
  if (topic === 'fulfillments/create' || topic === 'fulfillments/update') {
    return flowA.onFulfillmentCreate(orderId, deps());
  }
  if (topic === 'fulfillment_events/create') {
    if (payload?.status === 'delivered') return flowB.onDelivered(orderId, payload.happened_at || payload.created_at || null, deps());
    if (payload?.status === 'attempted_delivery' || payload?.status === 'failure') return flowC.onNdr(orderId, deps());
  }
}

// ---- WhatsApp inbound (taps + keywords) -------------------------------------
async function onWaInbound(m) {
  const phone = m.from;
  await touchInbound(phone);

  const msg = m.msg || {};
  const text = (msg.text?.body || '').trim().toUpperCase();
  if (OPT_OUT.has(text)) {
    await setOptOut(phone, true);
    return sendSessionTo(phone, 'optout_done', {});
  }
  if (OPT_IN.has(text)) {
    await setOptOut(phone, false);
    return sendSessionTo(phone, 'optin_done', {});
  }

  /*
   * A slash command from an admin phone is US, not a customer.
   *
   * WhatsApp buttons are tappable only by the person who received them, and our
   * own outbound messages are not echoed back to this webhook, so a button we
   * press in the Business app reaches nothing at all. This is the keyboard way
   * in, and it is gated on the phone rather than on the order: the command
   * names someone else's order and messages their handset.
   *
   * Checked before everything below, which all reads the text as a customer's,
   * and before the opt-out gate on purpose: the opt-out is about MARKETING to
   * customers, not about us talking to ourselves, so an admin who once sent
   * STOP must still be able to run a command and get an answer back.
   */
  const typed = (msg.text?.body || '').trim();
  if (typed.startsWith('/') && isAdminPhone(phone)) return onOwnerCommand(phone, typed);

  if (await isOptedOut(phone)) return; // opted out: only direct replies to their action, none here

  /*
   * Their message just opened a 24 hour service window, and that window is the
   * only thing that lifts Meta's per-user MARKETING cap for us. If a cart
   * recovery was refused with 131049 and parked against this phone, it can go
   * now, free-form and uncapped. soft() because this is opportunistic: it must
   * never cost them the reply they actually wrote in for.
   */
  await soft('cartOnWindowOpen', () => cartRecovery.onWindowOpen(phone, deps()), {});
  // Flow W parks on 131049 as well, against the same phone row's sibling sort
  // key, so an inbound message has to offer both flows their chance at it.
  await soft('subscriberOnWindowOpen', () => subscriberOffer.onWindowOpen(phone, deps()), {});

  // WhatsApp Flow completion (review form): the signed flow_token carries the order.
  const nfm = msg.interactive?.nfm_reply;
  if (nfm) {
    let data;
    try {
      data = JSON.parse(nfm.response_json || '{}');
    } catch {
      return;
    }
    const s = await getSecrets();
    const claims = data.flow_token ? verifyToken(data.flow_token, s.flowTokenKey || 'dev-flow-key') : null;
    if (!claims) return log.warn('nfm_reply: bad or expired flow token');
    const st = await getState(claims.orderId);
    if (st?.verifiedPhone && st.verifiedPhone !== phone) return log.warn('nfm_reply: phone mismatch, ignoring');
    return flowB.onReviewSubmit(claims.orderId, data, deps());
  }

  // list_reply joins the SAME expression on purpose. A separate branch would
  // skip the ownsOrder gate below, which is the one thing standing between a
  // clear-text payload and someone else's order.
  const rawPayload = msg.button?.payload || msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
  const p = rawPayload ? decodePayload(rawPayload) : null;

  if (p) {
    /*
     * Flow P (/replace) is dispatched BEFORE the ownership gate, and it is the
     * only one that is. ownsOrder compares the tapping phone to the order's
     * stored verified phone, and a P tap is an ADMIN confirming a replacement
     * on a CUSTOMER's order, so that gate would refuse every Confirm there is.
     * replace.route re-checks admission itself, strictly, against the admin
     * list and the nonce stored on the request. Every other tap keeps the gate
     * exactly as it was.
     */
    if (p.flow === 'P') {
      const rp = replace.route(p.orderId, p.action, deps(), phone);
      if (rp) return rp;
      return log.warn('replace: unknown P tap action', { action: p.action });
    }
    // Button payloads are "v1|A|<orderId>|cancel_yes" in CLEAR TEXT: unlike the
    // Flow token they carry no signature, and the order id is the plain Shopify
    // number. The review path right above already refuses a phone that does not
    // own the order; the taps did not, so one of them (cancel_yes) would cancel
    // a stranger's order for anyone who could get a payload in front of us.
    // Same check, same place in the flow.
    if (!(await ownsOrder(p.orderId, phone))) {
      return log.warn('tap: phone does not own this order, ignoring', { flow: p.flow, action: p.action });
    }
    if (p.flow === 'A') return routeFlowATap(p.orderId, p.action, phone);
    if (p.flow === 'C') return routeFlowCTap(p.orderId, p.action);
    /*
     * Flow R re-checks ownership STRICTLY inside onTap. ownsOrder above fails
     * open on an id it has never seen, and a Flow R payload carries a CHECKOUT
     * id, so there is never a STATE row for it and that gate always passes.
     */
    if (p.flow === 'R') return cartRecovery.onTap(p.orderId, p.action, phone, deps());
    /*
     * Flow W re-checks ownership strictly inside onTap too, and it has to: its
     * payload carries a CUSTOMER id, so ownsOrder above has never seen that id
     * and fails open on it.
     */
    if (p.flow === 'W') return subscriberOffer.onTap(p.orderId, p.action, phone, deps());
    return;
  }

  // No payload: if the phone is in an "awaiting" state, this text is the answer
  // (NDR address / RTO other reason). Otherwise a human handles it.
  const awaiting = await getAwaiting(phone);
  const rawText = msg.text?.body;
  if (awaiting && rawText) {
    if (awaiting.type === 'address') return flowC.onAddressText(awaiting.orderId, rawText, deps());
    if (awaiting.type === 'rto_other') return flowC.onRtoOtherText(awaiting.orderId, rawText, deps());
  }
}

/*
 * Owner commands.
 *
 * This was one entry and a comment saying a map of one entry is a registry for
 * a future that has not asked for anything yet. /replace is that future asking,
 * and it brings its own verbs, so the dispatch is a map now. The two
 * /size-change spellings behave exactly as they did: same argument string, same
 * handler, same reply.
 */
const COMMANDS = {
  '/size-change': (phone, args) => variantChange.onOwnerRequest(args, deps(), phone),
  '/size-change-request': (phone, args) => variantChange.onOwnerRequest(args, deps(), phone),
  // The WHOLE line, not just the arguments: /replace has sub-verbs and flags,
  // and its parser matches the alias itself so one parser answers all three
  // spellings. /size-change takes the argument string it always took.
  '/replace': (phone, args, typed) => replace.onOwnerRequest(typed, deps(), phone),
  '/replace-order': (phone, args, typed) => replace.onOwnerRequest(typed, deps(), phone),
  '/rp': (phone, args, typed) => replace.onOwnerRequest(typed, deps(), phone),
};

const OWNER_HELP = [
  'What I understand:',
  '',
  '/size-change 1214',
  'Asks the customer on order #1214 to pick a new size or colour.',
  '',
  '/replace 1214 noor m xl',
  'Books a reverse pickup of the size M and sends size XL instead. Also /replace status, cancel, retry, list.',
].join('\n');

/**
 * Who may type a command.
 *
 * The UNION of the owner alert phones and the /replace admin list, never just
 * the latter. isReplaceAdmin answers "replaceAdminPhones when it is set,
 * otherwise the owner phones", so gating this on it alone meant that setting
 * REPLACE_ADMIN_PHONES to one person silently took /size-change away from every
 * other owner phone: their command fell through to the customer branches and
 * was answered by nothing at all. /replace re-checks isReplaceAdmin itself, so
 * narrowing that list still narrows /replace and only /replace.
 */
const isAdminPhone = (phone) => config.ownerAlertPhones.includes(phone) || replace.isReplaceAdmin(phone);

async function onOwnerCommand(phone, typed) {
  const [cmd, ...rest] = typed.split(/\s+/);
  const name = cmd.toLowerCase();
  log.info('owner command', { cmd: name });
  const fn = COMMANDS[name];
  if (fn) return fn(phone, rest.join(' '), typed);
  return sendSessionTo(phone, 'ops_reply', {
    text: name === '/help' ? OWNER_HELP : `I do not know ${name}.\n\n${OWNER_HELP}`,
  });
}

/**
 * Does this phone own this order?
 *
 * Unknown order, or an order whose verified phone we never stored, is allowed
 * through: those predate the state row and refusing them would break real
 * customers. A STORED phone that disagrees is refused.
 */
async function ownsOrder(orderId, phone) {
  const st = await getState(orderId);
  return !st?.verifiedPhone || st.verifiedPhone === phone;
}

function routeFlowCTap(orderId, action) {
  const d = deps();
  if (action === 'ndr_reattempt') return flowC.onNdrReattempt(orderId, d);
  if (action === 'ndr_address') return flowC.onNdrAddressStart(orderId, d);
  if (action === 'ndr_cancel') return flowC.onNdrCancel(orderId, d);
  if (action.startsWith('rto_')) return flowC.onRtoReason(orderId, action.slice(4), d);
  log.info('flowC: unknown tap action', { action });
}

function routeFlowATap(orderId, action, phone) {
  const d = deps();
  // The vc* steps re-check ownership STRICTLY, where ownsOrder above fails
  // open on an order whose verified phone was never stored. Fail-open is
  // defensible for a read; these edit the order.
  const vc = variantChange.route(orderId, action, d, phone);
  if (vc) return vc;
  switch (action) {
    case 'confirm':
      return flowA.onConfirm(orderId, d);
    case 'pay_online':
      return flowA.onPayOnline(orderId, d);
    case 'cancel':
      return flowA.onCancel(orderId, d);
    case 'cancel_yes':
      return flowA.onCancelYes(orderId, d);
    case 'cancel_no':
      return flowA.onCancelNo(orderId, d);
    case 'keep_cod':
      return flowA.onKeepCod(orderId, d);
    default:
      log.info('flowA: unknown tap action', { action });
  }
}

// ---- WhatsApp delivery statuses --------------------------------------------
async function onWaStatus(m) {
  const st = m.status || {};
  const code = st.errors?.[0]?.code;
  // The delivery outcome is the ONLY evidence a send reached a handset. Without
  // this line a message Meta "accepted" but never delivered is invisible: the
  // send logs success, the order is tagged, and nothing anywhere says it failed.
  const err = st.errors?.[0];
  // Feeds the wa-whatsapp-failures alarm. Emitted with NO dimensions so it
  // matches the alarm's dimensionless metric.
  if (st.status === 'failed') metric('MessageFailed', 1);
  /*
   * 131049 is a WARN, not an ERROR, because it is now a HANDLED outcome rather
   * than a fault: onCartStatus parks the checkout and delivers it through the
   * next service window. The alert wiring fires an incident email on any
   * `level = "error"` line (iac/lib/stack.js), and that email reads "that step
   * did not complete, it retries automatically, then parks in the dead letter
   * queue" - all three untrue here. The step completed, nothing retries, the
   * DLQ stays empty.
   *
   * It matters because Meta refuses roughly half of this store's cart sends,
   * so leaving it at ERROR pages the owner several times a day for working
   * behaviour. Crying wolf that often is how the genuinely dead worker went
   * unnoticed for ten hours.
   *
   * Nothing is hidden: MessageFailed still feeds the wa-whatsapp-failures
   * alarm, and the WARN carries the same code, title and detail.
   */
  /*
   * 131026 joins it, for the same reason and with the same reasoning.
   * "Message undeliverable" means that handset cannot take a WhatsApp message:
   * no account on the number, or the terms never accepted. It is not a fault in
   * this service and there is nothing here to fix, so the incident email reads
   * as a dead worker when the worker is fine.
   *
   * It is also the failure we handle MOST completely: setUndeliverable parks
   * the number below, clearMarketing gives the eligibility back, and the
   * send-failed owner alert already goes out naming the order and asking the
   * owner to phone the customer. That alert is the one worth acting on, and the
   * incident email arriving beside it for the same event taught the owner to
   * ignore both.
   */
  const HANDLED_FAILURES = new Set([131049, 131026]);
  const level = st.status !== 'failed' ? 'info' : (HANDLED_FAILURES.has(code) ? 'warn' : 'error');
  log[level]('wa status', {
    status: st.status,
    phone: st.recipient_id ? `+${st.recipient_id}` : undefined,
    code,
    title: err?.title,
    detail: err?.error_data?.details,
  });
  if (st.recipient_id) {
    const ph = `+${st.recipient_id}`;
    if (st.status === 'failed' && code === 131026) await setUndeliverable(ph);
    /*
     * Any failure, not just 131026: Meta accepted the message and then did not
     * deliver it, so the customer received nothing and the marketing stamp
     * written at send time is now describing a message that does not exist.
     * Rolled back for exactly the reason Flow R already gives back the phone
     * lock further down this same path.
     *
     * This does NOT re-open the message that failed. Flow R's REC row keeps
     * firstSentAt and Flow A's order state keeps its own one-shot guard, so
     * neither flow can retry into a loop against a throttle that is still on.
     * Only the person's FUTURE eligibility is restored.
     */
    if (st.status === 'failed') await soft('clearMarketing', () => clearMarketing(ph), {});
    // Delivery is the one fact that outranks a past bounce: this handset just
    // took a message. Let it undo the block rather than waiting out the expiry.
    if (st.status === 'delivered') await soft('clearUndeliverable', () => clearUndeliverable(ph), {});
  }
  if (!st.id) return;

  // EVERY outcome is recorded, not just failures. Only failures used to be, so
  // a message that reached a customer looked exactly like one that never left:
  // both had a MSG# row with no status at all. There was no way to answer "did
  // they get it?" for any order, which is why a run of silent bounces read as
  // "the confirmation job stopped working" instead of "these two numbers are
  // not on WhatsApp". updateMessageStatus only moves the status forward.
  const map = await getWamidMap(st.id);
  /*
   * A cart message's WAMID row carries cartId and no orderId, so it has to be
   * handled before the return below, and separately: everything past that
   * point tags an order and names it to the owner, and a checkout has no order
   * to tag.
   */
  if (map?.cartId) {
    await soft('cartStatus', () => cartRecovery.onCartStatus(map.cartId, st), { wamid: st.id });
    return;
  }
  /*
   * A welcome offer's WAMID row carries customerId and no orderId, for the
   * same reason: everything past this point tags an order and names it to the
   * owner, and a customer id is not an order id.
   *
   * This is also where 131049 lands for Flow W: Meta accepts the send with a
   * 200 and reports the per-user cap seconds later, here, by which time both
   * lifetime locks are already written. onSubStatus gives them back.
   */
  if (map?.customerId) {
    await soft('subscriberStatus', () => subscriberOffer.onSubStatus(map.customerId, st, new Date(), deps()), { wamid: st.id });
    return;
  }
  if (!map?.orderId) return;
  await soft('updateMessageStatus', () => updateMessageStatus(map.orderId, st.id, st.status, st.errors), { wamid: st.id });
  if (st.status !== 'failed') return;

  // A send that Meta ACCEPTED is only queued. When it later fails, the order has
  // already been marked sent (codConfirmAt, reviewAsked, ...) and nothing ever
  // revisits it, so on 23 Sept every message failed 131042 "no payment method"
  // while the orders all read as confirmed. The log named a phone and a code and
  // no order, so there was no list of who to make good with afterwards.
  // Resolve the wamid, record the failure on the order, and name it to the owner.
  const d = deps();
  const stateRow = await getState(map.orderId);
  const orderName = stateRow?.name || map.orderId;

  // The order carries a tag saying we messaged this customer (wa-cod-sent,
  // wa-order-confirmed). That tag is written when Meta ACCEPTS the send, and
  // acceptance is not delivery, so the Shopify admin showed "messaged" for
  // customers who got nothing and the daily digest counted them as reached.
  // One tag, on the order, is what makes this recoverable by a human: the owner
  // can filter the admin for it and phone them.
  await soft(
    'tagsAdd:wa-undeliverable',
    () => d.clients.shopify.tagsAdd(`gid://shopify/Order/${map.orderId}`, ['wa-undeliverable']),
    { orderId: map.orderId },
  );
  // Once per order per message kind: a template that failed for an account-wide
  // reason fails for every order at once, and the owner needs one line each, not
  // one per retry.
  await soft('sendFailedAlert', () =>
    runOnce(map.orderId, `send-failed:${map.key || 'unknown'}`, async () => {
      await ownerAlert(
        d,
        orderName,
        `the ${map.key || 'WhatsApp'} message was accepted by WhatsApp and then FAILED to deliver (${code || 'no code'}: ${err?.title || 'unknown'}). This customer has not been told. Contact them and resend once the cause is fixed`,
      );
      return { alerted: true };
    }),
    { orderId: map.orderId, wamid: st.id },
  );
}

// ---- Delhivery courier events (poll or push) --------------------------------
async function onDelhivery(m) {
  const map = await getAwbMap(m.awb);
  if (!map) return log.info('delhivery: unknown AWB', {});
  const orderId = map.orderId;
  /*
   * Two message shapes reach here. The push webhook nests everything under
   * `shipment`; the poller sends the mapper's inputs flat. Read flat first and
   * fall back, so neither source loses a field: reading ONLY the nested shape
   * meant every polled event arrived with statusType undefined, and the poller
   * is the only live source (the push is still not enabled by Delhivery, 2
   * invocations in 30 days against the poller's 312).
   */
  const state = mapCourierStatus({
    status: m.status,
    statusType: m.statusType ?? m.shipment?.Status?.StatusType,
    instructions: m.instructions ?? m.shipment?.Status?.Instructions,
    statusCode: m.statusCode ?? m.shipment?.Status?.StatusCode,
  });
  if (state === 'DELIVERED') return flowB.onDelivered(orderId, m.at || null, deps());
  if (state === 'NDR') return flowC.onNdr(orderId, deps());
  /*
   * RTO_DELIVERED routes here too. It is the same event one leg later, and the
   * poller drops an AWB from the GSI as soon as it turns terminal, so whichever
   * of the two we observe first is the only one we will ever see. Landing on
   * RTO_DELIVERED with no branch meant a return that completed inside a polling
   * gap was never asked about at all. onRto is idempotent (runOnce on the tag,
   * a deterministic timer name, and onRtoTimer guards on rtoReasonAskedAt), so
   * seeing both legs still asks once.
   */
  if (state === 'RTO_INITIATED' || state === 'RTO_DELIVERED') return flowC.onRto(orderId, deps());
}

// ---- Razorpay ---------------------------------------------------------------
async function onRazorpay(m) {
  if (m.event !== 'payment_link.paid') return; // expired/cancelled: link lifecycle already handled
  const orderId = m.entity?.notes?.shopify_order_id;
  if (!orderId) {
    log.warn('razorpay paid without order id in notes');
    return;
  }
  return flowA.onPaymentPaid(orderId, m.entity, deps());
}

// ---- timers -----------------------------------------------------------------
async function onTimer(m) {
  const d = deps();
  if (m.flow === 'A') {
    switch (m.step) {
      case 'cod':
        return flowA.onCodTimer(m.orderId, d);
      case 'reminder':
        return flowA.onReminder(m.orderId, d);
      case 'fallback':
        return flowA.onFallback(m.orderId, d);
      case 'highrisk':
        return flowA.onHighRisk(m.orderId, d);
      default:
        return log.info('timer: unknown A step', { step: m.step });
    }
  }
  if (m.flow === 'B') {
    if (m.step === 'review_ask') return flowB.onReviewTimer(m.orderId, d);
    if (m.step === 'review_reminder') return flowB.onReviewReminder(m.orderId, d);
    return log.info('timer: unknown B step', { step: m.step });
  }
  if (m.flow === 'C') {
    if (m.step === 'ndr') return flowC.onNdr(m.orderId, d);
    if (m.step === 'rto_reason') return flowC.onRtoTimer(m.orderId, d);
    return log.info('timer: unknown C step', { step: m.step });
  }
  // Flow R carries the CHECKOUT id in the orderId slot: a timer is named
  // (flow, id, step) and an abandoned checkout has no order to name it after.
  if (m.flow === 'R') {
    if (m.step === 'final') return cartRecovery.onFinal(m.orderId, d);
    return log.info('timer: unknown R step', { step: m.step });
  }
  // Flow W carries the CUSTOMER id in the orderId slot, for the same reason
  // Flow R carries a checkout id: a timer is named (flow, id, step) and a
  // welcome offer has no order to name itself after. Its one timer is the
  // deferred first message, armed when the sweep lands outside the window.
  if (m.flow === 'W') {
    if (m.step === 'first') return subscriberOffer.onFirst(m.orderId, d);
    return log.info('timer: unknown W step', { step: m.step });
  }
}

// ---- WhatsApp template status changes ---------------------------------------
/**
 * Meta approved, rejected, paused or disabled one of our templates.
 *
 * A paused or rejected template stops customer messages, and for the keys with
 * no LEGACY fallback (order_shipped, delivered_review, review_reminder) it stops
 * them silently. This is the only advance warning Meta gives, so it goes
 * straight to the owner rather than into a log nobody reads.
 */
const TEMPLATE_BAD = new Set(['REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED', 'PENDING_DELETION']);

async function onTemplateStatus(m) {
  const bad = TEMPLATE_BAD.has(String(m.event || '').toUpperCase());
  log[bad ? 'error' : 'info']('wa template status', { name: m.name, event: m.event, reason: m.reason, language: m.language });
  metric('TemplateStatus', 1, { event: m.event || 'unknown' });
  if (!bad) return;
  const noFallback = NO_FALLBACK.has(m.name);
  await soft('templateStatusAlert', () =>
    ownerAlert(
      deps(),
      m.name || 'template',
      `WhatsApp has set the ${m.name} template to ${m.event}${m.reason ? ` (${m.reason})` : ''}.${
        noFallback ? ' This one has NO older version to fall back on, so those messages stop completely until it is fixed.' : ' The previous version is being sent meanwhile.'
      }`,
    ),
    { name: m.name, event: m.event },
  );
}

async function onCart(m) {
  if (m.step === 'final') return cartRecovery.onFinal(m.checkoutId, deps());
  return cartRecovery.onFirst(m.checkoutId, deps());
}

async function onSubOffer(m) {
  return subscriberOffer.onFirst(m.customerId, deps());
}

const routes = {
  shopify: onShopify,
  cart: onCart,
  suboffer: onSubOffer,
  wa_inbound: onWaInbound,
  wa_status: onWaStatus,
  wa_template_status: onTemplateStatus,
  razorpay: onRazorpay,
  delhivery: onDelhivery,
  timer: onTimer,
};

async function handleMessage(message) {
  const fn = routes[message.kind];
  if (!fn) {
    log.info('worker: no handler for kind, acking', { kind: message.kind });
    return;
  }
  await fn(message);
  metric('WorkerHandled', 1, { kind: message.kind });
}

/**
 * The error boundary. One record at a time (batch size 1), so a failure is
 * always reported back as exactly that record and SQS redelivers only it.
 *
 * Nothing is swallowed here: a throw means the work did not complete, and the
 * flow handlers are written so that redelivering is safe. After
 * maxReceiveCount attempts the record lands in the DLQ, which is alarmed.
 */
export const handler = async (event) => {
  const failures = [];
  for (const record of event.Records || []) {
    let message;
    try {
      message = JSON.parse(record.body);
    } catch (e) {
      // Unparseable: redelivering it would fail identically forever, so it is
      // dropped rather than left to poison its message group.
      log.error('worker: bad message body, dropping', { err: e.message, body: String(record.body).slice(0, 300) });
      metric('WorkerError', 1, { kind: 'unparseable' });
      continue;
    }
    try {
      await handleMessage(message);
    } catch (e) {
      // Everything a human needs to act on this without opening the console
      // first. attempt says how close this is to the DLQ.
      const attempt = Number(record.attributes?.ApproximateReceiveCount || 0);
      log.error('worker: message failed', {
        kind: message.kind,
        orderId: message.orderId || message.entity?.notes?.shopify_order_id,
        flow: message.flow,
        step: message.step,
        topic: message.topic,
        attempt,
        lastAttempt: attempt >= 5,
        err: e.message,
        stack: String(e.stack || '').split('\n').slice(0, 4).join(' | '),
      });
      metric('WorkerError', 1, { kind: message.kind || 'unknown' });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

export { routes };
