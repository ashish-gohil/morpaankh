# whatsapp-automation

Customer WhatsApp order automation for the Morpaankh Shopify store, through Meta's
WhatsApp Cloud API directly (no third-party provider). It confirms COD orders and
converts them to prepaid, asks for a review after delivery and rewards it with a
code, rescues failed deliveries and captures RTO reasons, and keeps the owner
informed. See `PLAN.md` for the full design and `DECISIONS.md` for every choice.

**Safe by default:** every flow is OFF and `DRY_RUN=true` until you flip it.
Nothing messages a customer or edits an order until you deliberately enable it.

## Flows

- **A** COD confirm / cancel / COD-to-prepaid (Rs 100 off + COD fee removed).
- **B** Delivered -> in-WhatsApp review -> thank-you code (5% off next order over Rs 1,500); reviews shown on the product page.
- **C** Failed-delivery (NDR) rescue + RTO reason capture.
- **D** Owner alerts, daily digest, nightly reconciliation, admin scripts.

## Architecture

Provider webhooks (Shopify, WhatsApp, Razorpay, Delhivery) hit an API Gateway HTTP
API; ingest Lambdas verify the signature, dedupe, and enqueue onto an SQS FIFO
queue (per-order ordering); one worker Lambda does all the side effects, re-reading
the order from Shopify before acting. EventBridge Scheduler runs one-time timers
(reminders, review asks) and the recurring poll/reconcile/digest jobs. State lives
in one DynamoDB table; secrets in Secrets Manager. Region ap-south-1, Node 24.x.
Conventions mirror the repo's `meta-outcomes` service (ESM `.mjs`, Vitest, hand-
rolled config, DRY_RUN discipline).

## Layout

```
src/lib        pure primitives (phone, money, IST time, signatures, ids, discount code)
src/domain     pure business logic (classify, amounts, eligibility, courier-status, review, ndr, digest)
src/clients    WhatsApp / Shopify / Razorpay / Delhivery, each with a fake (fakes/)
src/store      DynamoDB single-table access, order state, phone profile, maps, dedupe
src/ingest     API Gateway handlers (verify -> dedupe -> 200 -> enqueue)
src/worker     SQS FIFO consumer + flowA/B/C orchestrators + routing
src/timers     EventBridge scheduler + poll / reconcile / digest
messages       ALL customer copy (templates, session, labels, rules, review flow)
scripts        templates-sync, flows-sync, reviews-setup, webhooks-sync, admin tools
iac            AWS CDK v2 (JavaScript)
theme          Flow B on-site reviews snippet + wiring guide (applied at go-live)
```

## Develop

```
cd whatsapp-automation
npm install
npm test            # vitest (180+ tests, all with fakes; this is the DRY_RUN fixture replay)
npm run typecheck   # tsc --checkJs over the pure logic
npm run dryrun:render   # preview every customer message with sample data
```

The test suite is the fixture replay the spec asks for: each flow is exercised end
to end against in-memory fakes that assert the exact messages and API calls.

## Deploy (does not send anything on its own)

```
cd iac && npm install
npx cdk deploy -c region=ap-south-1 -c alertEmail=you@example.com \
  -c shopDomain=yaaijv-6p.myshopify.com -c publicBaseUrl=https://<api-domain>
```

Then, once (see Manual steps): fill the Secrets Manager secret, run
`scripts/shopify-webhooks-sync.mjs --live`, `scripts/reviews-setup.mjs --live`,
`scripts/flows-sync.mjs --live`, `scripts/templates-sync.mjs --live`.

## Going live safely (do these in order)

1. Deploy with `DRY_RUN=true` and all flows OFF. Watch logs; nothing sends.
2. Fill secrets; sync webhooks, templates, the review flow, the review metaobject.
3. `send-test` to your own allowlisted number to prove the pipeline.
4. Set `SEND_ALLOWLIST` + `ORDER_ALLOWLIST` to your own number/orders, set
   `DRY_RUN=false`, enable ONE flow, place a test order, verify end to end.
5. **Flow A conversion only:** run the test-order accounting verification, choose
   the working order-edit + payment-record option, author the sequence in
   `shopify.convertToPrepaid`, set `CONVERSION_VERIFIED=true` (DECISIONS C3).
6. Clear the allowlists to go fully live, one flow at a time, each with its
   `startAt` set to now (only newer orders are ever processed).

Flip flags without a redeploy with `scripts/pause-flow.mjs`.

## Manual steps for you (accounts + approvals)

- **Meta:** business verification; number route (Tech Provider + App Review for
  coexistence, or a dedicated number); display name; INR billing in WhatsApp
  Manager; a System User permanent token with `whatsapp_business_messaging` +
  `whatsapp_business_management`; subscribe the app to messages, template status,
  template category, and (coexistence) message echoes; approve the templates.
- **Razorpay:** account + webhook (payment_link paid/expired/cancelled) + secret.
- **Delhivery:** API credentials (Express static token assumed) + request the
  status push webhook (they quote ~5-6 working days; the poller covers the gap).
- **Shopify:** app scopes (orders, order edits, fulfillments, discounts,
  customers, products, metaobjects + definitions) + protected customer data for
  names.
- **COD King:** turn OFF its post-order WhatsApp/SMS (keep OTP + abandoned cart)
  so customers are not messaged twice; add a rule hiding COD for the `cod-block`
  customer segment; optionally add the WhatsApp order-updates notice to checkout.
- **Owner phones:** each number in `OWNER_ALERT_PHONES` must message the business
  number once so alerts can reach it.
- Put every secret in the one Secrets Manager JSON; never in git.

## Do not

Touch the `partial-payment` product or any checkout file. Message anyone but the
COD King OTP-verified number. Send an offer or code in a UTILITY template. Run the
live prepaid conversion before the test-order verification. Leave the old
`shipping-integration` / `node-workflow` automations or COD King's own post-order
messaging on at the same time as this service.
