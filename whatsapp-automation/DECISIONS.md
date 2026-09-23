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
| C2 | Mutations exist/shape | **Validated 2026-09-20 via validate_graphql_codeblocks (admin schema):** `getOrder` query (customAttributes/paymentGatewayNames/netPaymentSet/shippingLines/fulfillments.trackingInfo/lineItems) OK; `tagsAdd` OK; `metafieldsSet` OK; `orderCancel` OK but use **`orderCancelUserErrors`** not `userErrors` (fixed); `webhookSubscriptionCreate` OK but use **`uri`** not deprecated `callbackUrl` (fixed). STILL OPEN (Phase 5/6, validate when authored): `orderEdit*`, `orderMarkAsPaid`, `orderCreateManualPayment`, `metaobjectDefinitionCreate/Create`, `discountCodeBasicCreate` | PARTLY RESOLVED |
| C3 | COD-to-prepaid accounting | which of the 3 options (order-edit remove COD line + add discount / set-qty-0 + re-add / record-full-then-refund) works per case; and whether `orderMarkAsPaid` vs `orderCreateManualPayment` leaves PAID + outstanding 0 + no leftover pending COD txn | OPEN (Phase 5 — TEST on a test order first, document the winner) |
| C4 | Standard review metafields | **RESOLVED 2026-09-20:** the theme computes the star summary + JSON-LD aggregateRating from the product's `custom.reviews` metaobject list (only ACTIVE reviews are linked), so Shopify's standard `reviews.rating`/`rating_count` metafields are optional and not maintained by the service. Discount `context:{all:ALL}` + metaobject create/def shapes validated via validate_graphql_codeblocks | RESOLVED |
| C5 | Webhook topics | `ORDERS_CREATE/UPDATED/CANCELLED`, `FULFILLMENTS_CREATE/UPDATE`, `FULFILLMENT_EVENTS_CREATE`; register idempotently (pattern proven in `meta-outcomes/shopify.mjs`) | CHOSEN (register at Phase 3) |
| C6 | Scopes | read/write orders, order edits, fulfillments, discounts, customers, products, metaobjects + metaobject definitions; protected customer data for name fields | NEEDS YOU (app scope grant — manual step) |
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
