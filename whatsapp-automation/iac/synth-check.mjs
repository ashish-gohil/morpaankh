#!/usr/bin/env node
/*
 * synth-check.mjs — assertions about the SYNTHESIZED template.
 *
 * The stack has no unit tests, and the two things checked here are both the
 * silent kind: a function with no subscription filter reports nothing when it
 * fails, and an alarm math expression over ten metrics is rejected by
 * CloudWatch at deploy time rather than here.
 *
 *   cd iac && npx cdk synth > cdk.out/synth.yaml && node synth-check.mjs
 *
 * Reads cdk.out/WaAutomation.template.json, which `cdk synth` always writes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tpl = JSON.parse(readFileSync(join(here, 'cdk.out', 'WaAutomation.template.json'), 'utf8'));
const resources = Object.entries(tpl.Resources || {});

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok    ${name}`); }
  catch (e) { failures += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

/*
 * LogGroupName is a literal for an IMPORTED group and a { Ref } for one this
 * stack creates, so both shapes have to be resolved. A check that only read
 * the literal reported zero filters for wa-pnl-report, which has two.
 */
const groupNameOf = (prop) => {
  if (typeof prop === 'string') return prop;
  const ref = prop?.Ref;
  if (!ref) return '';
  const target = tpl.Resources?.[ref];
  return typeof target?.Properties?.LogGroupName === 'string' ? target.Properties.LogGroupName : '';
};

const filtersFor = (group) =>
  resources.filter(([, r]) =>
    r.Type === 'AWS::Logs::SubscriptionFilter' && groupNameOf(r.Properties?.LogGroupName).endsWith(group));

/*
 * Every function whose failures are CAUGHT and answered with an HTTP status
 * raises no Lambda error, so the log filter is the only thing that reports it.
 * wa-cart-capture is Flow R's primary source and had neither.
 */
for (const fn of ['wa-cart-capture', 'wa-subscribe', 'wa-worker', 'wa-pnl-report']) {
  check(`${fn} has both log subscription filters`, () => {
    assert.equal(filtersFor(fn).length, 2, `${filtersFor(fn).length} filters, expected 2`);
  });
}

/* CloudWatch refuses an alarm math expression over ten metrics. */
check('no alarm expression exceeds ten metrics', () => {
  for (const [id, r] of resources) {
    if (r.Type !== 'AWS::CloudWatch::Alarm') continue;
    for (const m of r.Properties?.Metrics || []) {
      if (!m.Expression) continue;
      const n = (m.Expression.match(/\be\d+\b/g) || []).length;
      assert.ok(n <= 10, `${id} uses ${n} metrics`);
    }
  }
});

/* The alarm that covers the public HTTP endpoints must actually cover them. */
check('the intake alarm counts five functions', () => {
  const intake = resources.find(([id]) => /intake/i.test(id) && tpl.Resources[id].Type === 'AWS::CloudWatch::Alarm');
  assert.ok(intake, 'no intake alarm found');
  const expr = (intake[1].Properties.Metrics || []).find((m) => m.Expression)?.Expression || '';
  assert.equal((expr.match(/\be\d+\b/g) || []).length, 5, `expression was "${expr}"`);
});

/*
 * O5. Lambda creates a function's log group on first invocation with retention
 * NEVER EXPIRES, and thirteen of the sixteen groups here were only IMPORTED,
 * which sets nothing on them. CloudWatch storage is already half this
 * account's bill, so a function shipping without a retention policy is a
 * silent cost.
 */
check('every function has a log retention policy', () => {
  const functions = resources
    .filter(([, r]) => r.Type === 'AWS::Lambda::Function')
    .map(([, r]) => r.Properties?.FunctionName)
    .filter((n) => typeof n === 'string' && n.startsWith('wa-'));
  assert.ok(functions.length >= 16, `only found ${functions.length} wa- functions`);

  // Either a LogRetention custom resource names the group, or the stack
  // declares the group itself with a RetentionInDays.
  const retained = new Set();
  for (const [, r] of resources) {
    if (r.Type === 'Custom::LogRetention' && typeof r.Properties?.LogGroupName === 'string') {
      retained.add(r.Properties.LogGroupName);
    }
    if (r.Type === 'AWS::Logs::LogGroup' && r.Properties?.RetentionInDays) {
      retained.add(r.Properties.LogGroupName);
    }
  }
  const missing = functions.filter((n) => !retained.has(`/aws/lambda/${n}`));
  assert.deepEqual(missing, [], `no retention policy for: ${missing.join(', ')}`);
});

