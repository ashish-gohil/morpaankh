# DECISIONS — WhatsApp order automation service

Every item the spec says to "confirm", plus decisions I made where the spec left a choice.
Status legend:
- **CHOSEN** — decided now (default or repo convention); no external check needed.
- **OPEN** — must be verified from docs / live API before the phase that uses it; the
  "current best-known" value is what the spec quoted or what I found in the repo. I will
  replace it with the verified finding (and date) when that phase starts.
- **NEEDS YOU** — a decision only you can make (account choice, business preference).

No secrets, tokens, phone numbers, or account ids appear in this file.

---

## A. Foundational (my defaults; overridable at the approval gate)

| # | Item | Decision | Status |
|---|---|---|---|
| A1 | Language | ESM JavaScript `.mjs` + JSDoc types (matches `meta-outcomes`); `tsc --checkJs` on pure modules | **CONFIRMED 2026-09-20 (you chose 1a)** |
| A2 | Test runner | Vitest (matches `meta-outcomes`) | CHOSEN |
| A3 | IaC | AWS CDK v2 in JavaScript | **CONFIRMED 2026-09-20 (you chose 2a)** |
| A4 | Region / runtime | `ap-south-1`, Node 20.x Lambda | CHOSEN |
| A5 | Service dir | `whatsapp-automation/` | **CONFIRMED 2026-09-20** |
| A6 | Branch | `whatsapp-automation` (branched off `main`; theme work in Phase 6 will rebase/handle the latest theme base then) | **CONFIRMED 2026-09-20** |
| A7 | State store | DynamoDB single-table (per spec, not the `meta-outcomes` S3 blob — this service needs ordering/locks/timers) | CHOSEN |
| A8 | Existing services | `shipping-integration` + `node-workflow` WhatsApp/COD/review flows superseded and left dormant; not modified | CHOSEN |
| A9 | Reuse | Lift `normalizeIndianPhone` + template-send shape + HMAC verify from `shipping-integration/src`; config/redact/dry-run from `meta-outcomes` | CHOSEN |

## B. WhatsApp Cloud API (Meta)

