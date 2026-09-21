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
| B1 | Graph API version | spec: v25.0; `shipping-integration` used v20.0; `meta-outcomes` uses v21.0. Will pin the current stable at Phase 3 and put in config | OPEN (Phase 3) |
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
| E1 | API variant | **Express API, static token** (`track.delhivery.com` / staging `staging-express.delhivery.com`); `Authorization: Token <token>` | **CONFIRMED 2026-09-20 (you chose 3a).** I cannot detect which API your *account* actually has without the credentials/dashboard; building to Express. Concrete endpoints verified from Delhivery docs at Phase 7; if the account turns out to be Delhivery One, only `clients/courier.mjs` changes (interface stays) |
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
