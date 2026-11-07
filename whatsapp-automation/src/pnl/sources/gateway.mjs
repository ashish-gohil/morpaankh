/*
 * pnl/sources/gateway.mjs — what the payment gateways took.
 *
 * TWO GATEWAYS, ONE OF WHICH WE CANNOT READ.
 *
 *   Razorpay carries the prepaid-conversion PAYMENT LINKS only, and its
 *   `reference_id` is '<orderNumber>-P1'. That is the ONLY thing that maps a
 *   Razorpay payment to a Shopify order, so the mapping is by reference and
 *   never by amount or timestamp. Where a payment exists, `fee` and `tax` are
 *   real paise off the payment and nothing is assumed. Note `fee` INCLUDES
 *   `tax`, so the ex-GST fee is fee - tax (verified 2026-11-03).
 *
 *   Cashfree carries every other prepaid order on this store and there are NO
 *   KEYS for it anywhere: not in the service secrets, not in meta-outcomes/.env,
 *   nowhere in the repo. Those orders therefore get gatewayFeePct from config,
 *   `assumed: true`, and the Assumptions sheet says so. It is the one cost on
 *   the report that is a rate rather than a reading.
 *
 * COD ORDERS GET NO ROW AT ALL. Nobody takes a percentage of cash; the ₹50 COD
 * fee is the customer paying us and lives on the order, not here.
 *
 * `clients` is not a parameter. clients.razorpay is the write client (links,
 * refunds) and has no read methods, so the two reads this needs live below;
 * `reader` is the seam a test replaces. Extra keys on the argument object are
 * ignored, so calling this with { orders, config, clients } is harmless.
 */
import { getSecrets } from '../../secrets.mjs';
import { deadline, TIMEOUT_MS } from '../../lib/timeout.mjs';
import { log } from '../../log.mjs';
import { withRetry } from '../../lib/resilience.mjs';
import { RULES } from '../../../messages/rules.mjs';

const BASE = 'https://api.razorpay.com/v1';
const DAY_S = 24 * 60 * 60;

/** '#1170' -> '1170-P1', the reference_id Flow A writes on a conversion link. */
export const linkRefFor = (orderName) => `${String(orderName || '').replace(/^#/, '')}-P1`;

async function rzpGet(path, auth, label) {
  return withRetry(
    label,
    async () => {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: auth },
        ...deadline(TIMEOUT_MS.shopify),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${label} non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        const e = /** @type {any} */ (
          new Error(`${label} failed (HTTP ${res.status}): ${json.error?.description || text.slice(0, 160)}`)
        );
        e.status = res.status;
        throw e;
      }
      return json;
    },
    { idempotent: true },
  );
}

/**
 * The real fee and tax per order reference, read off Razorpay.
 *
 * Only links that actually took money are followed, so a month like October
 * 2026 (every link expired, amount_paid 0) costs one list call and no more.
 * October's Razorpay fees are genuinely 0.00, which is not the same as missing
 * and must not read as missing on the report.
 *
 * @param {{refs: Set<string>, fromMs: number, toMs: number}} args
 * @returns {Promise<Map<string, {feePaise:number, taxPaise:number}>>}
 */
