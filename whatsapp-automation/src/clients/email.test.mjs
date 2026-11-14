/*
 * email.mjs at the SES contract, which is where the owner's daily digest was
 * lost on 2026-11-14.
 *
 * SES v2 wants ONE ADDRESS PER ToAddresses ENTRY. timers/digest.mjs passed
 * `config.pnlEmailTo.join(',')`, this client wrapped that whole string in a
 * one-element array, and SES refused the send with
 * `BadRequestException: Illegal address`. Nothing caught it: fakes/ses.mjs
 * records whatever `to` it is handed, so every test passed while no digest
 * arrived.
 *
 * These mock the SDK instead of the client, so the assertions are on the
 * command SES actually receives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.mjs';

const sent = [];

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    async send(cmd) {
      /*
       * The one rule the real service enforces and the fake never did: an
       * entry that is not a single address is refused, and the WHOLE send
       * fails with it.
       */
      for (const a of cmd.input.Destination.ToAddresses) {
        if (!/^[^\s,@]+@[^\s,@]+$/.test(a)) {
          const e = new Error('Illegal address');
          e.name = 'BadRequestException';
          throw e;
        }
      }
      sent.push(cmd.input);
      return { MessageId: `m${sent.length}` };
    }
  },
  SendEmailCommand: class {
    constructor(input) { this.input = input; }
  },
}));

const { email } = await import('./email.mjs');

const realDry = config.dryRun;
const realFrom = config.emailFrom;

beforeEach(() => {
  sent.length = 0;
  config.dryRun = false;
  config.emailFrom = 'hello@morpaankh.in';
});
afterEach(() => {
  config.dryRun = realDry;
  config.emailFrom = realFrom;
});

describe('email.send addressing', () => {
  it('gives SES one entry per address, not one joined string', async () => {
    const r = await email.send({
      to: ['one@example.com', 'two@example.com'].join(','),
      subject: 'Morpaankh, 14 Nov 2026',
      html: '<p>hi</p>',
      text: 'hi',
    });
    expect(r.messageId).toBeTruthy();
    expect(sent[0].Destination.ToAddresses).toEqual(['one@example.com', 'two@example.com']);
  });

  it('still sends a single address unchanged', async () => {
    await email.send({ to: 'one@example.com', subject: 's', html: 'h', text: 't' });
    expect(sent[0].Destination.ToAddresses).toEqual(['one@example.com']);
  });

  it('skips rather than calling SES with no destination at all', async () => {
    expect(await email.send({ to: '  ', subject: 's', html: 'h', text: 't' })).toEqual({
      skipped: 'email-invalid',
    });
    expect(sent).toHaveLength(0);
  });

  it('addresses the attachment route the same way, header included', async () => {
    const r = await email.sendWithAttachment({
      to: 'one@example.com,two@example.com',
      subject: 'P&L',
      html: 'h',
      text: 't',
      attachment: { filename: 'a.xlsx', mime: 'application/vnd.ms-excel', bytes: new Uint8Array([1, 2]) },
    });
    expect(r.messageId).toBeTruthy();
    expect(sent[0].Destination.ToAddresses).toEqual(['one@example.com', 'two@example.com']);
    const mime = Buffer.from(sent[0].Content.Raw.Data).toString('utf8');
    expect(mime).toContain('To: one@example.com, two@example.com\r\n');
  });
});
