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
 *   node scripts/pause-flow.mjs replace shadow
 */
import { config } from '../src/config.mjs';

const [target, state] = process.argv.slice(2);
const t = (target || '').toLowerCase();
/*
 * Two targets are not on/off switches, and an unknown target must never fall
 * through to a boolean: this script WRITES to eight production Lambdas, so
 * `replace on` silently setting REPLACE_MODE=true is a real misconfiguration
 * rather than a usage error. Anything in PASS_THROUGH is validated against its
 * own state list and written verbatim.
 *
 * `reviewvia` picks which review ask Flow B sends, not whether it sends one.
 * `replace` has a third state, shadow, which runs the whole replacement path
 * except the two courier writes and the customer message, so it cannot be
 * expressed as a boolean at all.
 */
const PASS_THROUGH = { reviewvia: ['flow', 'link'], replace: ['off', 'shadow', 'live'] };
const states = PASS_THROUGH[t] || ['on', 'off'];
if (!target || !states.includes(state)) {
  console.error(
    'usage: pause-flow.mjs <A|B|C|D|R|dryrun|variantchange> <on|off>\n' +
      '       pause-flow.mjs reviewvia <flow|link>\n' +
      '       pause-flow.mjs replace <off|shadow|live>',
  );
  process.exit(1);
}
const KEYS = {
  dryrun: 'DRY_RUN',
  reviewvia: 'REVIEW_VIA',
  variantchange: 'VARIANT_CHANGE_ENABLED',
  replace: 'REPLACE_MODE',
};
const key = KEYS[t] || `FLOW_${target.toUpperCase()}_ENABLED`;
const value = t === 'dryrun'
  ? state === 'off' ? 'false' : 'true'
  : PASS_THROUGH[t] ? state : String(state === 'on');

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
