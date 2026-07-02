'use strict';

/**
 * Post-delivery review request.
 *
 * Ran daily. Finds orders the Shiprocket tracking handler marked delivered
 * (tags `mp-delivered` + `mp-delivered-on-YYYY-MM-DD`) at least
 * REVIEW_DELAY_DAYS ago (default 3) and at most REVIEW_MAX_AGE_DAYS ago
 * (default 30, so a backlog never spams ancient orders), and asks for a
 * review once.
 *
 * Review invitations are marketing-category under Meta rules, so the
 * marketing consent gate applies by default (same flag as abandoned
 * checkouts).
 *
 * Dedup: order tag `mp-review-request-sent`.
 */
const config = require('../config');
const shopify = require('../shopify');
const whatsapp = require('../clients/whatsapp');
const { searchOrders, orderPhone } = require('./helpers');

const SENT_TAG = 'mp-review-request-sent';
const DELIVERED_TAG = 'mp-delivered';
const DELIVERED_ON_PREFIX = 'mp-delivered-on-';

/** Pure: extract the delivery date stamp from tags. Exported for tests. */
function deliveredOnFromTags(tags) {
  const tag = (tags || []).find((t) => t.startsWith(DELIVERED_ON_PREFIX));
  if (!tag) return null;
  const stamp = tag.slice(DELIVERED_ON_PREFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : null;
}

/** Pure: is the order inside the [delayDays, maxAgeDays] review window? */
function isDueForReview(deliveredOn, delayDays, maxAgeDays, now = new Date()) {
  if (!deliveredOn) return false;
  const ageDays = (now.getTime() - new Date(`${deliveredOn}T00:00:00+05:30`).getTime()) / 86400000;
  return ageDays >= delayDays && ageDays <= maxAgeDays;
}

async function run({ dryRun = false } = {}) {
  const orders = await searchOrders(`tag:'${DELIVERED_TAG}' -tag:'${SENT_TAG}'`);
  const { reviewDelayDays, reviewMaxAgeDays } = config.automation;

  const eligible = orders.filter((o) => {
    if (!orderPhone(o)) return false;
    if (
      config.automation.requireMarketingConsent &&
      (!o.customer ||
        !o.customer.defaultPhoneNumber ||
        o.customer.defaultPhoneNumber.marketingState !== 'SUBSCRIBED')
    ) {
      return false;
    }
    return isDueForReview(deliveredOnFromTags(o.tags), reviewDelayDays, reviewMaxAgeDays);
  });

  const results = [];
  for (const o of eligible) {
    const entry = { order: o.name };
    try {
      entry.whatsapp = await whatsapp.sendTemplate({
        to: orderPhone(o),
        template: config.whatsapp.templates.review,
        bodyParams: [(o.customer && o.customer.firstName) || 'there', o.name],
        dryRun,
      });
      if (!dryRun && entry.whatsapp.sent) {
        await shopify.addTags(o.id, [SENT_TAG]);
        entry.tagged = true;
      }
      results.push(entry);
    } catch (e) {
      entry.error = e.message;
      results.push(entry);
    }
  }

  return {
    scanned: orders.length,
    eligible: eligible.length,
    sent: results.filter((r) => r.whatsapp && r.whatsapp.sent).length,
    errors: results.filter((r) => r.error).length,
    results,
  };
}

module.exports = {
  run,
  deliveredOnFromTags,
  isDueForReview,
  SENT_TAG,
  DELIVERED_TAG,
  DELIVERED_ON_PREFIX,
};
