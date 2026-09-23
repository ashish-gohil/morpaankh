/*
 * error-reporter.mjs — turns every logged error into a readable email.
 *
 * A CloudWatch alarm email says "wa-worker-errors went to ALARM". It does not
 * say which order, which flow, which provider, or what the error was, so the
 * first thing anyone does is go and read the logs. This closes that gap: a
 * subscription filter on each function's log group delivers matching lines
 * here, and this formats them and publishes to the same SNS topic the alarms
 * use, so the owner gets the actual failure with the context to act on it.
 *
 * It is deliberately OUT OF BAND. It reads logs after the fact and cannot slow
 * down, block or fail anything a customer is waiting on. If this function is
 * broken, the service keeps working and only the reporting is lost.
 *
 * It is NOT subscribed to its own log group, so it cannot feed itself, and
 * neither delivery channel can break the other or the function.
 *
 * It reports on TWO channels on purpose. Email carries the full detail, but an
 * SNS email subscription is worthless until the recipient clicks a confirmation
 * link, and those links sat unclicked in a spam folder for days while every
 * alarm published into a void. WhatsApp to the owner needs no confirmation step
 * and is already proven to reach this owner's handset, so it carries the short
 * version and guarantees somebody actually finds out.
 */
import { gunzipSync } from 'node:zlib';
import { config } from '../config.mjs';
import { table } from '../store/table.mjs';
import { realClients } from '../clients/index.mjs';
import { tpl } from '../worker/send.mjs';
import { soft } from '../lib/resilience.mjs';
import { log } from '../log.mjs';

const THROTTLE_SECONDS = 15 * 60;
const MAX_EVENTS_PER_MAIL = 5;

let snsClient = null;
async function sns() {
  if (snsClient) return snsClient;
  const c = await import('@aws-sdk/client-sns');
  snsClient = { client: new c.SNSClient({ region: config.region }), PublishCommand: c.PublishCommand };
  return snsClient;
}

/** Strip the parts that differ between two occurrences of the same fault. */
function signature(logGroup, text) {
  const normalized = String(text)
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<t>')
    .replace(/\b\d{6,}\b/g, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .slice(0, 300);
  let h = 0;
  const s = `${logGroup}|${normalized}`;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `E${(h >>> 0).toString(36)}`;
}

/** First sighting of this fault in the throttle window? */
async function claim(sig) {
  const now = Math.floor(Date.now() / 1000);
  // The key carries the window, so the conditional put naturally expires into
  // the next one without needing a read-modify-write.
  const windowId = Math.floor(now / THROTTLE_SECONDS);
  return table.putNew({
    PK: `ERRALERT#${sig}#${windowId}`,
    SK: 'STATE',
    at: new Date().toISOString(),
    expiresAt: now + THROTTLE_SECONDS * 2,
  });
}

const fnName = (logGroup) => String(logGroup).replace('/aws/lambda/', '');

function istTime(ms) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(ms));
}

/** Pull the useful fields out of one log line, structured or not. */
export function describe(event) {
  const raw = String(event.message || '').trim();
  let parsed = null;
  try {
    const start = raw.indexOf('{');
    if (start >= 0) parsed = JSON.parse(raw.slice(start));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return { summary: raw.split('\n')[0].slice(0, 200), detail: raw.slice(0, 2000), fields: {}, soft: false };
  }
  const { level, msg, t, err, stack, soft, ...rest } = parsed;
  return {
    summary: [msg, err].filter(Boolean).join(': ').slice(0, 200) || raw.slice(0, 200),
    detail: raw.slice(0, 2000),
    fields: { ...rest, ...(stack ? { stack } : {}) },
    soft: soft === true,
  };
}

function consoleLink(logGroup, logStream) {
  const g = encodeURIComponent(logGroup).replace(/%/g, '$25');
  const s = encodeURIComponent(logStream).replace(/%/g, '$25');
  return `https://${config.region}.console.aws.amazon.com/cloudwatch/home?region=${config.region}#logsV2:log-groups/log-group/${g}/log-events/${s}`;
}

