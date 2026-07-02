#!/usr/bin/env node
/**
 * Seeds the MorPaankh automation flows into the node-workflow platform
 * (~/node-workflow) via its REST API. Idempotent by name: skips any workflow
 * that already exists.
 *
 * The platform does the scheduling, run history, and retries; each flow just
 * calls one idempotent hub endpoint and asserts on its summary. (The platform
 * has no loop node, so all fan-out lives in the hub endpoint.)
 *
 * Usage:
 *   NW_API_URL=https://<api-gateway-url> \
 *   NW_EMAIL=you@example.com NW_PASSWORD=... \
 *   HUB_BASE_URL=https://<hub-url> \
 *   AUTOMATION_SHARED_SECRET=<same value as the hub .env> \
 *   node scripts/seed-workflows.mjs
 *
 * Flows are created INACTIVE. Review each in the editor, run once manually
 * with {"dryRun": true} spirit (set AUTOMATION_DRY_RUN=true on the hub for a
 * rehearsal), then activate.
 */

const env = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
};

const API = env('NW_API_URL').replace(/\/$/, '');
const EMAIL = env('NW_EMAIL');
const PASSWORD = env('NW_PASSWORD');
const HUB = env('HUB_BASE_URL').replace(/\/$/, '');
const SECRET = env('AUTOMATION_SHARED_SECRET');

/** Standard 4-node graph: Schedule -> Run Task -> Check OK -> Summary. */
function taskGraph(task, schedulerConfig) {
  const nodes = [
    {
      id: 'trigger',
      name: 'Schedule',
      nodeType: 'scheduler',
      type: 'trigger',
      position: { x: 0, y: 0 },
      config: schedulerConfig,
      error: null,
    },
    {
      id: 'run',
      name: 'Run Task',
      nodeType: 'httpRequest',
      type: 'action',
      position: { x: 280, y: 0 },
      config: {
        url: `${HUB}/automations/${task}/run`,
        method: 'POST',
        headers: { 'x-automation-secret': SECRET },
        body: {},
        timeoutMs: 30000,
      },
      error: null,
    },
    {
      id: 'check',
      name: 'Check OK',
      nodeType: 'if',
      type: 'action',
      position: { x: 560, y: 0 },
      config: {
        conditions: [
          { left: '{{Run Task.output.body.ok}}', operator: 'equals', right: true },
        ],
      },
      error: null,
    },
    {
      id: 'summary',
      name: 'Summary',
      nodeType: 'set',
      type: 'action',
      position: { x: 840, y: 0 },
      config: {
        task,
        scanned: '{{Run Task.output.body.scanned}}',
        eligible: '{{Run Task.output.body.eligible}}',
        sent: '{{Run Task.output.body.sent}}',
        errors: '{{Run Task.output.body.errors}}',
      },
      error: null,
    },
  ];
  const edges = [
    { id: 'e1', source: 'trigger', target: 'run' },
    { id: 'e2', source: 'run', target: 'check' },
    { id: 'e3', source: 'check', target: 'summary', sourceHandle: 'true' },
  ];
  return { nodes, edges };
}

const FLOWS = [
  {
    name: 'MorPaankh: abandoned checkout recovery',
    graph: taskGraph('abandoned-checkouts', {
      mode: 'interval',
      every: 15,
      unit: 'minutes',
    }),
  },
  {
    name: 'MorPaankh: COD order confirmation',
    graph: taskGraph('cod-confirmation', {
      mode: 'interval',
      every: 15,
      unit: 'minutes',
    }),
  },
  {
    name: 'MorPaankh: review requests',
    graph: taskGraph('review-requests', {
      mode: 'daily',
      time: '11:00',
      timezone: 'Asia/Kolkata',
    }),
  },
];
// Shipped/delivered WhatsApp is event-driven inside the hub's Shiprocket
// webhook handler — no scheduled flow needed for it.

async function main() {
  const login = await fetch(`${API}/auth/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) {
    console.error(`Login failed (${login.status}): ${await login.text()}`);
    process.exit(1);
  }
  const { accessToken } = await login.json();
  const auth = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const existingRes = await fetch(`${API}/workflows`, { headers: auth });
  if (!existingRes.ok) {
    console.error(`Listing workflows failed (${existingRes.status})`);
    process.exit(1);
  }
  const existingNames = new Set((await existingRes.json()).map((w) => w.name));

  for (const flow of FLOWS) {
    if (existingNames.has(flow.name)) {
      console.log(`= exists, skipped: ${flow.name}`);
      continue;
    }
    const res = await fetch(`${API}/workflows`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: flow.name, active: false, graph: flow.graph }),
    });
    if (!res.ok) {
      console.error(`x failed: ${flow.name} (${res.status}): ${await res.text()}`);
      continue;
    }
    const created = await res.json();
    console.log(`+ created (inactive): ${flow.name} [${created.workflowId}]`);
  }

  console.log(
    '\nNext: open the editor, inspect each flow, do a dry-run rehearsal ' +
      '(AUTOMATION_DRY_RUN=true on the hub, then Run), and activate.'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
