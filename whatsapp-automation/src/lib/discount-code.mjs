/*
 * discount-code.mjs — generate a review thank-you code like THANKS-AB4K7P.
 * Unambiguous alphabet (no 0/O/1/I/L). Caller retries on collision.
 */
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(prefix = 'THANKS-', len = 6) {
  let s = '';
  for (let i = 0; i < len; i += 1) s += ALPHABET[randomInt(ALPHABET.length)];
  return prefix + s;
}
