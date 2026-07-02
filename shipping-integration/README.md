# MorPaankh — Shipping Integration (Shopify ↔ Shiprocket)

A small, stateless webhook service that connects the MorPaankh Shopify store to
Shiprocket. It implements the three integration flows that **cannot** live in a
Shopify theme (a theme has no server, secrets, or webhook endpoints):

| Flow | Trigger | What it does |
|------|---------|--------------|
| **1. Shipment creation on order placement** | Shopify `orders/create` webhook | Creates a Shiprocket order, assigns an AWB, schedules pickup, and writes the tracking number + URL back onto the Shopify order as a fulfillment (which also fires Shopify's shipment email). |
| **2. Real-time tracking status sync** | Shiprocket tracking webhook | Maps the courier status to a Shopify fulfillment event (in_transit / out_for_delivery / delivered / failure). |
| **3. Delivery / RTO event handling** | Shiprocket tracking webhook | On RTO, tags the Shopify order `RTO` and adds an order note so the top-priority signal is visible in admin. |

The **customer-facing tracking display** lives in the theme (the `/pages/track-order`
page and the order-page callout) and reads the tracking data this service writes back.

## Automation hub (scheduled by node-workflow)

The service also hosts idempotent automation tasks under
`POST /automations/:task/run` (auth: `x-automation-secret` header). They are
called on a schedule by the node-workflow platform (`~/node-workflow`), which
owns run history and retries; the endpoints own the Shopify queries, fan-out
message sending, and dedup (order tags / a shop-metafield ledger):

| Task | What it does |
|------|--------------|
| `abandoned-checkouts` | WhatsApp recovery message ~1h after checkout abandonment (marketing consent gated) |
| `cod-confirmation` | WhatsApp confirmation for new COD orders (RTO reduction) |
| `review-requests` | Review ask 3 days after delivery (consent gated) |

Shipped/delivered WhatsApp notifications are event-driven inside the
Shiprocket tracking handler, not scheduled. Message templates:
`docs/whatsapp-templates.md`. Seed the flows: `scripts/seed-workflows.mjs`.
Everything is off until the relevant env vars are set (see `.env.example`);
`AUTOMATION_DRY_RUN=true` rehearses a full run without sending or tagging.

```
Shopify order placed ──▶ orders/create webhook ──▶ [this service] ──▶ Shiprocket create order + AWB
                                                          │
                                                          └──▶ Shopify fulfillment (tracking #, URL)

Shiprocket status change ──▶ tracking webhook ──▶ [this service] ──▶ Shopify fulfillment event
                                                          └──(RTO)──▶ tag order + note
```

## Why a separate service?
This repo's storefront is a pure Shopify theme — there is no existing backend,
order-flow code, or API layer to extend. Webhook receivers need an always-on
HTTPS endpoint with secrets, so they belong in a deployable service, not in
Liquid. This is the standard architecture for code-level Shopify integrations.
(If you prefer zero code to maintain, Shiprocket's official Shopify app does the
same flows by configuration — see the project notes.)

## Setup
1. **Install** (Node ≥ 18):
   ```bash
   cd shipping-integration
   npm install
   cp .env.example .env   # then fill in real values
   ```
2. **Shopify custom app** (Admin → Settings → Apps → Develop apps): create an app,
   grant scopes `read_orders`, `write_orders`, `read_fulfillments`, `write_fulfillments`,
   `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`.
   Copy the **Admin API access token** → `SHOPIFY_ADMIN_TOKEN` and the **API secret**
   → `SHOPIFY_API_SECRET`.
3. **Shiprocket**: create an **API user** (Settings → API → Create an API User) and
   put its email/password in `.env`. Set `SHIPROCKET_PICKUP_LOCATION` to your pickup
   nickname.
4. **Run locally:** `npm run dev` then hit `GET /health`.

## Deploy
Deploy to any always-on Node host (Render, Railway, Fly.io). Set the same env
vars in the host dashboard. Then register the webhooks:

```bash
PUBLIC_URL=https://your-service.onrender.com npm run register-webhooks
```

This subscribes Shopify's `orders/create` webhook and prints the Shiprocket
webhook URL + header to paste into **Shiprocket → Settings → API → Webhooks**
(URL `…/webhooks/shiprocket/tracking`, header `x-api-key` = your
`SHIPROCKET_WEBHOOK_TOKEN`).

## Endpoints
- `GET  /health` — liveness check.
- `POST /webhooks/shopify/orders-create` — HMAC-verified (Shopify).
- `POST /webhooks/shiprocket/tracking` — token-verified (`x-api-key`).

## Status mapping
See `src/statusMap.js`. RTO is matched first and always flags the order; other
statuses map to the nearest Shopify fulfillment event. Courier status strings
vary, so the matcher is substring-based and easy to extend.

## Notes / limitations
- **Stateless:** order↔shipment mapping is by order number (no database). The
  tracking webhook looks the Shopify order up by `name`.
- **Idempotency:** Shopify rejects a second fulfillment on an already-fulfilled
  order, so re-delivered `orders/create` webhooks won't double-ship; the error is
  logged, not fatal.
- **Testing live** requires real Shopify + Shiprocket credentials. Syntax is
  verified with `node --check`; business flows should be smoke-tested against a
  Shiprocket test order before go-live.
- Confirm the Admin API version (`SHOPIFY_API_VERSION`) matches your store; the
  fulfillment-order REST shapes are stable across recent versions.
