'use strict';

/**
 * One-time setup: subscribe this service to Shopify's orders/create webhook.
 * Run after deploying, with PUBLIC_URL pointing at the deployed base URL:
 *
 *   PUBLIC_URL=https://your-service.onrender.com npm run register-webhooks
 *
 * The Shiprocket tracking webhook is added in the Shiprocket dashboard
 * (printed at the end) — Shiprocket has no public API to register webhooks.
 */
const shopify = require('../src/shopify');

const PUBLIC_URL = process.env.PUBLIC_URL;
if (!PUBLIC_URL) {
  console.error('Set PUBLIC_URL to your deployed base URL (https://...)');
  process.exit(1);
}

async function main() {
  const callbackUrl = `${PUBLIC_URL.replace(/\/$/, '')}/webhooks/shopify/orders-create`;
  const data = await shopify.graphql(
    `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
       webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
         webhookSubscription { id }
         userErrors { field message }
       }
     }`,
    { topic: 'ORDERS_CREATE', sub: { callbackUrl, format: 'JSON' } }
  );

  const out = data.webhookSubscriptionCreate;
  if (out.userErrors && out.userErrors.length) {
    console.error('Shopify webhook errors:', JSON.stringify(out.userErrors, null, 2));
  } else {
    console.log('Shopify orders/create webhook registered ->', callbackUrl);
    console.log('  subscription id:', out.webhookSubscription.id);
  }

  console.log('\nNext, add the Shiprocket tracking webhook in the Shiprocket dashboard:');
  console.log('  Settings -> API -> Webhooks -> Add');
  console.log(`  URL:   ${PUBLIC_URL.replace(/\/$/, '')}/webhooks/shiprocket/tracking`);
  console.log('  Header x-api-key: <your SHIPROCKET_WEBHOOK_TOKEN value>');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
