# whatsapp-automation RUNBOOK

Operating guide for the live service. Region ap-south-1. Logs are structured JSON
in CloudWatch (`/aws/lambda/wa-*`); phone numbers are masked to the last 4 digits.

## First: is it sending at all?

- `DRY_RUN` env on the Lambdas must be `false`, the flow's `FLOW_x_ENABLED` must be
  `true`, and (during a ramp) the number must be in `SEND_ALLOWLIST`. Check with
  `aws lambda get-function-configuration --function-name wa-worker`.
- Flip any of these without a redeploy: `scripts/pause-flow.mjs A on` /
  `pause-flow.mjs dryrun off`.

## Alarms (SNS -> your email) and what they mean

| Alarm | Meaning | First move |
|---|---|---|
| `wa-worker-errors` | the worker threw | `aws logs tail /aws/lambda/wa-worker --since 1h`; find the `msg:"worker: message failed"` line |
| `wa-dlq-not-empty` | messages exhausted 5 retries | inspect, fix the cause, then `scripts/replay-dlq.mjs --confirm` |
| `wa-whatsapp-failures` | spike of `MessageFailed` | usually an expired WhatsApp token or a template rejected; see below |
| `wa-courier-failures` | Delhivery API failing | check Delhivery status / credentials |

## Common WhatsApp error codes (from `errors[].code` in logs)

- `131047` window closed -> we send a template instead or skip (expected).
- `131049` marketing per-user cap -> no retry, no marketing to that phone for 7 days.
- `131026` undeliverable -> phone marked undeliverable; the owner is alerted to call.
- `132000/132001/132012` template/param problem -> a bug; fix the template, no retry.
- `130429/131056` rate limits -> retried with backoff automatically.

## Token / secret expiry (the main silent risk)

If sends suddenly fail with an auth error, the WhatsApp System User token likely
expired. Put a new token in the Secrets Manager secret `wa-automation/secrets`
(field `waAccessToken`); the worker picks it up within 5 minutes (cache TTL). Same
secret holds the Shopify admin token, Razorpay keys, and Delhivery token.

## The gated prepaid conversion

`shopify.convertToPrepaid` refuses to run live until `CONVERSION_VERIFIED=true`.
Before enabling: on a test order, confirm which order-edit + payment-record option
leaves financial status PAID, outstanding 0, and the outstanding equal to the
amount paid to the paisa; author that sequence in the client; then set the flag.
Until then a paid COD order tags `PREPAID-CONVERTED` and alerts, but the Shopify
accounting is not auto-applied.

## Delhivery push not enabled yet

Until Delhivery turns on the status push webhook, the hourly poller
(`wa-poll-delhivery`, 08:00-22:00 IST) is the source of truth for NDR/RTO. After
it is enabled, drop the poller to reconciliation cadence.

## Handy commands

```
aws logs tail /aws/lambda/wa-worker --since 30m --follow
scripts/replay-dlq.mjs                 # DLQ depth
scripts/replay-dlq.mjs --confirm       # redrive
scripts/pause-flow.mjs C off           # stop a flow now
scripts/resend.mjs <orderId> A cod     # re-run a step for one order
scripts/send-test.mjs +9198... "hi"    # allowlisted pipeline test
scripts/dryrun-render.mjs              # preview all copy
scripts/cart-recovery.mjs preview <checkoutId>        # Flow R: read-only, writes nothing
scripts/cart-recovery.mjs send <checkoutId> --live    # allowlisted phones ONLY
scripts/cart-recovery.mjs final <checkoutId> --live
```

## Flow R: "why did this customer not get a cart message?"

Read the record first. Every refusal is written down.

```
aws dynamodb get-item --table-name wa-automation --region ap-south-1 \
  --key '{"PK":{"S":"CART#<checkoutId>"},"SK":{"S":"REC"}}'
```

`outcome` is the answer. It is only ever a FINAL state:

| outcome | what happened |
|---|---|
| `too-old` / `too-fresh` | outside the 20 min to 12 h window, measured from `createdAt` (never `updatedAt`, which moves on its own) |
| `before-start` | the checkout predates `FLOW_R_START_AT` |
| `completed` / `already-ordered` | they bought; `already-ordered` was answered by Shopify, not by our table |
| `partial-advance` | COD King advance checkout: the line prices are only the deposit, so the bag cannot be priced |
| `no-verified-phone` / `sold-out` / `no-items` | nothing messageable |
| `opted-out` / `undeliverable` | hard phone guardrails |
| `cooldown` | this phone had a sequence inside the last 30 days |
| `marketing-cap` | they had another MARKETING message inside `marketingCapDays`, usually the prepaid offer |
| `public-offer-better` | the bag already gets as much as we could offer. Working as designed |
| `no-public-codes` | the live discount read FAILED, so it refused to offer blind. Check the app has `read_discounts` |
| `shadow` | `FLOW_R_ALLOWLIST` is set and this phone is not in it. Nothing was created |
| `send-dry_run` / `send-not_allowlisted` | the SERVICE-wide gate (`DRY_RUN`, `SEND_ALLOWLIST`) stopped the send. Asked before anything is created, so no code and no lock |
| `meta-131026` / `meta-131049` | Meta refused the recipient. No lock taken, no retry |
| `template-unusable` | the template is in review, paused or rejected |
| `recovered` | they came back. `codeUsed` says whether they actually used the code |

No `outcome` and a `firstSentAt` means the sequence is live and the reminder is
armed. `finalSkipped` records why the reminder did not go.

Other things worth knowing:

- **No message anywhere and no records at all?** Flow R is off, or
  `FLOW_R_START_AT` is empty (empty means nothing qualifies, by design), or it is
  outside 09:30-22:30 IST. Those three exit before writing anything so the next
  sweep retries.
- **The five-minute rule MUST send `{mode:'carts'}`.** Any other value falls
  through to the full nightly pass, which sends review asks. The handler returns
  on 'carts' before anything else runs.
- **`deliveryFailed` on the record** means Meta accepted and then failed to
  deliver. The phone lock is released automatically, because they got nothing.
- **A customer tapped Talk to us?** You get an owner alert with the bag, the code
  and the last four digits. The reminder is cancelled; they are expecting a human.
- **Changing where the link lands** is `RULES.cartRecovery.linkTarget` /
  `checkoutLinkStyle` and a deploy. It is never a template change: the button's
  URL is fixed once Meta approves it and all it carries is the token.

## Escalation checklist

1. Silence the noisy flow (`pause-flow.mjs <x> off`).
2. Read the worker logs for the failing `kind` + order id.
3. If money is involved (payment received, refund, conversion), verify in Shopify
   + Razorpay before re-driving anything; the `SIDE#` idempotency records prevent
   double side effects on replay.
4. Fix root cause, then `replay-dlq.mjs --confirm`.
