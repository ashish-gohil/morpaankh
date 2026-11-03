# WhatsApp order automation service (Morpaankh) — PLAN

Status: **Phase 1 deliverable. Awaiting your approval before any code is written.**

This is the folder layout, module map, data model, phase breakdown, open questions, and
your manual steps. Nothing here has been deployed or run. No customer has been messaged.
Every "confirm" item from the spec is tracked in `DECISIONS.md`.

---

## 1. What this is, and how it relates to what already exists

A new, self-contained service that sends customer WhatsApp messages for the Shopify store
through Meta's WhatsApp Cloud API directly (no BSP). It covers Flow A (COD confirm / cancel /
COD-to-prepaid), Flow B (delivered -> review -> code + on-site reviews), Flow C (NDR rescue +
RTO reasons), Flow D (owner alerts, digest, reconciliation, admin scripts).

Two Node services already live in this repo. I read both:

- **`meta-outcomes/`** — AWS Lambda + Meta Graph API + Shopify Admin GraphQL + scheduled poll +
  idempotency ledger. This is the pattern I mirror for code style: ESM `.mjs`, hand-rolled
  `config`/`assertConfig`/`redact`, `DRY_RUN=true` default, lazy `@aws-sdk` imports, global
  `fetch` Shopify client, HMAC verify with `timingSafeEqual`, region `ap-south-1`, Vitest.
- **`shipping-integration/`** — a never-deployed (accounts blocked) prior attempt that already
  contains a **direct Meta WhatsApp Cloud API client** (`src/clients/whatsapp.js` with
  `normalizeIndianPhone` + template send), Shopify HMAC verify, a courier status map, and
  COD-confirmation / review-request automations. **The new service supersedes its WhatsApp,
  COD, and review flows.** I will lift the phone normalizer and the send shape, and leave
  `shipping-integration/` untouched and dormant.

**Guardrail (double-messaging):** the new service must be the *only* thing sending order
WhatsApp/SMS. Before go-live, `shipping-integration` automations stay off, the old
`node-workflow` automations stay off, and COD King's own post-order WhatsApp/SMS is turned off
(kept: OTP + abandoned cart). Listed in README manual steps and in `DECISIONS.md`.

**No change to the Shopify app / theme / checkout / COD King settings** happens without your
explicit go-ahead. The `partial-payment` product is never touched. Checkout files are never
touched.

---

## 2. Tech decisions (headline — these gate everything; see the questions at the end)

The spec says default to TypeScript-strict + CDK v2 *"only where no convention exists."* A
convention **does** exist (`meta-outcomes` = plain ESM JS, Vitest, shell/CLI deploy), so my
recommended defaults follow the repo, not the spec's fallback:

| Area | Recommended | Why | Spec fallback (override on request) |
|---|---|---|---|
| Language | **ESM JavaScript (`.mjs`) + JSDoc types** | Matches `meta-outcomes`; no build step to maintain across the repo's services | TypeScript (strict) |
| Type-checking | `tsc --noEmit --checkJs` over the pure-logic modules only (phone, classification, money, windows, payloads) | Catches the dangerous mistakes without a compile step | full TS everywhere |
| Tests | **Vitest** | Matches `meta-outcomes` | (same) |
| IaC | **AWS CDK v2 authored in JavaScript** | ~12 resource types (API GW HTTP API, DynamoDB, SQS FIFO+DLQ, 4 Lambdas, EventBridge Scheduler + rules, Secrets Manager, SSM, SNS, alarms); a hand-rolled shell script (the `meta-outcomes` convention) would be fragile for this much IAM/wiring | plain shell/CLI, or SAM |
| Region | `ap-south-1` (Mumbai) | Matches `meta-outcomes`; customers + store are in India | (same) |
| Runtime | Node.js 20.x on Lambda | Matches `meta-outcomes` deploy | latest LTS Lambda supports |

Everything in the spec's section 4 architecture (DynamoDB single-table, SQS FIFO + DLQ,
EventBridge Scheduler one-time timers, Secrets Manager, API Gateway) is followed as written.
It is genuinely warranted here: unlike `meta-outcomes` (twice-daily batch, safe on an S3 JSON
blob), this service is real-time, per-order-serialized, timer-driven, multi-provider, and moves
money, so it needs ordering, durable timers, optimistic locking, and dedupe.

---

## 3. Folder layout

