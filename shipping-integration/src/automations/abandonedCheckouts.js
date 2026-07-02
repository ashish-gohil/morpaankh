'use strict';

/**
 * Abandoned checkout recovery.
 *
 * Ran on a schedule (every 15 min) by the node-workflow platform. Finds
 * checkouts abandoned at least ACR_MIN_AGE_MINUTES ago (default 60) and at
 * most ACR_MAX_AGE_HOURS old (default 48), that we haven't contacted yet,
 * and sends one WhatsApp template with the recovery link.
 *
 * Channel split (deliberate): Shopify's native abandoned-checkout email owns
 * the email channel. This automation owns WhatsApp. Brevo email here is a
 * fallback that stays OFF unless ACR_EMAIL_ENABLED=true — never run both
 * email sources at once.
 *
 * Consent: abandoned-cart WhatsApp is a marketing-category template under
 * Meta rules, so by default we only message customers whose phone number is
 * SUBSCRIBED to marketing (REQUIRE_MARKETING_CONSENT=false relaxes this —
 * understand the quality-rating and compliance risk before doing that).
 *
 * Dedup: processed checkout ids live in a shop metafield ledger
 * (internal.acr_processed_ids) because abandoned checkouts can't carry tags.
 */
const config = require('../config');
const shopify = require('../shopify');
const whatsapp = require('../clients/whatsapp');
const brevo = require('../clients/brevo');
const {
  minutesSince,
  readLedger,
  writeLedger,
} = require('./helpers');

const LEDGER_KEY = 'acr_processed_ids';

/**
 * Pure eligibility filter — exported for tests.
 * @returns {{eligible: object[], skipped: {id: string, reason: string}[]}}
 */
function selectEligible(checkouts, ledgerIds, opts, now = new Date()) {
  const { minAgeMinutes, maxAgeHours, requireConsent } = opts;
  const ledger = new Set(ledgerIds);
  const eligible = [];
  const skipped = [];

  for (const c of checkouts) {
    const reason = (() => {
      if (ledger.has(c.id)) return 'already contacted';
      const idleMinutes = minutesSince(c.updatedAt || c.createdAt, now);
      if (idleMinutes < minAgeMinutes) return 'too fresh';
      if (minutesSince(c.createdAt, now) > maxAgeHours * 60) return 'too old';
      if (!c.abandonedCheckoutUrl) return 'no recovery url';
      if (!c.customer) return 'no customer';
      const phone =
        (c.customer.defaultPhoneNumber && c.customer.defaultPhoneNumber.phoneNumber) ||
        (c.customer.defaultAddress && c.customer.defaultAddress.phone);
      if (!phone) return 'no phone';
      if (
        requireConsent &&
        (!c.customer.defaultPhoneNumber ||
          c.customer.defaultPhoneNumber.marketingState !== 'SUBSCRIBED')
      ) {
        return 'no marketing consent';
      }
      return null;
    })();

    if (reason) skipped.push({ id: c.id, reason });
    else eligible.push(c);
  }
  return { eligible, skipped };
}

async function fetchRecentCheckouts(first = 50) {
  const data = await shopify.graphql(
    `query AbandonedCheckouts($first: Int!) {
       abandonedCheckouts(first: $first, sortKey: CREATED_AT, reverse: true) {
         nodes {
           id
           abandonedCheckoutUrl
           createdAt
           updatedAt
           totalPriceSet { shopMoney { amount currencyCode } }
           customer {
             id
             firstName
             defaultEmailAddress { emailAddress marketingState }
             defaultPhoneNumber { phoneNumber marketingState }
             defaultAddress { phone }
           }
           lineItems(first: 5) { nodes { title quantity } }
         }
       }
     }`,
    { first }
  );
  return data.abandonedCheckouts.nodes;
}

async function run({ dryRun = false } = {}) {
  const opts = {
    minAgeMinutes: config.automation.acrMinAgeMinutes,
    maxAgeHours: config.automation.acrMaxAgeHours,
    requireConsent: config.automation.requireMarketingConsent,
  };

  const [checkouts, ledger] = await Promise.all([
    fetchRecentCheckouts(),
    readLedger(LEDGER_KEY),
  ]);
  const { eligible, skipped } = selectEligible(checkouts, ledger.ids, opts);

  const results = [];
  const processedIds = [];

  for (const c of eligible) {
    const firstName = (c.customer.firstName || '').trim() || 'there';
    const itemTitle =
      c.lineItems.nodes.length > 0 ? c.lineItems.nodes[0].title : 'your picks';
    const phone =
      (c.customer.defaultPhoneNumber && c.customer.defaultPhoneNumber.phoneNumber) ||
      c.customer.defaultAddress.phone;
    // Dynamic URL button: template base is {{storefront}}/, param is the path
    const urlPath = c.abandonedCheckoutUrl.replace(/^https?:\/\/[^/]+\//, '');

    const entry = { checkoutId: c.id, phone };
    try {
      entry.whatsapp = await whatsapp.sendTemplate({
        to: phone,
        template: config.whatsapp.templates.abandonedCheckout,
        bodyParams: [firstName, itemTitle],
        urlButtonParam: urlPath,
        dryRun,
      });

      if (config.automation.acrEmailEnabled && c.customer.defaultEmailAddress) {
        const email = c.customer.defaultEmailAddress;
        const consentOk =
          !config.automation.requireMarketingConsent ||
          email.marketingState === 'SUBSCRIBED';
        if (consentOk && email.emailAddress) {
          entry.email = await brevo.sendEmail({
            to: email.emailAddress,
            toName: firstName,
            subject: 'Your MorPaankh bag is waiting',
            html:
              `<p>Hi ${firstName},</p>` +
              `<p>You left ${itemTitle} in your bag. It is still reserved for you.</p>` +
              `<p><a href="${c.abandonedCheckoutUrl}">Complete your order</a></p>` +
              `<p>Free delivery on prepaid orders. 7-day returns.</p>` +
              `<p>MorPaankh</p>`,
            dryRun,
          });
        }
      }

      if (!dryRun) processedIds.push(c.id);
      results.push(entry);
    } catch (e) {
      entry.error = e.message;
      results.push(entry);
    }
  }

  if (processedIds.length) {
    await writeLedger(ledger.shopId, LEDGER_KEY, ledger.ids.concat(processedIds));
  }

  return {
    scanned: checkouts.length,
    eligible: eligible.length,
    sent: results.filter((r) => r.whatsapp && r.whatsapp.sent).length,
    errors: results.filter((r) => r.error).length,
    skippedReasons: skipped.reduce((acc, s) => {
      acc[s.reason] = (acc[s.reason] || 0) + 1;
      return acc;
    }, {}),
    results,
  };
}

module.exports = { run, selectEligible };
