import { describe, it, expect, afterEach } from 'vitest';
import { handler } from './onboarding.mjs';

const GET = { requestContext: { http: { method: 'GET', path: '/onboarding' } } };

afterEach(() => {
  delete process.env.ONBOARDING_ENABLED;
  delete process.env.FB_APP_ID;
  delete process.env.FB_CONFIG_ID;
});

describe('onboarding (flagged)', () => {
  it('404 when the flag is off', async () => {
    expect((await handler(GET)).statusCode).toBe(404);
  });
  it('500 when enabled but not configured', async () => {
    process.env.ONBOARDING_ENABLED = 'true';
    expect((await handler(GET)).statusCode).toBe(500);
  });
  it('serves the embedded-signup page when configured', async () => {
    process.env.ONBOARDING_ENABLED = 'true';
    process.env.FB_APP_ID = '123';
    process.env.FB_CONFIG_ID = '456';
    const r = await handler(GET);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Connect the Morpaankh WhatsApp number');
  });
});
