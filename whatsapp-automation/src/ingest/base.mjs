/*
 * base.mjs — the shared ingest pipeline for every provider webhook.
 *
 * Each ingest Lambda: verify the signature on the RAW body, parse, map the
 * payload to one or more queue items, dedupe each item (DynamoDB conditional
 * put), enqueue, and return 200 fast (Shopify gives up after ~5s). If enqueue
 * fails we unmark the dedupe key and return 5xx so the provider retries.
 *
 * A provider def supplies:
 *   name         string
 *   verify(raw, headers, secrets) -> boolean
 *   verifyGet?(event, secrets)    -> response   (WhatsApp GET challenge)
 *   checkRequest?(headers)        -> boolean     (e.g. Shopify shop-domain)
 *   toItems(headers, body)        -> [{ message, groupId, dedupId }]
 */
import { rawBody } from '../lib/signature.mjs';
import { markSeen, unmarkSeen } from '../store/dedupe.mjs';
import { enqueue } from '../queue.mjs';
import { getSecrets } from '../secrets.mjs';
import { log, metric } from '../log.mjs';

export const resp = (statusCode, body = '') => ({ statusCode, body });

function method(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || 'POST';
}
function lowerHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

export function makeIngest(provider) {
  return async (event) => {
    const secrets = await getSecrets();

    if (method(event) === 'GET') {
      return provider.verifyGet ? provider.verifyGet(event, secrets) : resp(404, 'not found');
    }

    const raw = rawBody(event);
    const headers = lowerHeaders(event.headers);

    if (!provider.verify(raw, headers, secrets)) {
      log.warn('ingest bad signature', { provider: provider.name });
      metric('IngestRejected', 1, { provider: provider.name });
      return resp(401, 'unauthorized');
    }
    if (provider.checkRequest && !provider.checkRequest(headers)) {
      log.warn('ingest request check failed', { provider: provider.name });
      return resp(401, 'unauthorized');
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return resp(400, 'bad json');
    }

    let items;
    try {
      items = provider.toItems(headers, body) || [];
    } catch (e) {
      log.error('ingest map failed', { provider: provider.name, err: e.message });
      return resp(200, 'ignored'); // malformed payload: ack so it is not retried forever
    }

    for (const it of items) {
      if (!it || !it.groupId || !it.dedupId) continue;
      const first = await markSeen(provider.name, it.dedupId);
      if (!first) {
        metric('IngestDuplicate', 1, { provider: provider.name });
        continue;
      }
      try {
        await enqueue(it.message, { groupId: it.groupId, dedupId: it.dedupId });
        metric('IngestEnqueued', 1, { provider: provider.name });
      } catch (e) {
        await unmarkSeen(provider.name, it.dedupId).catch(() => {});
        log.error('ingest enqueue failed', { provider: provider.name, err: e.message });
        return resp(502, 'enqueue failed'); // provider retries; dedupe makes it safe
      }
    }
    return resp(200, 'ok');
  };
}

export { lowerHeaders };
