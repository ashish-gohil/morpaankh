# meta-outcomes

Keep Meta optimising for **money received**, not orders placed. Shopify tells Meta
"Purchase" the instant a COD order is placed, but for Morpaankh only ~45% of
placed orders become money. This service watches each order to its real ending
and reports the truth back to Meta.

## What it sends

- A Conversions API custom event **`DeliveredPurchase`** when, and only when, an
  order is actually delivered and the cash is collected. Value = the real amount
  collected, currency INR, `event_id` = the numeric Shopify order id as a string
  (same convention as the Purchase event), plus SHA-256 hashed email and phone
  for matching.
- Two Meta Custom Audiences, kept in sync:
  - **MP - Delivered Buyers** (people whose orders became money)
  - **MP - Cancelled or RTO** (people whose orders did not)

It never sends a second `Purchase`. `DeliveredPurchase` is a distinct custom
event, so it can never collide with Purchase de-duplication.

## The state machine (built + tested: `src/classify.mjs`)

Every order is reduced to exactly one state:

| State | Meaning | Trigger |
|---|---|---|
| `PLACED` | created, nothing has happened | default |
| `CANCELLED_ON_CALL` | cancelled before dispatch | `cancelledAt`, or `COD-Cancelled` tag |
| `IN_TRANSIT` | dispatched, outcome open | a shipped fulfillment displayStatus |
| `RTO` | genuine return-to-origin (a real loss) | displayStatus `ATTEMPTED_DELIVERY`, OR an exact `RTO` tag (merchant applies at day-end) / `RTO Initiated via Shiprocket` tag |
| `DELIVERED_PAID` | delivered AND money collected | displayStatus `DELIVERED` **and** net payment > 0 |

**RTO tag matching is precise on purpose.** The risk-score tags `HIGH/MEDIUM/LOW RTO Risk` contain the letters "RTO" but are only predictions, not real RTOs — they never trigger RTO. Only an exact `RTO` tag or a `…RTO Initiated…` tag does. The merchant gets **replacements only** (damaged / wrong size, customer pays), never change-of-mind refunds, so a replacement is a paid sale: it counts as `DELIVERED_PAID` once the cash shows in Shopify, and genuine losses are marked with the `RTO` tag.

**Merchant policy: a courier "return" note is NOT a loss.** For this store,
"return"/"returned" notes are almost always customer-requested *replacements*,
and change-of-mind returns are not accepted, so the buyer has kept and paid for
the item. The free-text note is therefore **ignored** for classification. Only
two things decide the money-relevant outcome: `ATTEMPTED_DELIVERY` (a genuine
failed delivery) is the only RTO trigger, and cash actually collected
(`net > 0` on a `DELIVERED` order) is the only "paid" trigger. A delivered order
with a return note still counts as `DELIVERED_PAID` if the cash was collected;
one with no cash yet stays `IN_TRANSIT` until it is (never falsely paid, never
falsely lost).

Run the tests:

```bash
bunx vitest run      # or: npm test
```

## Shopify Admin API scopes required

Request these on the custom app before generating the token:

- `read_orders` — order note, tags, `cancelledAt`, `netPaymentSet`, financial status
- `read_fulfillments` — fulfillment `displayStatus` (DELIVERED / ATTEMPTED_DELIVERY / IN_TRANSIT)
- `read_merchant_managed_fulfillment_orders` — fulfillment-order detail behind those statuses
- `read_assigned_fulfillment_orders` — same, for third-party/assigned fulfilment

Plus, because the delivered event matches on email and phone, the app needs
**Protected customer data** access approved in the Partner/app settings (this is
an app-level toggle, not a scope string). We only ever read those fields to hash
them; raw PII is never logged.

Webhook topics subscribed: `orders/create`, `orders/updated`, `orders/cancelled`,
`fulfillments/create`, `fulfillments/update`.

## Credentials needed (all via env, see `.env.example`)

- `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`
- `META_ACCESS_TOKEN` (System User, `ads_management` + dataset access)
- `META_AD_ACCOUNT_ID`
- Known / discovered, confirm: `META_DATASET_ID=2138165280468636`,
  `META_BUSINESS_ID=1728084641501165`, `SHOPIFY_STORE_DOMAIN=yaaijv-6p.myshopify.com`

## Idempotency, backfill, dry-run

- **Idempotent.** A per-order ledger records the last state already reported.
  Re-processing a webhook, or two webhooks racing, can only move an order
  forward through states and sends each side effect (DeliveredPurchase,
  audience add) at most once. Meta also de-dupes on `event_id`.
- **Backfill.** First run replays orders created on/after `BACKFILL_SINCE`
  (default 2026-08-01), classifies them, and reconciles audiences before the
  live webhook stream takes over.