| # | Item | Current best-known | Status |
|---|---|---|---|
| B1 | Graph API version | **CONFIRMED 2026-09-21: v25.0** (read off the account's API-setup curl). Pinned in config default + CDK env | RESOLVED |
| B0 | Meta account facts (non-secret, read from console 2026-09-21) | App "Morpaankh" **App ID 1302051881713968**; real WABA "Morpaankh collection" **WABA ID 3348947278638950**; number **+91 9372710234** (coexistence, Connected) **Phone Number ID 1131284036741289**. (A separate free Test WABA 1403770704586834 with test number +1 555-144-0259 also exists; ignore it.) waWabaId + waPhoneNumberId written to Secrets Manager. STILL NEEDED from owner: WA System User **access token** + **app secret** (into the secret); and the app must be **subscribed to the real WABA** for its webhooks | RECORDED |
| B2 | Named vs positional template params | **CHOSEN 2026-09-20:** registry stores named `{{placeholders}}`; templates-sync converts to positional `{{1}}..{{n}}` at creation and the renderer supplies params in the same declared order (positional is universally supported). Code always uses names. Named-params can be adopted later without touching flow code | RESOLVED |
| B3 | Flow button send shape | `sub_type:"flow"`, parameter `{type:"action", action:{flow_token, flow_action_data}}` | OPEN (Phase 6) |
| B4 | URL button send shape | `sub_type:"url"`, parameter `text` = token suffix (confirmed pattern exists in `shipping-integration/whatsapp.js`) | OPEN (verify at Phase 4) |
| B5 | Error codes -> handling | 131047 window-closed -> template/skip; 131049 marketing-cap -> no retry + 7d marketing block; 131026 undeliverable -> mark + alert; 132000/132001/132012 template/param -> alert as bug, no retry; 130429/131056 rate -> backoff; unknown -> alert once/code/day | OPEN (Phase 3, verify in Meta error reference) |
| B6 | Coexistence echoes field | `smb_message_echoes` webhook subscription; sets `humanTakeoverUntil = now+12h` | OPEN (Phase 9) |
| B7 | Template status + category-change webhooks | field names for status and category-change events feeding the APPROVED cache | OPEN (Phase 4) |
| B8 | Flow endpoints + JSON version | `flows-sync` create/update SURVEY Flow, upload asset, publish; latest Flow JSON version; no data endpoint (static screens; terminal `complete` returns form data) | OPEN (Phase 6) |
| B9 | Dev sends | Meta test business number + verified test recipients; `SEND_ALLOWLIST` gates real sends | CHOSEN |

## C. Shopify Admin GraphQL

| # | Item | Current best-known | Status |
|---|---|---|---|
| C1 | API version | pin in config (repo uses `2026-07` in meta-outcomes; `2024-10` in shipping-integration). Pin current at Phase 3 | OPEN (Phase 3) |
| C2 | Mutations exist/shape | **Validated 2026-09-20 via validate_graphql_codeblocks (admin schema):** `getOrder` query (customAttributes/paymentGatewayNames/netPaymentSet/shippingLines/fulfillments.trackingInfo/lineItems) OK; `tagsAdd` OK; `metafieldsSet` OK; `orderCancel` OK but use **`orderCancelUserErrors`** not `userErrors` (fixed); `webhookSubscriptionCreate` OK but use **`uri`** not deprecated `callbackUrl` (fixed). STILL OPEN (Phase 5/6, validate when authored): `orderEdit*`, `orderMarkAsPaid`, `orderCreateManualPayment`, `metaobjectDefinitionCreate/Create` | PARTLY RESOLVED; `discountCodeBasicCreate` **RESOLVED** on existing live evidence, see section U9 |
| C3 | COD-to-prepaid accounting | which of the 3 options (order-edit remove COD line + add discount / set-qty-0 + re-add / record-full-then-refund) works per case; and whether `orderMarkAsPaid` vs `orderCreateManualPayment` leaves PAID + outstanding 0 + no leftover pending COD txn | OPEN (Phase 5 — TEST on a test order first, document the winner) |
| C4 | Standard review metafields | **RESOLVED 2026-09-20:** the theme computes the star summary + JSON-LD aggregateRating from the product's `custom.reviews` metaobject list (only ACTIVE reviews are linked), so Shopify's standard `reviews.rating`/`rating_count` metafields are optional and not maintained by the service. Discount `context:{all:ALL}` + metaobject create/def shapes validated via validate_graphql_codeblocks | RESOLVED |
| C5 | Webhook topics | `ORDERS_CREATE/UPDATED/CANCELLED`, `FULFILLMENTS_CREATE/UPDATE`, `FULFILLMENT_EVENTS_CREATE`; register idempotently (pattern proven in `meta-outcomes/shopify.mjs`) | CHOSEN (register at Phase 3) |
| C6 | Scopes | read/write orders, order edits, fulfillments, discounts, customers, products, metaobjects + metaobject definitions; protected customer data for name fields | DONE. Verified live 2026-10-08 against the service's own token: app `whatsapp-automation` holds 15 scopes including `read_order_edits` + `write_order_edits` and the `read_orders` that `orderEditCommit` additionally needs. NOT granted: `read_inventory`, `read_locations` (so `locations` and per-location inventory levels are denied; variant `inventoryQuantity`/`availableForSale` need only `read_products` and do work). Note the scope is `write_order_edits`, NOT `write_orders` - order edits 403 without it however broad `write_orders` is. |
| C7 | Existing reviews metafield | repo already has a `tapi.reviews` JSON metafield (empty). Spec wants metaobjects + `custom.reviews`. Decision: follow spec (metaobjects); theme reads `product.metafields.custom.reviews`; retire/ignore `tapi.reviews` | CHOSEN (note in Phase 6) |

## D. Payments (Razorpay behind a `PaymentLinks` interface)

| # | Item | Current best-known | Status |
|---|---|---|---|
| D1 | Provider | Razorpay for WhatsApp payment links (checkout stays on Cashfree); interface lets Cashfree be added later | NEEDS YOU (confirm a Razorpay account) |
| D2 | `expire_by` minimum lead time | ~15 minutes | OPEN (Phase 5) |
| D3 | Webhook events | `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`; verify `amount_paid` == expected + link maps to order | CHOSEN (verify signature = hex HMAC-SHA256, dedupe `x-razorpay-event-id`) |
| D4 | Cancel / refund / reuse | cancel on convert/cancel/out-for-delivery; refund via `/payments/{id}/refund`; reuse a still-valid same-amount link else cancel+recreate | CHOSEN |

## E. Courier (Delhivery behind a `Courier` interface)

| # | Item | Current best-known | Status |
|---|---|---|---|
| E1 | API variant | **Express API, static token** (`Authorization: Token <token>`, base `track.delhivery.com`). **RESOLVED 2026-09-21:** owner provided the classic Express token; it's stored as `delhiveryToken` and the tracking endpoint (`/api/v1/packages/json/?waybill=`) is verified working (HTTP 200). `clients/courier.mjs` (Express) is correct as written. The earlier-shared UCP MCP creds are a separate agent interface, not used by the Lambda. **The Express token was pasted in chat -> rotate after go-live.** Still OPEN (verify on a staging AWB at Flow C): `/api/p/edit` (COD->prepaid + cancel) and NDR (`/api/p/update`) exact fields (E4-E6) | RESOLVED (track); edit/NDR OPEN at Phase 7 |
| E2 | Tracking max waybills/call | default 25, comma-separated | OPEN (Phase 7) |
| E3 | Status/NSL mapping | -> MANIFESTED, PICKED_UP, IN_TRANSIT, PENDING, OUT_FOR_DELIVERY, NDR, DELIVERED, RTO_INITIATED, RTO_DELIVERED, LOST, CANCELLED (kept in `domain/courier-status.mjs`, friendly text in `labels.mjs`) | OPEN (Phase 7) |
| E4 | COD->prepaid edit | `/api/p/edit` payment mode prepaid + COD amount 0; only while Manifested/In-Transit/Pending/Scheduled; field names + accepted prepaid value | OPEN (Phase 5/7 — verify on staging with a test AWB) |
| E5 | Cancel shipment | edit API `cancellation: true`, before pickup | OPEN (Phase 7) |
| E6 | NDR actions | async NDR API `RE-ATTEMPT` / `DEFER_DLV`(date) / `EDIT_DETAILS`; returns request id to poll; next-day cutoff time; which reasons allow which actions; address edits same-pincode only | OPEN (Phase 7) |
| E7 | Push webhook | shared-secret header + optional IP allowlist; Delhivery enables on request (~5-6 working days). Until then hourly poller is source of truth; after, poller drops to 6-hourly reconciliation | CHOSEN (poller-first) |

## F. Onboarding (one-time, flagged — Phase 9)

| # | Item | Current best-known | Status |
|---|---|---|---|
| F1 | Route | coexistence (embedded signup) **or** dedicated number (skip onboarding, echo handling dormant) | NEEDS YOU |
| F2 | Embedded signup | Facebook Login for Business config id + WhatsApp Business app onboarding `featureType`; session info version; exchange code server-side; subscribe app to WABA webhooks; save WABA id + phone number id to Secrets Manager | OPEN (Phase 9) |
| F3 | Coexistence specifics | do NOT call phone registration for a coexistence number; contact/history sync optional + its time limit | OPEN (Phase 9) |

## G. Ops / integration risks flagged now

- **G1 Double-messaging:** COD King post-order WhatsApp/SMS must be OFF (keep OTP + abandoned
  cart); `shipping-integration` + `node-workflow` automations stay OFF. (README manual steps.)
- **G2 `cod-block` segment:** in COD King, hide COD for the customer segment tagged `cod-block`
  (this service applies the tag; COD King enforces it). Manual step for you.
- **G3 Two payment processors:** Cashfree (checkout) + Razorpay (WA links) coexist; reconcile so a
  link-paid order is not also marked paid twice. Handled by the `SIDE#` idempotency records.
- **G4 Owner phones:** each `OWNER_ALERT_PHONES` number must message the business number once so
  alert session-messages can be delivered. Manual step.
- **G5 Verified-phone coverage:** if many real orders lack `_otpVerifiedPhoneNumber`, Flow A
  reach is limited by design (hard rule 1). The digest counts `wa-no-verified-phone` so you can
  see the gap. No fallback to typed phones, ever.

---

## H. Build completion (2026-09-21)

All 10 phases are built, committed, and green (180+ Vitest tests, `tsc --checkJs`
clean, `cdk synth` clean). Nothing has been deployed; no customer messaged; no
order touched. What remains before go-live is **account setup + gated verification**,
not code:

- **Verified now (no account needed):** all pure logic; message registry + copy
  rules; the four client interfaces + fakes; the CDK stack (synths); the Shopify
  mutations that ship (`getOrder`, `tagsAdd`, `orderCancel`, `metafieldsSet`,
  `webhookSubscriptionCreate`, `metaobjectCreate`, `metaobjectDefinitionCreate`,
  `discountCodeBasicCreate`, `ordersUpdatedSince`) validated against the live
  admin schema.
- **Still OPEN (verify at the phase's go-live, needs creds/staging):** Graph API
  version pin (B1); flow button send shape + template FLOW-button create + Flow
  JSON version (B3/B7/B8); Meta error codes in practice (B5); coexistence echoes
  (B6); Razorpay `expire_by` minimum (D2); all Delhivery Express endpoints/field
  names/NDR cutoff (E2/E4/E5/E6) + which API the account actually has (E1); the
  Flow A prepaid-conversion sequence + payment-record choice on a test order (C3,
  gated by `CONVERSION_VERIFIED`); Embedded Signup featureType/session version (F2).
- **Needs you (accounts / manual):** A5 dir name and A6 branch are set; the Meta /
  Razorpay / Delhivery / Shopify-scope / COD King steps in README "Manual steps".

---

## I. Live end-to-end verification (2026-09-22)

Full production audit run against the deployed stack, real Shopify orders and
the live Meta/Delhivery/Razorpay accounts.

### Verified working
- **Templates: all 9 APPROVED** by Meta (plus a pre-existing `order_placed`).
  Rendered payloads compared field-by-field against Meta's approved component
  structures: body-parameter counts, language and button sub_type/index all
  match for the 10 templates that exist.
- **WABA** `account_review_status: APPROVED`; number +91 9372710234 `CONNECTED`,
  `TIER_250`, platform CLOUD_API.
- **Domain layer against real orders** (#1143-#1148): `_codkAmountType=cod`
  present, COD vs PREPAID classified correctly, cancelled and COD-Cancelled
  orders excluded, `_otpVerifiedPhoneNumber` present on every order, Rs 50 COD
  fee and the Delhivery AWB both extracted.
- **Delhivery Express** tracking live on real AWBs -> `IN_TRANSIT` mapping.
- **Shopify** 6 webhooks registered; Admin API reads fine. **Razorpay** auth 200.
- **Endpoint auth**: WhatsApp GET verify returns the challenge, wrong token 403,
  Shopify/Razorpay unsigned 401, `/p/<bad token>` serves the expiry page.
  (Route is `/p/{token}`, matching the approved `prepaid_offer_v1` button URL.)

### Defects found and fixed
- **wa-worker was dead in production.** `src/worker/index.mjs` declared
  `const text` twice in `onWaInbound`, a module-scope SyntaxError, so every
  invocation failed with `Runtime.UserCodeSyntaxError` and 42 real Shopify
  order/fulfillment events landed in the DLQ. Renamed the second to `rawText`.
  Missed because `jsconfig.json` scopes tsc to `src/lib` + `src/domain` and no
  test imported a Lambda entry point -> added `src/handlers.test.mjs` covering
  all 10 entry points (190 tests). Deployed; DLQ redriven; all 42 reprocessed
  clean, both queues empty, zero errors.
- **`cdk deploy` blanked runtime config.** `shopDomain` / `publicBaseUrl` were
  only ever passed as `-c` flags, so a bare deploy rewrote every Lambda with
  `SHOP_DOMAIN=''` and `PUBLIC_BASE_URL=''` (kills the webhook shop check and
  every payment link). Caught by `cdk diff` before shipping; pinned as context
  defaults in `iac/cdk.json`.

### OPEN blockers for go-live
1. **Business verification REJECTED** (`business_verification_status: rejected`).
   Consequence chain: the review Flow `morpaankh_review_v1` (id 1105549658511440)
   is stuck `DRAFT` with zero validation errors -> `delivered_review_v1` and
   `review_reminder_v1` cannot be created (they carry a FLOW button) -> **Flow B
   cannot run at all**. Also caps sending at TIER_250/24h. Owner action: re-submit
   verification in Meta Business Settings.
2. **COD King is still a Tech Provider on the WABA** (app 1414959830674213,
   subscribed alongside ours). Its post-order WhatsApp/SMS must be confirmed OFF
   before `DRY_RUN=false` or customers get double-messaged. Do NOT unsubscribe the
   app: that would break the pre-checkout OTP the store depends on.
3. **Nobody receives alarms.** `wa-automation-alerts` SNS topic has zero
   subscriptions (stack deployed with `alertEmail` empty), which is exactly why
   the dead worker went unnoticed. Deploy with `-c alertEmail=<address>`.
4. **`OWNER_ALERT_PHONES` is empty**, so Flow D owner alerts and the digest have
   no recipient.
5. **No message has ever been sent** through this WABA. Sending is unproven until
   one template goes to a real handset.
6. Unchanged from H: Flow A prepaid conversion stays hard-gated
   (`CONVERSION_VERIFIED`), and the Delhivery write endpoints `/api/p/edit` +
   `/api/p/update` field shapes are still unverified (reads are proven).

### State left behind
Stack deployed and healthy, `DRY_RUN=true`, all four flows OFF. Nothing has been
sent to any customer and no order has been modified.

### J. Business verification rejection - actual cause (2026-09-22, read from Security Center)

Business portfolio "Morpaankh" id **1728084641501165**, entity name on file
**MORPAANKH COLLECTION**, verification use case already correct
("App requires access to permissions on Meta for Developers").

Meta's own rejection detail reads: **"There's a problem with the ID you
submitted. Try submitting a different ID."** So the business is not refused,
the uploaded document is. Resubmission is allowed immediately (no appeal
needed): Security Center -> Business Verification -> Learn more -> Continue ->
Get started. Country India is pre-filled; the wizard then asks for **business
type** (Corporation / Sole Proprietorship / Partnership / Private Company /
Institution), which decides which documents are accepted, then business
details, then a contact confirmation, then the upload.

Accepted documents (must be unexpired, issued by the relevant authority, in a
supported language - English and Hindi both qualify):
Certificate/Articles of Incorporation; Business Registration or License
Document; Government-issued Business Tax Document (**self-filed tax documents
are NOT accepted**); Business Bank Statement; Utility Bill (only proves address
/ phone, and the legal business name must appear on it).
Docs: accepted list https://www.facebook.com/business/help/159334372093366 ,
rejection reasons https://www.facebook.com/business/help/2342133782492969 .

**Scope of the block: Flow B only.** The number is CONNECTED at TIER_250 with
all 9 templates APPROVED, so Flows A, C and D can go live without verification.
Verification is needed to publish the review Flow (unblocking
delivered_review_v1 / review_reminder_v1) and to raise the 250 unique
recipients / 24h cap.

### K. First live send + the webhook field gap (2026-09-22)

Owner test number **+91 7048459816**. Owner confirmed COD King post-order
WhatsApp is now OFF (OTP + abandoned cart stay on).

- **First real message ever sent through this WABA succeeded**: `cod_confirm_v1`
  to the owner, Meta returned `accepted` with a wamid. This also proves the app
  being in Development mode does NOT stop sends to real numbers.
- **Allowlist verified**: with `SEND_ALLOWLIST` set, a non-listed number is
  skipped as `not_allowlisted` with no Graph call at all. That is the safety net
  for a staged rollout.
- **GAP FOUND AND FIXED: the app was subscribed to `account_alerts` ONLY.**
  The `messages` field was missing, which is what delivers inbound messages,
  **quick-reply button taps** and message status callbacks. Flow A would have
  sent cod_confirm and then never heard the customer tap Confirm. Subscribed
  `messages` + `message_template_status_update` via
  `POST /<app-id>/subscriptions`. Only noticed because the first send produced
  no delivery receipt - worth re-checking after any Meta app change:
  `GET /<app-id>/subscriptions?access_token=<app-id>|<app-secret>`.
- **Round trip then proven live**: second send -> Meta status callback ->
  `wa-ingest-whatsapp` (signature verified) -> SQS FIFO -> `wa-worker` handled
  `kind: wa_status`, zero errors.

Go-live switches are now deploy-controlled (`iac/lib/stack.js` + `bin/app.js`
read `dryRun`, `sendAllowlist`, `orderAllowlist`, `ownerAlertPhones` and a
`flows` map from CDK context). **Defaults verified safe**: an unparameterised
`cdk synth` still yields `DRY_RUN=true`, empty allowlists and all four flows
`false`. The staged flip itself was NOT applied - the sandbox blocks it.

### L. Full trigger audit (2026-09-23) - three silent failures found

Order #1150 (owner's own COD test order, 18:27Z) produced no message. Root
cause was not Flow A logic:

**BUG 1 (critical, fixed): every timer in all four flows was dead.** The FIFO
queue had `ContentBasedDeduplication: false`, and EventBridge Scheduler's SQS
target can only supply a `MessageGroupId`, never a `MessageDeduplicationId`.
Every timer delivery failed with InvalidParameterValue, and because schedules
carry `ActionAfterCompletion: DELETE` the schedule then erased itself. No
error in our logs, no DLQ message, no alarm - the timer simply never existed.
That killed the COD confirm, reminder, fallback, high-risk check, review ask
and every NDR timer. Fixed by enabling contentBasedDeduplication (ingest is
unaffected, it passes an explicit dedup id). **Verified live end to end**:
orders/create replay -> schedule created -> fired -> worker `kind:timer` ->
`cod_confirm_v1` delivered (real wamid) -> order tagged `wa-cod-sent` ->
state `confirm_sent`.

**BUG 2 (critical, fixed): `hasTag(tags,'RTO')` matched every order.** hasTag
is a substring match and COD King tags every order `LOW/MEDIUM/HIGH RTO Risk`.
So Flow B skipped the review ask on 100% of orders (reason 'rto') and the
daily digest counted every order as RTO. Added `hasRtoTag` (matches 'rto' but
not '...risk') and used it in flowB + digest. Digest over the last 40 real
orders now reports rto=5, not 40.

**BUG 3 (fixed earlier): a skipped send still marked the order confirmed**,
so a staged rollout tagged real orders `wa-cod-sent` and then never messaged
them once the allowlist came off.

Trigger inventory, all checked: Shopify webhook -> ingest -> SQS -> worker
PROVEN; Scheduler timer -> SQS -> worker PROVEN (after fix); WhatsApp status
callback PROVEN; Razorpay webhook signature + routing PROVEN; recurring rules
(poll 08:00-22:00 IST hourly, reconcile 02:30 IST, digest 09:30 IST) all
ENABLED and running with zero errors in 24h; `track-active` enqueue passes an
explicit dedup id so it was never affected. Still unproven: a customer button
tap (needs a real tap), and the Delhivery write endpoints.

**OPEN RISK before the allowlist comes off: the prepaid conversion is still
hard-gated.** A synthetic `payment_link.paid` for #1150 reached
`flowA.onPaymentPaid` and `convertToPrepaid` threw as designed
(`CONVERSION_VERIFIED` unset). The guard is correct, but it means that if a
real customer takes the prepaid offer, **Razorpay collects the money and the
Shopify order is never converted**; the message retries and lands in the DLQ.
Harmless today because the allowlist blocks customers. Either finish the C3
conversion verification or disable the prepaid-offer path before going wide.

### M. Why no message ever arrived: WABA has no payment method (2026-09-23)

**Root cause: Meta error 131042, "Business eligibility payment issue" - no
payment method is set up on the WhatsApp Business account.** The Graph API
accepts the send and returns a wamid with `message_status: accepted`, which
only means queued. Delivery then fails. Every message sent so far, including
the manual owner tests, failed this way. Fix (owner, billing details, not
something this repo can do):
https://business.facebook.com/billing_hub/accounts/details/?business_id=1728084641501165&asset_id=3348947278638950&wizard_name=ADD_PM&account_type=whatsapp-business-account

**Why it stayed invisible - three observability holes, all now closed:**
1. `onWaStatus` discarded the delivery callback without logging it, so a
   message Meta accepted but never delivered looked like a success everywhere:
   the send logged MessageSent, the order got tagged, nothing said otherwise.
   Now logs status/code/title/detail, at error level on failure.
2. `wa-whatsapp-failures` alarmed on a `MessageFailed` metric that **nothing in
   the codebase emitted**, and `wa-courier-failures` on `CourierError`, also
   never emitted. Two of four alarms were dead. Both are now emitted
   (dimensionless, matching the alarms) and MessageFailed was verified
   end to end: failed send -> status callback -> worker -> EMF -> CloudWatch
   datapoint 1.0.
3. Only the worker had a Lambda error alarm. An ingest function throwing on
   every invocation would 5xx every webhook, the provider would retry, give up,
   and events would be lost silently. Added `wa-function-errors`, a math
   expression over errors across all ingest + timer + redirect functions.

**Error boundaries audited and correct as built:** ingest returns 401 on a bad
signature (+IngestRejected), 400 on bad JSON, 200-ack on an unmappable payload
so it cannot retry forever, and 502 after unmarking the dedupe key when enqueue
fails so the provider retries safely. The worker drops a poison body, and on a
handler throw logs, emits WorkerError and returns only that record in
`batchItemFailures`; the event source mapping has batch size 1 with
ReportBatchItemFailures, DLQ at maxReceiveCount 5, visibility 360s.

Known, deliberately not changed mid-incident: Lambda log groups have unlimited
retention (cost only). CDK's logRetention adds another custom-resource Lambda
and the account concurrency cap is 10.

**Both halves of that are now out of date (2026-11-07).** The account limit is
1,000, not 10, confirmed against the live account. And the retention IS set
now: O5 puts a `logs.LogRetention` on every function in `makeFn`, which is
exactly the custom-resource Lambda this paragraph was avoiding. It costs one
extra function and one IAM role, against CloudWatch storage that was half the
October bill (USD 0.73 of 1.47) on log groups that kept everything forever.

### N. First confirmed delivery + a prepaid-tagging bug (2026-09-23)

Owner added a payment method (Visa, Tax ID verified, INR, ₹3 verification
charge Paid). The first send right after still failed 131042 with a CHANGED
detail ("one or more errors related to your payment method" rather than "no
payment method is set up") - that was propagation lag, not a billing problem.
A retry ~90s later delivered.

**Full flow proven end to end on real order #1150:** orders/create replay
03:34:09 -> Scheduler timer fired 03:37:26 -> cod_confirm_v1 -> status sent
03:37:36, delivered 03:37:37, read 03:37:46, `codConfirmAt` recorded, order
tagged wa-cod-sent. Owner confirmed receipt on the handset.

**BUG (fixed): PREPAID-CONVERTED was tagged before the conversion ran.** In
`onPaymentPaid`'s no-AWB branch the tag was applied, then `convertToPrepaid`
was called; when that threw (the CONVERSION_VERIFIED gate) the tag stayed.
Real order #1150 ended up tagged PREPAID-CONVERTED with
displayFinancialStatus PENDING and netPayment 0.00 - i.e. marked prepaid while
still an unpaid COD order, which risks shipping without collecting cash. Tag
removed by hand via tagsRemove; the tag is now applied only after
convertToPrepaid returns, with a regression test.

Note for future testing: firing a synthetic `payment_link.paid` at a real
order exercises the conversion path against that real order. Use a throwaway
order, not a live one.

### O. Prepaid conversion live + three money bugs (2026-09-23)

Owner paid Rs 1049 on #1150 (pay_TfKlu9dIc0fDrz, UPI, captured). Conversion
authored and verified: orderEditBegin -> remove COD fee line -> Rs discount on
the top line -> commit -> assert outstanding == captured -> orderMarkAsPaid.
#1150 is now PAID, netPayment 1049.00, outstanding 0.00, tagged
wa-prepaid-converted + PREPAID-CONVERTED. CONVERSION_VERIFIED is now CDK
context and is true.

Three money bugs found while reconciling:
1. **Would have refunded a paying customer.** onPaymentPaid called classify()
   afresh, but classify is explicitly a once-at-first-sight decision: a
   converted order reads back PAID, so a retried or duplicate Razorpay webhook
   took the "no longer eligible" branch. It genuinely attempted a refund at
   03:55:42. Now uses the stored class, returns early when already converted
   (records convertedAt), and the guard was observed working live.
2. **Refunds could never succeed.** The ingest passed the payment_link entity,
   whose id is plink_..., to the refund endpoint, which rejects it. The refund
   above failed only because of this. A customer genuinely owed money would
   never have been repaid. Ingest now carries payment.entity.id + amount.
3. **Saving was Rs 150, not Rs 100.** prepaidDiscountInr stacked on top of the
   waived Rs 50 COD fee. Replaced with prepaidTotalSavingInr: the line discount
   is target minus waived fee, clamped at zero, so the saving is exactly the
   promised number.

Owner copy decisions: offer copy says "save Rs 100 extra" and mentions priority
dispatch, and never mentions the COD fee. OPEN: whether to put the offer into
cod_confirm_v1, which is an APPROVED UTILITY template. Offer wording risks a
MARKETING reclassification (opt-in + marketing caps + higher cost), so the
session message after the Pay online tap carries it for now at zero approval
cost.

## P. Product details in the message, every customer served, and the loophole sweep (2026-09-23)

### What can actually be fetched and shown (verified live before any code)
- Shopify `lineItem.variant.selectedOptions` gives a clean `Size`. `variantTitle`
  alone is NOT usable: a two-option product returns "S / Lavender", so the size
  would read as a colour. variantTitle is a fallback for single-option variants
  only, and "Default Title" is not a size.
- `lineItem.image.url` is a public Shopify CDN JPEG, which is what Meta needs.
- The CDN centre-crops on demand but **refuses to upscale**: `width=800&height=800`
  against a 473x593 source silently returns the original 473x593 portrait.
  `heroImageUrl` clamps the square edge to the shorter side, so it is always a
  true square. Verified against both a small and a large real product image.
- A template IMAGE header cannot be created with a URL example. Meta wants a
  handle from the Resumable Upload API, which needs the **app id**, read from
  the access token via `/debug_token` rather than stored as another secret.
  Proved end to end before writing the registry.

### The category problem, and how the confirmation avoids it
`cod_confirm` is UTILITY. Offer wording (save, discount, limited time) invites a
MARKETING reclassification, which would bring opt-in requirements, per-user
frequency caps and a higher price to **every** order confirmation. So v2 states
the two amounts this order can be paid at and lets the customer choose:

    Cash on delivery: Rs 1,499
    Pay online instead: Rs 1,399

Meta accepted it as UTILITY at create time. `prepaid_offer` is the one message
that IS an offer, so it stays MARKETING and keeps its opt-out footer.
`ops_digest` is now declared MARKETING because that is what Meta actually
assigned it; a periodic summary is tied to no transaction, so no wording makes
it UTILITY, and declaring otherwise only made templates-sync fail forever.

### New copy cannot break production: TEMPLATES + LEGACY
A template cannot be edited in place, so new copy means a new name, and a new
name is unsendable until a human at Meta approves it. Deploying new copy without
a safety net would silently break every order confirmation for hours. `tpl()`
now tries TEMPLATES and falls back to LEGACY on the Meta codes that mean "this
template is not usable" (131052/131053 media, 132000/132001/132005/132007/132012
shape, 132015/132016 paused or disabled). It also uses the fallback when a
product has no photo, and on request via `preferLegacy`. New copy therefore
starts going out by itself the moment it is approved, with no redeploy.

**Meta rejects a body that ends in a variable even with punctuation after it**
(error_subcode 2388299), which killed prepaid_offer_v2 on the first submission.
registry.test.mjs now rejects `}}` followed only by punctuation.

### Everyone gets served now, not just COD
- **PREPAID and PARTIAL were silently excluded from Flow A.** `flowAEligible`
  rejected `class-PREPAID`, so a customer who paid online at checkout got no
  WhatsApp at all. They now get `order_confirmed`: their items, their total, and
  no payment wording, because one of those two has paid in full and the other
  still owes a balance. No buttons either, since Flow A's cancel path issues no
  refund and a paid order cannot be cancelled without one.
- **There was no dispatch message anywhere.** `keep_cod_ack` promised "we will
  send you the tracking link" and nothing ever sent one. `order_shipped` now
  goes out on fulfillment for every class, with the item, the courier, the
  waybill, a Track button, and one line that differs by what is still owed
  (`currentTotal - netPayment`), so it is correct for COD, prepaid and partial
  without needing to know the class.
- **`fulfillments/update` was subscribed but not routed.** Shopify often creates
  a fulfillment first and attaches tracking in a later update, so those orders
  never had their AWB mapped. Both topics now route to the same idempotent
  handler.
- Flows B and C were checked and already had no class gate, so reviews and
  NDR/RTO work for every customer once enabled.

### Money and delivery loopholes found and fixed
1. **A Shopify read failure could refund a paying customer.** `onPaymentPaid`
   treated `getNorm` returning null as "order not eligible" and refunded. null
   means both "does not exist" and "Shopify was briefly unhappy", and refunding
   on the second is unrecoverable. It now throws, so SQS retries and a genuinely
   missing order lands in the DLQ where a human sees it. runOnce records nothing
   when the function throws, so the retry is clean.
2. **Messages could quote a price the customer cannot be charged.** The payment
   link is created once and reused, but the copy was rendered from a fresh
   `computeAmounts`. If the order was edited after the link was made, the
   message quoted one number and Razorpay collected another. Every message now
   quotes the LINK's amount and the LINK's real expiry, and logs when they
   diverge.
3. **A "Pay online" tap killed the last nudge.** It cancelled the marketing
   fallback timer, so someone who opened the link and got distracted was never
   contacted again and the order quietly stayed COD. Asking for a link is not
   paying; the fallback now stays armed and a real payment cancels everything.
4. **The confirmation could quote a prepaid price we could not honour.** When
   the COD fee does not match the COD King value, `ensurePaymentLink` refuses,
   so a customer who tapped after seeing a number got an apology. The price-free
   version is sent instead.
5. **The owner's own messages bypassed the fallback.** digest.mjs and
   reconcile.mjs called the WhatsApp client directly, so renaming the ops
   templates would have silently killed the daily digest and every alert.
6. `recordMessage` hardcoded `template: 'cod_confirm_v1'` and would have lied
   from the first send of v2. It now records what was actually sent.

### Left deliberately
- The dispatch message is gated on a Delhivery AWB, because the Track button
  points at Delhivery's tracking page and another courier would get a link that
  does not resolve. Better quiet than wrong.
- A template that is still in review makes the dispatch message fail. That is
  caught and logged rather than thrown, because it shares a handler with the AWB
  mapping and the courier prepaid edit, and parking a paid order's fulfillment
  in the DLQ over a message is the wrong trade. The prepaid confirmation is
  deliberately NOT caught: it is the whole point of that handler, so a failure
  should be visible and replayable.

## Q. Hard error guardrails, retries, and reporting that actually says what broke (2026-09-23)

The rule this section implements: **an error may cost us a retry, but it must
never cost the customer a duplicate message, a second refund, or a wrong order,
and it must never disappear silently.**

### The two primitives (`src/lib/resilience.mjs`)
Everything routes through `withRetry` and `soft`.

`withRetry` turns on one distinction that matters for money: whether the failed
request ever reached the provider.
- **Never sent** (DNS failure, connection refused, connect timeout, HTTP 429 and
  503): the provider refused or was never reached, so the call definitely did
  not happen. Always safe to retry, even a refund.
- **Unknown** (connection reset, socket timeout, HTTP 500/502/504): it may have
  been processed before the connection died. Retried ONLY when the caller
  declares the operation idempotent.

`idempotent` defaults to false, so a caller that has not thought about it gets
the safe behaviour. Reads are marked idempotent; WhatsApp sends, Razorpay calls
and Shopify order edits are not. Backoff is jittered so two workers hitting the
same outage do not come back in lockstep.

`soft` runs a step that must never fail the message it belongs to (an internal
tag, an audit metafield, an owner alert). It logs at ERROR level on purpose, so
swallowed is not the same as hidden: the failure still reaches the owner's inbox.

### Errors could reach the customer. Now they cannot.
1. **A failing tag resent the confirmation.** `onCodTimer` sent the message,
   then recorded it, then tagged Shopify, then wrote `codConfirmAt`. A Shopify
   blip anywhere in that tail threw, SQS redelivered, `codConfirmAt` was still
   unset, and the customer got a **second confirmation**. The send marker is now
   written immediately after a successful send and everything after it is soft.
   Same fix in the reminder, the marketing fallback, the prepaid confirmation,
   the Flow B review ask and reminder, and the Flow C NDR and RTO asks. Several
   of those had no re-send guard at all (`onNdr`, `onReminder`, `onFallback`,
   `onReviewReminder`), so a redelivery always re-sent.
2. **An unreachable owner could cost a customer money.** `ownerAlert` was called
   immediately after a refund and a cancel. If the owner's WhatsApp send threw,
   the whole record failed, SQS redelivered, and the refund ran **again**.
   `ownerAlert` can no longer throw.
3. **A refund could be issued twice.** The refund sat inline inside the outer
   `runOnce`, so anything failing after it (the customer message, the alert)
   meant the whole block was retried from the top. Refunds are now
   `runOnce(orderId, 'refund')`: no redelivery, retry or duplicate webhook can
   issue a second one, whatever fails afterwards.
4. **A converted customer could never be told.** If the conversion succeeded and
   the notification then failed, the retry hit the duplicate guard and returned
   early, so the money moved and the customer heard nothing. The notification is
   its own `runOnce` step and the duplicate branch calls it too, so a retry
   completes the missing half without repeating the conversion.
5. **Flow C left customers hanging.** An RTO reason tap wrote metafields and
   tags before replying; a Shopify failure meant the customer who just tapped
   got nothing. The bookkeeping is soft now and the reply always goes.

### A pre-existing bug the new tests caught
`shopify.graphql` never checked `res.ok`. A 503 with a JSON body fell straight
through and returned `undefined`, so a Shopify outage looked exactly like "this
order does not exist" to every caller, silently. Now it throws with the status.

### Error reporting that is worth reading
A CloudWatch alarm email says "wa-worker-errors went to ALARM" and nothing else,
so every incident started with a trip to the console. `src/ops/error-reporter.mjs`
receives the actual error lines through log subscription filters and emails the
failure with the order id, flow, step, attempt number, stack and a direct link
to the log stream, and says in one line whether the customer was affected.

It is deliberately **out of band**: it reads logs after the fact, so it cannot
slow down, block or fail anything a customer is waiting on, and it is not
subscribed to its own log group, so it cannot feed itself. Identical faults are
throttled to one mail per 15 minutes by a conditional put whose key contains the
window id, so a storm cannot flood the inbox.

Two filters per log group (the per-group maximum), on all ten functions:
`{ $.level = "error" }` for our own structured errors, and
`?"Task timed out" ?"Runtime." ?"[ERROR]"` for the failures that happen before
any of our code runs. That second one is exactly the class that killed the
worker silently for hours (`Runtime.UserCodeSyntaxError`).

Log retention was "never expire" on every group; set to 90 days, and the two
groups that had never been created (`wa-ingest-delhivery`, `wa-onboarding`,
neither function had ever been invoked) were created so the filters attach.

### Decoupling, checked rather than assumed
FIFO message groups are already per order (`order:<id>`), per waybill
(`awb:<n>`) and per phone (`phone:<e164>`), so a poison message blocks only that
one order or customer and never the whole service. Batch size is 1 with
`reportBatchItemFailures`, so a failure is reported back as exactly that record.

**The one real coupling left is not fixable in code:** this AWS account has a
Lambda concurrency limit of **10**, and AWS requires the unreserved pool to stay
at or above 10, so no function can reserve capacity. A retry storm in the worker
can therefore starve the ingest functions and lose webhooks. The fix is a
service quota increase for Lambda concurrent executions (the default is 1000);
it is free and usually granted quickly. Until then the exposure is limited by
the 360s visibility timeout, which paces retries at roughly one per six minutes
per message rather than in a tight loop.

### Caught live while writing the above
Checking the DLQ at the end of this work turned up one real message, which is
the same bug class in production. A customer cancelled order #1150 after paying.
`onStop` tried to cancel the payment link, Razorpay answered "cannot cancel or
expire an already paid / partially paid link", and that threw out of the
handler. The `orders/cancelled` record failed five times at roughly six minute
intervals (the visibility timeout) and was parked in the DLQ, so Flow A was
never marked stopped for that order.

Nothing reached the customer and no money moved, and there are no live
schedules for #1150, so the practical damage was nil. But it is a perfect
example of why cleanup must never be able to fail the work it belongs to.
`cancelLinkIfAny` can no longer throw. **The DLQ message should be redriven
(`node scripts/replay-dlq.mjs`) after the deploy, not before**, or it will
simply fail a sixth time.

### Deployed and proven live (2026-09-23 16:06 UTC)
All 11 functions deployed, including the new `wa-error-reporter`, with two
subscription filters on each of the ten log groups.

The whole chain was then proven on the real DLQ message rather than a synthetic
one. The `orders/cancelled` record for #1150 was redriven, hit the same Razorpay
"cannot cancel an already paid link" failure, and this time:

1. the failure was logged as `soft: true` with the label, order id, link id and
   stack, and the record **completed** instead of failing;
2. both queues went to zero, so nothing returned to the DLQ;
3. the subscription filter picked the error line up and the reporter published
   it to SNS about one second later (`error-reporter: reported sig=E7i0fic`);
4. a second identical error was suppressed by the 15 minute throttle
   (`already reported in this window`).

**The one thing still not working is delivery of those emails.** Both SNS email
subscriptions are `PendingConfirmation`, so the topic publishes and nothing
arrives. Fresh confirmation mails were re-sent to morpaankh.collection@gmail.com
and ashishgohil148@gmail.com; until someone clicks "Confirm subscription" in
them, every alarm and every error report is being published into a void.

### The alert emails were never going to arrive (2026-09-23)
The owner reported receiving nothing. The metrics settle it: the topic delivered
**4 notifications on 22 Sep 21:42 IST with 0 failures**, so AWS sent the
confirmation mails and nothing bounced. They are sitting in a spam or promotions
folder, unopened, which is why both subscriptions are still
`PendingConfirmation` and every alarm for the last two days published into a
void. Re-subscribing does not reliably resend, because SNS matches the existing
pending subscription rather than creating a new one.

An alerting channel that only works once somebody finds an email in spam is not
an alerting channel. The reporter now sends on **two independent channels**:
SNS email carries the full report, and a WhatsApp ops_alert to the owner carries
the short version. WhatsApp needs no confirmation step and is already proven to
reach this owner's handset. Neither channel can break the other or the function;
both go through `soft`.

Proving it turned up one more gap, exactly the way it was designed to: the first
attempt returned `whatsapp: false` and the soft log named the reason precisely,
`secretsmanager:GetSecretValue ... no identity-based policy allows`. The
reporter is created after the shared grant loop, so it never got secret read.
Fixed with `secret.grantRead(errorReporter)`. Retested: `whatsapp: true`, and
the worker logged the Meta callbacks `sent` then `delivered`.

### The last unverified write on a live money path (2026-09-23)
Delhivery's edit-to-prepaid field names are still marked unverified (a Phase 7
TODO), and `DRY_RUN` is now false, so that call goes out for real. It could
throw for reasons that have nothing to do with the customer.

Letting it throw was the worst possible outcome: the payment landed in the DLQ,
the order was never converted, the customer was never told, and the waybill was
still marked COD, so the courier would have collected the money a second time on
delivery. The same rethrow existed in `onFulfillmentCreate`.

Both now convert the order regardless, tell the customer, tag the order
`wa-courier-still-cod`, and raise an URGENT owner alert naming the actual risk.
`soft` returns null and `runOnce` records nothing when its function throws, so a
later fulfillment update still retries the edit. Strictly better than the DLQ on
every axis: the customer is served, and what remains is one courier record a
human can fix before dispatch.

## R. Live to real customers (2026-09-23)

`sendAllowlist` removed. `SEND_ALLOWLIST=""` on all 11 functions, `DRY_RUN=false`,
Flow A enabled from 2026-09-22T18:16:41Z. Every real customer who places an
order from now on is messaged.

### Checked before flipping it, not after
- **Every enabled path has an approved template.** cod_confirm, cod_reminder,
  prepaid_offer, prepaid_confirmed, prepaid_refund, ops_alert and ops_error all
  have an APPROVED version to fall back to while the new copy is in review.
- **Two did not, and one of them would have broken real orders.**
  `order_confirmed` (the prepaid and partial confirmation) had BOTH its versions
  PENDING, so every prepaid order would have thrown and gone to the DLQ.
  `order_shipped` has no fallback by design and already degraded gracefully.
- **No backlog blast.** Zero one-time schedules existed, and the only order
  created since the start date is #1150, which was fully processed. Orders
  skipped as `not_allowlisted` were deliberately left unmarked and their timers
  had already fired, so nothing re-fires at a customer now.

### The confirmation now waits for its template instead of failing
A template in review must not cost a customer their confirmation. Throwing sent
a real order to the DLQ; dropping it left the customer with silence forever.
`onCodTimer` now catches a template-unusable error on the non-COD branch and
re-arms its own timer two hours out, up to twelve times. The confirmation
therefore goes out by itself the moment Meta approves, with no redeploy and no
DLQ redrive. After a day of trying it gives up and tells the owner rather than
retrying forever.

### What a customer actually receives today
COD orders, which is nearly all of them, get `cod_confirm_v1`: the older copy,
no product photo, buttons Confirm / Pay online / Cancel. Everything downstream
of a tap works, including the prepaid conversion. Prepaid and partial orders get
nothing yet and are queued to be confirmed once `order_confirmed` is approved.
The dispatch message stays silent until `order_shipped_v1` is approved.

### Sending cap
The number is CONNECTED, quality GREEN, **TIER_250**: 250 unique customers per
24 hours. That is a consequence of the rejected business verification, not of
this change. Current volume is far below it, but it is the ceiling until
verification passes.

## S. Flow R: abandoned cart recovery (2026-10-13)

**S1. The offer is a fixed rupee amount derived from what the bag already gets,
not a flat percentage.** Measured against the last ten reachable carts on
2026-10-12: a flat 10% was equal to or WORSE than what eight of them already had
applied or could type in themselves. A Rs 1,249 bag gets Rs 125 at 10% while
WELCOME150 sits on the cart page offering Rs 150; a two-piece bag gets exactly
what BUY2 gives. So the offer is computed as `max(bag x percentOff, floor +
beatPublicByInr)` capped at `maxPercentOfBag`, where `floor` is the better of the
discount already applied and the best live public code this bag qualifies for.
If the cap makes beating the floor impossible, nothing is sent and the outcome is
`public-offer-better`. That is a designed result, not a failure.

**S2. A failed read of the live discount codes stops the message.** The floor
depends on `discountNodes`, which needs `read_discounts`. Without it the floor
collapses to "whatever is already applied" and we would quietly offer less than
the public code. The flow therefore fails CLOSED with outcome `no-public-codes`
and one owner alert a day. Cost: if the scope is missing, Flow R sends nothing at
all until it is granted. That is the right way round.

**S3. The phone lock is taken after Meta accepts, and released if delivery then
fails.** A 30-day cooldown written before the send would burn a customer's next
month on a message that never left. `onWaStatus` gets a cart branch that releases
it on `failed`. The lease is a conditional put on `attribute_not_exists(PK) OR
lockUntil <= :now` rather than a plain put-if-absent, because the row carries a
TTL and DynamoDB deletes expired items days late: waiting for the TTL would keep
a customer silently blocked well past their 30 days.

**S4. Flow R honours the service-wide marketing cap, checked after its own
cooldown.** The cart templates are MARKETING, and before this flow `prepaid_offer`
was the only MARKETING message a customer could receive. Without the cap someone
could get a prepaid offer on Monday and a cart recovery on Tuesday. It is checked
for message 1 only: the reminder belongs to a sequence the first message opened,
and re-checking the cap there would block it 22 hours later against the stamp
message 1 had just made. The cooldown is checked first so that a repeat abandoner
is recorded as `cooldown` rather than `marketing-cap` - both refuse, but only one
answers the question.

**S5. `{mode:'carts'}` is handled and returned at the TOP of the reconcile
handler.** The mode line maps anything that is not 'orders' to 'full', and the
cart rule fires every five minutes. 'full' runs `sweepUnreviewed`, which SENDS
review asks to real customers, plus a webhook re-assert and a full Delhivery
re-track: 288 times a day. `sweepUnconfirmed` also runs ABOVE the mode branch, so
returning from inside the 'full' block would not have been enough.

**S6. Cart rows use sort key `REC`, never `STATE`.** `scanStates()` treats every
`SK=STATE` row in the table as an order and reads the order id out of the PK, so a
cart row with that sort key would be handed to `flowB.onDelivered` as order
"CART#..." by the nightly review sweep. The code's end time lives in `codeEndsAt`
and never in `expiresAt`, which is the table's TTL attribute: putting it there
would delete the record at the moment the code closed, taking the attribution
window, the reminder guard and the outcome with it.

**S7. The image-free twins live in LEGACY, not NO_PRICE.** `send.mjs` reaches
LEGACY from both paths that need them: `noImage` falls back to
`NO_PRICE[key] || LEGACY[key]`, and Meta's 131052/131053 ("could not fetch the
media") are in TEMPLATE_UNUSABLE, which falls back to LEGACY. One entry covers a
bag with no photo and a photo Meta cannot reach.

**S8. No COPY_CODE button.** Meta caps that button's code at 15 characters;
`MORPAANKH` + a name + two digits is always longer. The code is in the body in
bold and the URL button applies it instead. Code digits are drawn from 2-9 only,
because a 0 reads as an O and a 1 as an I when somebody types a code off a phone.

**S9. Flow R taps re-check ownership strictly.** The router's `ownsOrder()` fails
open for an id it has never seen, and a Flow R payload carries a CHECKOUT id, so
there is never a STATE row and that gate always passes. `onTap` compares the
tapping phone to the one on the record itself.

**S10. The link target is a RULES switch, never a template change, and the
default is the style that was measured.** A URL button's address is fixed once
Meta approves the template and the only thing it can carry at send time is the
token, so `/r/{token}` resolves the destination server-side: `checkout` + `path`
(default), `checkout` + `query`, or `cart` as a last resort. Changing it is a
deploy, not another template review.

`path` is the default because it is the only one that was measured. On the live
storefront, 13 Oct:

    GET /discount/BUY2?redirect=/cart   302 + set-cookie: discount_code=BUY2
    GET /cart?discount=BUY2             200, no cookie, no code

The redirect target keeps its own query string, so the recover URL's `key=`
survives intact, and an unknown code still redirects rather than erroring, so a
code that has been deleted cannot cost the customer their bag. `query` was the
original default on the assumption that the checkout recover endpoint reads the
parameter directly; it is kept as a switch in case the handset test shows it
does, but nothing had ever demonstrated it.

**S11. OPEN DECISION, not changed here: STOP is a full opt-out.** A customer who
replies STOP to a cart recovery message is opted out of EVERYTHING, so they will
also get no order confirmation, no dispatch message and no delivery update on a
later order. That is the existing behaviour for every flow and Flow R does not
change it, but Flow R is the first MARKETING message most customers will ever get
from us, which makes a STOP much more likely than it was before. If a
marketing-only opt-out is wanted, it needs a second flag on the phone profile
(`marketingOptOut`) checked in `tpl()` for MARKETING templates only, and the
`optout_done` copy would have to say which messages are stopping. Owner's call.

**S12. read_discounts IS granted, verified 13 Oct, and the fail-closed branch
stays anyway.** `discountNodes(query:"status:active")` returns data on the live
token, and `publicCodeDiscounts()` returns exactly BUY2, BUY3 and WELCOME150 in
the shape the offer function expects, so the `no-public-codes` outcome will not
fire in production and the floor is real. The branch stays because the scope can
be revoked by a reinstall at any time, and without the live codes a Rs 1,249 bag
would be offered Rs 130 against WELCOME150's Rs 150, which is worse than sending
nothing. All six section-3 fixtures were re-run against those live codes and
produce the spec's numbers exactly.

**S13. The service-wide send gate is asked BEFORE the Shopify code is created.**
`DRY_RUN` and `SEND_ALLOWLIST` live in the WhatsApp client and used to surface
only in the send's reply, which arrives after `createUniqueCode` has already
made a real single-use discount. A run with `SEND_ALLOWLIST` set for testing
would therefore have left one orphan code in the Shopify admin per eligible
checkout. The client now answers `sendSkipReason(phone)` and Flow R asks it at
the same point it checks its own allowlist, so a gated send creates nothing,
takes no lock and records `send-<reason>`. Shadow mode already worked this way;
this is the service-wide gate catching up.

**S14. The marketing stamp is soft, and that is a deliberate trade.**
`markMarketing` runs after `firstSentAt` and the phone lock. If it threw, SQS
would redeliver, `firstSentAt` would short-circuit the retry, the stamp would be
lost anyway AND the handler would report a failure. Wrapped in `soft()` the
stamp can still be lost, but it is logged and nothing else breaks. The exposure
is one customer who could receive a Flow A prepaid offer inside
`marketingCapDays`; writing the stamp before the send instead would mean a
failed send still burns the cap, which is the worse of the two.

---

## T. /replace: replacement shipments, courier-neutral (2026-10-22)

A replacement is two parcels and no Shopify edit: a reverse pickup of what the
customer has, and a new prepaid forward parcel of what they should have had.
The owner types `/replace #1234 noor m xl` into the business number, gets a
preview with Confirm and Cancel, and on Confirm we book both legs, message the
customer and report both AWBs back.

### T0. Shopify is read-only here, and that is the whole point

`/replace` creates, edits, tags, notes, refunds, fulfils and re-stocks nothing.
The money was already collected on the original order and the replacement goes
out prepaid at our cost, so there is no Shopify-side truth to update. This is
deliberate and it is what keeps the feature reversible: if a booking is wrong,
the only thing to undo is a courier shipment.

### T1. Why a `shadow` mode rather than a boolean flag

Every `/api/p/edit` and `/api/p/update` field name already in `courier.mjs` is
marked unverified against a live AWB (E4-E6), and Delhivery publishes no API
reference for `cmu/create.json` at all: their own help pages document the
dashboard only. So the payload this feature sends is, on day one, an educated
guess at a document that books a real courier movement and prints a GST label.

`REPLACE_MODE=shadow` is the state that lets the whole path run against a real
delivered order and prove itself without that risk: parse, resolve, validate,
serviceability, freight quote, preview, Confirm, and then instead of the two
provider writes and the customer message, a log line and a reply to the owner
describing what it would have booked.

What shadow does NOT prove is the Delhivery payload itself. It stops before the
logistics client is called, so the field names, the form wrapper and the
response classifier are first exercised by the one live test on the go-live
checklist, not by a shadow run. It stops there deliberately: routing shadow
through the client would mean the fake books parcels in tests, and would
persist the would-be payload, customer address included, into a state row. The
narrow things shadow therefore misses (a phone the adapter would reject, an
address it would clamp) all fail before the first HTTP write and tell the
owner, so the cost is a failed first live attempt rather than a wrong parcel. A boolean cannot express
"everything except the writes", and that is the state this has to sit in until
one live test confirms the field names.

Shadow is the DEFAULT. A deploy that forgets to set the variable is safe.

### T2. The replacement AWBs must never enter the order AWB map

`setAwbMap(awb, orderId)` writes one row per AWB, all pointing at the same
order, all into GSI1, and `onDelhivery` routes any terminal event on ANY of
them straight into the order's flows. Putting a replacement AWB in there would
mean: the reverse pickup reaching RTO fires Flow C's RTO flow on the original
order (tagging it RTO, asking the customer why they returned it, counting it
toward their COD block), and the new parcel reaching DELIVERED fires Flow B and
asks the same customer for a second review of an order they already reviewed.

So replacement AWBs live in their own `REPLAWB#<awb>` rows, which carry no
`activeShipment` attribute and are therefore invisible to both GSI1 and
`getAwbMap`. The poller does not track them and `onDelhivery` cannot find them.
The cost is that we do not learn the return was collected by webhook; `/replace
status` asks the courier directly instead, which is the right trade for a
command the owner runs by hand a handful of times a week.

Related trap, already paid for once: `track-active.mjs` drops a terminal AWB by
rewriting the map row from scratch, so any extra attribute added to an `AWB#`
row is erased the moment the shipment finishes. Nothing about a replacement is
stored on those rows for that reason.

### T3. The consignee details get their own query, not a wider fragment

A courier booking needs name, street, city, state, pin and phone.
`ORDER_FIELDS` has `shippingAddress { zip city }` and nothing else, and it is
on the hot path of every flow, every poll and every reconcile pass. Widening it
would put a customer's full address and phone into the response of every order
read the service makes, including the ones that only wanted a status, and all
of it is protected customer data.

`getShippingDetails(orderId)` asks for it once, at the only moment it is
needed. Validated against the live 2026-07 schema (`countryCodeV2`, not the
deprecated `countryCode`; `customer.defaultPhoneNumber.phoneNumber`, not the
deprecated `customer.phone`). An app without protected-customer-data approval
gets an access error for the whole query rather than null fields, so that case
is caught and reported as `scopeProblem` and the owner is told it is a
permissions problem instead of hunting for a typo in an address.

### T4. Only the warehouse name blocks. GSTIN and HSN warn

Corrected 2026-10-22, after the owner asked the obvious question: these details
are already on the Delhivery account, so why ask again?

They were right about two of the three. The seller's GST registration sits on
the account the API token belongs to, and `seller_gst_tin` in the payload only
echoes it onto the label, so an empty one does not stop a label printing. HSN is
per garment, which the account cannot know, but it is optional on a B2C label.
Making either a hard stop meant the owner had to re-enter what Delhivery already
held before the feature would run at all. Both are warnings now, printed in the
preview, and the owner decides.

The warehouse name stays a hard stop for a narrower reason: `pickup_location
.name` is a PER SHIPMENT field, one account can hold several registered pickup
locations, and the API offers no way to list them (every `clientwarehouse` path
answers 404, verified against the live account). Nothing but a human can tell us
which one, and an empty value fails after the request with "ClientWarehouse
matching query does not exist".

What has not changed: neither value is ever guessed. A made up HSN would be a
wrong tax declaration on a GST document in the owner's name, so
`RULES.replace.hsn` still ships empty and stays empty until the owner fills it.

Also verified against the live account the same day: the token in Secrets
Manager works (pin 302017 answers `pickup: Y`, `pre_paid: Y`, `is_oda: N`, so
both legs are serviceable), and the STAGING host rejects that token with a 401.
There is therefore no rehearsal environment: the one live test order on the
go-live checklist is the only way the create payload can be verified.

### T5. The state machine

```
AWAITING_CONFIRMATION -> CONFIRMED -> RETURN_CREATED -> FORWARD_CREATED
                                   -> CUSTOMER_NOTIFIED -> DONE
terminal: REJECTED, EXPIRED, CANCELLED
failure: FAILED { failedStep, error }   (resumable via /replace retry)
```

Persisted after every step, so re-running the handler resumes at the first
incomplete one. Return leg first, always: it is the leg that is correct
regardless of what happens next (the customer has the wrong item either way),
so if the forward leg fails we keep the return, set FAILED, and tell the owner
the pickup is already booked. The customer is messaged only once both legs
exist, because a pickup notice with no replacement on the way is worse than
silence.

Provider references are deterministic: `<order>-REPLACE-<seq>R` and
`<order>-REPLACE-<seq>F` (so `1222-REPLACE-1R`). The order number leads so that
one search in Delhivery One turns up the original delivery and both replacement
legs together; the earlier `RPL1222-1R` sorted every replacement away from the
order it belonged to. The seq and the leg letter stay because the reference is
the adoption key below, and letters/digits/hyphens stay because that is the
alphabet cmu/create.json is known to accept (proven 2026-10-23) against an
endpoint with no published spec. If the provider reports a duplicate reference, or the
outcome is ambiguous (timeout, or 5xx after the request went out), we look the
shipment up by reference and adopt it rather than retrying, because a blind
retry is how one replacement becomes two parcels.

Each leg is its own `runOnce` action keyed by leg and sequence, because
`runOnce` records nothing when its function throws: that is exactly what makes
a half-finished execution safe to resume, and it is why the whole irreversible
call goes inside and nothing else does.

One execution per order at a time, held by a conditional-write lease row. A
second command or a second tap gets "already running" rather than a race.

### T6. Interface contract (frozen before the build, so three parallel
### workstreams could not drift)

`src/domain/replace.mjs` (pure, no I/O):
```
parseReplaceCommand(text) -> { verb, orderName?, swaps?, flags, error? }
normaliseSize(word)       -> canonical token or null
resolveLine(lines, words) -> { line } | { candidates } | { none: true }
resolveTarget({ line, swap, variants, catalog }) -> { variant } | { reason, candidates? }
validate(input)           -> { stops: [{ kind:'hard'|'soft', code, message }], warnings }
```
The orchestrator owns the policy: any hard stop refuses, a soft stop refuses
unless `force`, warnings are printed in the preview and never block.

Logistics adapter (provider-neutral, picked by `LOGISTICS_PROVIDER` through a
registry, so a new courier is one adapter file plus one registry entry and zero
orchestrator changes):
```
serviceability(pin) -> { reversePickup, prepaidDelivery, oda, raw }
quote({ fromPin, toPin, weightGrams, mode, leg }) -> { amountInr } | null
createReverse(spec) -> { ref, awb, status }
createForward(spec) -> { ref, awb, status }   manifested, never pickup-requested
findByRef(ref)      -> { awb, status } | null
label(awb)          -> { url } | null
cancel(awb) / track(awbs)
capabilities        -> { quote, label, findByRef }
```
`spec` carries no COD field at all. A replacement is prepaid by construction,
and a field that cannot be set correctly is better absent than defaulted.

Records: `REPL#<orderId>` / `REQ#<seq>`, a `LOCK` row, a `REPLOPEN` pointer row
per open request so `list` is one scan, and `REPLAWB#<awb>`. TTL 400 days on all
of them, outliving `stateRetentionDays` on purpose: a return that never reaches
the warehouse becomes a dispute months later and this row is the only record of
what was promised.

### T7. The confirm tap is routed before the per-order ownership gate

`ownsOrder` compares the tapping phone to the order's stored verified phone, so
an admin tapping Confirm on a customer's order would be refused by it. The `P`
flow letter (no other flow uses it) is dispatched ahead of that gate and
re-checks admission itself, strictly: the tapping phone must be an admin, the
nonce must match the one stored on the request, and the request must still be
AWAITING_CONFIRMATION and unexpired. Every other tap keeps the existing gate
untouched. An admin who once sent STOP can still run commands, because the
opt-out check in front of the command gate is about marketing to customers, not
about us talking to ourselves.


## U. Flow W: the 24 hour welcome offer (2026-10-24)

One private, single-use Rs 200 code, valid 24 hours, for every Shopify customer
created yesterday who has never ordered. WhatsApp first, email when WhatsApp
cannot reach them, once per person ever. Sweep at 11:00 IST, one new route, one
new Lambda, one new IAM statement, nothing else.

### U1. The recipient is `Customer.defaultPhoneNumber`, by owner's decision

Hard rule 1 of this service is that the only number we ever message is COD
King's `_otpVerifiedPhoneNumber`. A Flow W candidate has no order and has never
reached checkout, so that attribute does not exist for them and the choice was
between messaging an unverified number and not building the flow.

The owner was shown the tradeoff on 2026-10-24 and chose to message
`defaultPhoneNumber`. It is the first time this service messages a number that
nobody OTP-verified. Three things make it defensible and all three are in the
code: the number is validated by the EXISTING `normalizeVerifiedPhone` (12
digits starting 91 with a mobile third digit, or 10 digits starting 6-9, which
also enforces `countryPrefixes: ['+91']`); the exception and its date are
recorded at the top of `src/lib/phone.mjs` so the next reader does not think
the rule was simply broken; and `FLOW_W_ALLOWLIST` shadow mode is the
mitigation, which is why it has to work before go-live. The rule stands
unchanged for Flows A, B, C and R.

### U2. An unusable number falls back to email. It is not terminal

The first reading of the spec made a non-`+91` number a terminal `no-phone`
outcome. That was wrong, and it was corrected by the owner the same day. Spec
section 10 is "email only when WhatsApp is impossible or refused", and a number
that is absent, malformed, a landline or foreign is precisely WhatsApp being
impossible; section 2c hands out an `email:<hash>` message group id, which only
exists because email-only candidates are meant to be enqueued and sent to. The
`countryPrefixes` rule exists to stop us PAYING to WhatsApp an international
number, which is a cost control, not a reason to drop a customer.

So `no-phone` survives only as a NOTE on the record, `phoneSkipReason` of
`no-phone` / `bad-phone` / `non-india`, so that `subscriber-offer.mjs preview`
can answer "why did this person get an email rather than a WhatsApp". It is
never written to `outcome`. `excludeTags` and `requireAnyTag` stay terminal,
because "not a candidate at all" is a different statement from "we cannot reach
them this way". Six tests encoded the old reading and were flipped.

### U3. There is NO draft-order gate

An earlier design had one, failing open, with a `draftCheckSkipped` flag and a
`read_draft_orders` scope this app has never been granted. The owner removed it
on 2026-10-24 and the reasoning is correct: **a completed draft order IS an
order**, so the existing "any order" gates already cover the only case that can
matter, and an OPEN draft order is a quote the owner is still building, which is
not a reason to withhold a welcome code. No scope grant, no app reinstall, and
no `has-draft-order` outcome.

### U4. The offer sits EXACTLY on both of its bounds, and that is deliberate

The guard is Flow R's, measured against the code's own minimum rather than a
bag, because Flow W is sent before there is any bag: the minimum is the only
basket size we know anything about. Floor = the best live PUBLIC code on that
basket, beaten by `cartRecovery.beatPublicByInr`. Ceiling =
`cartRecovery.offerTiers` for that basket.

With the shipped numbers both are equalities. WELCOME150 gives Rs 150 on
anything over Rs 1,199, so the floor is Rs 150 + Rs 50 = Rs 200, and Rs 1,500.01
lands in the Rs 2,000 tier, whose ceiling is Rs 200. BUY2 and BUY3 score nothing
because the guard asks with quantity 1 and their minimums are 2 and 3 items.
There is NO SLACK in either direction: raise `amountInr` and it breaks the
ceiling, lower it and it stops beating WELCOME150, and either way the flow goes
silent with `public-offer-better` rather than sending something worse than the
cart page already offers. The unit test asserts the paise (20000 / 15000 /
20000) rather than `ok: true` so that an edit to any of those numbers fails
loudly instead of muting the flow in silence, and the worker alerts the owner
once a day when the guard refuses.

The Shopify minimum is `minOrderAboveInr + 0.01`. The paisa is load-bearing
twice: it makes "above Rs 1,500" literally true of every order the code works
on, and it is what puts the guard in the Rs 2,000 tier. At a flat Rs 1,500 the
ceiling is Rs 160 and this flow would never send anything.

### U5. Once per person EVER, on two keys, written last and given back

`SUBOFFER#PHONE#<e164>/LOCK` and `SUBOFFER#EMAIL#<sha256>/LOCK`, both
`putNew` (`attribute_not_exists(PK)`) and both deliberately WITHOUT
`expiresAt`: `expiresAt` is the table's TTL attribute, so a lifetime lock
carrying one would be deleted by DynamoDB and the same person would be offered a
second code. `putIfFree` cannot be used for the same reason, since it needs an
ISO field that expires. The email lock is what stops the obvious farm, which is
a new number against an address that has already been offered a code.

Both are written only AFTER the provider accepts, and **both are released by the
status webhook on a `failed` delivery, along with the marketing cap, before
anything is parked or emailed.** That is the highest-consequence path in the
feature: every real 131049 at this store has arrived asynchronously on the
status webhook, seconds after Meta accepted the send with a 200, by which time
`firstSentAt` and both locks are already written. "Once ever" has no expiry to
wait out, so leaving them would burn that customer permanently over a message
they never received.

### U6. The sort key is `SUB`, and the neighbouring scans are now fenced

`reconcile`'s `scanStates()` hands every `SK=STATE` row to `flowB.onDelivered`
as an order, and the digest counted every `SK=REC` row as a cart Flow R
messaged. `table.scanBySk` matches the sort key with NO PK condition, so a
Flow W row under either would have been messaged or counted as something it is
not, every day. Flow W therefore files under `SUBOFFER#.../SUB`, and the hole
is now closed from the other side as well: `allRecs()` filters on
`PK.startsWith('CART#')`, so the next flow cannot fall into it either.

### U7. WhatsApp creates the code first; email sends first

The WhatsApp gate is visible before the send (`sendSkipReason`), so the Shopify
code is created first and a send that throws cannot mint a second one on
redelivery. SES can be genuinely ABSENT at runtime: the Lambda asset excludes
`node_modules`, so `@aws-sdk/client-sesv2` may simply not be in the bundle, and
that is invisible until the first send is attempted. A single-use discount code
created for a message that never left is an orphan in the admin, one per
candidate, so the email path sends first carrying a code string drawn locally
and creates the Shopify discount the moment the send is accepted. The exposure
is a code promised and not yet created, for the second between the two calls;
the string is memoised, so a redelivery re-sends the SAME code and retries the
create, and a duplicate email is a far smaller harm than a dead code.

### U8. Email: `validFormat` is honoured, suppression is final, Reply-To is set

`UNSUBSCRIBED` is the only marketing state that refuses; `NOT_SUBSCRIBED`,
`PENDING` and `INVALID` all still receive, because the customer record is itself
the consent. But Shopify's own `validFormat: false` is now a skip
(`email-invalid`), SES account-level suppression for BOUNCE and COMPLAINT is on,
and a suppressed address is `email-suppressed` with NO retry. The reason is
scale: at one or two emails a day a handful of bounces is a large share of the
bounce RATE, and SES judges the rate, not the count. `Reply-To` comes from
`EMAIL_REPLY_TO` (defaulting to the From identity) so a customer who answers
reaches a human; every header value is stripped of CR and LF, because the
address is the customer's and the unsubscribe URL is Shopify's.

### U9. C2 is RESOLVED, and the four new reads were validated

`discountCodeBasicCreate` has been live since Flows B and R and the store proves
it. Verified in the live store on 2026-10-24, newest first:
`Cart recovery #66834159468916` / `MORPAANKHJANANI69` (2026-10-20),
`MORPAANKHHEMISHA92`, `MORPAANKHNIDHI93`, `MORPAANKHSUREKHA29`,
`MORPAANKHRAMA78`, `Review thanks #1188` / `THANKS-P9YCPX`, and
`MORPAANKHASHISH97` with `asyncUsageCount: 1`, a code that was created AND
redeemed. **C2 is therefore RESOLVED on existing evidence and is not dated to
today**: this session created nothing in the store, and the newest discount of
any kind is 2026-10-20.

Flow W's four new reads (`customer(id:)`, `customers(query:)` with
`customer_date` + `orders_count:0`, `orders(query: email:)` and
`collectionByIdentifier` + `products(sortKey: BEST_SELLING)`) were validated
2026-10-24 against the current admin schema via `validate_graphql_codeblocks`;
the service pins `2026-07`. Two corrections came out of it and are in the code:
`availableForSale` does NOT exist on `Product` in the Admin API (it is a
Storefront field), so buyability is read off `variants(first: 50)` and
flattened; and `collectionByHandle` / `featuredImage` are both deprecated in
favour of `collectionByIdentifier` / `featuredMedia`.

`orders_count:0` is PROVEN, not assumed: the owner ran it live on 2026-10-24 and
it returned 5 customers for 23 Oct and correctly dropped the one who had
ordered. The documented negated-`order_date` fallback is therefore NOT built and
should not be.

### U10. NEVER `customersCount(query:)` for the blast radius

In the same live test it returned **475, the entire customer base, for every
filter including tags.** A `maxPerRun` guard built on it would compare 475
against 100 and refuse to run every single day, for ever. The guard counts the
nodes actually paged and filtered, and the comment on it says so with the 475 in
it, because the obvious one-query version looks like an optimisation.

### U11. The theme needs no change

`theme/snippets/tapi-smart-offers.liquid` builds `applied_code` from
`cart.cart_level_discount_applications`, i.e. codes that are actually
discounting the cart. A Flow W code whose Rs 1,500.01 minimum is unmet never
appears there, so `applied` is empty, the suppression guard in
`theme/assets/tapi-offers.js` does not fire, and the shopper IS still upgraded
to the best public code. When the code DOES apply, the regex
`/^MORPAANKH[A-Z]*\d+$/` matches it and the suppression works correctly. No
theme edit and no theme push, which is why the code format is shared with
Flow R through `cartCode` rather than invented here.

### U12. Low and accepted

- **The `/w` route counts a tap for anything that is not a known bot UA.** Shared
  with the cart redirect through an exported `isRealTap` rather than a second
  copy of the regex. A determined scraper can still inflate a click count; it
  cannot reach a code it was not sent, because the token is 128 bits of
  base64url and an unknown one is a plain redirect.
- **The owner alert for `template-unusable` is itself a template.** When Meta
  disables our templates it cannot be delivered either. The session twin is the
  only route that still works and nothing uses it for alerts today; it is named
  in the test that covers that path. Not fixed here because it is the same gap
  Flow R has had since it shipped, and fixing it belongs with the ops copy.
- **`onSubStatus` remembers the clients it was last given.** The status webhook
  arrives in its own invocation and the router hands `onCartStatus` no deps at
  all, because Flow R's status path sends nothing; Flow W's has to send the
  email fallback. In production every caller passes the same stateless
  `realClients` singleton, so remembering the last one is identical to asking
  for it again, and the router passes deps explicitly anyway.
- **A code collision after an email has gone out cannot draw a new code.** The
  WhatsApp path re-draws up to five times because nothing has been sent yet; the
  email path has one attempt with the string already in the customer's inbox,
  and a collision there throws so SQS retries and ultimately DLQs with an owner
  alert. 8^4 = 4096 codes per first name, one code per person ever, one or two
  candidates a day: decades, not days.

## V. /pnl: the monthly profit and loss report (2026-11-03)

The brief called this "section P"; `## P.` was already taken on 2026-09-23, so it keeps the
file's chronological lettering as V.

### Proven against the live APIs before any feature code

Every row below was a real call on 2026-11-03, not a doc reading.

**Shopify.** `POST https://yaaijv-6p.myshopify.com/admin/api/2026-07/graphql.json`. The full
P&L field set validates against the live 2026-07 schema and returns real values. Scopes the
validator names: `read_orders`, `read_customers`, `read_products`, `read_inventory`.
- `lineItems.variant.inventoryItem.unitCost.amount` **is readable with the token we already
  hold**. Shopify relaxed this in Jan 2025 and the relaxation is in force here, so there is
  no scope to add. 94 of 96 October line items carry a cost.
- `shippingAddress { city provinceCode zip }` is readable; not protected-data denied.
- `customerJourneySummary.lastVisit.utmParameters` is readable on 73 of 73 October orders.
- **The `created_at:` search filter ignores the time of day.** Asking for
  `created_at:>=2026-09-30T18:30:00Z` still returns #1168 (08:04Z) and #1169 (17:37Z), both
  of which are September in IST. A month cohort therefore over-fetches a day either side and
  filters in code on the real `createdAt`. Doing that yields exactly 71 orders, #1170-#1240.

**Delhivery tracking.** `GET /api/v1/packages/json/?waybill=a,b,c` — **25 waybills in one
call verified working**; `?ref_ids=<ref>` for the lookup. Real field names on
`ShipmentData[].Shipment`:

| What the P&L needs | The actual field |
|---|---|
| status text / type / code / date | `Status.Status` / `Status.StatusType` / `Status.StatusCode` / `Status.StatusDateTime` |
| charged weight | `ChargedWeight` — **null on 89 of 89 shipments** |
| origin | `Origin`, a depot NAME (`Surat_RingRd_C (Gujarat)`), not a pin |
| destination pin | `Consignee.PinCode` (`Destination` is a city name) |
| payment type | `OrderType` (`COD` / `Pre-paid` / `Pickup`) |
| COD amount / invoice value | `CODAmount` / `InvoiceAmount` |
| pickup / delivered | `PickUpDate`, `PickedupDate` / `DeliveryDate` |
| RTO start / returned | `RTOStartedDate` / `ReturnedDate`, plus `ReverseInTransit` |

Timestamps carry no offset and are IST. Statuses seen across 89 shipments: Delivered 65,
RTO 9, In Transit 10, Not Picked 1, Pending 2, Dispatched 1, Manifested 1.

- **On an RTO parcel `DeliveryDate` is the return-accepted time, not customer delivery.**
  #1170's `DeliveryDate` 2026-10-13T16:46:36 is identical to its "RETURN Accepted" scan.
  Reading `DeliveryDate` without first checking `Status.Status` would book an RTO as a sale.
- **`ref_ids` finds nothing for #1205 or #1233**, with and without the leading `#`:
  `{"Error":"No such waybill or Order Id found"}`. The brief expected this lookup to rescue a
  fulfilled order with no AWB in Shopify. It does not, so those orders are MISSING.

**Delhivery charges.** `GET /api/kinko/v1/invoice/charges/.json?md=S&ss=..&o_pin=..&d_pin=..&cgm=..&pt=..&cod=..`
returns `status, zone, charged_weight, divisor (5000), wt_sop_type, gross_amount,
total_amount, tax_data{SGST,CGST,IGST,...}` and a per-head breakdown `charge_DL, charge_RTO,
charge_DTO, charge_COD, charge_DPH, charge_PEAK, charge_FS, charge_ROV, charge_INS, ...`.
Verified arithmetic on #1170 (zone D1, 500 g):

```
ss=Delivered pt=COD : DL 52 + COD 40 + DPH 1.92 + PEAK 2 = gross 95.92 ; +SGST 8.63 +CGST 8.63 = total 113.18
ss=RTO       pt=COD : DL 52 + RTO 52 + DPH 3.83 + PEAK 2 = gross 109.83 ; +9.88 +9.88       = total 129.59
ss=DTO              : DTO 80 + DPH 2.95 + PEAK 2         = gross  84.95 ;                     total 100.25
```

`total_amount` includes GST, `gross_amount` is ex-GST.

- **`ss=RTO` returns BOTH legs in one row.** The brief described `ss=RTO` as "the RTO return
  leg"; it actually carries `charge_DL` and `charge_RTO` together. Adding a separate
  `ss=Delivered` forward charge on top would double the forward freight on every RTO.
- **`charged_weight` is just the `cgm` we sent, echoed back.** Combined with
  `ChargedWeight: null` in tracking, **there is no API source anywhere for Delhivery's real
  scanned weight.** Every computed charge rests on an assumed weight and must say so. The
  uploaded ledger is the only exact source, which is what makes it worth asking for.

**Delhivery ledger: no API.** 404 on `/api/cmu/wallet/balance`, `/api/wallet/balance`,
`/api/kinko/v1/invoice/.json`, `/api/p/invoice`, `/api/v1/billing/invoices`,
`/api/kinko/v1/invoice/backup/.json` (each answers an auth0 HTML login page, i.e. no such API
path on this host). Actuals come from the owner's monthly upload, S3, or `--ledger`.

**Meta Ads.** `act_1046985611096981`: currency INR, `timezone_name` **Asia/Kolkata** (so no
timezone warning is needed on Summary), `account_status` 1. `/me/permissions` grants
`ads_management, business_management, public_profile`. `ads_read` is **not** granted but
`ads_management` covers the read and the insights call succeeded, so **no new Meta permission
is needed** and the `meta-outcomes` System User token is sufficient. Campaign insights,
`time_increment=1`, 1-31 Oct: 86 rows over 31 days, **total 39,161.21 = sales 34,879.40 +
boost 4,281.81**, which matches the owner's independent snapshot exactly.
- Classification: `OUTCOME_SALES` -> sales. Boosts are caught by the **`Instagram post:` name
  prefix**, not the objective: one of the two boosts has objective `LINK_CLICKS`, which no
  engagement/awareness objective list would catch. Zero campaigns unclassified.

**Razorpay.** The stored key authenticates. `GET /v1/payments` for October returns **0
payments** (Sep 4 captured, Jun-Aug 4 captured + 1 failed). Razorpay is used only for the
prepaid-conversion **payment links**, and `reference_id` is `<orderNumber>-P1` — that is how a
Razorpay payment maps to a Shopify order. Every October link is `expired` with
`amount_paid: 0`. So **October Razorpay fees are genuinely 0.00, not missing.** `fee` and
`tax` both exist on a payment, in paise, and `fee` includes `tax`.

**Cashfree: no keys.** The string appears only in a comment in `src/clients/razorpay.mjs`.
Nothing in `wa-automation/secrets`, `meta-outcomes/.env`, or the repo. The 17 October Cashfree
orders therefore use `gatewayFeePct` from config, labelled ASSUMED, until keys exist.

### The October cohort, reconciled before the engine was written

Classifying the 71 live orders by the brief's own rules reproduces the owner's 3 Nov snapshot
on every line: on record 71, excluded 9, cancelled 11, delivered 34, RTO 8, pending 9, lost 0.
RTO is 8 orders in 7 parcels (#1208 and #1209 share AWB 59152210001584). Delivered is 34
orders in 33 parcels because #1205 has no AWB at all. The only inferred outcome is #1205
(COD cash recorded after fulfilment). Shopify-vs-Delhivery conflicts are exactly #1170,
#1183 and #1203 — fulfilled, and `displayStatus: DELIVERED` with a `deliveredAt`, while
Delhivery says RTO. Missing COGS is exactly #1174 "Toran" (no unit cost) and #1233 "Dupatta"
(no variant).

October has **zero genuine replacement jobs**: the one `REPL#` row in the table is test order
#1222, state CANCELLED, tag `replace-payload-test`, and its two AWBs (59152210001805 "Not
Picked", 59152210001794 "Closed Reverse Pickup") were never collected, so almost certainly
never billed.

### Decisions this forced

- **`exceljs` arrives as a Lambda layer.** The service has zero runtime dependencies and the
  shared asset excludes `node_modules`, so nothing from npm reaches a Lambda today. Widening
  that exclude would ship vitest and the whole AWS SDK into all 15 functions. The layer is
  built by `npm run pnl:layer` and synth throws if its directory is missing, so a deploy
  cannot silently ship a function whose `import` will fail at runtime.
- **`PNL#` is the key prefix** (verified free against every prefix in use). SK avoids
  `STATE`, `REC`, `SUB` and `REPLOPEN`, all of which are scanned by other flows, and no
  `PNL#` row ever carries `activeShipment`.
- **`/pnl` acks in the worker and async-invokes the report function.** The worker is 60 s with
  no ack-then-continue mechanism, and a month of Shopify orders plus ~50 tracking calls will
  not fit. This needs one scoped `lambda:InvokeFunction` statement on the one function ARN;
  it is the only new IAM in the feature besides S3 and SES.
- **A new error alarm rather than joining `pipelineFns`.** That list is at 9 of CloudWatch's
  10-metric cap for a math expression, and taking the last slot would leave the next function
  with nowhere to go. `wa-pnl-report` also joins the `reported` log-group list, without which
  its errors would go unreported the way `wa-subscribe` did for two days.

### Found by the first live run, not by any test (2026-11-04)

**The charges API throttles, and reports it as HTTP 200.** The body is XML:
`<root><detail>Request was throttled. Expected available in 25 seconds.</detail></root>`.
`withRetry` backs off in hundreds of milliseconds and gives up after three
attempts, so all three landed inside the same closed 25 second window. On the
first live October run a handful of lanes answered and every remaining one was
dropped: the whole month's freight read MISSING, which correctly but uselessly
blocked every row from the totals. Charges now parse the number of seconds
Delhivery names and wait it out, capped at 35 s and attempt-bounded. October
went from almost nothing counted to 33 delivered and 9 RTO.

No test could have caught this. The fakes never throttle, and a month is the
first time the service makes forty charges calls in a row.

**The workbook totals what the workbook renders, and cross-checks the engine.**
Every Summary total is a SUMIF over an "In totals" flag column on the order
sheets, so a cell and its live formula can never disagree, and `report.totals`
appears only as ~20 cross-check rows on Data Checks. That design earned itself
immediately: the rows caught the workbook summing a row the engine had blocked
(#1205, no AWB, so freight MISSING, Rs 2,046 of revenue and Rs 780 of COGS),
then a packing split that lost a paisa per shared parcel, then a test order's
replacement charge reaching the statement. None of those were visible in the
engine's own tests, because the engine was right every time.

**A killed run leaves its lock for 20 minutes.** `PNL#<month>` / `LOCK` is a
lease, so a terminated CLI or a timed-out Lambda self-heals at the end of it.
The RUNBOOK carries the one-line delete-item for clearing it sooner.

**#1219 moved after the owner's snapshot.** Its RTO started
2026-11-03T22:02:15, so the live month reads 9 RTO / 8 pending where the 3 Nov
snapshot said 8 / 9. Verified directly against the waybill rather than assumed:
`StatusType: RT`, `RTOStartedDate` set, `ReturnedDate` null. This is the drift
the cohort is supposed to show, not an error, and it is why the report carries a
"Last Month Update" block at all.

### The adversarial audit (2026-11-04)

A verifier that had not seen the build checked the live October report against
the sources. What it VERIFIED, by pulling the sources itself rather than reading
the code: all 44 delivered and RTO rows exact against live Shopify (gross =
`currentTotalPrice`, COGS = sum of `currentQuantity x unitCost`, and name, city,
province and payment type correct on every row); 18 of 18 live charges calls
exact including zone, COD charge and GST; all 8 RTO lanes answered by ONE
`ss=RTO` call with no separate forward call added, so no double counting; the
#1208 + #1209 split adding back to the parcel to the paisa; #1205 out of every
money column; the partial-payment revenue rule; Meta exact to the paisa per
campaign including the `LINK_CLICKS` boost; and `customerDeliveredAt()`
returning null for every RTO shipment, so the `DeliveryDate` trap is shut.

It also found nine real defects. The two that mattered:

**A tripwire that could not trip.** Two Data Checks reconciliation rows took
their status from a literal `true` rather than a comparison, so they printed
"ok" whatever the cells held, including after the exact hand edit one of them
said it existed to catch. A check that cannot fail is worse than no check,
because it is read as reassurance.

**The provenance line for the month's one inferred delivery was backwards.**
#1205 read "Delhivery says delivered, Shopify never marked it" when Delhivery
has no record of the parcel at all and Shopify had marked it FULFILLED. The real
basis is the COD-cash-after-fulfilment inference, which the row above it stated
correctly. Cause: the workbook re-implemented the conflict test instead of
calling `shopifyConflict()`, losing its "no shipments means no conflict" guard.
On a report whose central claim is that Delhivery decides, that was the worst
available line to get backwards, and it is the argument for rendering from the
domain function rather than re-deriving a rule at the edge.

The rest were a contradictory soft check answered twice with different verdicts,
two unlabelled GST bases 2.38 apart on every COD order, a charged-weight column
header that read as measured when the figure is the one we sent, preview quotes
printed under charge headers, a duplicate-order detector keyed on a null, and
Rs 99.95 of unrefunded deposit booked as income on one RTO while the identical
order beside it was only asked about.

Two things worth keeping from the exercise. The month genuinely MOVES: across
three runs on 4 Nov the funnel went 34 delivered / 8 pending to 35 / 7 as
parcels settled, and Delhivery's own RTO quotes drift a few rupees between runs
while the API throttles. And the cohort is orders PLACED in the month, so 4 of
35 delivered orders settled in November carrying 17.7% of net revenue. All three
are correct behaviour; the first two are why the report says PROVISIONAL and the
third is why the statement now states its own cut.

### The bug that only exists in production (2026-11-05)

**Delhivery timestamps carry no offset and are IST. `Date.parse` reads an
offsetless stamp as LOCAL time.** Both developer machines here are on
Asia/Calcutta, so every local run was right and every Lambda run would have been
wrong by 5.5 hours, in the direction that moves a date FORWARD:

```
'2026-10-31T23:00:00'  (a real scan, 31 Oct 23:00 IST)
  parsed on an IST machine -> 2026-10-31T17:30:00Z   correct
  parsed on a UTC Lambda   -> 2026-10-31T23:00:00Z   5.5h early
```

`monthEndUtc` for October is `2026-10-31T18:30:00Z`, so that scan would have
tested as November and left the month that owns it. A parcel delivered late on
the last evening of a month is not a rare case, it is the normal case for a
month's final orders.

Nothing would have surfaced it. The clients run on an IST laptop, the fakes hold
whatever string a test wrote, and the only machine that disagrees is the one
nobody reads the clock on. `cohort.mjs` now exports `istWallToUtc()`, which
normalises an offsetless stamp and passes a `Z` stamp through untouched.

Audited after the fix, by hand, every place a courier date meets a boundary:
- `engine.mjs` `deliveredAtUtc` normalises the courier date and falls back to
  Shopify's already-`Z` fulfilment date; the settlement cut and the RTO-start
  comparison both go through the helper.
- Meta's `date_start` is a DATE, parsed as `${date}T00:00:00+05:30`, which is
  explicit and therefore safe.
- `src/pnl/sources/delhivery.mjs` parses no dates at all. It passes the raw
  strings through, which is why the normalising belongs in the domain.
- The whole suite passes under `TZ=UTC`, which is now the way to check this.

The general rule this earns: **a date from a provider that omits its offset is
not a date until something has said which clock it was written on.** Treat the
string as data and normalise at the domain boundary, never at the point of
comparison.

### Why the freight is lower than the invoice, and the one COD charge we invented (2026-11-05)

The owner read the October report and said two things: the parcels cost more
than Rs 120 each, and had COD handling been counted at all. Both were checked
before anything was changed.

**COD handling was already counted, and is right.** Every one of the 26
delivered COD parcels carries a collection fee (Rs 40 up to about Rs 2,000 of
cash, 2% above it: the month holds 40.00, 42.98, 53.16, 93.58 and 96.98), it
is a line of its own on the statement (COD charges, Rs 1,263.23 delivered plus
Rs 137.48 inside the RTO loss), and the nine RTO parcels correctly carry none,
because no cash was collected. Not one delivered COD parcel was missing it.

**There is still no API for the billed amount.** Seven more endpoint shapes
tried on 2026-11-05, on both `track.delhivery.com` and `api.delhivery.com`:
every one answers 404 with an auth0 HTML login page, or 400 from the rate
calculator asking for `md`. Delhivery's own documentation for the Invoice /
Shipping Charge API says its output is approximate and can differ from what is
actually charged, and seller reports put the difference down to re-weighing and
dimension correction. So the rate card remains the only computable source and
the owner's billing export remains the only exact one.

**The gap is the weight, and it is one-directional.** Delhivery bills the
greater of dead weight and volumetric weight; every charges row says so with
`divisor: 5000` and `wt_sop_type: "dead_lt"`. We send 500 g of dead weight and
no dimensions, so the quote can only come back at or below the invoice. Four
real October lanes, re-quoted:

| Lane | zone | 500 g | 1000 g | 1500 g |
|---|---|---|---|---|
| 395010 to 411012, COD 150 | B | 92.88 | 135.00 | 174.13 |
| 395010 to 583229, COD 1149 | D1 | 113.18 | 173.12 | 233.09 |
| 395010 to 600043, prepaid | D2 | 68.94 | 131.82 | 191.79 |
| 395010 to 783334, COD 1999 | E | 127.86 | 202.49 | 277.13 |

At 500 g a prepaid parcel cannot reach Rs 120 on any lane we ship; at 1000 g
every lane clears it. That matches the report's own soft check, which already
flagged prepaid at Rs 71.57 against the owner's Rs 110 rule of thumb while COD
at Rs 131.70 sat inside tolerance. So the number is not wrong arithmetic, it is
the wrong weight, and raising it without a measurement would be inventing a
cost. What changed instead: `assumedWeightGrams` is documented as a FLOOR in
three places the owner reads (rules, the Assumptions sheet, the soft check's
verdict), and the verdict now names the weight rather than sending them to look
at the rate card. The fix is one config value, from either a Delhivery invoice
line or the billing export upload.

**One real defect, found while checking the COD question.** #1236 showed
`Prepaid` in the Courier Ledger next to a Rs 40 COD charge. The waybill is
manifested Pre-paid with `CODAmount: 0` while the Shopify order reads COD, and
`fetchCharges` fell back to the order's total whenever Shopify said COD. So it
quoted the lane as COD and booked a collection fee on a parcel where Delhivery
will collect nothing. The fallback now needs the waybill to agree
(`sh.orderType === 'cod'`), which leaves it doing its only real job, filling a
COD waybill whose `CODAmount` came back empty, and stops it contradicting the
page it prints on. #1236 is still in transit, so no delivered total moved.

## W. The customer's own language, English or Hindi (2026-11-11)

Branch `feat/wa-language`, built on `27d8fab`. Ships with
`RULES.language.enabled: false`, so merging it changes nothing a customer sees.

### The shape

**One place resolves the language.** `langFor(phone)` in `src/worker/send.mjs`,
read from the RECIPIENT PHONE, and no call site ever passes or guesses one. A
flow asks for `cod_confirm` and gets whichever language that customer chose; a
flow written next year inherits it by doing nothing. This was the whole reason
for choosing the send helpers over a per-flow parameter: there are 60-odd
customer send sites and any one of them forgetting to pass a language would be
a silent English message.

**English is byte-identical when nothing is stored.** `messages/golden.snapshot.json`
pins all 103 rendered English payloads as they stood before this branch, and
`golden.test.mjs` compares against it per key. With the feature off, `langFor`
returns English WITHOUT READING THE PROFILE, so the path every order
confirmation takes gains no extra read, no registry lookup and no new way to
fail. That is not an approximation of today's behaviour, it is today's.

**A language problem never costs a message.** Hindi template, then the current
English template, then the existing LEGACY / NO_PRICE chain. The fallback fires
on TEMPLATE_UNUSABLE codes ONLY: 131049, 130472 and 131026 are rethrown
untouched, so the handling that parks a refused offer and flags a dead number
still sees them unchanged.

**Separate Meta names, and no Hindi LEGACY.** `cod_confirm_hi_v1` is its own
template at Meta rather than a second language on `cod_confirm_v3`. Every
name-keyed map in the service therefore keeps working untouched, and the owner
can rewrite the Hindi at gate G1 and bump to `_hi_v2` without putting a word of
English back through review. There is no Hindi LEGACY because the fallback for
Hindi is English, which is the thing we know works.

### Decisions worth the argument

**The picker goes BEFORE the confirmation, and the confirmation waits five
minutes.** This is the only place in the service that deliberately delays a
customer message. The alternative, confirm in English and ask afterwards, makes
the most important message of the order the one message that ignored their
answer. Five minutes on a message that already waits three. Every other exit
from `languageGate` is "send now".

**Asked at most twice, per PHONE, across all their orders.** Being asked the
same question on every order is how an automation starts to feel like a
machine. `markLangAsked` is read-increment-write against the version it read,
like `markRto`, because two orders for one phone can be in flight at once and a
count computed from the losing row is not a cap.

**Two orders minutes apart ask once.** The queue serialises by ORDER, not by
phone, so both would have sent a picker. The second borrows the first's deadline
and waits behind it; one tap answers both, because the tap writes to the phone
and the confirmation reads from there.

**Flow L taps are dispatched before the ownership gate.** The second place in
the router that happens, and for the opposite reason to `/replace`'s. `ownsOrder`
fails OPEN on an order it has never seen, and the picker goes out before any tap
exists, so neither of its behaviours suits. `onPick` sets the language of the
phone that pressed the button and re-checks the order's stored phone STRICTLY
before touching that order, so a forged payload carrying a stranger's order sets
the forger's own language and moves nothing else.

**The picker is the one bilingual template in the registry.** Somebody who
cannot read English cannot read an English question about which language they
read. `language_select_plain_v1` carries the same question in English only, for
if Meta refuses a mixed-script body, and `askMode: 'session'` drops the template
entirely as plan B. The picker gets NO Hindi twin: a Hindi version could only be
chosen by a customer who can already read the language we are asking about.

**A failed picker is not a customer who was not told.** It records
`flowA.langAskFailed`, which releases the confirmation on the next pass, and
raises no alert and no `wa-undeliverable` tag. Nothing had been said about the
order yet.

**PROFILE rows have no TTL and must not get one.** `backfill-ttl.mjs` already
names that sort key as one it will not touch, because an expired opt-out is
marketing to somebody who said stop. A stored language inherits that property,
which is exactly what it needs.

### The part that was actually hard

Not the registries. The English assembled in JavaScript and handed in as a
variable: a Hindi body with ", size M" or "tomorrow at 9:20 PM" or an English
"there" in it. `lazy((l) => ...)` defers those until the send helper knows the
language, and resolves them AGAIN in English if the Hindi template turns out
unusable. `Lazy.toJSON` throws, because a lazy value written to DynamoDB would
serialise to `{}` and come back as a hole in a message months later. That throw
caught Flow W's email path, which shares its vars with the WhatsApp path.

Converted: `itemLine`'s three joiners and both fallbacks, `payment_line`,
`orderTotalLine`'s paid/at-delivery split inside `{{order_total}}`, both gift
lines, `refund_eta`, `formatExpiresAt`, `formatTimeLeft`, the `top_picks` joiner
and the duplicate "our best sellers" beside it, `describeVariant`, the
`vc_pick_item` row descriptions, every RTO row title, `/replace`'s `pay_line`
and item descriptions, `newItemLine`, and the `/r/` and `/p/` pages.

`/replace` PERSISTED the joined English descriptor on a request row that lives
400 days, and by the time the replacement ships a week later that string was all
there was. It stores the PARTS now (title, colour, size) beside the English
join, so the line can be assembled in the customer's language at the moment it
is sent; a request raised before this change still reads correctly from the old
field.

Session button `ctx.actions` was keyed by BUTTON TITLE TEXT, which is the one
thing about a button a translation changes. Every button carries a stable `id`
now and call sites key on that. The title lookup stays underneath and is not
dead code: a message already on a customer's phone was rendered by the old
shape.

### Out of scope, deliberately English

The SES welcome email, the WhatsApp review Flow JSON (a Hindi Flow is a second
published Flow and a second id), the Google review form, and every owner-facing
message. Owner safety is structural rather than a phone check: there are no
Hindi definitions for `ops_*` or `pnl_*`, so those fall back to English however
the owner's own language is set.

### Rollout

G0 code complete, off. G1 the owner reads `docs/hindi-copy-review.md`
(`npm run copy:hi`). G2 pilot four templates with
`templates-sync --live --only=...`. G3 the rest. G4 `enabled: true` with
`allowPhones` set to the owner's handsets, checked on a real order. G5
`allowPhones: []`. Rollback at any point is `enabled: false`; stored choices
survive and apply again when it is switched back on.

### What an adversarial read found afterwards

The 50-test suite found two bugs while being written. A separate read of the
whole branch, with the tests passing, found nine more. Worth recording because
most of them were in the same shape: code that was correct for Hindi and wrong
for the shipped state, or correct in sequence and wrong in parallel.

**The worst one was not about Hindi at all.** The `vc_pick_item` row builder is
`lines.map((l) => ...)`, and the lazy wrapper went in as `lazy((l) => ...)`.
The parameter shadowed the line item, so inside the closure `l` was the string
`'en'`: `currentVariantOf('en')` returned an empty variant and `'en'.size` was
undefined. Every row went out with a BLANK description, in both languages, with
the feature switched off. `sendList` drops an empty description, so Meta
accepted it and it failed in silence. A customer who ordered the same garment
in two colours saw two identical rows. It is the only one of 56 `lazy()` sites
that shadows its parameter, and nothing asserted that a row has a description.

**A keyword worked while the feature was off.** `langFromText` was checked
unconditionally, so a customer typing `हिंदी` got a Hindi reply saying "from
now on we will speak to you in Hindi", a stored language, and English for ever
after, because `langFor` returns English when the feature is off. The same
branch also RETURNED above the window-open hooks, so that inbound no longer
released a parked cart recovery or welcome offer: their message had just opened
the only window that could deliver it. Both fixed; `/lang` says plainly that
languages are off rather than promising one.

**Two orders seconds apart could both ask.** Every check before the send was a
read, and the queue serialises by ORDER, so two parallel records both saw no
previous ask. The sequential case was tested and passed; the parallel one was
the bug. The slot is CLAIMED now with a version-conditioned write, so
concurrent callers serialise on it: one asks, the other waits behind its
deadline, and the claim is given back if the send turns out to be skipped.

**The resend guard keyed on the language.** `SIDE#lang-resend:hi` and
`SIDE#lang-resend:en` are different rows, so tapping English, Hindi, English
produced the confirmation and TWO reminders off one picker. One key per order
now. And `resendConfirm` sends `cod_reminder` without stamping
`reminderSentAt`, so the scheduled reminder fired hours later and sent the same
message again.

**The read-your-own-write the gate depends on.** `table.get` had no
`ConsistentRead`, and DynamoDB defaults to eventually consistent. `onPick`
writes the choice and then reads it back in the same invocation to pick a
registry; a stale read sends English seconds after the customer tapped Hindi.
`getProfile` is a strongly consistent read now. It costs twice the read units
on a row this service reads a few thousand times a month, which is cents, and
it quietly closes the same window on the opt-out: STOP written by one record
and read by another seconds later.

**Two Hindi list row titles sat on exactly 24 characters**, Meta's cap, with
the only enforcement a `.slice(0, 24)` at the call site. A slice does not fail,
it truncates, and truncating Devanagari at a fixed offset can cut a combining
mark from the character it belongs to. Both shortened, and the caps are
asserted now with one character of headroom so a copy edit is not a cliff.

**The refused-Hindi cache keyed on the template name but was fed per-order
failures.** 131052 and 131053 mean "the header image could not be downloaded",
which is a fact about one order's product photo. Caching it took Hindi away
from every other customer for ten minutes. The cache now only remembers codes
that are genuinely about the template.

Every one has a regression test. The categories the read could NOT break are
worth recording too: the English-fragment-in-a-Hindi-body sweep came back clean
across all 56 lazy sites bar the shadow; `tpl`'s fallback does re-resolve vars
for English; owner-facing English holds structurally; a forged Flow L payload
touches nothing; and no `vars` object is ever persisted or logged, so neither
`Lazy` throw can land anywhere harmful.
