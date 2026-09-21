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
```

## Escalation checklist

1. Silence the noisy flow (`pause-flow.mjs <x> off`).
2. Read the worker logs for the failing `kind` + order id.
3. If money is involved (payment received, refund, conversion), verify in Shopify
   + Razorpay before re-driving anything; the `SIDE#` idempotency records prevent
   double side effects on replay.
4. Fix root cause, then `replay-dlq.mjs --confirm`.
