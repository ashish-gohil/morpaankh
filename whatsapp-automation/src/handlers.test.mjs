/*
 * handlers.test.mjs — every Lambda entry point must import and export a
 * handler. Nothing else imports src/worker/index.mjs, so a module-scope
 * syntax error there shipped clean tests and crashed the deployed worker at
 * INIT (Runtime.UserCodeSyntaxError). This is the cheap guard against that.
 *
 * Entry points mirror the `makeFn(...)` list in iac/lib/stack.js.
 */
import { describe, it, expect } from 'vitest';

const ENTRY_POINTS = [
  'ingest/shopify',
  'ingest/whatsapp',
  'ingest/razorpay',
  'ingest/delhivery',
  'ingest/pay-redirect',
  'ingest/onboarding',
  'worker/index',
  'timers/poll-delhivery',
  'timers/reconcile',
  'timers/digest',
];

describe('every deployed Lambda entry point loads', () => {
  it.each(ENTRY_POINTS)('%s exports a handler', async (mod) => {
    const m = await import(`./${mod}.mjs`);
    expect(typeof m.handler).toBe('function');
  });
});