/*
 * O10. The public unsigned endpoints are throttled in front of Lambda, so a
 * flood costs nothing rather than one invocation and one DynamoDB write per
 * refused request.
 *
 * Asserted in CloudFormation's own casing, because that is the trap: assigning
 * the L1 property synthesises VERBATIM, so an array or camelCase keys produce
 * a template CloudFormation accepts and API Gateway ignores. A throttle
 * present in the diff and absent in reality.
 */
check('the public routes are throttled, in CloudFormation s casing', () => {
  const stage = resources.find(([, r]) => r.Type === 'AWS::ApiGatewayV2::Stage');
  assert.ok(stage, 'no stage found');
  const rs = stage[1].Properties?.RouteSettings;
  assert.ok(rs && !Array.isArray(rs), 'RouteSettings must be a MAP keyed by route key, not a list');
  for (const routeKey of ['POST /cart-capture', 'POST /subscribe', 'GET /p/{token}', 'GET /r/{token}', 'GET /w/{token}']) {
    const one = rs[routeKey];
    assert.ok(one, `no throttle for ${routeKey}`);
    assert.ok(Number(one.ThrottlingRateLimit) > 0, `${routeKey}: ThrottlingRateLimit missing (camelCase does nothing)`);
    assert.ok(Number(one.ThrottlingBurstLimit) > 0, `${routeKey}: ThrottlingBurstLimit missing`);
  }
  // CloudFormation rejects a route setting naming a route it has not created.
  assert.ok((stage[1].DependsOn || []).length >= 5, 'the stage must depend on the routes it throttles');
});

/*
 * EVERY FUNCTION THAT SENDS EMAIL NEEDS ITS OWN SES GRANT, and a missing one
 * is invisible until the send is the only route left.
 *
 * wa-digest sent nothing on 2026-11-14 and its role had never been granted
 * ses:SendEmail. The grant block said "on the WORKER role and nowhere else",
 * which stopped being true when the digest and the P&L report started sending
 * for themselves. It stayed hidden because the digest's own call passed a
 * comma-joined address list, so SES refused on "Illegal address" before IAM was
 * consulted, and both failures landed on a soft() path that logs and continues.
 *
 * Each of these three reaches SES through clients/email.mjs. Add a function
 * here when it starts sending, and read the grant comment in lib/stack.js
 * before widening anything.
 */
check('every email-sending function can actually send email', () => {
  const needsSes = ['wa-worker', 'wa-pnl-report', 'wa-digest'];

  // FunctionName -> the logical id of its role, via Role: Fn::GetAtt.
  const roleOf = new Map();
  for (const [, r] of resources) {
    if (r.Type !== 'AWS::Lambda::Function') continue;
    const name = r.Properties?.FunctionName;
    const att = r.Properties?.Role?.['Fn::GetAtt'];
    if (typeof name === 'string' && Array.isArray(att)) roleOf.set(name, att[0]);
  }

  for (const fn of needsSes) {
    const role = roleOf.get(fn);
    assert.ok(role, `${fn}: no function found, or it has no role`);

    const granted = resources.some(([, r]) => {
      if (r.Type !== 'AWS::IAM::Policy') return false;
      const roles = (r.Properties?.Roles || []).map((x) => x?.Ref);
      if (!roles.includes(role)) return false;
      return (r.Properties?.PolicyDocument?.Statement || []).some((st) => {
        const actions = [].concat(st.Action || []);
        return st.Effect === 'Allow' && actions.includes('ses:SendEmail');
      });
    });
    assert.ok(granted, `${fn}: its role has no ses:SendEmail, so every email it sends is denied`);
  }
});

/*
 * O7. Arm costs about 20% less per GB-second for the same Node code, and a
 * function added later without it is invisible: it just costs more.
 */
check('every function runs on arm64', () => {
  const wrong = resources
    .filter(([, r]) => r.Type === 'AWS::Lambda::Function')
    .map(([, r]) => r.Properties)
    .filter((p) => typeof p?.FunctionName === 'string' && p.FunctionName.startsWith('wa-'))
    .filter((p) => !(p.Architectures || []).includes('arm64'))
    .map((p) => p.FunctionName);
  assert.deepEqual(wrong, [], `not on arm64: ${wrong.join(', ')}`);
});

check('the P&L layer runs on either architecture', () => {
  const layer = resources.find(([, r]) => r.Type === 'AWS::Lambda::LayerVersion');
  assert.ok(layer, 'no layer found');
  const archs = layer[1].Properties?.CompatibleArchitectures || [];
  assert.ok(archs.includes('arm64'), 'the layer does not declare arm64');
  // Both, so a function can be moved back to x86 without republishing it.
  assert.ok(archs.includes('x86_64'), 'the layer does not declare x86_64');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
