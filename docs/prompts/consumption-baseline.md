# Consumption baseline

Read-only measurement, taken before the O-blocks. Window: 2026-10-07 to 2026-11-06 (30 days),
region ap-south-1. Re-run the same commands a week after the O-blocks deploy and fill the "after"
column. Source of the commands: `morpaankh-flow-fixes-v2-2026-11-06.md`, "Measure first".

## 1. Lambda, 30 days

| Function | Invocations | Avg ms | Errors | Throttles | After |
|---|---|---|---|---|---|
| wa-reconcile | 8270 | 605 | 5 | 0 | |
| wa-worker | 6296 | 655 | 0 | 0 | |
| wa-ingest-whatsapp | 4343 | 657 | 0 | 0 | |
| wa-ingest-shopify | 1531 | 1107 | 0 | 0 | |
| wa-poll-delhivery | 452 | 3030 | 0 | 0 | |
| wa-cart-capture | 214 | 624 | 0 | 0 | |
| wa-subscribe | 175 | 1194 | 0 | 0 | |
| wa-cart-redirect | 104 | 338 | 1 | 0 | |
| wa-pay-redirect | 35 | 238 | 1 | 0 | |
| wa-ingest-razorpay | 33 | 2139 | 0 | 0 | |
| wa-w-redirect | 32 | 601 | 2 | 0 | |
| wa-digest | 31 | 5182 | 0 | 0 | |
| wa-error-reporter | 23 | 3025 | 0 | 0 | |
| wa-pnl-report | 4 | 23045 | 0 | 0 | |
| wa-ingest-delhivery | none | none | none | none | |
| wa-onboarding | none | none | none | none | |

`wa-ingest-delhivery` has never been invoked, which matches M7: the push webhook is not enabled for
this account. Nothing has called `wa-onboarding` in 30 days either.

## 2. DynamoDB, 30 days

| Metric | Before | After |
|---|---|---|
| ItemCount | 4017 | |
| TableSizeBytes | 682,580 | |
| ConsumedReadCapacityUnits | 229,616.5 | |
| ConsumedWriteCapacityUnits | 12,370 | |

**18.6 reads for every write.** This is O3's case in one line: the table is written once per event and
read by the whole table on every 5-minute sweep. 8270 reconcile runs against a 4017-item table is
where those 229k read units went, and the ratio gets worse as the table grows, which O4 then bounds.

## 3. Metrics, logs, schedules, queue

| Thing | Before | After |
|---|---|---|
| WAAutomation metric series | 59 | |
| EventBridge schedules | 2 | |
| SQS NumberOfMessagesSent | 6277 | |

Log groups, stored bytes (retention is already 90 days on all 16, so M8 has been applied; O5 is what
keeps it that way through a deploy):

| Log group | Bytes |
|---|---|
| wa-worker | 9,802,899 |
| wa-ingest-whatsapp | 8,493,373 |
| wa-reconcile | 3,979,327 |
| wa-ingest-shopify | 1,128,078 |
| wa-poll-delhivery | 426,848 |
| wa-subscribe | 123,971 |
| wa-cart-capture | 98,807 |
| wa-pay-redirect | 47,674 |
| wa-cart-redirect | 45,942 |
| wa-digest | 43,693 |
| wa-ingest-razorpay | 42,737 |
| wa-error-reporter | 33,416 |
| wa-w-redirect | 18,338 |
| wa-pnl-report | 7,972 |
| wa-ingest-delhivery | 1,477 |
| wa-onboarding | 910 |

The 59 metric series are what O11 trims: a label carrying a waybill list opens a new series per call.

## 4. Bill by service, October 2026 (USD)

| Service | Oct 2026 | After |
|---|---|---|
| AmazonCloudWatch | 0.7345 | |
| AWS Secrets Manager | 0.4390 | |
| Amazon DynamoDB | 0.0451 | |
| Amazon API Gateway | 0.0194 | |
| Amazon S3 | 0.0046 | |
| Amazon SES | 0.0006 | |
| Amazon SQS | 0.0000003 | |
| AWS Lambda | 0 | |
| AWS Cost Explorer | 0.01 | |
| Tax | 0.22 | |
| **Total** | **~1.47** | |

Lambda is genuinely zero: every invocation above fits inside the free tier, which is why O7 (Arm) is
honestly worth close to nothing today and is only insurance against volume. CloudWatch is half the
bill, and it is charged per metric series per hour, so O11 is the line that moves it. Secrets Manager
at 0.44 is four secrets at the flat per-secret rate, not usage.

## 5. WhatsApp, last 30 days

Not machine-readable from here. Read it in WhatsApp Manager, Insights, last 30 days: delivered
messages by category and the amount charged. Fill in before the O-blocks deploy so O8 and O9 have a
number to beat.

| Category | Delivered | Charged (INR) | After |
|---|---|---|---|
| Marketing | | | |
| Utility | | | |
| Service | | | |
| Refused (131049 / 130472) | | | |
