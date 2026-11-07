/*
 * GSI2, the sparse index that replaced six full-table Scans.
 *
 * A Scan is billed for every row it EVALUATES, not for what the filter returns.
 * Measured over the 30 days to 2026-11-06 the table served 229,616 read units
 * against 12,370 write units, 18.6 reads per write, on 4,017 items, and the
 * worst offender ran every five minutes inside 09:30 to 22:30.
 *
 * A dry run of scripts/backfill-kind.mjs against the live table on 2026-11-07
 * found 135 rows that belong in this index, out of 4,017: it holds about 3% of
 * the table, which is the whole saving.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { table, _resetMemory } from './table.mjs';
import { putCapture, listCaptures } from './cartCapture.mjs';
import { ensureRec, allRecs } from './cartRecovery.mjs';

beforeEach(_resetMemory);

describe('queryKind', () => {
  const put = (kind, kindAt, extra = {}) =>
    table.put({ PK: `X#${kindAt}`, SK: 'ROW', kind, kindAt, ...extra });

  it('returns only the kind asked for', async () => {
    await put('capcart', '2026-11-01T00:00:00Z');
    await put('subrec', '2026-11-02T00:00:00Z');
    const rows = await table.queryKind('capcart');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('capcart');
  });

  it('bounds by the sort key in both directions', async () => {
    for (const d of ['01', '02', '03', '04']) await put('capcart', `2026-11-${d}T00:00:00Z`);
    expect(await table.queryKind('capcart', { sinceISO: '2026-11-03T00:00:00Z' })).toHaveLength(2);
    expect(await table.queryKind('capcart', { untilISO: '2026-11-03T00:00:00Z' })).toHaveLength(2);
    expect(await table.queryKind('capcart', {
      sinceISO: '2026-11-02T00:00:00Z', untilISO: '2026-11-04T00:00:00Z',
    })).toHaveLength(2);
  });

  it('comes back in time order, which is the order the sweeps want', async () => {
    for (const d of ['03', '01', '02']) await put('capcart', `2026-11-${d}T00:00:00Z`);
    const rows = await table.queryKind('capcart');
    expect(rows.map((r) => r.kindAt)).toEqual([
      '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z',
    ]);
  });

  it('never sees a row with no kind, which is what makes it sparse', async () => {
    await table.put({ PK: 'ORDER#1', SK: 'STATE', flowA: {} });
    await table.put({ PK: 'ORDER#1', SK: 'MSG#wamid.X', key: 'cod_confirm' });
    expect(await table.queryKind('capcart')).toEqual([]);
  });
});

describe('the writers stamp what the index needs', () => {
  it('a captured cart', async () => {
    const id = await putCapture({
      token: 'Z2NwLWFzaWEtc291dGgx',
      phone: '+919637361371',
      items: [{ id: 'gid://shopify/ProductVariant/1', qty: 1 }],
      now: new Date('2026-11-06T10:00:00Z'),
    });
    expect(await listCaptures()).toHaveLength(1);
    // kindAt mirrors capturedAt, so the sweep's oldest-first order is the
    // index's own order.
    const [row] = await table.queryKind('capcart');
    expect(row.kindAt).toBe('2026-11-06T10:00:00.000Z');
    expect(row.id).toBe(id);
  });

  it('a cart recovery record, and allRecs still refuses a foreign PK', async () => {
    await ensureRec('66743166239092', { phone: '+919637361371' }, new Date('2026-11-06T10:00:00Z'));
    expect(await allRecs()).toHaveLength(1);
    // A row of another flow's, carrying the same kind by mistake: the PK filter
    // is the second guarantee and it still holds.
    await table.put({ PK: 'SUBOFFER#9', SK: 'REC', kind: 'cartrec', kindAt: '2026-11-06T11:00:00Z' });
    expect(await allRecs()).toHaveLength(1);
  });

  it('bounds a capture read, so a sweep is not charged for last month', async () => {
    await putCapture({
      token: 'OLDTOKEN0001', phone: '+919637361371',
      items: [{ id: 'gid://shopify/ProductVariant/1', qty: 1 }],
      now: new Date('2026-10-01T10:00:00Z'),
    });
    await putCapture({
      token: 'NEWTOKEN0001', phone: '+919637361372',
      items: [{ id: 'gid://shopify/ProductVariant/1', qty: 1 }],
      now: new Date('2026-11-06T10:00:00Z'),
    });
    expect(await listCaptures('2026-11-01T00:00:00Z')).toHaveLength(1);
    expect(await listCaptures()).toHaveLength(2);
  });
});

/*
 * THE GUARD.
 *
 * Every scanBySk left in src/ is a deliberate fallback for the window between
 * the deploy that adds GSI2 and scripts/backfill-kind.mjs running --live. They
 * are listed here so a NEW one cannot be added quietly, and so that deleting
 * them after the backfill is a visible, failing-test-driven step rather than
 * something to remember.
 */
describe('no new full-table scans', () => {
  const ALLOWED = new Set([
    'store/table.mjs', // the implementation itself
    // Temporary fallbacks. Delete these, and these lines, after the backfill.
    'store/cartCapture.mjs',
    'store/cartRecovery.mjs',
    'store/replace.mjs',
    'store/subscriberOffer.mjs',
    'pnl/sources/replacements.mjs',
  ]);

  const walk = (dir, rel = '') => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) out.push(...walk(full, path));
      else if (name.endsWith('.mjs') && !name.includes('.test.')) out.push([path, full]);
    }
    return out;
  };

  it('only the known callers call scanBySk', () => {
    const src = new URL('..', import.meta.url).pathname;
    const offenders = walk(src)
      .filter(([, full]) => /\btable\.scanBySk\(/.test(readFileSync(full, 'utf8')))
      .map(([path]) => path)
      .filter((path) => !ALLOWED.has(path));
    expect(offenders, 'use table.queryKind and a `kind` stamp instead of a full-table Scan').toEqual([]);
  });
});
