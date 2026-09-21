/*
 * reconcile.mjs — nightly reconciliation (02:30 IST). Ensures the Shopify
 * webhook subscriptions still exist and re-tracks every active AWB (a safety net
 * for missed webhooks). Alerts the owner if it had to repair anything.
 */
import { config } from '../config.mjs';
import { realClients } from '../clients/index.mjs';
import { renderTemplate } from '../../messages/templates.mjs';
import { trackActiveShipments } from './track-active.mjs';
import { log } from '../log.mjs';

async function alert(text) {
  for (const phone of config.ownerAlertPhones) {
    const t = renderTemplate('ops_alert', { order_number: 'reconcile', alert_text: text }, {});
    await realClients.whatsapp.sendTemplate({ to: phone, name: t.name, language: t.language, components: t.components });
  }
}

export const handler = async () => {
  const out = { webhooks: [], shipments: null };
  try {
    out.webhooks = await realClients.shopify.ensureWebhooks({ dryRun: config.dryRun });
  } catch (e) {
    log.error('reconcile webhooks failed', { err: e.message });
  }
  const repaired = out.webhooks.filter((w) => w.status === 'created' || w.status === 'error');
  try {
    out.shipments = await trackActiveShipments();
  } catch (e) {
    log.error('reconcile track failed', { err: e.message });
  }
  if (repaired.length && !config.dryRun) await alert(`reconciliation repaired webhook subscriptions: ${repaired.map((r) => r.topic).join(', ')}`);
  log.info('reconcile done', out);
  return { ok: true, ...out };
};
