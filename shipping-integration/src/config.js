'use strict';

/**
 * Central environment configuration + validation.
 * Mirrors the "fail fast with a clear message" pattern: required vars throw
 * at startup so a misconfigured deploy never silently no-ops a shipment.
 */
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

module.exports = {
  port: Number(optional('PORT', 3000)),

  shopify: {
    // e.g. sawri-bawri.myshopify.com
    shop: required('SHOPIFY_STORE_DOMAIN'),
    // Admin API access token from a custom app (shpat_...)
    adminToken: required('SHOPIFY_ADMIN_TOKEN'),
    // App's API secret — used to verify webhook HMAC signatures
    apiSecret: required('SHOPIFY_API_SECRET'),
    apiVersion: optional('SHOPIFY_API_VERSION', '2024-10'),
  },

  shiprocket: {
    email: required('SHIPROCKET_EMAIL'),
    password: required('SHIPROCKET_PASSWORD'),
    // Pickup location nickname exactly as configured in Shiprocket
    pickupLocation: required('SHIPROCKET_PICKUP_LOCATION'),
    // The x-api-key value you set on the Shiprocket tracking webhook
    webhookToken: required('SHIPROCKET_WEBHOOK_TOKEN'),
    channelId: optional('SHIPROCKET_CHANNEL_ID', ''),
    // Auto-assign an AWB (and request pickup) right after order creation
    autoAssignAwb: optional('SHIPROCKET_AUTO_AWB', 'true') !== 'false',
    // Base for the customer-facing tracking link written back to Shopify
    trackingUrlBase: optional('SHIPROCKET_TRACKING_BASE', 'https://shiprocket.co/tracking/'),
  },

  // Fallback parcel dimensions/weight when product data has none
  defaults: {
    weightKg: Number(optional('DEFAULT_WEIGHT_KG', 0.5)),
    length: Number(optional('DEFAULT_LENGTH_CM', 30)),
    breadth: Number(optional('DEFAULT_BREADTH_CM', 25)),
    height: Number(optional('DEFAULT_HEIGHT_CM', 5)),
  },

  notifyCustomer: optional('NOTIFY_CUSTOMER', 'true') !== 'false',

  // Customer-facing base URL used in message links
  storefrontBase: optional('STOREFRONT_BASE_URL', 'https://www.morpaankh.in'),

  /**
   * Automation task endpoints (/automations/:task/run), called on a schedule
   * by the node-workflow platform. All optional: without a shared secret the
   * routes return 503, and each channel stays off until its creds + enable
   * flag are set, so the shipping flows keep working with none of this
   * configured.
   */
  automation: {
    sharedSecret: optional('AUTOMATION_SHARED_SECRET', ''),
    dryRun: optional('AUTOMATION_DRY_RUN', 'false') === 'true',
    // Abandoned checkout recovery
    acrMinAgeMinutes: Number(optional('ACR_MIN_AGE_MINUTES', 60)),
    acrMaxAgeHours: Number(optional('ACR_MAX_AGE_HOURS', 48)),
    // Only message people who opted in to marketing (WhatsApp abandoned-cart
    // and review messages are marketing-category templates under Meta rules)
    requireMarketingConsent: optional('REQUIRE_MARKETING_CONSENT', 'true') !== 'false',
    // Brevo abandoned-cart email is OFF by default: Shopify's native
    // abandoned-checkout email should own that channel (never send both)
    acrEmailEnabled: optional('ACR_EMAIL_ENABLED', 'false') === 'true',
    codMinAgeMinutes: Number(optional('COD_MIN_AGE_MINUTES', 20)),
    reviewDelayDays: Number(optional('REVIEW_DELAY_DAYS', 3)),
    reviewMaxAgeDays: Number(optional('REVIEW_MAX_AGE_DAYS', 30)),
  },

  // Meta WhatsApp Cloud API (direct, no third-party SaaS)
  whatsapp: {
    enabled: optional('WHATSAPP_ENABLED', 'false') === 'true',
    phoneNumberId: optional('WHATSAPP_PHONE_NUMBER_ID', ''),
    accessToken: optional('WHATSAPP_ACCESS_TOKEN', ''),
    apiVersion: optional('WHATSAPP_API_VERSION', 'v20.0'),
    languageCode: optional('WHATSAPP_TPL_LANG', 'en'),
    templates: {
      abandonedCheckout: optional('WHATSAPP_TPL_ABANDONED', 'abandoned_checkout_reminder'),
      codConfirm: optional('WHATSAPP_TPL_COD_CONFIRM', 'cod_order_confirmation'),
      shipped: optional('WHATSAPP_TPL_SHIPPED', 'order_shipped'),
      delivered: optional('WHATSAPP_TPL_DELIVERED', 'order_delivered'),
      review: optional('WHATSAPP_TPL_REVIEW', 'review_request'),
    },
  },

  // Brevo transactional email (free tier: 300/day)
  brevo: {
    enabled: optional('BREVO_ENABLED', 'false') === 'true',
    apiKey: optional('BREVO_API_KEY', ''),
    senderEmail: optional('BREVO_SENDER_EMAIL', 'care@morpaankh.in'),
    senderName: optional('BREVO_SENDER_NAME', 'MorPaankh'),
  },
};
