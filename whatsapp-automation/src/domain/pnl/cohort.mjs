/*
 * cohort.mjs — which month an order belongs to, and whether it counts at all.
 *
 * Pure. No clock: the month is an argument, never "now".
 */
import { istParts, fromISTWall } from '../../lib/time.mjs';

/** @typedef {import('./types.mjs').NormOrder} NormOrder */
/** @typedef {import('./types.mjs').PnlConfig} PnlConfig */

/** ISO with no millis, so the window reads the way Shopify writes timestamps. */
const iso = (d) => d.toISOString().replace('.000Z', 'Z');

/**
 * An IST calendar month as a half-open UTC window.
 *
 *   monthWindow('2026-10') -> 2026-09-30T18:30:00Z .. 2026-10-31T18:30:00Z
 *
 * The end is EXCLUSIVE. This exists because Shopify's `created_at:` search
 * filter ignores the time of day: asking it for `>=2026-09-30T18:30:00Z` still
 * returns #1168 (08:04Z) and #1169 (17:37Z), both September in IST. So the
 * fetch over-fetches a day either side and the real cohort is cut here.
 *
 * @param {string} month 'YYYY-MM'
 * @returns {{monthStartUtc:string, monthEndUtc:string}}
 */
export function monthWindow(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month));
  if (!m) throw new Error(`monthWindow: expected YYYY-MM, got ${month}`);
  const y = Number(m[1]);
  const mon = Number(m[2]) - 1;
  if (mon < 0 || mon > 11) throw new Error(`monthWindow: no such month: ${month}`);
  // Date.UTC rolls month 12 into January of y+1, so December needs no case.
  return {
    monthStartUtc: iso(fromISTWall(y, mon, 1, 0, 0)),
    monthEndUtc: iso(fromISTWall(y, mon + 1, 1, 0, 0)),
  };
}

/** The IST calendar date of a UTC timestamp, 'YYYY-MM-DD'. The daily series key. */
export function istDateKey(isoUtc) {
  const p = istParts(new Date(isoUtc));
  return `${p.y}-${String(p.mon + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Every IST date in the window, in order. Empty days still get a row. */
export function istDatesIn(monthStartUtc, monthEndUtc) {
  const out = [];
  const end = Date.parse(monthEndUtc);
  for (let t = Date.parse(monthStartUtc); t < end; t += 24 * 60 * 60 * 1000) {
    out.push(istDateKey(new Date(t).toISOString()));
  }
  return out;
}

/**
 * A Delhivery timestamp as a UTC instant.
 *
 * Delhivery's dates carry NO offset and are IST ('2026-11-01T10:30:00.000').
 * `Date.parse` reads an offsetless stamp as LOCAL time, so on a Lambda running
 * UTC every Delhivery date would land 5.5 hours early, which is exactly enough
 * to move a late-evening delivery into the previous day and a 31 Oct 23:00 IST
 * scan back inside a month that had closed. Shopify's own timestamps already
 * carry Z and are passed through untouched.
 * @param {string|null} stamp
 * @returns {string|null} ISO UTC, or null
 */
export function istWallToUtc(stamp) {
  if (!stamp) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp);
  const t = Date.parse(hasZone ? stamp : `${stamp}+05:30`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** True when the order was really created inside the IST month. */
export function inCohort(order, monthStartUtc, monthEndUtc) {
  const t = Date.parse(order.createdAt);
  return t >= Date.parse(monthStartUtc) && t < Date.parse(monthEndUtc);
}

const words = (name) => String(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/*
 * Surnames worth a second look, and NOTHING MORE THAN A LOOK.
 *
 * Deliberately not configurable, and deliberately not an exclusion: these only
 * raise a flag on Data Checks. The previous version of this list was wired to
 * `excluded` and dropped every customer who shared the founder's surname.
 */
const FAMILY_SURNAMES = ['gohil', 'gohel'];
const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Section 6: does this order belong in the P&L at all.
 *
 * The excluded orders are real rows in Shopify and would otherwise read as
 * sales, so they get their own sheet rather than being deleted. Ambiguity is
 * always INCLUDED and flagged: an order wrongly dropped is invisible, an order
 * wrongly kept is one line on a sheet someone reads.
 *
 * @param {NormOrder} order
 * @param {PnlConfig} config
 * @returns {{included:boolean, reason:string|null, flags:string[]}}
 */
export function classifyInclusion(order, config) {
  const flags = [];
  /*
   * Draft orders and Claude-connector orders with a real customer are real
   * WhatsApp and over-the-counter sales (#1188, #1233), so they stay in. They
   * are flagged because their payment and shipping details were typed by hand.
   */
  if (order.channel === 'Manual') flags.push('manual_channel_review');

  const name = (order.customerName || '').trim();
  if (!name) {
    const app = order.appName || order.sourceName;
    return {
      included: false,
      reason: app ? `no customer (app order: ${app})` : 'no customer',
      flags,
    };
  }

  if ((config.excludeCustomers || []).some((c) => eq(c, name))) {
    return { included: false, reason: `excluded customer: ${name}`, flags };
  }

  /*
   * IDENTITY, NOT SURNAME.
   *
   * This used to carry excludeSurnames: ['Gohil', 'Gohel'] and drop every
   * order whose display name contained one as a word. Gohil is one of the most
   * common surnames in Surat, which is this store's own city, so the rule
   * silently deleted real customers' revenue AND their costs from every total
   * on the report, and the only trace was a line on the excluded sheet.
   *
   * A paying customer who happens to share the founder's surname is a
   * customer. So the surname now FLAGS and keeps, with the fix named on the
   * flag, and the exclusions that actually remove money are an explicit id or
   * an explicit number.
   */
  const idTail = (v) => String(v || '').split('/').pop();
  const orderId = idTail(order.customerId);
  if (orderId && (config.excludeCustomerIds || []).some((c) => idTail(c) === orderId)) {
    return { included: false, reason: `excluded customer id: ${orderId}`, flags };
  }

  const nameWords = words(name);
  for (const surname of FAMILY_SURNAMES) {
    if (nameWords.includes(surname) || name.toLowerCase().includes(surname)) {
      flags.push(`possible family order (${surname}): tag it \`family\` in Shopify to exclude it`);
    }
  }

  for (const tag of order.tags || []) {
    if ((config.excludeTags || []).some((t) => eq(t, tag))) {
      return { included: false, reason: `excluded tag: ${tag}`, flags };
    }
  }

  return { included: true, reason: null, flags };
}
