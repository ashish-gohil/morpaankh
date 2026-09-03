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
| `RTO` | shipped and returned | note matches `/return/i`, or displayStatus `ATTEMPTED_DELIVERY` |
| `DELIVERED_PAID` | delivered AND money collected | displayStatus `DELIVERED` **and** net payment > 0 |

**RTO is checked before DELIVERED_PAID on purpose.** An order that Shopify shows
as `DELIVERED` but whose courier note says it was returned classifies as `RTO`,
never `DELIVERED_PAID`. That case is real in the data and is covered by a test.

The note is read defensively (it is free text from a courier integration). The
matcher defaults to `/return|\brto\b|\brts\b|sent back/i` and is overridable via
`META_RETURN_REGEX` with no code change.

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

## How to run

```bash
# 1) Tests (offline, no credentials)
bunx vitest run

# 2) Backfill in dry-run: classify every order since BACKFILL_SINCE and print
#    exactly what it WOULD send to Meta. Writes nothing to Meta.
node src/backfill.mjs

# 3) Live webhook server (needs PUBLIC_BASE_URL). Registers the 5 topics,
#    verifies HMAC, processes each order idempotently.
node src/server.mjs
```

Flip `DRY_RUN=false` only after a dry-run looks right and the Meta token is in.

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