```
whatsapp-automation/
  PLAN.md                     # this file
  DECISIONS.md                # every "confirm" item + chosen defaults + status
  README.md                   # setup + manual steps (Phase 10)
  RUNBOOK.md                  # ops: alarms, DLQ replay, token expiry (Phase 10)
  package.json                # type: module, vitest, jsdoc-typecheck script
  jsconfig.json               # checkJs on src/domain + src/lib pure modules
  .env.example                # every var, documented; real .env is gitignored
  .gitignore

  src/
    config.mjs                # env + non-secret config (SSM/Dynamo overrides at runtime)
    secrets.mjs               # Secrets Manager fetch, 5-min in-memory cache, redact()
    log.mjs                   # masked structured logging (phone -> last 4) + EMF metrics

    lib/                      # provider-agnostic primitives (pure where possible)
      phone.mjs               # normalizeVerifiedPhone() — verified-attr only (hard rule 1)
      money.mjs               # paise integers, en-IN formatting
      time.mjs                # Asia/Kolkata quiet hours, send windows, caps, expiries
      ids.mjs                 # button-payload encode/decode, timer names, tokens (HMAC)
      signature.mjs           # timing-safe HMAC verify per provider + base64/hex/isBase64
      dedupe.mjs              # DynamoDB conditional-put dedupe (TTL 7d)

    store/
      table.mjs               # single-table DynamoDB access (get/put/update, optimistic version)
      orderState.mjs          # ORDER#<id>/STATE + MSG + SIDE (idempotency) helpers
      phoneProfile.mjs        # PHONE#<e164>/PROFILE (optOut, window, awaiting, takeover, caps)
      maps.mjs                # AWB#, PAYLINK#, PAYTOKEN# -> orderId

    clients/                  # each behind an interface + a fake for tests
      whatsapp.mjs            # Cloud API: template + session sends, inbound parse, statuses
      shopify.mjs             # Admin GraphQL client + order fetch + mutations + webhooks-sync
      razorpay.mjs            # PaymentLinks interface (create/cancel/refund/reuse)
      courier.mjs             # Courier interface (track/edit-to-prepaid/cancel/NDR) — Delhivery
      fakes/                  # in-memory fakes for all four, used by tests + DRY_RUN replay

    domain/                   # pure business logic, no I/O — heavily unit-tested
      classify.mjs            # COD | PARTIAL | PREPAID | UNKNOWN (classify once, store)
      eligibility.mjs         # per-flow eligibility (startAt, cancelled, tags, opt-out)
      amounts.mjs             # codFee, newTotal, saving, link expiry (paise)
      courier-status.mjs      # Delhivery status/NSL -> internal state enum
      flowA.mjs flowB.mjs flowC.mjs   # state machines: (state, event) -> actions
      moderation.mjs          # review moderation (URL/email/phone/word list) — rating-blind

    ingest/                   # API Gateway HTTP handlers: verify, dedupe, 200 fast, enqueue
      shopify.mjs whatsapp.mjs razorpay.mjs delhivery.mjs
      pay-redirect.mjs        # GET /p/{token}
      onboarding.mjs          # GET /onboarding + POST /onboarding/exchange (flagged)

    worker/                   # SQS FIFO consumer (batch 1, partial-batch-failure)
      index.mjs               # route by message kind -> flow handlers; re-fetch before side effects
      flowA.run.mjs flowB.run.mjs flowC.run.mjs flowD.run.mjs

    timers/                   # EventBridge Scheduler helpers + recurring jobs
      schedule.mjs            # create/replace/delete one-time schedules (deterministic names)
      poll-delhivery.mjs reconcile.mjs digest.mjs

  messages/                   # THE ONLY place with customer-facing text (spec section 5)
    templates.mjs             # Meta template registry (name+version, category, placeholders)
    session.mjs               # free-form session messages
    labels.mjs                # payload ids, RTO reasons, NDR options, moderation list, status text
    rules.mjs                 # config/rules.ts equivalent: every number + timing (section 10)
    flows/review.flow.json    # WhatsApp Flow (SURVEY) JSON
    README.md                 # how to edit copy (version-bump rule, sync)
    *.test.mjs                # registry shape rules (lengths, dashes, placeholder positions)

  scripts/                    # IAM-protected admin/setup scripts (not public)
    templates-sync.mjs flows-sync.mjs shopify-webhooks-sync.mjs reviews-setup.mjs
    dryrun-render.mjs send-test.mjs replay-dlq.mjs pause-flow.mjs resend.mjs

  iac/                        # AWS CDK v2 (JavaScript)
    app.mjs bin/ lib/*-stack.mjs cdk.json

  theme/                      # Flow B on-site reviews — patches to the LIVE theme
    (edits under the repo's existing theme/ dir, pushed with the usual CLI; see Phase 6)
```

---

## 4. Data model — DynamoDB single table (on-demand, PITR on, TTL `expiresAt`)

