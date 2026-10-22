/*
 * clients/logistics/index.mjs: the provider registry for /replace.
 *
 * The orchestrator never names a courier. It asks for `logistics` and gets
 * whatever LOGISTICS_PROVIDER selected, which is what keeps a second courier
 * down to one adapter file, its fake, one line here and one config value
 * (DECISIONS T6).
 *
 * An unknown provider throws rather than quietly falling back to Delhivery: a
 * typo in the variable would otherwise book every replacement with a courier
 * nobody chose, and that is only visible once a parcel is already moving.
 */
import { config } from '../../config.mjs';
import { delhivery } from './delhivery.mjs';

const PROVIDERS = { delhivery };

/** @param {string} [provider] */
export function makeLogistics(provider = config.logisticsProvider) {
  const adapter = PROVIDERS[String(provider || '').toLowerCase()];
  if (!adapter) {
    throw new Error(`unknown logistics provider: ${provider || '(empty)'} (have: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  return adapter;
}

/*
 * Resolved on FIRST USE, not at import.
 *
 * This matters more than it looks. `clients/index.mjs` is imported by every
 * Lambda in the service, so a module-level `makeLogistics()` would run on every
 * cold start of the worker, all four ingest handlers, the poller, the
 * reconciler and the digest. A single typo in LOGISTICS_PROVIDER would then
 * throw before any handler ran and take down COD confirmations, review asks,
 * NDR rescue and cart recovery, all for a feature that ships switched off.
 *
 * Deferring it means the same typo breaks exactly one thing: the next /replace
 * command, whose owner gets told what is wrong and can fix the variable. The
 * throw is still loud, it just lands on the feature that asked for it.
 */
let cached = null;
export function getLogistics() {
  if (!cached) cached = makeLogistics();
  return cached;
}
/** Test-only: forget the memoized adapter so a changed provider is re-read. */
export function _resetLogistics() {
  cached = null;
}
