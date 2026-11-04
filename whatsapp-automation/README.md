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
- **R** Abandoned cart recovery: one private, expiring, single-use code 20 minutes
  after a checkout is abandoned, one reminder two hours before it closes, and
  nothing else. Replaces COD King's abandoned-cart messages.

- **W** New-customer welcome offer: one private, single-use Rs 200 code valid 24
  hours for somebody who joined yesterday and has never ordered, plus a gift in
  the parcel. WhatsApp first, email when WhatsApp cannot reach them. Once per
  person, ever.

### Flow R in one paragraph

A five-minute sweep (`reconcile` with `{mode:'carts'}`) lists open abandoned
checkouts created in the last 12 hours, keeps the newest per verified phone, and
enqueues them. `onFirst` re-reads the checkout, prices the bag against the LIVE
public codes, and sends only if it can beat what that bag could already get by
beatPublicByInr: a private code worth less than the one printed on the cart page
is worse than silence, so `public-offer-better` is a normal outcome, not a bug.
One sequence per phone per 30 days, enforced by a conditional-put lease that is
taken only AFTER Meta accepts and released if the message then fails to deliver.
The "Complete my order" button is `/r/{token}`, which looks the token up and 302s
to the customer's own saved checkout with the code applied. Everything stops the
moment they order, use the code, reply, tap Talk to us, or send STOP.

### Flow W in one paragraph

A daily rule at 11:00 IST (`reconcile` with `{mode:'subscribers'}`) asks Shopify
for every customer created YESTERDAY as an IST calendar day with
`orders_count:0`, and enqueues them; it refuses the whole run rather than
message a backlog if there are more than `maxPerRun` of them. `onFirst` re-reads
each customer with `customer(id:)` (the search index lags a create by seconds,
the id lookup does not), checks that they have no order and no cart anywhere,
and sends ONE code: Rs 200 off an order above Rs 1,500.01, closing in 24 hours.
The guard is Flow R's: Rs 200 is exactly WELCOME150 beaten by Rs 50 and exactly
the Rs 2,000 tier's ceiling, so `public-offer-better` is a normal outcome rather
than a bug. Once per person EVER, enforced by two no-TTL conditional-put locks,
one on the number and one on the sha256 of the email, both written only AFTER
the provider accepts and both given back if the message then fails to deliver.
The "Shop best sellers" button is `/w/{token}`, which 302s to
`/discount/<CODE>?redirect=/collections/best-sellers`. Anyone with a cart is left
to Flow R, and anyone holding a live Flow W code makes Flow R stand down, so one
person never holds two private codes.

THE ONE THING THAT IS NEW: Flow W messages `Customer.defaultPhoneNumber`, not
the COD King OTP-verified number, because a candidate has never reached
checkout. That is an explicit owner decision (2026-10-24) recorded at the top of
`src/lib/phone.mjs`, it validates the number through the same
`normalizeVerifiedPhone`, and `FLOW_W_ALLOWLIST` shadow mode is the mitigation.

## Monthly profit and loss (`/pnl`)

One month's P&L as an .xlsx workbook, from live sources only, to the owner on
WhatsApp and by email. Automatic on the 7th at 09:00 IST for the month before;
on demand with `/pnl`, `/pnl 2026-10`, `/pnl oct`, `/pnl mtd`, or
`npm run pnl -- --month 2026-10 --no-send`.

Thirteen sheets: Summary (the P&L statement, six KPI tiles, the order funnel,
unit economics, data-quality flags), Daily, Delivered, RTO, Not Delivered,
Excluded, Replacements, By Product, Meta Ads, Courier Ledger, Last Month Update,
Data Checks, Assumptions. Every total is a live Excel formula with its cached
result written, so it opens correct in Excel, Numbers, Sheets and the WhatsApp
preview and still recalculates when you edit an Assumptions input.

**The rule that shapes all of it: a cost we could not read is never a zero.**
A row with a missing cost is flagged, left out of every total, and counted on
Summary with the money it affects. Delhivery decides whether an order was
delivered, not Shopify, because a PAID status alone never proves delivery and
Shopify reports RTO parcels as fulfilled and delivered.

Needs the exceljs layer: run `npm run pnl:layer` before any `cdk synth`, `diff`
or `deploy`. Synth refuses without it. See RUNBOOK.md for the ledger upload,
which is the only way to get exact courier charges, and DECISIONS.md section V
for what was proven against the live APIs.

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
src/domain     pure business logic (classify, amounts, eligibility, courier-status, review, ndr, digest, cart)
src/clients    WhatsApp / Shopify / Razorpay / Delhivery, each with a fake (fakes/)
src/store      DynamoDB single-table access, order state, phone profile, maps, dedupe
src/ingest     API Gateway handlers (verify -> dedupe -> 200 -> enqueue)
src/worker     SQS FIFO consumer + flowA/B/C/R orchestrators + routing
src/timers     EventBridge scheduler + poll / reconcile / digest / cart-sweep
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
- **Amazon SES (Flow W's email fallback only):** verify `morpaankh.in` with DKIM,
  request production access (the sandbox will only send to verified addresses),
  turn ON account-level suppression for BOUNCE and COMPLAINT
  (`aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE
  COMPLAINT`; there is no CloudFormation resource for it, which is why it is a
  manual step), then set `emailFrom` and `emailReplyTo` in `iac/cdk.json`.
  Without `EMAIL_FROM` the email channel is simply unavailable and recorded as
  `email-unavailable`; nothing breaks.
- **Owner phones:** each number in `OWNER_ALERT_PHONES` must message the business
  number once so alerts can reach it.
- Put every secret in the one Secrets Manager JSON; never in git.

## Do not

Touch the `partial-payment` product or any checkout file. Message anyone but the
COD King OTP-verified number. Send an offer or code in a UTILITY template. Run the
live prepaid conversion before the test-order verification. Leave the old
`shipping-integration` / `node-workflow` automations or COD King's own post-order
messaging on at the same time as this service.
