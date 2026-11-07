/*
 * O11. A CloudWatch metric is billed per hour per unique name AND DIMENSION
 * SET. CloudWatch is already half this account's bill (USD 0.73 of 1.47 in
 * October) with 59 series live.
 *
 * The expensive mistake is putting a variable in a dimension. `delhivery.${path}`
 * produced
 * `delhivery./api/v1/packages/json/?waybill=59152210001142,591522...`,
 * so every distinct batch of waybills opened its own series, forever, and none
 * of them aggregated: "is Delhivery tracking flaky today" was unanswerable
 * because every call was its own metric.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

const SRC = new URL('.', import.meta.url).pathname;

/* A literal that would be a dimension VALUE, and whether it is safe. */
const unbounded = (literal) => /[?=]/.test(literal) || /\d{6,}/.test(literal);

describe('no metric carries an unbounded dimension', () => {
  /*
   * The dimension literals: `metric('X', 1, { k: 'v' })`. A dimension built
   * from a variable cannot be read statically, so this catches the literal
   * case and the label check below catches the one that actually bit us.
   */
  it('no literal dimension value contains a query string or a long number', () => {
    const offenders = [];
    for (const [path, full] of walk(SRC)) {
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/metric\(\s*'[^']+'\s*,[^,)]+,\s*\{([^}]*)\}/g)) {
        for (const lit of m[1].matchAll(/'([^']*)'/g)) {
          if (unbounded(lit[1])) offenders.push(`${path}: ${lit[1].slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * THE ONE THAT COST MONEY. withRetry's label becomes the TransientRetry and
   * SoftFailure dimension, and a label built by interpolating a path or an id
   * opens a series per call. A template literal in a label is only safe when
   * every value it can take comes from a fixed set (a flow step, an API method
   * name), so each one is listed here deliberately rather than pattern-matched.
   */
  it('every withRetry label is a fixed string or a known small set', () => {
    const ALLOWED_INTERPOLATED = new Set([
      // step: one of the five Flow A timer names.
      'src/worker/flowA.run.mjs',
      // call: one of the three logistics API method names.
      'src/worker/replace.run.mjs',
      // Built by labelFor / a trailing-segment slice, both fixed sets.
      'src/clients/courier.mjs',
      'src/clients/logistics/delhivery.mjs',
      // path.split('/')[1], which is the resource name and never an id.
      'src/clients/razorpay.mjs',
    ]);
    const offenders = [];
    for (const [path, full] of walk(SRC)) {
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/withRetry\(\s*`([^`]*)`/g)) {
        if (!m[1].includes('${')) continue;
        if (ALLOWED_INTERPOLATED.has(`src/${path}`)) continue;
        offenders.push(`src/${path}: ${m[1]}`);
      }
    }
    expect(offenders, 'a label becomes a metric dimension: use a fixed name per operation').toEqual([]);
  });

  /*
   * And the specific regression: the tracking label must not be built from the
   * path, because that path carries the waybill list.
   */
  it('the Delhivery tracking label is one fixed string', async () => {
    const text = readFileSync(new URL('./clients/courier.mjs', import.meta.url), 'utf8');
    expect(text).toContain("return 'delhivery.track'");
    expect(text).not.toContain('withRetry(`delhivery.${path}`');
  });
});
