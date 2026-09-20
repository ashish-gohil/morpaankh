/*
 * onboarding.mjs — one-time WhatsApp number onboarding (coexistence embedded
 * signup or dedicated number). Behind ONBOARDING_ENABLED; inert until Phase 9.
 * Routes GET /onboarding and POST /onboarding/exchange are wired now so the
 * flag is all that gates it later.
 */
const enabled = () => /^(1|true|yes|on)$/i.test(process.env.ONBOARDING_ENABLED || '');

export const handler = async (event) => {
  if (!enabled()) return { statusCode: 404, body: 'not found' };
  // Implemented in Phase 9 (see PLAN section 12 / DECISIONS F1-F3).
  return { statusCode: 501, body: 'onboarding not implemented yet' };
};