`PK` / `SK` design (all per spec section 4):

| PK | SK | Purpose |
|---|---|---|
| `ORDER#<id>` | `STATE` | class, riskTag, verifiedPhone, firstName, amounts(paise), codFee, AWB, courierStatus, per-flow sub-state, `version` (optimistic lock) |
| `ORDER#<id>` | `MSG#<wamid>` | message key, template+version, status history, error codes, pricing category |
| `ORDER#<id>` | `SIDE#<action>` | idempotency record for each external side effect (order edit, payment, courier edit, refund, code, tags) |
| `PHONE#<e164>` | `PROFILE` | optOut, lastInboundAt, awaiting{type,orderId,until}, humanTakeoverUntil, lastMarketingAt, lastReviewAskAt, undeliverable |
| `AWB#<awb>` | `MAP` | -> orderId |
| `PAYLINK#<id>` | `MAP` | -> orderId |
| `PAYTOKEN#<token>` | `MAP` | -> orderId |
| `EVENT#<source>#<id>` | `DEDUP` | provider event dedupe, TTL 7d |

- **GSI1 (sparse):** `activeShipment` -> item, for the Delhivery poller to scan only live AWBs.
- Every `STATE`/`PROFILE` write is a conditional update on `version` (optimistic lock).
- `expiresAt` set 180 days after a terminal state.

---

## 5. AWS resources (CDK)

- **API Gateway HTTP API** with routes: `POST /webhooks/shopify`, `GET|POST /webhooks/whatsapp`,
  `POST /webhooks/razorpay`, `POST /webhooks/delhivery`, `GET /p/{token}`, `GET /onboarding`,
  `POST /onboarding/exchange` (last two behind a flag).
- **4 ingest Lambdas** (one per provider family) + **pay-redirect** + **onboarding** Lambdas.
- **SQS FIFO queue + FIFO DLQ** (maxReceiveCount 5). `MessageGroupId` = `order:<id>` (or
  `phone:<e164>`); `MessageDeduplicationId` = source event id.
- **Worker Lambda** (batch size 1, partial-batch-failure reporting, reserved concurrency 5).
- **EventBridge Scheduler** one-time schedules (`at(...)`, Asia/Kolkata, flexible window off,
  ActionAfterCompletion DELETE) targeting the FIFO queue; deterministic names
  `<flow>-<orderId>-<step>`. Plus **EventBridge rules** for recurring jobs (poll hourly
  08:00-22:00 IST, reconcile 02:30, digest 09:30).
- **DynamoDB** table (above). **Secrets Manager** one JSON secret. **SSM Parameter Store** (or a
  Dynamo config item) for non-secret flags so they change without a redeploy.
- **CloudWatch** EMF metrics + alarms (worker errors, DLQ depth > 0, WhatsApp failure spike,
  courier API failures) -> **SNS** email (same opt-in pattern as `meta-outcomes`).
- IAM least-privilege per Lambda (only the table/queue/secret/scheduler actions it needs).

---

## 6. Config & secrets (mirrors `meta-outcomes`)

- **Secrets Manager** (one JSON, cached 5 min): WhatsApp token/app-secret/verify-token/phone-number-id/WABA-id;
  Shopify admin token + webhook secret; Razorpay key id/secret/webhook secret; Delhivery creds +
  push secret; pay-token + flow-token signing keys.
- **Non-secret config** (SSM/Dynamo, hot-swappable): shop domain, Shopify API version, Graph
  version, public base URL, `OWNER_ALERT_PHONES`, `DRY_RUN`, `SEND_ALLOWLIST`, `ORDER_ALLOWLIST`,
  per-flow `enabled` + `startAt`.
- **Defaults:** all flows **OFF**, `DRY_RUN=true`. Nothing sends until a flag is flipped.
- Local dev reads `.env` with the same tiny hand-rolled reader as `meta-outcomes` (no dotenv dep).

---

## 7. Phases (each: typecheck + lint + tests green + one small commit)

1. **PLAN.md + DECISIONS.md** — this. **Stop for approval.** (No code, no commit yet.)
2. **Skeleton:** CDK stacks, config, secrets, DynamoDB, SQS FIFO + DLQ, ingest + worker wiring,
   signature verify, dedupe, masked logging, flags, `DRY_RUN`, allowlists. Deploys nothing live.
3. **Clients + fakes:** WhatsApp, Shopify, Razorpay, Courier, each behind an interface with a
   fake; `shopify-webhooks-sync` script.
