/*
 * pnl/sources/meta.mjs — the month's ad spend, one row per campaign per day.
 *
 * Campaign level and time_increment=1 because the report splits spend into
 * SALES and BOOST and shows a daily curve, and because an account total cannot
 * be split after the fact. Verified against the live account on 2026-11-03:
 * 86 rows over 31 days for October, total 39,161.21 = sales 34,879.40 + boost
 * 4,281.81, which matches the owner's own snapshot exactly.
 *
 * THE ACCOUNT TIMEZONE IS Asia/Kolkata, so `since`/`until` are plain IST dates
 * and no boundary correction is needed here. That is a property of the account
 * (verified), not an assumption: an account in another timezone would need the
 * same one-day-wider-then-filter treatment the Shopify adapter uses.
 *
 * CLASSIFICATION IS BY NAME FIRST, THEN OBJECTIVE. One of the two October
 * boosts carries objective LINK_CLICKS, which no engagement/awareness list
 * would catch, and both carry the "Instagram post:" prefix Meta puts on a
 * boosted post. Reading the objective first would book a boost as sales
 * spend and overstate the ad cost of the sales channel.
 *
 * An unclassified campaign is 'other' and the report FLAGS it rather than
 * folding it into either bucket. Zero campaigns were unclassified in October;
 * the next new campaign type is the one that would be.
 *
 * No token and no ad account are a SOURCE FAILURE, not zero spend. A month
 * showing 0.00 of ad spend because a secret was missing would show a profit
 * the business did not make, so this throws and the engine records it.
 */
import { getSecrets } from '../../secrets.mjs';
import { deadline, TIMEOUT_MS } from '../../lib/timeout.mjs';
import { log } from '../../log.mjs';
import { withRetry } from '../../lib/resilience.mjs';
import { toPaise } from '../../lib/money.mjs';
import { RULES } from '../../../messages/rules.mjs';

const GRAPH = () => process.env.META_GRAPH_VERSION || 'v21.0';
const FIELDS = 'date_start,campaign_id,campaign_name,objective,spend,impressions,clicks';

const BOOST_NAME = /^Instagram post:/;
const SALES_OBJECTIVE = /OUTCOME_SALES|CONVERSIONS/;
const BOOST_OBJECTIVE = /ENGAGEMENT|AWARENESS|VIDEO_VIEWS|POST_ENGAGEMENT|LINK_CLICKS/;

/**
 * 'sales' | 'boost' | 'other' for one insights row.
 *
 * @param {{campaign_id?:string, campaign_name?:string, objective?:string}} row
 * @param {Record<string,'sales'|'boost'|'other'>} [overrides] campaignTypeOverrides
 */
export function classifyCampaign(row, overrides = {}) {
  const id = String(row.campaign_id || '');
  if (overrides[id]) return overrides[id];
  const name = String(row.campaign_name || '');
  if (BOOST_NAME.test(name)) return 'boost';
  const objective = String(row.objective || '');
  if (SALES_OBJECTIVE.test(objective)) return 'sales';
  if (BOOST_OBJECTIVE.test(objective)) return 'boost';
  return 'other';
}

/** '2026-10' -> { since: '2026-10-01', until: '2026-10-31' }, in account time. */
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) throw new Error(`pnl meta: month must be YYYY-MM, got ${month}`);
  const y = Number(m[1]);
  const mon = Number(m[2]);
  // Day 0 of the next month is the last day of this one, leap years included.
  const last = new Date(Date.UTC(y, mon, 0)).getUTCDate();
  return { since: `${m[1]}-${m[2]}-01`, until: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

/** `act_1234` from either spelling, or null. */
function accountId(explicit) {
  const raw = String(explicit || process.env.META_AD_ACCOUNT_ID || '').trim();
  const digits = raw.replace(/^act_/, '');
  return /^\d+$/.test(digits) ? `act_${digits}` : null;
}

async function getJson(url, label) {
  return withRetry(
    label,
    async () => {
      const res = await fetch(url, deadline(TIMEOUT_MS.metaGraph));
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${label} non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      if (!res.ok || json.error) {
        const e = /** @type {any} */ (
          new Error(`${label} failed (HTTP ${res.status}): ${json.error?.message || text.slice(0, 200)}`)
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
 * Every campaign-day of spend in the month.
 *
 * @param {{month: string, config?: any, adAccountId?: string, token?: string}} args
 * @returns {Promise<import('../../domain/pnl/types.mjs').MetaDay[]>}
 */
export async function fetchMetaSpend({ month, config = {}, adAccountId, token }) {
  const act = accountId(adAccountId);
  if (!act) throw new Error('pnl meta: no META_AD_ACCOUNT_ID, ad spend cannot be read');
  /*
   * A SECRET OF ITS OWN. The meta-outcomes System User token already grants
   * ads_management, which covers this read (ads_read is not granted and is not
   * needed, verified 2026-11-03), but that token belongs to another service and
   * nothing in this one has ever held a Meta credential. One named key means
   * rotating it cannot break a customer-facing flow.
   */
  const secret = token || (await getSecrets()).metaAdsToken;
  if (!secret) throw new Error('pnl meta: no metaAdsToken secret, ad spend cannot be read');

  const { since, until } = monthRange(month);
  const overrides = config.campaignTypeOverrides || RULES.pnl.campaignTypeOverrides || {};
  const qs = new URLSearchParams({
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: FIELDS,
    limit: '500',
    access_token: secret,
  });

  let url = `https://graph.facebook.com/${GRAPH()}/${act}/insights?${qs}`;
  /** @type {import('../../domain/pnl/types.mjs').MetaDay[]} */
  const out = [];
  for (let page = 0; page < 50; page += 1) {
    const json = await getJson(url, 'pnl.meta.insights');
    for (const r of json.data || []) {
      out.push({
        date: String(r.date_start || ''),
        campaignId: String(r.campaign_id || ''),
        campaignName: String(r.campaign_name || ''),
        objective: String(r.objective || ''),
        type: classifyCampaign(r, overrides),
        spendPaise: toPaise(r.spend),
        impressions: Number(r.impressions) || 0,
        clicks: Number(r.clicks) || 0,
      });
    }
    // paging.next carries the cursor AND the access token, so it is followed
    // verbatim rather than rebuilt.
    if (!json.paging?.next) break;
    url = json.paging.next;
    if (page === 49) throw new Error('pnl meta: insights paging did not end, the month is not complete');
  }

  const unclassified = [...new Set(out.filter((r) => r.type === 'other').map((r) => r.campaignName))];
  log.info('pnl meta: spend read', {
    rows: out.length,
    days: new Set(out.map((r) => r.date)).size,
    spendPaise: out.reduce((n, r) => n + r.spendPaise, 0),
    ...(unclassified.length ? { unclassified: unclassified.length } : {}),
  });
  if (unclassified.length) {
    log.warn('pnl meta: campaigns neither sales nor boost, set campaignTypeOverrides', {
      campaigns: unclassified.slice(0, 5),
    });
  }
  return out;
}
