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