4. **messages/** registry + session + labels + rules; `templates-sync`, `flows-sync`; registry
   tests (lengths, dash ban, placeholder positions, examples, sanitization).
5. **Flow A** (COD confirm / cancel / COD-to-prepaid) + all its timers + accounting paths.
6. **Flow B** (delivered -> review Flow -> code) + `reviews-setup` metaobjects + **theme** reviews
   section/JSON-LD + WhatsApp notice locale strings.
7. **Flow C** (NDR rescue + RTO reasons).
8. **Flow D** (alerts, digest, reconciliation, admin scripts) + alarms.
9. **Onboarding** page (coexistence embedded signup / dedicated number), behind a flag.
10. **README.md + RUNBOOK.md** + final `DECISIONS.md` pass.

Testing per spec section 14 (unit + integration with fakes + recorded fixtures). Staging
end-to-end only after you say go (Meta test number, Razorpay test mode, a Delhivery staging AWB,
orders placed by you only via `ORDER_ALLOWLIST`).

---

## 8. Guardrails I will enforce every phase

- Recipient = `_otpVerifiedPhoneNumber` only; never any user-typed phone. Missing/invalid ->
  tag `wa-no-verified-phone`, count in digest, send nothing.
- Business-initiated = approved templates only; free-form only inside an open 24h window (10-min
  safety margin). Utility templates carry no offer/discount wording.
- Only orders created after each flow's `startAt`. No backfill.
- Opt-out (STOP/UNSUBSCRIBE/OPT OUT) honored; START re-opts. Caps enforced (2 business msgs/
  order/flow; 1 marketing/phone/7d; 1 review ask/phone/14d). Quiet hours 21:30-09:30 IST.
- Reviews: code for any genuine review regardless of rating; moderation never depends on rating.
- No em/en dash and no emoji in any customer copy (enforced by a registry test).
- Worker re-fetches the order and re-checks eligibility before ANY side effect.
- Never touch `partial-payment`, checkout files, or COD King's partial-payment flow. Partial
  orders excluded from Flow A (still get B and C).
- Every mutation validated against the live Shopify schema before it ships (`validate_graphql_codeblocks`).

---

## 9. Open questions for you (answered at the approval gate)

1. **Language:** ESM JS + JSDoc (recommended, matches repo) or full TypeScript-strict (your
   spec default)? This one is expensive to change later.
2. **IaC:** CDK v2 in JavaScript (recommended) or plain shell/CLI (repo convention) or SAM?
3. **Service directory name** `whatsapp-automation/` acceptable?
4. **Branch:** new `whatsapp-automation` branch off `main` (we are on `audit/seo-perf`), or
   continue here?
5. **Courier API variant:** does this Delhivery account use the **express API static token**
   (`track.delhivery.com`) or **Delhivery One** (client id + secret)? Needed before Flow C; I
   will build behind the `Courier` interface either way, but the concrete client differs.
6. **Payment links = Razorpay** even though checkout runs on **Cashfree** (means a second PG
   account + its fees). Spec says Razorpay behind a `PaymentLinks` interface with Cashfree added
   later — confirming you want to open/keep a Razorpay account for this.

Everything else marked "confirm" in the spec I will verify from Meta/Shopify/Razorpay/Delhivery
docs or the live API at the start of the phase that needs it, and record the finding in
`DECISIONS.md` (current best-known values are already listed there).

---

## 10. P&L report (`wa-pnl-report`, 2026-11-03)

One month's profit and loss as an .xlsx, from live sources only, delivered to the owner.
Automatic on the 7th at 09:00 IST for the previous month; manual by `/pnl`, `npm run pnl`,
or `aws lambda invoke`.

### 10.1 The five things the brief assumed that this repo does not have

Each one is a real build item, not a config flag.

| Assumed | Reality | What we do |
|---|---|---|
| `exceljs` is available | zero runtime deps; the shared Lambda asset excludes `node_modules` (`iac/lib/stack.js:29-31`) | a **Lambda layer**, built by `npm run pnl:layer`, carrying `exceljs` + `@aws-sdk/client-s3`. Synth throws if the layer dir is missing so a deploy cannot silently ship a broken function |
| WhatsApp can send a document | no `document` type, no `/media` upload (`whatsapp.mjs`) | add `whatsapp.uploadMedia(bytes, filename, mime)` and `whatsapp.sendDocument({to, mediaId, filename, caption})`, both through the existing `post()` so they inherit DRY_RUN, the allowlist, retries and `metric('MessageSent',{type})` |
| SES can attach a file | `Content.Simple` only (`email.mjs:122-136`) | add `email.sendWithAttachment()` building MIME for `Content.Raw`. Keep `send()` untouched |
| an S3 bucket exists | none anywhere in the stack | new RETAIN + versioned + SSE + BLOCK_ALL bucket |
| the worker can run the report | worker timeout 60 s, `lambda:InvokeFunction` granted to nobody | `/pnl` acks in the worker, then async-invokes `wa-pnl-report` (`InvocationType: 'Event'`). One scoped IAM statement on that one function ARN |

### 10.2 Shape: adapters -> engine -> builder

The engine is pure and type-checked. Adapters do I/O, the builder only renders.

```
src/domain/pnl/            PURE, in the jsconfig typecheck set
  cohort.mjs      month boundary (IST), who is in, who is excluded
  outcome.mjs     DELIVERED | RTO | PENDING | LOST | CANCELLED, Delhivery first
  gst.mjs         slab rule, back GST out of an inclusive price
  engine.mjs      rows + totals from normalized inputs. No clients, no clock, no fs
src/pnl/                   I/O
  sources/shopify.mjs      the month's orders, own query, own field set
  sources/delhivery.mjs    tracking (chunked by 25) + charges per leg, cached
  sources/meta.mjs         campaign insights by day, paged
  sources/gateway.mjs      Razorpay fees; Cashfree -> config rate, ASSUMED
  sources/ledger.mjs       parse an uploaded wallet/invoice file by HEADER NAME
  sources/replacements.mjs REPL# rows for the month
  snapshot.mjs             normalized inputs + totals -> S3
  workbook.mjs             exceljs, 13 sheets
  deliver.mjs              WhatsApp document + summary, email, S3
src/timers/pnl-report.mjs  the Lambda handler
src/worker/pnl.run.mjs     /pnl and /pnl-ledger
scripts/pnl.mjs            npm run pnl
```

### 10.3 Rules carried over from `finance/pnl.mjs`, and the four that change

Ported as-is: RTO recovers COGS in full (the garment comes back); packaging is charged on
RTO too; a partial-payment order with duplicated line titles is **refused, not guessed**;
only complete rows contribute to a total; `missing[]` vs `assumed[]` per row; the trust
report (coverage %, tally of reasons, loss-making orders).

Changed, with the reason:

1. **Money moves to integer paise.** `finance/pnl.mjs` uses floats plus `r2()`;
   `src/lib/money.mjs` says integer paise everywhere and format only at the edge.
2. **GST is slab-based, not one rate.** 5% up to Rs 2,625 incl. GST per unit after
   discounts, 18% above; flag a line within Rs 100 of the threshold. The old engine booked
   **zero** GST when `pricesAreGstInclusive` was false; we never book zero silently.
3. **`inputCreditOnCogs` is actually read.** It was dead config before.
4. **Delhivery decides the outcome, not Shopify.** The old engine trusted
   `shipment.status` loosely and inferred delivery from `financialStatus === 'PAID'`.
   A paid status alone never proves delivery here.

### 10.4 Facts proven against the live APIs on 2026-11-03

Recorded in full in `DECISIONS.md` section V. The ones that shape the code:

- Shopify's `created_at:` search filter **ignores the time of day**, so a month window must
  over-fetch a day either side and filter in code on the real `createdAt`.
- `ss=RTO` on the charges API returns **both legs in one row** (`charge_DL` and
  `charge_RTO`). Never add a separate forward charge to it.
- There is **no API source for Delhivery's real scanned weight**: `ChargedWeight` is null on
  every shipment and the charges API echoes back the `cgm` you sent. Every computed charge
  therefore rests on an assumed weight and is flagged.
- On an RTO parcel `DeliveryDate` is the **return-accepted** time, not customer delivery.
- `ref_ids` finds nothing for #1205 or #1233, so a fulfilled order without an AWB is MISSING.
- No Delhivery wallet/invoice API exists on this account; actuals come from the owner's upload.
- `courier.track` silently truncates to 25 AWBs. Chunk like `src/timers/track-active.mjs:21-25`.

### 10.5 Guardrails

- Never invent a number. A missing cost flags the row, leaves it out of totals, and is
  counted on Summary with the money it affects.
- Read-only towards Shopify, Delhivery, Meta and the gateways. Writes only to S3, the table
  (`PNL#<month>` lock + snapshot index; `PNL#` is a free prefix) and messages to the owner.
- `PNL#` rows must not use SK `STATE`, `REC`, `SUB` or `REPLOPEN`, and must never carry an
  `activeShipment` attribute (that is what puts a row in GSI1 and makes the poller track it).
- Workbook holds display name, city, state, pincode. No phone, no email, no street address.
- Every money cell that is a total is a live formula **with its cached result written**.
- Same inputs -> same workbook, except the generated-at stamp.
