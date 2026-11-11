import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderAll } from './golden.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = JSON.parse(readFileSync(join(HERE, 'golden.snapshot.json'), 'utf8'));

/*
 * THE ENGLISH OUTPUT DOES NOT MOVE.
 *
 * Captured from the registries at 27d8fab, before the language work. A
 * customer with no stored language, or with 'en', must receive exactly the
 * bytes they received before Hindi existed: same template name, same version,
 * same parameter order, same button payloads, same session body.
 *
 * Per key rather than one big compare, so a failure names the message that
 * changed instead of printing a hundred of them.
 */
describe('English copy is byte-identical to the pre-language snapshot', () => {
  const live = renderAll();

  it('renders exactly the same set of keys', () => {
    expect(Object.keys(live).sort()).toEqual(Object.keys(SNAPSHOT).sort());
  });

  for (const key of Object.keys(SNAPSHOT)) {
    it(key, () => {
      expect(live[key]).toEqual(SNAPSHOT[key]);
    });
  }
});
