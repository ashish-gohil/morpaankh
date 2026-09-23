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
  conversionVerified: app.node.tryGetContext('conversionVerified') === true,
});

app.synth();