export async function razorpayFees({ refs, fromMs, toMs }) {
  const s = await getSecrets();
  if (!s.razorpayKeyId || !s.razorpayKeySecret) {
    throw new Error('pnl gateway: no Razorpay key, its fees cannot be read');
  }
  const auth = `Basic ${Buffer.from(`${s.razorpayKeyId}:${s.razorpayKeySecret}`).toString('base64')}`;
  // A day either side: a conversion link is created with the order but can be
  // paid late, and the reference_id match is exact so a wider window is free.
  const from = Math.floor(fromMs / 1000) - DAY_S;
  const to = Math.ceil(toMs / 1000) + DAY_S;

  /** @type {Map<string, {feePaise:number, taxPaise:number}>} */
  const out = new Map();
  for (let skip = 0; skip < 1000; skip += 100) {
    const page = await rzpGet(
      `/payment_links?count=100&skip=${skip}&from=${from}&to=${to}`,
      auth,
      'pnl.razorpay.links',
    );
    const links = page.payment_links || [];
    for (const l of links) {
      const ref = String(l.reference_id || '');
      if (!refs.has(ref) || !(Number(l.amount_paid) > 0)) continue;
      // The list row carries no payment ids, so the paid links (and only those)
      // are fetched one by one for theirs.
      const full = await rzpGet(`/payment_links/${encodeURIComponent(l.id)}`, auth, 'pnl.razorpay.link');
      for (const p of full.payments || []) {
        if (!p.payment_id || !/^captured$/i.test(String(p.status || 'captured'))) continue;
        const pay = await rzpGet(`/payments/${encodeURIComponent(p.payment_id)}`, auth, 'pnl.razorpay.payment');
        const fee = Number(pay.fee) || 0;
        const tax = Number(pay.tax) || 0;
        const prev = out.get(ref) || { feePaise: 0, taxPaise: 0 };
        // `fee` INCLUDES `tax`, so the ex-GST fee is the difference.
        out.set(ref, { feePaise: prev.feePaise + (fee - tax), taxPaise: prev.taxPaise + tax });
      }
    }
    if (links.length < 100) break;
  }
  return out;
}

/**
 * One GatewayFee per prepaid or partial order.
 *
 * @param {{orders: import('../../domain/pnl/types.mjs').NormOrder[], config?: any,
 *          reader?: typeof razorpayFees}} args
 * @returns {Promise<import('../../domain/pnl/types.mjs').GatewayFee[]>}
 */
export async function fetchGatewayFees({ orders, config = {}, reader = razorpayFees }) {
  const feePct = config.gatewayFeePct ?? RULES.pnl.gatewayFeePct;
  const gstPct = config.gatewayGstPct ?? RULES.pnl.gatewayGstPct;
  const paying = (orders || []).filter((o) => o.paymentType !== 'cod');
  if (!paying.length) return [];

  const refs = new Set(paying.map((o) => linkRefFor(o.name)));
  const times = paying.map((o) => new Date(o.createdAt).getTime()).filter(Number.isFinite);
  /** @type {Map<string, {feePaise:number, taxPaise:number}>} */
  let real = new Map();
  try {
    real = await reader({ refs, fromMs: Math.min(...times), toMs: Math.max(...times) });
  } catch (e) {
    /*
     * Razorpay being unreachable must not lose the whole gateway column: every
     * order it would have covered falls back to the configured rate, which is
     * what the Cashfree orders use anyway. The throw is logged so the Data
     * Checks sheet can say the real figures were not read.
     */
    log.warn('pnl gateway: Razorpay unreadable, every row falls back to the configured rate', {
      err: /** @type {any} */ (e).message,
    });
  }

  return paying.map((o) => {
    const hit = real.get(linkRefFor(o.name));
    if (hit) {
      return {
        orderName: o.name,
        source: /** @type {'razorpay'} */ ('razorpay'),
        feePaise: hit.feePaise,
        gstPaise: hit.taxPaise,
        assumed: false,
      };
    }
    /*
     * The rate applies to WHAT WENT THROUGH THE GATEWAY, not to the order
     * total. A COD King partial order is 5% paid online and the rest collected
     * as cash, so charging the rate on the full total would overstate its
     * gateway fee twentyfold. prepaidReceivedPaise is that amount, and for a
     * fully prepaid order it IS the total.
     */
    const base = o.prepaidReceivedPaise || o.currentTotalPaise;
    const feePaise = Math.round((base * feePct) / 100);
    return {
      orderName: o.name,
      source: /** @type {'config'} */ ('config'),
      feePaise,
      gstPaise: Math.round((feePaise * gstPct) / 100),
      assumed: true,
    };
  });
}
