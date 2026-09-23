import { describe, it, expect } from 'vitest';
import { describe as describeEvent, formatReport } from './error-reporter.mjs';

const ev = (message, timestamp = 1758645600000) => ({ message, timestamp });

describe('reading one log line', () => {
  it('pulls the message, the error and the context out of a structured line', () => {
    const d = describeEvent(ev(JSON.stringify({
      level: 'error', msg: 'worker: message failed', t: '2026-09-23T10:00:00Z',
      err: 'Shopify GraphQL errors', kind: 'razorpay', orderId: '12345',
    })));
    expect(d.summary).toBe('worker: message failed: Shopify GraphQL errors');
    expect(d.fields.orderId).toBe('12345');
    expect(d.fields.kind).toBe('razorpay');
    expect(d.soft).toBe(false);
  });

  it('marks a soft failure so the mail can say the customer was fine', () => {
    expect(describeEvent(ev(JSON.stringify({ level: 'error', msg: 'x', soft: true }))).soft).toBe(true);
  });

  it('still reports a crash that never reached our own logger', () => {
    // This is the shape that once killed the worker silently.
    const d = describeEvent(ev('2026-09-23T10:00:00.000Z\tundefined\tERROR\tUncaught Exception \t{"errorType":"Runtime.UserCodeSyntaxError"}'));
    expect(d.summary).toContain('Runtime.UserCodeSyntaxError');
  });
});

describe('the email an owner actually receives', () => {
  const report = formatReport({
    logGroup: '/aws/lambda/wa-worker',
    logStream: '2026/09/23/[$LATEST]abc123',
    events: [
      ev(JSON.stringify({ level: 'error', msg: 'worker: message failed', err: 'boom', orderId: '12345', kind: 'razorpay' })),
      ev(JSON.stringify({ level: 'error', msg: 'second thing', err: 'also boom' })),
    ],
  });

  it('names the function and the failure in the subject', () => {
    expect(report.subject).toContain('wa-worker');
    expect(report.subject).toContain('worker: message failed');
    expect(report.subject.length).toBeLessThanOrEqual(99);
  });
  it('says what it means for the customer', () => {
    expect(report.body).toContain('SQS will retry');
  });
  it('carries the context needed to debug without guessing', () => {
    expect(report.body).toContain('orderId');
    expect(report.body).toContain('12345');
    expect(report.body).toContain('/aws/lambda/wa-worker');
    expect(report.body).toContain('2026/09/23/[$LATEST]abc123');
    expect(report.body).toMatch(/https:\/\/.*console\.aws\.amazon\.com/);
  });
  it('mentions the other lines in the same batch', () => {
    expect(report.body).toContain('second thing');
  });
  it('tells a soft failure apart, so nobody panics over a skipped tag', () => {
    const r = formatReport({
      logGroup: '/aws/lambda/wa-worker',
      logStream: 's',
      events: [ev(JSON.stringify({ level: 'error', msg: 'non-fatal step failed, continuing', soft: true, label: 'tagsAdd' }))],
    });
    expect(r.body).toContain('NON-FATAL');
    expect(r.body).toContain('the order is correct');
  });
});
