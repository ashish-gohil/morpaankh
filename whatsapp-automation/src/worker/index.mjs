/*
 * worker/index.mjs — the single SQS FIFO consumer (batch size 1, reserved
 * concurrency 5). Routes each message by kind, re-validating against a fresh
 * Shopify read before any side effect (in the flow handlers). Per-record
 * failures are reported so SQS redelivers only what threw.
 */
import { log, metric } from '../log.mjs';
import { realClients } from '../clients/index.mjs';
import { decodePayload, verifyToken } from '../lib/ids.mjs';
import { hasTag } from '../domain/order.mjs';
import { getSecrets } from '../secrets.mjs';
import { getState } from '../store/orderState.mjs';
import { isOptedOut, setOptOut, touchInbound, setUndeliverable } from '../store/phoneProfile.mjs';
import { renderSession } from '../../messages/session.mjs';
import * as flowA from './flowA.run.mjs';
import * as flowB from './flowB.run.mjs';

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
  return null;
}

// ---- Shopify webhooks -------------------------------------------------------
async function onShopify(m) {
  const { topic, orderId, payload } = m;
  if (topic === 'orders/create') return flowA.onOrderCreate(orderId, deps());
  if (topic === 'orders/cancelled') return flowA.onStop(orderId, deps());
  if (topic === 'orders/updated') {
    const tags = String(payload?.tags || '').split(',').map((t) => t.trim());
    if (hasTag(tags, 'COD-Cancelled')) return flowA.onStop(orderId, deps());
    return;
  }
  if (topic === 'fulfillments/create') return flowA.onFulfillmentCreate(orderId, deps());
  if (topic === 'fulfillment_events/create' && payload?.status === 'delivered') {
    return flowB.onDelivered(orderId, payload.happened_at || payload.created_at || null, deps());
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
  if (await isOptedOut(phone)) return; // opted out: only direct replies to their action, none here

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

  const rawPayload = msg.button?.payload || msg.interactive?.button_reply?.id;
  const p = rawPayload ? decodePayload(rawPayload) : null;
  if (!p) return; // free text with no actionable payload: a human answers it

  if (p.flow === 'A') return routeFlowATap(p.orderId, p.action);
  // Flow C taps (ndr_*, rto_*) are handled in a later phase
}

function routeFlowATap(orderId, action) {
  const d = deps();
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
  if (st.status === 'failed' && code === 131026 && st.recipient_id) {
    await setUndeliverable(`+${st.recipient_id}`); // 131026 = undeliverable number
  }
  // Fuller per-message status history (wamid -> order) lands with Flow D metrics.
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
  // Flow C timers handled in a later phase
}

const routes = {
  shopify: onShopify,
  wa_inbound: onWaInbound,
  wa_status: onWaStatus,
  razorpay: onRazorpay,
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

export const handler = async (event) => {
  const failures = [];
  for (const record of event.Records || []) {
    let message;
    try {
      message = JSON.parse(record.body);
    } catch (e) {
      log.error('worker: bad message body, dropping', { err: e.message });
      continue;
    }
    try {
      await handleMessage(message);
    } catch (e) {
      log.error('worker: message failed', { kind: message.kind, err: e.message });
      metric('WorkerError', 1, { kind: message.kind || 'unknown' });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

export { routes };
