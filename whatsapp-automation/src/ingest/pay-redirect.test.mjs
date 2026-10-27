/*
 * pay-redirect had no test at all. It is the route a customer taps to pay, and
 * it redirected on nothing more than "the row exists", ignoring the expiry it
 * stored and the state of the order it belonged to.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetMemory } from '../store/table.mjs';
import { setPayTokenMap } from '../store/maps.mjs';
import { ensureState, patchFlowA } from '../store/orderState.mjs';
import { handler } from './pay-redirect.mjs';

const LIVE = Math.floor(Date.now() / 1000) + 3600;
const DEAD = Math.floor(Date.now() / 1000) - 3600;
const get = (token) => handler({ pathParameters: { token } });

beforeEach(async () => {
  _resetMemory();
  await ensureState('12345', {});
});

describe('pay redirect', () => {
  it('sends a live token to the payment link', async () => {
    await setPayTokenMap('tok', { orderId: '12345', url: 'https://rzp.io/x', expiresAt: LIVE });
    const r = await get('tok');
    expect(r.statusCode).toBe(302);
    expect(r.headers.Location).toBe('https://rzp.io/x');
  });

  it('shows our expired page instead of bouncing them to Razorpay errors', async () => {
    await setPayTokenMap('tok', { orderId: '12345', url: 'https://rzp.io/x', expiresAt: DEAD });
    const r = await get('tok');
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/expired/i);
  });

  it('refuses to let an already converted order be paid a second time', async () => {
    // Cancelling the link is a soft step, so a failed cancel leaves it live.
    await setPayTokenMap('tok', { orderId: '12345', url: 'https://rzp.io/x', expiresAt: LIVE });
    await patchFlowA('12345', { convertedAt: new Date().toISOString() });
    const r = await get('tok');
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/already paid/i);
  });

  it('closes the link once Flow A has stopped for that order', async () => {
    await setPayTokenMap('tok', { orderId: '12345', url: 'https://rzp.io/x', expiresAt: LIVE });
    await patchFlowA('12345', { step: 'stopped' });
    const r = await get('tok');
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/no longer open/i);
  });

  it('shows the expired page for a token that does not exist', async () => {
    const r = await get('nope');
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/expired/i);
  });
});

/*
 * An over-long token is a stranger's input, not an error. DynamoDB caps a
 * partition key at 2048 bytes, so a longer one raised a ValidationException
 * that escaped as HTTP 500; confirmed against production on 2026-10-27. A dead
 * or unknown pay token is meant to render our own expired page.
 */
describe('an over-long token renders the expired page, not a 500', () => {
  it('answers 200 with our page for a 3000 character token', async () => {
    const res = await get('A'.repeat(3000));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/expired|no longer/i);
  });
});
