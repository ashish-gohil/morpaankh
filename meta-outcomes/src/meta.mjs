/*
 * meta.mjs — Conversions API (DeliveredPurchase) + Custom Audiences.
 *
 * Every write honours config.dryRun: in dry-run nothing is sent, the payload is
 * printed with PII already reduced to hashes. Raw PII never reaches this module
 * (callers pass hashed user_data built by hash.mjs).
 */
import { config } from './config.mjs';

const graph = (path) =>
  `https://graph.facebook.com/${config.meta.graphVersion}/${path}`;

async function metaPost(path, body) {
  const res = await fetch(graph(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: config.meta.accessToken }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Meta API error (HTTP ${res.status}): ${JSON.stringify(json.error || json)}`);
  }
  return json;
}

async function metaGet(path) {
  const url = `${graph(path)}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(config.meta.accessToken)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Meta API error (HTTP ${res.status}): ${JSON.stringify(json.error || json)}`);
  }
  return json;
}

/**
 * Send one DeliveredPurchase Conversions API event.
 * @param {object} p
 * @param {string} p.eventId       String(order.id) — same convention as Purchase
 * @param {number} p.eventTime     unix seconds (delivery/payment time)
 * @param {number} p.value         real collected amount
 * @param {string} p.currency      e.g. INR
 * @param {object} p.userData      hashed user_data from buildUserData()
 * @param {string} [p.sourceUrl]   action_source_url
 */
export async function sendDeliveredPurchase(p) {
  const event = {
    event_name: config.meta.deliveredEventName,
    event_time: p.eventTime,
    event_id: p.eventId,
    action_source: 'website',
    event_source_url: p.sourceUrl || 'https://www.morpaankh.in',
    user_data: p.userData,
    custom_data: {
      value: Number(p.value),
      currency: p.currency || 'INR',
      order_id: p.eventId,
    },
  };
  const payload = { data: [event] };
  if (config.meta.testEventCode) payload.test_event_code = config.meta.testEventCode;

  if (config.dryRun) {
    console.log(
      `[dry-run] CAPI ${event.event_name} event_id=${p.eventId} value=${event.custom_data.value} ${event.custom_data.currency} ` +
        `match_keys=[${Object.keys(p.userData).join(',')}]`,
    );
    return { dryRun: true };
  }
  return metaPost(`${config.meta.datasetId}/events`, payload);
}

/**
 * Find a Custom Audience by name on the ad account, or create it. Returns its id.
 * Cached per-process to avoid repeated lookups.
 */
const audienceCache = new Map();
export async function ensureAudience(name) {
  if (audienceCache.has(name)) return audienceCache.get(name);

  if (config.dryRun) {
    const fake = `dryrun-audience:${name}`;
    audienceCache.set(name, fake);
    console.log(`[dry-run] ensureAudience "${name}" -> ${fake}`);
    return fake;
  }

  const acct = `act_${config.meta.adAccountId}`;
  const list = await metaGet(`${acct}/customaudiences?fields=id,name&limit=200`);
  const found = (list.data || []).find((a) => a.name === name);
  if (found) {
    audienceCache.set(name, found.id);
    return found.id;
  }
  const created = await metaPost(`${acct}/customaudiences`, {
    name,
    subtype: 'CUSTOM',
    description: 'Maintained by meta-outcomes',
    customer_file_source: 'USER_PROVIDED_ONLY',
  });
  audienceCache.set(name, created.id);
  return created.id;
}

// Meta user schema slots we populate, in order.
const AUDIENCE_SCHEMA = ['EMAIL', 'PHONE'];

function rowsToPayload(rows) {
  // rows: [{ em?: [hash], ph?: [hash] }]. One entry per slot, '' when absent.
  const data = rows.map((ud) => [
    (ud.em && ud.em[0]) || '',
    (ud.ph && ud.ph[0]) || '',
  ]);
  return { schema: AUDIENCE_SCHEMA, data };
}

/** Add hashed users to an audience. `rows` are user_data objects (hashed). */
export async function audienceAddUsers(audienceId, rows) {
  if (!rows.length) return { added: 0 };
  const payload = rowsToPayload(rows);
  if (config.dryRun) {
    console.log(`[dry-run] audienceAddUsers ${audienceId} +${rows.length} (schema ${AUDIENCE_SCHEMA.join('/')})`);
    return { dryRun: true, added: rows.length };
  }
  return metaPost(`${audienceId}/users`, { payload });
}

/** Remove hashed users from an audience (used when an order moves state). */
export async function audienceRemoveUsers(audienceId, rows) {
  if (!rows.length) return { removed: 0 };
  const payload = rowsToPayload(rows);
  if (config.dryRun) {
    console.log(`[dry-run] audienceRemoveUsers ${audienceId} -${rows.length}`);
    return { dryRun: true, removed: rows.length };
  }
  const res = await fetch(
    `${graph(`${audienceId}/users`)}?access_token=${encodeURIComponent(config.meta.accessToken)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Meta API error (HTTP ${res.status}): ${JSON.stringify(json.error || json)}`);
  }
  return json;
}
