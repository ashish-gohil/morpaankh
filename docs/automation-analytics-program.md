# MorPaankh growth infrastructure program

Written 2026-07-02. Three tracks, in order: (1) order automation, (2) storefront
performance, (3) analytics. Goal: more orders, at near-zero monthly cost.

## Why this shape (and not a "SaaS rebuild")

The store is a Shopify theme plus one small Express service. There is no
backend in the buying path and no reason to create one. Everything below uses
what already exists:

- **Storefront** (this repo, `theme/`): system of record for catalog, checkout,
  design. Feature flags already exist as section-schema settings. Only two
  changes planned: a performance pass and one analytics module.
- **node-workflow** (`~/node-workflow`): Ashish's n8n-style platform.
  Verified 2026-07-02: builds clean, all 44 executor tests pass under vitest.
  Serverless (Lambda + SQS + EventBridge + MongoDB Atlas + Vercel), which fits
  the free-tier constraint.
- **shipping-integration** (`shipping-integration/`): existing Express service
  with Shopify HMAC verification and Admin API client. Grows into the
  "automation hub" that hosts task endpoints.

## Track 1 — order automation

### Platform capabilities, verified in code

Works today: ManualTrigger, SchedulerTrigger (cron poller), HttpRequest
(timeouts, retryable-error semantics), If (AND-combined conditions), Set,
expression interpolation `{{Node Name.output.field}}`, per-run immutable audit
trail, SQS-backed retries.

Not implemented (do not design against): Delay node (file is a design doc,
commented out of the registry), Code node, webhook trigger (untested, no
registration route), any loop/split node.

### Consequence: the split of responsibilities

Because there is no loop node, flows cannot fan out over a list of checkouts
or orders. So:

- **node-workflow does**: scheduling, run history, retries, on/off switches,
  a visual place to see every automation.
- **The hub does**: each automation is one idempotent HTTP endpoint
  (`POST /automations/<task>/run`, shared-secret header) that queries Shopify,
  iterates, sends messages, marks each object processed, and returns a summary
  the flow can assert on.

Idempotency: mark processed objects with Shopify order tags or metafields
(e.g. tag `mp-auto-cod-confirm-sent`), not time windows alone. Safe across
retries, downtime, and overlapping runs.

### The four flows (v1)

| Flow | Schedule | Hub endpoint queries | Sends |
|---|---|---|---|
| Abandoned checkout recovery | every 15 min | `abandonedCheckouts` older than 1h, not yet contacted | WhatsApp utility template + Brevo email, with checkout recovery URL |
| COD confirmation | every 15 min | unfulfilled COD orders without confirm tag | WhatsApp template asking customer to confirm the order (cuts RTO) |
| Shipped / delivered notify | event-driven already | (extends existing Shiprocket webhook handlers) | WhatsApp on shipped + delivered |
| Review request | daily | orders delivered 3 days ago without review tag | WhatsApp/email asking for a review |

Also: turn ON Shopify's native abandoned-checkout email automation
(Marketing → Automations). It is free, has the best deliverability, and ships
in minutes. The hub's abandoned-checkout flow then leads with WhatsApp, which
native Shopify cannot do. Do not send both emails; keep native email + hub
WhatsApp.

Voice rules apply to every message: MorPaankh (one word), no fake urgency, no
handcrafted claims, no em dashes, honest offers only.

### Deployment map (free tiers)

| Piece | Where | Cost |
|---|---|---|
| node-workflow API + poller + executor | AWS Lambda + SQS + EventBridge (per its DEPLOYMENT.md) | free tier |
| node-workflow frontend | Vercel | free |
| Database | MongoDB Atlas M0 | free |
| Automation hub (shipping-integration) | AWS Lambda + API Gateway via serverless-http (same AWS account) | free tier |
| Email | Brevo | free 300/day |
| WhatsApp | Meta WhatsApp Cloud API, direct | ~1,000 free conversations/mo, then ~Rs 0.35/utility msg |

### User setup checklist (only Ashish can do these)

Start 1 and 2 immediately; Meta business verification can take days.

1. **Meta WhatsApp Cloud API**: business.facebook.com → create app →
   WhatsApp → add and verify business + phone number (must not be an active
   personal WhatsApp number). Then submit utility message templates for
   approval (I will draft the template texts).
2. **AWS account** (aws.amazon.com, free tier; billing card required).
   Create IAM user per node-workflow/DEPLOYMENT.md.
3. **MongoDB Atlas** M0 cluster (mongodb.com/atlas), connection string.
4. **Brevo** account (brevo.com), API key, verify sender domain morpaankh.in
   (SPF/DKIM DNS records; I will provide the exact records).
5. **Shopify custom app** for the hub: Admin → Settings → Apps → Develop apps.
   Scopes: read_orders, write_orders, read_checkouts, read_fulfillments,
   write_fulfillments, read/write_merchant_managed_fulfillment_orders.
6. **Turn ON native abandoned-checkout email**: Admin → Marketing →
   Automations → Abandoned checkout.

### Build order (Claude)

1. Hub: `/automations/abandoned-checkouts/run` + Brevo and WhatsApp clients +
   shared-secret auth + idempotency tags + tests.
2. Hub: COD confirmation endpoint; extend Shiprocket handlers with WhatsApp.
3. Hub: review-request endpoint.
4. Flow pack: 4 workflow JSONs (SchedulerTrigger → HttpRequest → If ok → Set
   summary) + seeder script against the node-workflow API.
5. Deploy hub + platform once accounts exist; register flows; smoke-test with
   a real abandoned checkout.

## Track 2 — storefront performance (open audit item)

Image weight/dimensions, font loading, stale compiled CSS bundle, third-party
script audit. Measure CWV before and after (PageSpeed Insights). Theme deploy
conventions apply (pull first, `--path theme`, verify via Admin API).

## Track 3 — analytics

`tapi-analytics.js`: one event stream (view_item, add_to_cart, begin_checkout,
purchase, offer impressions, countdown clicks, wishlist adds) with fan-out to
backends toggled in theme settings. First backend: GA4 (needs a measurement ID
from Ashish, minutes to create). Self-hosted Umami/PostHog CE later, same
stream, no theme rework. Checkout events beyond begin_checkout come from
Shopify's Customer Events (web pixel), not the theme.

Rejected for now: self-hosting analytics before there is traffic. The site
entered Google's index queue 2026-06-30; revisit when sessions justify a
server.
