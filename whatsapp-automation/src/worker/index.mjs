/*
 * worker/index.mjs — the single SQS FIFO consumer (batch size 1, reserved
 * concurrency 5). Every message is re-validated against a fresh Shopify read
 * before ANY side effect (webhook payloads and timers can be stale) inside the
 * flow handlers. Here we only route by kind and report per-record failures so
 * SQS redelivers just the ones that threw.
 *
 * Flow handlers are wired in Phases 5-8; until then unknown/unhandled kinds are
 * acked (logged) so the skeleton drains cleanly.
 */
import { log, metric } from '../log.mjs';

/** kind -> handler(message). Filled in by later phases. */
const routes = {
  // 'shopify':   (m) => flowRouter(m),
  // 'wa_inbound':(m) => inboundRouter(m),
  // 'wa_status': (m) => recordStatus(m),
  // 'razorpay':  (m) => flowA.onPayment(m),
  // 'delhivery': (m) => courierRouter(m),
  // 'timer':     (m) => timerRouter(m),
};

async function handleMessage(message) {
  const fn = routes[message.kind];
  if (!fn) {
    log.info('worker: no handler yet, acking', { kind: message.kind });
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
      continue; // unparseable: acking avoids a poison-pill retry loop
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
