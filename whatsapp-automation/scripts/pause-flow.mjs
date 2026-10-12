#!/usr/bin/env node
/*
 * pause-flow — turn a flow on/off by updating FLOW_<X>_ENABLED on the worker +
 * ingest Lambdas (takes effect on the next cold start, usually seconds). Also
 * flips DRY_RUN with `dryrun on|off`.
 *
 *   node scripts/pause-flow.mjs A off
 *   node scripts/pause-flow.mjs B on
 *   node scripts/pause-flow.mjs dryrun off
 *   node scripts/pause-flow.mjs reviewvia link
 */
import { config } from '../src/config.mjs';

const [target, state] = process.argv.slice(2);
const t = (target || '').toLowerCase();
// `reviewvia` takes flow|link rather than on|off: it picks which review ask
// Flow B sends, not whether it sends one.
const states = t === 'reviewvia' ? ['flow', 'link'] : ['on', 'off'];
if (!target || !states.includes(state)) {
  console.error('usage: pause-flow.mjs <A|B|C|D|R|dryrun|variantchange> <on|off> | reviewvia <flow|link>');
  process.exit(1);
}
const KEYS = { dryrun: 'DRY_RUN', reviewvia: 'REVIEW_VIA', variantchange: 'VARIANT_CHANGE_ENABLED' };
const key = KEYS[t] || `FLOW_${target.toUpperCase()}_ENABLED`;
const value = t === 'dryrun' ? (state === 'off' ? 'false' : 'true') : t === 'reviewvia' ? state : String(state === 'on');

const c = await import('@aws-sdk/client-lambda');
const lambda = new c.LambdaClient({ region: config.region });
const fns = ['wa-worker', 'wa-ingest-shopify', 'wa-ingest-whatsapp', 'wa-ingest-razorpay', 'wa-ingest-delhivery', 'wa-poll-delhivery', 'wa-reconcile', 'wa-digest'];

for (const fn of fns) {
  try {
    const cfg = await lambda.send(new c.GetFunctionConfigurationCommand({ FunctionName: fn }));
    const env = { ...(cfg.Environment?.Variables || {}), [key]: value };
    await lambda.send(new c.UpdateFunctionConfigurationCommand({ FunctionName: fn, Environment: { Variables: env } }));
    console.log(`${fn}: ${key}=${value}`);
  } catch (e) {
    console.error(`${fn}: ${e.name || e.message}`);
  }
}
