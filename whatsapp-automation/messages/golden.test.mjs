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

  /*
   * EVERY PINNED KEY IS STILL THERE. Not "the same set": the feature adds
   * language_select and language_set to the English registry, and a new key is
   * an addition, not a movement. A key that DISAPPEARS is still caught here,
   * which is the half that matters, and every pinned key's payload is compared
   * below.
   */
  it('still renders every key that was pinned', () => {
    const missing = Object.keys(SNAPSHOT).filter((k) => !(k in live));
    expect(missing).toEqual([]);
  });

  for (const key of Object.keys(SNAPSHOT)) {
    it(key, () => {
      expect(live[key]).toEqual(SNAPSHOT[key]);
    });
  }
});
