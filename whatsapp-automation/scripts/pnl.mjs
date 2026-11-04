#!/usr/bin/env node
/*
 * scripts/pnl.mjs — build a month's P&L from this machine.
 *
 *   npm run pnl -- --month 2026-10
 *   npm run pnl -- --month 2026-10 --no-send            # write the file, send nothing
 *   npm run pnl -- --month 2026-10 --out ~/Desktop
 *   npm run pnl -- --month 2026-10 --ledger ./statement.csv
 *   npm run pnl -- --mtd
 *
 * The SAME code the Lambda runs: it imports src/pnl/run.mjs and nothing of its
 * own. The only thing this file decides is where the output lands and which
 * backends to talk to, which is why a local dry run is worth trusting.
 *
 * DEFAULTS TO --no-send IS DELIBERATELY NOT THE CASE: the brief asks for a flag
 * that suppresses sending, so sending is the default and the flag is explicit.
 * Be aware that a bare `npm run pnl` therefore messages and emails the owner.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const a = { month: null, send: true, out: null, ledger: null, mtd: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--month' || k === '-m') a.month = argv[++i];
    else if (k === '--no-send') a.send = false;
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--ledger') a.ledger = argv[++i];
    else if (k === '--mtd') a.mtd = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k.startsWith('--month=')) a.month = k.slice(8);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\n?/, ''));
  process.exit(0);
}

/*
 * The real backends, set BEFORE config.mjs is imported: config reads
 * process.env once at module load and is explicitly not hot-swappable, so an
 * assignment after the import would be silently ignored.
 */
process.env.SECRETS_BACKEND = process.env.SECRETS_BACKEND || 'aws';
process.env.DYNAMO_BACKEND = process.env.DYNAMO_BACKEND || 'aws';
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
process.env.PNL_ENABLED = process.env.PNL_ENABLED || 'true';
// Sending is what DRY_RUN gates, and a local run should behave like production
// unless --no-send says otherwise.
if (!args.send) process.env.DRY_RUN = 'true';
else process.env.DRY_RUN = process.env.DRY_RUN || 'false';

/*
 * Shop domain, ad account and the bucket come from the deployed stack's own
 * context file rather than being repeated here, so a local run and the Lambda
 * cannot drift apart.
 */
try {
  const ctx = JSON.parse(readFileSync(join(ROOT, 'iac', 'cdk.json'), 'utf8')).context || {};
  process.env.SHOP_DOMAIN = process.env.SHOP_DOMAIN || ctx.shopDomain || '';
  process.env.META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || ctx.metaAdAccountId || '';
  process.env.GRAPH_VERSION = process.env.GRAPH_VERSION || ctx.graphVersion || 'v25.0';
  process.env.EMAIL_FROM = process.env.EMAIL_FROM || ctx.emailFrom || '';
  process.env.PNL_EMAIL_TO = process.env.PNL_EMAIL_TO || ctx.pnlEmailTo || '';
  process.env.OWNER_ALERT_PHONES = process.env.OWNER_ALERT_PHONES || ctx.ownerAlertPhones || '';
} catch {
  console.warn('could not read iac/cdk.json; relying on the environment alone');
}

const { runPnl, previousMonth, currentMonth, monthLabel } = await import('../src/pnl/run.mjs');
const { realClients } = await import('../src/clients/index.mjs');
const { formatINR } = await import('../src/lib/money.mjs');

const now = new Date();
const month = args.month || (args.mtd ? currentMonth(now) : previousMonth(now));
const ledgerBuffer = args.ledger ? readFileSync(resolve(args.ledger)) : null;

console.log(`\nMorpaankh P&L: ${monthLabel(month)}  (${args.send ? 'WILL SEND' : 'no-send'})`);
if (ledgerBuffer) console.log(`ledger: ${args.ledger} (${ledgerBuffer.length} bytes)`);
console.log('');

const r = await runPnl({
  month,
  trigger: 'cli',
  clients: realClients,
  now,
  send: args.send,
  ledgerBuffer,
  ledgerName: args.ledger || '',
  // A local run must not block a scheduled one, and vice versa, but it also
  // must not be able to race it. The lock is kept.
  lock: true,
});

if (r.skipped) {
  console.log(`skipped: ${r.skipped}`);
  process.exit(0);
}

const outDir = args.out ? resolve(args.out) : join(ROOT, 'finance', 'out');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, r.filename);
writeFileSync(file, r.bytes);

const t = r.report.totals;
const f = r.report.funnel;
console.log('funnel      ', JSON.stringify(f));
console.log('net profit  ', t.netProfitPaise == null ? 'not computable' : formatINR(t.netProfitPaise));
console.log('net revenue ', formatINR(t.netRevenuePaise));
console.log('counted     ', `${t.countedDelivered} delivered, ${t.countedRto} RTO`);
console.log('blocked     ', `${t.blockedDelivered} delivered, ${t.blockedRto} RTO (incomplete rows, excluded from totals)`);
console.log('courier     ', r.wbMeta.courierChargeBasis);
console.log('incomplete  ', r.incomplete ? `YES: ${r.status.failures.join(' | ')}` : 'no');
if (r.report.flags?.length) {
  console.log(`\nflags (${r.report.flags.length}):`);
  for (const fl of r.report.flags.slice(0, 40)) console.log('  -', typeof fl === 'string' ? fl : JSON.stringify(fl));
  if (r.report.flags.length > 40) console.log(`  ... and ${r.report.flags.length - 40} more, all on Data Checks`);
}
console.log(`\nworkbook: ${file}`);
console.log(`snapshot: ${r.stored?.key || r.stored?.skipped || 'not stored'}`);