export function formatReport({ logGroup, logStream, events }) {
  const fn = fnName(logGroup);
  const first = describe(events[0]);
  const lines = [];
  lines.push('WHAT FAILED');
  lines.push(`  function   ${fn}`);
  lines.push(`  when       ${istTime(events[0].timestamp)} IST`);
  lines.push(`  error      ${first.summary}`);
  lines.push(
    first.soft
      ? '  impact     NON-FATAL. The customer was served and the order is correct; this step was skipped.'
      : '  impact     The message was not completed. SQS will retry it, then park it in the DLQ.',
  );
  lines.push('');

  const ctx = Object.entries(first.fields).filter(([k]) => k !== 'stack');
  if (ctx.length) {
    lines.push('CONTEXT');
    for (const [k, v] of ctx.slice(0, 12)) lines.push(`  ${k.padEnd(10)} ${String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 300)}`);
    lines.push('');
  }
  if (first.fields.stack) {
    lines.push('STACK');
    lines.push(`  ${String(first.fields.stack).slice(0, 800)}`);
    lines.push('');
  }

  lines.push('WHERE TO LOOK');
  lines.push(`  log group  ${logGroup}`);
  lines.push(`  log stream ${logStream}`);
  lines.push(`  console    ${consoleLink(logGroup, logStream)}`);
  lines.push('');

  if (events.length > 1) {
    lines.push(`OTHER LINES IN THIS BATCH (${events.length - 1} more)`);
    for (const e of events.slice(1, MAX_EVENTS_PER_MAIL)) {
      lines.push(`  ${istTime(e.timestamp)}  ${describe(e).summary}`);
    }
    lines.push('');
  }
  lines.push(`Identical errors are not re-sent for ${THROTTLE_SECONDS / 60} minutes.`);

  const subject = `[wa-automation] ${fn}: ${first.summary}`.slice(0, 99);
  return { subject, body: lines.join('\n') };
}

export const handler = async (event) => {
  let payload;
  try {
    payload = JSON.parse(gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'));
  } catch (e) {
    log.warn('error-reporter: undecodable payload, dropping', { err: e.message });
    return { ok: false };
  }
  if (payload.messageType !== 'DATA_MESSAGE' || !payload.logEvents?.length) return { ok: true, skipped: true };

  const { logGroup, logStream, logEvents } = payload;
  const sig = signature(logGroup, describe(logEvents[0]).summary);
  if (!(await claim(sig))) {
    log.info('error-reporter: already reported in this window', { sig, logGroup });
    return { ok: true, throttled: true };
  }

  const { subject, body } = formatReport({ logGroup, logStream, events: logEvents });
  const topicArn = process.env.ALERT_TOPIC_ARN;
  // Both channels are attempted independently: a failure in one must not stop
  // the other, and neither may throw, or CloudWatch Logs would redeliver this
  // batch and report the same fault again.
  const emailed = !topicArn
    ? null
    : await soft('publishAlert', async () => {
        const a = await sns();
        await a.client.send(new a.PublishCommand({ TopicArn: topicArn, Subject: subject, Message: body }));
        return true;
      }, { sig });
  const pinged = await notifyOwnerOnWhatsApp(logGroup, logEvents[0]);

  log.info('error-reporter: reported', { sig, logGroup, events: logEvents.length, emailed: Boolean(emailed), pinged: Boolean(pinged) });
  return { ok: true, reported: true, emailed: Boolean(emailed), whatsapp: Boolean(pinged) };
};

/**
 * The short version, straight to the owner's phone.
 *
 * Uses the same approved ops_alert template the flows use, so it needs no new
 * Meta review. The body parameter is capped because a template body has a hard
 * 1024 character limit and Meta rejects the whole send if it is exceeded.
 */
async function notifyOwnerOnWhatsApp(logGroup, event) {
  if (!config.ownerAlertPhones.length) return null;
  const d = describe(event);
  const fn = fnName(logGroup);
  const orderId = d.fields.orderId ? `#${d.fields.orderId}` : fn;
  const detail = `${fn} failed: ${d.summary}${d.soft ? ' (non-fatal, the customer and the order are fine)' : ''}`;
  const deps = { clients: realClients };
  let sent = null;
  for (const phone of config.ownerAlertPhones) {
    sent = await soft('ownerWhatsAppAlert', () =>
      tpl(deps, phone, 'ops_alert', { order_number: orderId, alert_text: detail.slice(0, 500) }, {}),
      { logGroup },
    );
  }
  return sent;
}
