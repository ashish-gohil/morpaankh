/*
 * The daily owner digest had no test at all, which is how 2026-11-14 passed
 * with no digest and nobody told.
 *
 * RULES.digestChannel is 'window-else-email', so with the owner's 24 hour
 * window shut the WhatsApp route is skipped IN FAVOUR of email. Email then
 * failed (it was handed `config.pnlEmailTo.join(',')` as one SES address, see
 * clients/email.test.mjs), soft() logged it and carried on, and there was no
 * route left: the digest was simply gone, with one ERROR line as its trace.
 *
 * Two things are pinned here: one SES call per recipient, and a WhatsApp
 * attempt when no email lands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config } from '../config.mjs';
import { RULES } from '../../messages/rules.mjs';
import { _resetMemory } from '../store/table.mjs';
import { realClients } from '../clients/index.mjs';
import { makeFakeWhatsApp, makeFakeShopify } from '../clients/fakes/index.mjs';
import { makeFakeSes } from '../clients/fakes/ses.mjs';
import { handler } from './digest.mjs';

const keep = {
  email: realClients.email,
  whatsapp: realClients.whatsapp,
  shopify: realClients.shopify,
  dry: config.dryRun,
  to: config.pnlEmailTo,
  phones: config.ownerAlertPhones,
  channel: RULES.digestChannel,
};

/** The live shape on 2026-11-14: two owner email addresses, one owner phone. */
function setup({ emailFails = false } = {}) {
  const ses = makeFakeSes(emailFails ? { failWith: 'MessageRejected' } : {});
  const wa = makeFakeWhatsApp({});
  realClients.email = ses;
  realClients.whatsapp = wa;
  realClients.shopify = makeFakeShopify({});
  config.dryRun = false;
  config.pnlEmailTo = ['one@example.com', 'two@example.com'];
  config.ownerAlertPhones = ['+919999999999'];
  RULES.digestChannel = 'window-else-email';
  return { ses, wa };
}

beforeEach(() => { _resetMemory(); });
afterEach(() => {
  realClients.email = keep.email;
  realClients.whatsapp = keep.whatsapp;
  realClients.shopify = keep.shopify;
  config.dryRun = keep.dry;
  config.pnlEmailTo = keep.to;
  config.ownerAlertPhones = keep.phones;
  RULES.digestChannel = keep.channel;
});

describe('the daily digest, when the owner window is shut', () => {
  it('emails each recipient on its own send, never one joined address', async () => {
    const { ses, wa } = setup();
    const out = await handler();

    expect(out.ok).toBe(true);
    expect(ses.sent.map((e) => e.to)).toEqual(['one@example.com', 'two@example.com']);
    // The bug: a single call carrying both, which SES refuses outright.
    expect(ses.sent.some((e) => String(e.to).includes(','))).toBe(false);
    // Email landed, so the metered marketing template is not spent.
    expect(wa.sent).toHaveLength(0);
  });

  it('falls back to WhatsApp when no email lands, rather than losing the digest', async () => {
    const { ses, wa } = setup({ emailFails: true });
    const out = await handler();

    expect(out.ok).toBe(true);
    expect(ses.sent).toHaveLength(0);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0].type).toBe('template');
    expect(wa.sent[0].name).toMatch(/^ops_digest/);
    expect(wa.sent[0].to).toBe('+919999999999');
  });
});