- **Dry-run.** `DRY_RUN=true` (the default) prints every Meta call it would make
  and writes nothing. Flip to `false` to go live.

## How it runs (deployment model = scheduled poll)

Primary path is a **scheduled poll**, deployed as an **AWS Lambda** on an
**EventBridge** timer (twice a day, daytime IST). Each run
(`src/handler.mjs` → `runPoll`):

1. loads state from S3 (ledger + last checkpoint),
2. fetches orders **updated** since the last checkpoint (first run: since
   `BACKFILL_SINCE`), minus a small overlap,
3. reconciles each idempotently (classify → CAPI when fresh → audiences),
4. advances the checkpoint and writes state back to S3 (once).

Lambda uses `STATE_BACKEND=s3` (its disk is ephemeral) and **reserved
concurrency = 1** so two runs never touch the state object at once.
`@aws-sdk/client-s3` is provided by the Node 20 Lambda runtime (nothing to
bundle). An optional always-on webhook path (`src/server.mjs`) also exists.

```bash
# Tests (offline, no credentials)
bunx vitest run

# One poll run locally in dry-run: real Shopify reads, prints what it WOULD
# send to Meta, writes nothing. First run also backfills from BACKFILL_SINCE.
node src/poll.mjs

# Manual full re-seed since BACKFILL_SINCE (ignores the checkpoint)
node src/backfill.mjs
```

Flip `DRY_RUN=false` only after a dry-run looks right and the Meta token is in.

## Won't-break guarantees (do-no-harm review)

- **Nothing on the storefront changes.** No theme, pixel, or tag edits. The
  browser Purchase and the Facebook & Instagram channel's server Purchase are
  untouched. This service only *reads* Shopify and *adds* a new Meta event.
- **New, distinct event.** `DeliveredPurchase` is a custom event, never
  `Purchase`. Different event_name means it can't merge with, dedupe against, or
  inflate Purchase, and it doesn't touch any campaign currently optimising for
  Purchase. Sharing event_id with the order only dedupes DeliveredPurchase
  against itself.
- **Read-only on Shopify.** Scopes are all `read_*`. The app cannot cancel,
  refund, tag, fulfil, or alter any order. Worst case of a bug is a wrong Meta
  event, never a change to store data or other apps.
- **No order counted twice.** Three independent guards: the per-order ledger
  (`deliveredSent`), a per-order in-process lock (`lock.mjs`, serialises
  concurrent webhooks for the same order), and Meta's own event_id dedupe.
- **No false revenue.** "Paid" requires cash actually collected (`net > 0` on a
  DELIVERED order); the value sent is that real collected amount. A "return"
  note never fabricates or removes revenue on its own.
- **Backfill can't spike optimisation.** Historical deliveries older than
  `BACKFILL_CAPI_MAX_AGE_DAYS` (7) seed the audience but do NOT emit a
  mis-dated conversion event.
- **Additive on Meta.** The new `meta-outcomes` system user was granted access
  alongside existing users (COD King, etc.); nothing was revoked or reconfigured.
- **Independent of the Job 1 duplicate-Purchase issue.** This service neither
  causes nor worsens it.

### Operational must-dos for a safe go-live

1. Keep `DRY_RUN=true` for the first `node src/backfill.mjs`, read the output.
2. Set `META_TEST_EVENT_CODE` so the first live DeliveredPurchase lands in
   Events Manager → Test Events, not in live data. Remove it once verified.
3. **Persist `data/state.json` on durable storage** (EBS/EFS/DB). If it lives on
   an ephemeral container disk and is lost on redeploy, the idempotency memory
   resets. Meta's event_id dedupe still covers re-sends within its window, but
   the ledger is the real guarantee.
4. Run `backfill` to completion *before* starting the webhook server (the lock
   is per-process; don't run both against the same data at once).

## Status

- **Done:** the app `Meta Outcomes Sync` was created and installed on the store
  (2026-09-03) with the four read scopes; the Admin automation token and client
  secret are in `.env` (token expires **2027-03-04**, rotate before then). The
  full service is built: classifier, Shopify GraphQL client, hashing, CAPI
  sender, audience sync, idempotent ledger, HMAC webhook server, backfill. 24
  unit tests pass.
- **Needed from you:** `META_ACCESS_TOKEN` + `META_AD_ACCOUNT_ID` in `.env`
  (system-user token with `ads_management` + dataset access), and a
  `PUBLIC_BASE_URL` (tunnel or deployment) for live webhook delivery. Backfill
  and dry-run work without the public URL.
- **Not yet verified live:** this sandbox blocks outbound calls, so the Shopify
  token was not exercised here. First `node src/backfill.mjs` run (dry-run)
  confirms it end to end.
