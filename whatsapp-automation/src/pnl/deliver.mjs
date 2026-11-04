/*
 * deliver.mjs — the finished workbook, to the owner, by every route that works.
 *
 * Three channels, deliberately unequal:
 *   email     ALWAYS. It is the only one that works unprompted, so it is the
 *             one the scheduled run depends on.
 *   WhatsApp  free-form document + the six line summary. Only legal inside an
 *             open 24 hour window, which a 09:00 scheduled run does not have.
 *             A reply from the owner opens one, which is why /pnl always gets
 *             the file and the 7th usually does not.
 *   S3        already written by the caller before we get here; it is the copy
 *             that survives both of the above failing.
 *
 * Nothing here throws. A report that was built is worth delivering by one
 * channel even when another is down, and the caller records what happened.
 */
import { config } from '../config.mjs';
import { log, metric } from '../log.mjs';
import { soft } from '../lib/resilience.mjs';
import { formatINR } from '../lib/money.mjs';
import { renderSession } from '../../messages/session.mjs';

export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Rupees for display, or a plain "not known" rather than a misleading 0. */
const money = (paise) => (paise == null ? 'not known' : formatINR(paise));
const pct = (n) => (n == null ? 'n/a' : `${Number(n).toFixed(1)}%`);
const signed = (paise) =>
  paise == null ? 'not known' : `${paise < 0 ? '-' : '+'}${formatINR(Math.abs(paise))}`;

/**
 * The six lines the owner reads on a phone before deciding whether to open the
 * workbook. Every number here is also in the workbook, so the two cannot
 * disagree: they are read from the same report object.
 * @param {any} report
 * @param {{monthLabel: string, provisional: boolean, courierChargeBasis: string, incomplete?: boolean}} meta
 */
export function summaryVars(report, meta) {
  const t = report.totals || {};
  const f = report.funnel || {};
  const r = report.ratios || {};
  return {
    month: meta.monthLabel,
    state: meta.provisional ? `provisional, ${f.pending || 0} orders pending` : 'final',
    net: signed(t.netProfitPaise),
    margin: pct(t.netProfitPctOfNetRevenue),
    delivered: String(f.delivered ?? 0),
    rto: String(f.rto ?? 0),
    rto_pct: pct(r.rtoRateByOrderPct),
    pending: String(f.pending ?? 0),
    rto_loss: money(t.rtoLossPaise),
    meta: money(t.totalMetaPaise),
    meta_per_order: money(r.metaPerDeliveredOrderPaise),
    charge_basis: meta.courierChargeBasis,
  };
}

/**
 * The email, as subject + both bodies. Same lines as WhatsApp so the two
 * channels never tell a different story.
 */
export function emailParts(report, meta) {
  const v = summaryVars(report, meta);
  const lead = meta.incomplete ? 'INCOMPLETE. ' : '';
  const subject = `${lead}Morpaankh P&L ${meta.monthLabel} (${v.state.split(',')[0]}): Net ${v.net}`;
  const lines = [
    `${lead}P&L ${v.month} (${v.state})`,
    `Net: ${v.net} (${v.margin} of net revenue)`,
    `Delivered ${v.delivered} | RTO ${v.rto} (${v.rto_pct}) | Pending ${v.pending}`,
    `RTO loss both ways: ${v.rto_loss}`,
    `Meta: ${v.meta} | per delivered order ${v.meta_per_order}`,
    `Courier charges: ${v.charge_basis}`,
    '',
    'Offline sales not recorded in Shopify are not included. Boost spend is included.',
  ];
  if (meta.incomplete) {
    lines.push('', 'A source failed on this run, so the workbook carries an INCOMPLETE banner and');
    lines.push('the affected orders are listed on its Data Checks sheet.');
  }
  const text = lines.join('\n');
  const html = `<pre style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">${lines
    .map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    .join('\n')}</pre>`;
  return { subject, text, html };
}

/**
 * @param {{report:any, meta:any, bytes:Uint8Array, filename:string, clients:any,
 *          phones?:string[], emails?:string[]}} args
 * @returns {Promise<{whatsapp:any[], email:any[]}>}
 */
export async function deliver({ report, meta, bytes, filename, clients, phones, emails }) {
  const out = { whatsapp: [], email: [] };

  // ---- email, always -----------------------------------------------------
  const to = emails && emails.length ? emails : config.pnlEmailTo;
  const { subject, text, html } = emailParts(report, meta);
  for (const addr of to) {
    // One SES call per recipient: sendWithAttachment takes a single
    // destination, like send() does, so a dud address cannot take the rest down.
    const r = await soft('pnl.email', () =>
      clients.email.sendWithAttachment({
        to: addr,
        subject,
        html,
        text,
        attachment: { filename, mime: MIME_XLSX, bytes },
      }),
    );
    out.email.push({ ok: Boolean(r && !r.skipped), skipped: r?.skipped || null });
  }
  if (!to.length) log.warn('pnl: no PNL_EMAIL_TO, the workbook was not emailed', { month: meta.month });

  // ---- WhatsApp, best effort --------------------------------------------
  const nums = phones && phones.length ? phones : adminPhones();
  for (const phone of nums) {
    /*
     * Upload once per recipient rather than once overall. Meta scopes a media
     * id to the phone number id that uploaded it, and sharing one across
     * recipients has no benefit here: there are one or two owners, not a list.
     */
    const up = await soft('pnl.upload', () =>
      clients.whatsapp.uploadMedia({ bytes, filename, mime: MIME_XLSX }),
    );
    if (!up?.mediaId) {
      out.whatsapp.push({ phone: 'owner', ok: false, step: 'upload' });
      continue;
    }
    const doc = await soft('pnl.document', () =>
      clients.whatsapp.sendDocument({
        to: phone,
        mediaId: up.mediaId,
        filename,
        caption: `P&L ${meta.monthLabel}`,
      }),
    );
    const msg = renderSession('pnl_summary', summaryVars(report, meta));
    const txt = await soft('pnl.summary', () => clients.whatsapp.sendText({ to: phone, body: msg.body }));
    out.whatsapp.push({
      ok: Boolean(doc && !doc.skipped),
      document: doc?.skipped || (doc ? 'sent' : 'failed'),
      summary: txt?.skipped || (txt ? 'sent' : 'failed'),
    });
  }

  metric('PnlDelivered', 1, { month: meta.month });
  log.info('pnl delivered', {
    month: meta.month,
    email: out.email.filter((e) => e.ok).length,
    whatsapp: out.whatsapp.filter((w) => w.ok).length,
    incomplete: Boolean(meta.incomplete),
  });
  return out;
}

/**
 * Who may be sent the report. PNL_ADMIN_PHONES, else whoever may run /replace,
 * else the owner alert phones: one list to maintain until a second person
 * genuinely needs it.
 */
export function adminPhones() {
  if (config.pnlAdminPhones.length) return config.pnlAdminPhones;
  if (config.replaceAdminPhones.length) return config.replaceAdminPhones;
  return config.ownerAlertPhones;
}

/** Is this phone allowed to ask for a P&L? */
export function isPnlAdmin(phone) {
  return adminPhones().includes(phone);
}
