/*
 * onboarding.mjs — one-time WhatsApp number onboarding, behind ONBOARDING_ENABLED.
 *
 * Coexistence route (keeps the number on the WhatsApp Business app): serve an
 * Embedded Signup page (Facebook Login for Business config id + the WhatsApp
 * Business onboarding feature), exchange the returned code server-side for a
 * System User token, subscribe the app to the WABA's webhooks, and save the WABA
 * id + phone number id to Secrets Manager. A coexistence number is NOT phone-
 * registered (spec section 12).
 *
 * Dedicated-number route: skip onboarding entirely; echo handling stays dormant.
 *
 * The FB app id, config id, feature type and session-info version are account-
 * specific and set during the manual onboarding step (DECISIONS F1-F3); this
 * wires the flow and stays inert until ONBOARDING_ENABLED plus those values.
 */
import { config } from '../config.mjs';
import { getSecrets, writeSecrets } from '../secrets.mjs';
import { log } from '../log.mjs';

const enabled = () => /^(1|true|yes|on)$/i.test(process.env.ONBOARDING_ENABLED || '');
const FB_APP_ID = () => process.env.FB_APP_ID || '';
const FB_CONFIG_ID = () => process.env.FB_CONFIG_ID || '';
const GRAPH = () => `https://graph.facebook.com/${config.graphVersion}`;

function page() {
  // Minimal Embedded Signup page. The exact featureType + sessionInfoVersion are
  // filled from the account setup (TODO Phase 9 / DECISIONS F2).
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect WhatsApp</title>
<body style="font-family:system-ui;max-width:32rem;margin:12vh auto;padding:0 1rem">
<h1>Connect the Morpaankh WhatsApp number</h1>
<p>This links the business number so order updates can be sent. You stay in the WhatsApp Business app.</p>
<button id="go" style="padding:.8rem 1.4rem;font-size:1rem">Connect WhatsApp</button>
<pre id="out"></pre>
<script>
  window.fbAsyncInit = function () {
    FB.init({ appId: ${JSON.stringify(FB_APP_ID())}, autoLogAppEvents: true, xfbml: true, version: ${JSON.stringify(config.graphVersion)} });
  };
  (function(d,s,id){var js,fjs=d.getElementsByTagName(s)[0];if(d.getElementById(id))return;js=d.createElement(s);js.id=id;js.src="https://connect.facebook.net/en_US/sdk.js";fjs.parentNode.insertBefore(js,fjs);}(document,'script','fb'));
  document.getElementById('go').onclick = function () {
    FB.login(function (resp) {
      var code = resp && resp.authResponse && resp.authResponse.code;
      if (!code) { document.getElementById('out').textContent = 'No code returned.'; return; }
      fetch('/onboarding/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
        .then(function (r) { return r.text(); }).then(function (t) { document.getElementById('out').textContent = t; });
    }, { config_id: ${JSON.stringify(FB_CONFIG_ID())}, response_type: 'code', override_default_response_type: true });
  };
</script>
</body>`;
}

async function exchange(code) {
  const s = await getSecrets();
  // 1) code -> access token
  const tokenRes = await fetch(
    `${GRAPH()}/oauth/access_token?client_id=${FB_APP_ID()}&client_secret=${s.waAppSecret}&code=${encodeURIComponent(code)}`,
  );
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokenJson).slice(0, 200)}`);
  const accessToken = tokenJson.access_token;

  // 2) discover the WABA + phone number id shared by the signup
  const debug = await (await fetch(`${GRAPH()}/debug_token?input_token=${accessToken}&access_token=${accessToken}`)).json();
  const wabaId = debug?.data?.granular_scopes?.find?.((g) => g.scope === 'whatsapp_business_management')?.target_ids?.[0] || '';
  let phoneNumberId = '';
  if (wabaId) {
    const phones = await (await fetch(`${GRAPH()}/${wabaId}/phone_numbers?access_token=${accessToken}`)).json();
    phoneNumberId = phones?.data?.[0]?.id || '';
    // 3) subscribe the app to this WABA's webhooks (coexistence: no phone registration)
    await fetch(`${GRAPH()}/${wabaId}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
  }

  await writeSecrets({ waAccessToken: accessToken, waWabaId: wabaId, waPhoneNumberId: phoneNumberId });
  log.info('onboarding exchange complete', { wabaId: Boolean(wabaId), phoneNumberId: Boolean(phoneNumberId) });
  return { wabaId, phoneNumberId };
}

export const handler = async (event) => {
  if (!enabled()) return { statusCode: 404, body: 'not found' };
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  const path = event?.requestContext?.http?.path || event?.rawPath || '';

  if (method === 'GET') {
    if (!FB_APP_ID() || !FB_CONFIG_ID()) return { statusCode: 500, body: 'onboarding not configured (set FB_APP_ID + FB_CONFIG_ID)' };
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: page() };
  }
  if (method === 'POST' && path.endsWith('/exchange')) {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: 'bad json' };
    }
    if (!body.code) return { statusCode: 400, body: 'missing code' };
    try {
      const r = await exchange(body.code);
      return { statusCode: 200, body: `Connected. WABA ${r.wabaId ? 'ok' : 'missing'}, phone ${r.phoneNumberId ? 'ok' : 'missing'}.` };
    } catch (e) {
      log.error('onboarding exchange failed', { err: e.message });
      return { statusCode: 502, body: 'exchange failed, check logs' };
    }
  }
  return { statusCode: 404, body: 'not found' };
};
