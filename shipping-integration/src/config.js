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
};
