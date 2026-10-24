#!/usr/bin/env node
'use strict';
const cdk = require('aws-cdk-lib');
const { WaAutomationStack } = require('../lib/stack');

const app = new cdk.App();
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'ap-south-1';

new WaAutomationStack(app, 'WaAutomation', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  // Non-secret config comes in as context or Lambda env; secrets are filled in
  // Secrets Manager by hand (see README). Everything defaults to safe/OFF.
  alertEmail: app.node.tryGetContext('alertEmail') || '',
  shopDomain: app.node.tryGetContext('shopDomain') || '',
  graphVersion: app.node.tryGetContext('graphVersion') || 'v25.0',
  publicBaseUrl: app.node.tryGetContext('publicBaseUrl') || '',
  // Go-live switches (safe when absent: dry run on, all flows off).
  dryRun: app.node.tryGetContext('dryRun') !== false,
  sendAllowlist: app.node.tryGetContext('sendAllowlist') || '',
  orderAllowlist: app.node.tryGetContext('orderAllowlist') || '',
  ownerAlertPhones: app.node.tryGetContext('ownerAlertPhones') || '',
  flows: app.node.tryGetContext('flows') || {},
  reviewVia: app.node.tryGetContext('reviewVia') || 'flow',
  variantChangeEnabled: app.node.tryGetContext('variantChangeEnabled') === true,
  // Flow R shadow mode: non-empty means only these phones are really messaged.
  cartRecoveryAllowlist: app.node.tryGetContext('cartRecoveryAllowlist') || '',
  // Flow W shadow mode, and its email fallback. Absent is safe in both
  // directions: no allowlist means live to everyone (so FLOW_W_ENABLED is the
  // real switch), and no EMAIL_FROM means the email channel is unavailable and
  // recorded as such rather than failing.
  subscriberOfferAllowlist: app.node.tryGetContext('subscriberOfferAllowlist') || '',
  emailFrom: app.node.tryGetContext('emailFrom') || '',
  emailReplyTo: app.node.tryGetContext('emailReplyTo') || '',
  conversionVerified: app.node.tryGetContext('conversionVerified') === true,
  // /replace: defaults to shadow, which runs everything except the two courier
  // writes and the customer message.
  replaceMode: app.node.tryGetContext('replaceMode') || 'shadow',
  replaceAdminPhones: app.node.tryGetContext('replaceAdminPhones') || '',
  replaceTestOrders: app.node.tryGetContext('replaceTestOrders') || '',
  replaceRequireConfirm: app.node.tryGetContext('replaceRequireConfirm') !== false,
  replaceAllowSkipConfirm: app.node.tryGetContext('replaceAllowSkipConfirm') === true,
  replaceNotifyCustomer: app.node.tryGetContext('replaceNotifyCustomer') !== false,
  replaceSendLabel: app.node.tryGetContext('replaceSendLabel') !== false,
  logisticsProvider: app.node.tryGetContext('logisticsProvider') || 'delhivery',
  delhiveryPickupLocation: app.node.tryGetContext('delhiveryPickupLocation') || '',
  delhiveryShippingMode: app.node.tryGetContext('delhiveryShippingMode') || 'Surface',
  sellerGstin: app.node.tryGetContext('sellerGstin') || '',
  replaceReturnTo: app.node.tryGetContext('replaceReturnTo') || {},
});

app.synth();
