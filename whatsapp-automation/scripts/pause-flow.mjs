#!/usr/bin/env node
/*
 * pause-flow — turn a flow on/off by updating FLOW_<X>_ENABLED on the worker +
 * ingest Lambdas (takes effect on the next cold start, usually seconds). Also
 * flips DRY_RUN with `dryrun on|off`.
 *
 *   node scripts/pause-flow.mjs A off
 *   node scripts/pause-flow.mjs B on
 *   node scripts/pause-flow.mjs dryrun off
 */
import { config } from '../src/config.mjs';

const [target, state] = process.argv.slice(2);
if (!target || !['on', 'off'].includes(state)) {
  console.error('usage: pause-flow.mjs <A|B|C|D|dryrun> <on|off>');
  process.exit(1);
}
const key = target.toLowerCase() === 'dryrun' ? 'DRY_RUN' : `FLOW_${target.toUpperCase()}_ENABLED`;
const value = target.toLowerCase() === 'dryrun' ? (state === 'off' ? 'false' : 'true') : String(state === 'on');

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
