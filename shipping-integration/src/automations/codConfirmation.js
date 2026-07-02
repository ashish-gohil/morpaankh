'use strict';

/**
 * COD order confirmation.
 *
 * Ran on a schedule (every 15 min). Finds recent unfulfilled Cash on Delivery
 * orders we haven't messaged, and sends a WhatsApp order-confirmation
 * template. The point is RTO reduction: a customer who actively confirms a
 * COD order is far less likely to refuse it at the door.
 *
 * This is a utility-category template (an update about an order the customer
 * placed), so no marketing consent gate applies.
 *
 * Dedup: order tag `mp-cod-confirm-sent` — visible in admin, queryable.
 */
const config = require('../config');
const shopify = require('../shopify');
const whatsapp = require('../clients/whatsapp');
const { minutesSince, searchOrders, orderPhone, formatAmount } = require('./helpers');

const SENT_TAG = 'mp-cod-confirm-sent';

/** Pure: does this order look like COD? Exported for tests. */
function isCodOrder(order) {
  return (order.paymentGatewayNames || []).some((g) => /cash|cod/i.test(g));
}

/** Pure eligibility — exported for tests. */
function selectEligible(orders, minAgeMinutes, now = new Date()) {
  return orders.filter(
    (o) =>
      isCodOrder(o) &&
      !(o.tags || []).includes(SENT_TAG) &&
      o.displayFulfillmentStatus === 'UNFULFILLED' &&
      minutesSince(o.createdAt, now) >= minAgeMinutes &&
      orderPhone(o)
  );
}

async function run({ dryRun = false } = {}) {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  // financial_status pending = typical COD; gateway check is the real filter
  const orders = await searchOrders(
    `financial_status:pending fulfillment_status:unfulfilled created_at:>='${since}' -tag:'${SENT_TAG}'`
  );
  const eligible = selectEligible(orders, config.automation.codMinAgeMinutes);

  const results = [];
  for (const o of eligible) {
    const entry = { order: o.name };
    try {
      entry.whatsapp = await whatsapp.sendTemplate({
        to: orderPhone(o),
        template: config.whatsapp.templates.codConfirm,
        bodyParams: [
          (o.customer && o.customer.firstName) || 'there',
          o.name,
          formatAmount(o.totalPriceSet),
        ],
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

module.exports = { run, isCodOrder, selectEligible, SENT_TAG };
