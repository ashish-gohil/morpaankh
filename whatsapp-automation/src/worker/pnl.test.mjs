/*
 * `/pnl` and `/pnl-ledger` from an admin phone.
 *
 * The command is the owner's whole interface to the report, and the two things
 * most worth pinning are the ones that are easy to get wrong and silent when
 * they are: that a NON-admin gets no reply at all rather than a refusal (a
 * refusal tells a stranger the command exists), and that the ack is sent BEFORE
 * the work is handed off (the worker has 60 seconds; if it acked afterwards the
 * owner would stare at nothing for two minutes or get a timeout).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../config.mjs';
import { onOwnerRequest, onLedgerUpload } from './pnl.run.mjs';

const ADMIN = '+917048459816';
const STRANGER = '+919999900000';
const NOV_4 = new Date('2026-11-04T03:30:00Z');

/** A whatsapp fake that records sends in order, so "ack first" is assertable. */
function makeDeps({ media = {} } = {}) {
  const sent = [];
  const order = [];
  return {
    sent,
    order,
    deps: {
      now: NOV_4,
      clients: {
        whatsapp: {
          sendText: async ({ to, body }) => {
            sent.push({ to, body });
            order.push('text');
            return { messageId: 'm1' };
          },
          downloadMedia: async (id) => {
            order.push('download');
            if (!media[id]) throw new Error('no such media');
            return media[id];
          },
        },
      },
    },
  };
}

let saved;
beforeEach(() => {
  saved = {
    pnlEnabled: config.pnlEnabled,
    pnlFunctionName: config.pnlFunctionName,
    pnlAdminPhones: config.pnlAdminPhones,
    ownerAlertPhones: config.ownerAlertPhones,
    dryRun: config.dryRun,
  };
  config.pnlEnabled = true;
  config.pnlFunctionName = 'wa-pnl-report';
  config.pnlAdminPhones = [ADMIN];
  config.ownerAlertPhones = [ADMIN];
  config.dryRun = false;
  return () => Object.assign(config, saved);
});

describe('/pnl', () => {
  it('says nothing at all to a phone that is not an admin', async () => {
    const { sent, deps } = makeDeps();
    const invoked = [];
    await onOwnerRequest('/pnl 2026-10', { ...deps, invokePnl: async (p) => invoked.push(p) }, STRANGER);
    // Not a refusal: a refusal confirms the command exists to someone who
    // should not know. /replace behaves the same way.
    expect(sent).toEqual([]);
    expect(invoked).toEqual([]);
  });

  it('acks BEFORE it hands the work off, and hands off the month it parsed', async () => {
    const { sent, order, deps } = makeDeps();
    const invoked = [];
    await onOwnerRequest(
      '/pnl 2026-10',
      {
        ...deps,
        invokePnl: async (p) => {
          order.push('invoke');
          invoked.push(p);
          return { StatusCode: 202 };
        },
      },
      ADMIN,
    );
    expect(order).toEqual(['text', 'invoke']);
    expect(sent[0].body).toContain('October 2026');
    expect(sent[0].body).toContain('about two minutes');
    expect(invoked).toEqual([
      { month: '2026-10', trigger: 'whatsapp', phone: ADMIN, mtd: false },
    ]);
  });

  it('a bare /pnl means last month', async () => {
    const { deps } = makeDeps();
    const invoked = [];
    await onOwnerRequest('/pnl', { ...deps, invokePnl: async (p) => invoked.push(p) }, ADMIN);
    expect(invoked[0].month).toBe('2026-10');
  });

  it('/pnl mtd passes the flag through', async () => {
    const { deps } = makeDeps();
    const invoked = [];
    await onOwnerRequest('/pnl mtd', { ...deps, invokePnl: async (p) => invoked.push(p) }, ADMIN);
    expect(invoked[0]).toMatchObject({ month: '2026-11', mtd: true });
  });

  it('answers with the usage line, and invokes nothing, when the month is unreadable', async () => {
    const { sent, deps } = makeDeps();
    const invoked = [];
    await onOwnerRequest('/pnl smarch', { ...deps, invokePnl: async (p) => invoked.push(p) }, ADMIN);
    expect(invoked).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('/pnl mtd');
    expect(sent[0].body).toContain('/pnl-ledger');
  });

  it('says so rather than going quiet when the report cannot be started', async () => {
    const { sent, deps } = makeDeps();
    await onOwnerRequest(
      '/pnl 2026-10',
      { ...deps, invokePnl: async () => { throw new Error('AccessDenied'); } },
      ADMIN,
    );
    // The ack, then the bad news. An owner who got "two minutes" and then
    // silence has no way to tell a slow report from a dead one.
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toContain('could not be started');
  });

  it('refuses while the feature is switched off', async () => {
    config.pnlEnabled = false;
    const { sent, deps } = makeDeps();
    const invoked = [];
    await onOwnerRequest('/pnl 2026-10', { ...deps, invokePnl: async (p) => invoked.push(p) }, ADMIN);
    expect(invoked).toEqual([]);
    expect(sent[0].body).toContain('switched off');
  });

  it('refuses when there is no function to hand off to, rather than timing out', async () => {
    config.pnlFunctionName = '';
    const { sent, deps } = makeDeps();
    await onOwnerRequest('/pnl 2026-10', { ...deps, invokePnl: async () => ({}) }, ADMIN);
    expect(sent[0].body).toContain('not reachable');
  });
});

describe('/pnl-ledger', () => {
  const csv = Buffer.from(
    ['AWB,Amount,Type', '59152210001315,129.59,Forward', '59152210001326,65.98,Forward'].join('\n'),
  );

  it('asks for the file when the command arrives without one', async () => {
    const { sent, deps } = makeDeps();
    await onLedgerUpload('/pnl-ledger 2026-10', deps, ADMIN, null);
    expect(sent[0].body).toContain('Attach the statement as a file');
  });

  it('reads the statement and reports what it found', async () => {
    const { sent, deps } = makeDeps({
      media: { 'mid-1': { bytes: csv, mime: 'text/csv', filename: 'oct.csv' } },
    });
    await onLedgerUpload('/pnl-ledger 2026-10', deps, ADMIN, { id: 'mid-1', filename: 'oct.csv' });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('October 2026');
    expect(sent[0].body).toContain('2 rows');
    // 129.59 + 65.98
    expect(sent[0].body).toContain('195.57');
  });

  it('says so when the file cannot be fetched, instead of claiming it saved one', async () => {
    const { sent, deps } = makeDeps();
    await onLedgerUpload('/pnl-ledger 2026-10', deps, ADMIN, { id: 'missing' });
    expect(sent[0].body).toContain('could not be downloaded');
  });

  it('keeps a file it could not parse, and says the file was saved anyway', async () => {
    const junk = Buffer.from('this is not a statement\nnor is this\n');
    const { sent, deps } = makeDeps({
      media: { j: { bytes: junk, mime: 'text/plain', filename: 'junk.txt' } },
    });
    await onLedgerUpload('/pnl-ledger 2026-10', deps, ADMIN, { id: 'j', filename: 'junk.txt' });
    // A statement in a shape the parser does not know yet is exactly the file
    // worth keeping, because it is the evidence for teaching it the new headers.
    expect(sent[0].body).toContain('saved');
  });

  it('ignores a stranger here too', async () => {
    const { sent, deps } = makeDeps({
      media: { 'mid-1': { bytes: csv, mime: 'text/csv', filename: 'oct.csv' } },
    });
    await onLedgerUpload('/pnl-ledger 2026-10', deps, STRANGER, { id: 'mid-1' });
    expect(sent).toEqual([]);
  });
});
