/*
 * worker/pnl.run.mjs — `/pnl` and `/pnl-ledger`, from an admin phone.
 *
 * Neither command computes anything here. The worker has 60 seconds and a
 * month is three or four minutes of Shopify, Delhivery and Meta calls, so
 * `/pnl` answers at once and hands the work to wa-pnl-report. That is also why
 * the async invoke exists at all: without it the only options were a timeout
 * halfway through, or an owner staring at a chat that never replies.
 *
 * `/pnl-ledger` is the opposite shape: all it does is fetch the file the owner
 * attached and put it in the bucket, which fits comfortably in the worker.
 */
import { config } from '../config.mjs';
import { log, metric } from '../log.mjs';
import { soft } from '../lib/resilience.mjs';
import { toPaise, formatINR } from '../lib/money.mjs';
import { renderSession } from '../../messages/session.mjs';
import { parseMonthArg, monthLabel } from '../pnl/run.mjs';
import { isPnlAdmin } from '../pnl/deliver.mjs';
import { parseLedger } from '../pnl/sources/ledger.mjs';
import { putInput } from '../pnl/snapshot.mjs';

/** Lambda is loaded the way every AWS client in this service is: lazily, and
 * degraded rather than fatal, so a bundle without it answers instead of dying. */
let lambdaMod = null;
let lambdaBroken = false;
async function lambdaClient() {
  if (lambdaMod || lambdaBroken) return lambdaMod;
  try {
    const mod = await import('@aws-sdk/client-lambda');
    const c = new mod.LambdaClient({ region: config.region });
    lambdaMod = { send: (cmd) => c.send(cmd), InvokeCommand: mod.InvokeCommand };
  } catch (e) {
    lambdaBroken = true;
    log.error('pnl: no Lambda SDK in this bundle, /pnl cannot hand off', {
      err: /** @type {any} */ (e).message,
    });
  }
  return lambdaMod;
}

const reply = (deps, phone, key, vars) =>
  soft('pnl.reply', () => {
    const m = renderSession(key, vars);
    return deps.clients.whatsapp.sendText({ to: phone, body: m.body });
  });

/**
 * `/pnl`, `/pnl 2026-10`, `/pnl oct`, `/pnl oct 2026`, `/pnl mtd`.
 *
 * @param {string} typed the whole command line
 * @param {{clients: any, now?: Date}} deps
 * @param {string} phone
 */
export async function onOwnerRequest(typed, deps, phone) {
  /*
   * Admission is re-checked here even though the router already gated on
   * isAdminPhone, exactly as /replace does. The router's list is the union of
   * two configs and this command can be reached by a future caller that
   * forgets; a P&L names every customer's city and every cost we pay.
   */
  if (!isPnlAdmin(phone) && !config.ownerAlertPhones.includes(phone)) {
    return log.warn('pnl: command from a phone that is not an admin', {});
  }
  if (!config.pnlEnabled) {
    return reply(deps, phone, 'pnl_failed', {
      month: 'that month',
      reason: 'The P&L is switched off (PNL_ENABLED).',
    });
  }

  const args = typed.replace(/^\/\S+\s*/, '');
  const parsed = parseMonthArg(args, deps.now || new Date());
  if ('error' in parsed) {
    log.info('owner command: bad pnl month', { cmd: '/pnl' });
    return reply(deps, phone, 'pnl_usage', {});
  }

  const label = monthLabel(parsed.month);
  const c = await lambdaClient();
  if (!c || !config.pnlFunctionName) {
    return reply(deps, phone, 'pnl_failed', {
      month: label,
      reason: 'The report function is not reachable from here, so nothing was built.',
    });
  }

  /*
   * Answer FIRST, then invoke. The owner has just typed a command and a silent
   * two minutes reads as a broken bot; and if the invoke fails, the next
   * message they get says so, which is better than no message at all.
   */
  await reply(deps, phone, 'pnl_working', { month: label });

  const sent = await soft('pnl.invoke', () =>
    c.send(
      new c.InvokeCommand({
        FunctionName: config.pnlFunctionName,
        // Event, not RequestResponse: the worker must not sit and wait, and the
        // report answers the owner directly when it finishes.
        InvocationType: 'Event',
        Payload: Buffer.from(
          JSON.stringify({ month: parsed.month, trigger: 'whatsapp', phone, mtd: parsed.mtd }),
        ),
      }),
    ),
  );
  if (!sent) {
    return reply(deps, phone, 'pnl_failed', {
      month: label,
      reason: 'The report could not be started. Try again, or run it from the terminal.',
    });
  }
  metric('PnlRequested', 1, { trigger: 'whatsapp' });
  log.info('owner command: pnl handed off', { cmd: '/pnl', month: parsed.month });
  return { ok: true, month: parsed.month };
}

/**
 * `/pnl-ledger 2026-10` as the caption on an attached statement.
 *
 * Stores the raw bytes and tells the owner what we read out of them. It does
 * NOT rebuild the report: the next `/pnl 2026-10` picks the file up from the
 * bucket on its own, so a mis-sent file can be replaced before anything is
 * recomputed.
 *
 * @param {string} typed
 * @param {{clients: any, now?: Date}} deps
 * @param {string} phone
 * @param {{id?: string, filename?: string}|null} document
 */
export async function onLedgerUpload(typed, deps, phone, document) {
  if (!isPnlAdmin(phone) && !config.ownerAlertPhones.includes(phone)) {
    return log.warn('pnl-ledger: command from a phone that is not an admin', {});
  }
  const args = typed.replace(/^\/\S+\s*/, '');
  const parsed = parseMonthArg(args, deps.now || new Date());
  if ('error' in parsed) return reply(deps, phone, 'pnl_usage', {});
  const label = monthLabel(parsed.month);

  if (!document?.id) {
    return reply(deps, phone, 'pnl_failed', {
      month: label,
      reason: 'Attach the statement as a file, with this command as its caption.',
    });
  }

  const file = await soft('pnl.ledger-download', () => deps.clients.whatsapp.downloadMedia(document.id));
  if (!file?.bytes?.length) {
    return reply(deps, phone, 'pnl_failed', {
      month: label,
      reason: 'The attached file could not be downloaded from WhatsApp.',
    });
  }

  const name = document.filename || file.filename || 'ledger.csv';
  const parsedLedger = parseLedger(file.bytes, name);
  // Stored whatever the parse said: a statement in a shape we cannot read yet
  // is exactly the file worth keeping, because it is the evidence for teaching
  // the parser the new header names.
  const stored = await soft('pnl.ledger-store', () =>
    putInput({ month: parsed.month, filename: name, bytes: file.bytes, now: deps.now || new Date() }),
  );

  if (!parsedLedger.rows.length) {
    const why = parsedLedger.warnings[0] || 'no AWB rows were found in it.';
    return reply(deps, phone, 'pnl_failed', { month: label, reason: `The file was saved but ${why}` });
  }

  const total = parsedLedger.rows.reduce((n, r) => n + toPaise(r.chargeInr), 0);
  log.info('pnl ledger uploaded', {
    month: parsed.month,
    rows: parsedLedger.rows.length,
    stored: Boolean(stored && !stored.skipped),
  });
  metric('PnlLedgerUploaded', 1, { month: parsed.month });
  return reply(deps, phone, 'pnl_ledger_saved', {
    month: label,
    rows: String(parsedLedger.rows.length),
    total: formatINR(total),
  });
}
