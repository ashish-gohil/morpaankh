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

## Templates: is the one you are about to rely on actually approved?

```
node scripts/templates-sync.mjs          # report + GATE, exit 2 if any is not usable
node scripts/templates-sync.mjs --live   # submit the missing ones to Meta
```

**Run the gate before shipping anything that sends a new template, and before
flipping a flow live.** It checks every name the sender can reach (TEMPLATES,
LEGACY and NO_PRICE) against Meta and exits 2 if any is missing, PENDING or
REJECTED. Approval is usually minutes for UTILITY, longer for MARKETING.

This exists because the dry run used to print `would-create` for a template
that was not at Meta at all and still exit 0, so it could not gate anything.
`replacement_raised_v1` was written, tested, deployed and reported as finished
without ever being submitted. The local suite cannot catch this: it has no
credentials, and Meta is the only thing that knows a template's real status.

The daily digest (09:30 IST) carries the same check, so a template Meta
PAUSES or REJECTS later shows up as `TEMPLATE NOT USABLE: <name> is <status>`
on the morning line without anyone remembering to look. The line disappears by
itself once the status is APPROVED. To stop that check entirely, delete the
`digestTemplateHealth` block in `src/timers/digest.mjs`; nothing else uses it.

A missing template is not a crash. With the customer's 24 hour window OPEN the
sender uses the free-form twin in `messages/session.mjs` and the customer is
reached normally. It only bites on a CLOSED window, where there is no second
route: the send is skipped and the owner is told to call them.

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
scripts/subscriber-offer.mjs preview --date 2026-10-23    # Flow W: read-only, writes nothing
scripts/subscriber-offer.mjs run --date 2026-10-23 --live  # the real sweep for one day
scripts/subscriber-offer.mjs backfill --from D --to D --live  # the only way past START_AT
scripts/subscriber-offer.mjs status <customerId>
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

## Flow W: "why did this new customer not get a welcome offer?"

Read the record first. Every refusal is written down.

```
scripts/subscriber-offer.mjs status <customerId>
aws dynamodb get-item --table-name wa-automation --region ap-south-1 \
  --key '{"PK":{"S":"SUBOFFER#<customerId>"},"SK":{"S":"SUB"}}'
```

`outcome` is the answer, and it is only ever a FINAL state:

| outcome | what happened |
|---|---|
| `not-found` | Shopify no longer has that customer |
| `before-start` | they joined before `FLOW_W_START_AT`. `backfill` is the only way past it |
| `no-created-at` | the customer record has no usable creation time |
| `already-ordered` | they have an order, by customer id, by exact email, or by the verified phone on a recent order. Asked of Shopify, not of our table |
| `excluded-tag` / `not-a-subscriber` | `excludeTags` hit, or `requireAnyTag` is set and they have none of them |
| `no-channel` | no usable number AND no usable email. An unusable number alone is NOT this: it falls back to email |
| `email-unsubscribed` | Shopify marketing state UNSUBSCRIBED and no number. The only email state that refuses |
| `email-invalid` | Shopify's own `validFormat` says that address cannot receive. Skipped before anything is created, because SES judges us on the bounce RATE |
| `has-cart` | an abandoned checkout, a captured cart, or a Flow R lock or park on their number. Flow R owns them |
| `opted-out` / `undeliverable` | hard phone guardrails. `undeliverable` only when there is no email either |
| `already-offered` | a LIFETIME lock on the number or on the email hash. Once per person, ever |
| `marketing-cap` | another MARKETING template inside `marketingCapDays`. Not checked when their 24 hour window is open |
| `public-offer-better` / `above-tier-ceiling` | the guard refused. Rs 200 sits exactly on both bounds, so a change to `offerTiers`, `beatPublicByInr` or `amountInr` mutes the whole flow. Working as designed, and alerted once a day |
| `no-public-codes` | the live discount read FAILED, so it refused to offer blind. Check `read_discounts` |
| `shadow` | `FLOW_W_ALLOWLIST` is set and this number is not in it. Nothing created |
| `send-dry_run` | the service-wide gate stopped it, before anything was created |
| `email-unavailable` | `EMAIL_FROM` is unset, or `@aws-sdk/client-sesv2` is not in the Lambda bundle. A DEPLOY problem, not an address problem |
| `email-send-failed` / `email-suppressed` | SES refused the message, or that address is on the account suppression list. Never retried |
| `waiting-window` | Meta's per-user cap (131049). Parked against the phone until they write in, AND emailed now |
| `meta-131026` | that number cannot receive WhatsApp. Emailed instead |
| `template-unusable` | the offer template is in review, paused or rejected. Alerted once a day |
| `converted` | they ordered with the code. `revenuePaise` is what it earned |

No `outcome` and a `firstSentAt` means it went out and is live.

Other things worth knowing:

- **Nothing anywhere, no records at all?** Flow W is off, or `FLOW_W_START_AT` is
  empty (empty means nothing qualifies, by design), or the day marker
  `SUBOFFER#RUN#<date>/DAY` is already written. Check with `preview --date`.
- **The daily rule MUST send `{mode:'subscribers'}`.** Any other value falls
  through to the full nightly pass, which sends review asks to real customers.
- **A whole day missing** is the one failure that cannot be repaired by waiting:
  the sweep only ever looks at yesterday. It is also why the day marker is
  written LAST and why a failed customer search writes none, so a re-run the same
  day still reaches everybody. `run --date <that day> --live` is the repair.
- **`skipped: too-many-candidates`** means more eligible signups than
  `maxPerRun` (100). Nothing was sent and no marker was written. Look for a
  customer import or a signup bot, then re-run by hand. It counts the nodes it
  actually paged: `customersCount(query:)` returns 475, the entire customer base,
  for every filter, so a guard built on it would refuse to run every day.
- **`skipped: template-not-approved`** means `subscriber_offer_v1` or its
  image-free twin is not APPROVED at Meta. No marker is written, so a re-run
  after approval still reaches that day.
- **All sends by email and none by WhatsApp?** Look at `phoneSkipReason` on the
  records. `non-india` or `bad-phone` across the board usually means a signup
  form that stopped collecting a number properly.
- **Changing the landing page** is `RULES.subscriberOffer.collectionHandle` and a
  deploy, never a template change: the button's URL is fixed at Meta approval
  time and all it carries is the token.

## /replace: replacement shipments

A replacement is two parcels and no Shopify change: a reverse pickup of what the
customer has, and a new prepaid Surface parcel of what they should have had.
Nothing is tagged, edited, refunded or restocked, so **Shopify will not show you
that a replacement exists**. `/replace status <order>` and the daily digest are
the only places it is visible.

### Running it

Send these from an admin phone to the business number, in the thread where your
alerts arrive. Typing them into the customer's chat in the Business app reaches
nothing (we are not subscribed to message echoes) and would show the command to
the customer.

```
/replace #1234 noor m xl          book a size swap, after a preview
/replace 1234 noor m xl x2        two of them
/replace 1234 noor m bandhan xl   swap to a different product
/replace 1234 m xl                when the order has one changeable line
/replace status 1234              both AWBs, live courier status, next action
/replace list                     every open replacement, newest first
/replace cancel 1234              cancel whichever leg is not yet picked up
/replace retry 1234               resume a FAILED request from where it stopped
/replace help
```

Flags: `reason:size|damaged|wrong|other`, `pays:us|customer` (recorded only,
never charged), `force` to pass a soft stop, `again` to replace a line a second
time.

### Which mode is it in?

```
aws lambda get-function-configuration --function-name wa-worker \
  --query 'Environment.Variables.REPLACE_MODE' --output text
node scripts/pause-flow.mjs replace off|shadow|live
```

`shadow` is the default and runs everything except the two courier writes and
the customer message: you get a preview, a Confirm button, and a reply saying
what it WOULD have booked. That is the right place to be until the Delhivery
payload has been proven once against a real AWB.

### "It refused and I do not know why"

Every refusal names its own reason and the next command. The ones that catch
people out:

- **"DELHIVERY_PICKUP_LOCATION is not set"**: the only config that refuses. It
  is a per-shipment field, one Delhivery account can hold several registered
  pickup locations, and the API exposes no way to list them, so only you can say
  which one. Set it in `cdk.json` context and deploy.
- **GSTIN and HSN are warnings, not refusals.** Your GST registration already
  sits on the Delhivery account this token belongs to, and HSN is optional on a
  B2C label, so the parcel books either way and the preview tells you the label
  will go out without them. Set `sellerGstin` in `cdk.json` or
  `RULES.replace.hsn` when you want them printed. Neither is ever guessed: a
  made up HSN is a wrong tax declaration on a document in your name.
- **"the warehouse name does not match"**: `DELHIVERY_PICKUP_LOCATION` must equal
  the registered warehouse EXACTLY, case included. Delhivery matches it as a
  string.
- **"our 24 hour window with this customer has closed"**: the size list and the
  free-form twin need an open window. The approved template covers the closed
  case; if the template itself is paused or unapproved you are told rather than
  the message being dropped.
- **"not serviceable"**: reverse pickup and prepaid delivery are checked
  separately at the pin. Ask the customer to self ship, or book it by hand.
- **"delivered more than 7 days ago"** / **"no AWB"** / **"ODA pin"**: soft
  stops. Re-send with `force` if you mean it.
- **A protected-customer-data message**: the app cannot read the shipping
  address at all. That is a Shopify app-scope approval, not a typo in the
  address.

### When it fails halfway

The return leg is booked first, always, because it is the correct leg whichever
way the rest goes. So a failure usually means **the return pickup is already
booked and the new parcel is not**. The reply says so and names
`/replace retry 1234`. Retry resumes from the failed step; it does not rebook
the return.

If the provider reported a duplicate reference, or timed out after the request
went out, the shipment is looked up by its reference (`<order>-REPLACE-<seq>R` or
`-<seq>F`) and adopted rather than retried. Never rebook by hand without
checking Delhivery One for that reference first: that is how one replacement
becomes two parcels.

A refusal the courier can explain is quoted VERBATIM: `"The courier said: insufficient balance. Fix that, then /replace retry 1234"` means exactly that.

### What a human still has to do

- The new parcel is manifested and left **Ready to Ship**. We never request a
  pickup for it. Add it to a pickup yourself once the return has been collected.
- Reverse pickups are scheduled by Delhivery; there is no pickup request to
  make for that leg.
- Any price difference is collected by hand. `pays:` is recorded, not charged.
- A cancellation messages nobody. There is no approved template for calling a
  pickup off, so if the customer was already told one was coming (the reply
  says whether they were) you have to tell them it is off.

### Why the replacement AWBs are not in the tracker

They are deliberately kept out of the `AWB#` map and out of GSI1, so the poller
never sees them. Any AWB in that map routes its terminal events into the
order's flows, which would mean the reverse pickup going RTO fires Flow C on
the original order (tagging it RTO, asking the customer why they returned it,
counting it toward their COD block) and the new parcel being delivered fires a
second review ask. The cost is that we do not learn of collection by webhook,
which is why `status` asks the courier directly.

## Escalation checklist

1. Silence the noisy flow (`pause-flow.mjs <x> off`).
2. Read the worker logs for the failing `kind` + order id.
3. If money is involved (payment received, refund, conversion), verify in Shopify
   + Razorpay before re-driving anything; the `SIDE#` idempotency records prevent
   double side effects on replay.
4. Fix root cause, then `replay-dlq.mjs --confirm`.

## /pnl: monthly profit and loss

One month's P&L as an .xlsx, built from live sources only and sent to you. It
reads Shopify, Delhivery, Meta and Razorpay and writes nothing back to any of
them: the only writes are the reports bucket, a lock row, and messages to you.

### Running it

Three ways, all the same code:

```
/pnl                       last month
/pnl 2026-10               a month
/pnl oct                   the most recent October that has finished
/pnl oct 2026
/pnl mtd                   this month so far, provisional by definition
```

```bash
npm run pnl -- --month 2026-10            # builds AND sends
npm run pnl -- --month 2026-10 --no-send  # writes the file only
npm run pnl -- --month 2026-10 --out ~/Desktop
npm run pnl -- --month 2026-10 --ledger ./statement.csv
```

```bash
aws lambda invoke --function-name wa-pnl-report \
  --cli-binary-format raw-in-base64-out \
  --payload '{"month":"2026-10"}' /tmp/pnl.json
```

Automatically on the **7th at 09:00 IST** for the previous month
(`wa-pnl-monthly`, `cron(30 3 7 * ? *)`). The 7th rather than the 1st because a
report run on the 1st calls a third of the month pending and gets restated a
week later.

`/pnl` replies at once and then hands the work to `wa-pnl-report`: the worker
has 60 seconds and a month is three or four minutes, mostly waiting on
Delhivery. Expect the workbook about two minutes after the reply.

### "It said a run is already in flight"

A `PNL#<month>` / `LOCK` row, leased for 20 minutes. A run killed halfway (a
terminated CLI, a Lambda timeout) leaves it behind and it clears itself at the
end of the lease. To clear it now:

```bash
aws dynamodb delete-item --table-name wa-automation --region ap-south-1 \
  --key '{"PK":{"S":"PNL#2026-10"},"SK":{"S":"LOCK"}}'
```

### The courier charges line, and why it matters

The header of every report says one of two things:

- **Delhivery ledger (exact)** - a statement you uploaded is being used.
- **computed from Delhivery rates and an assumed weight** - the default.

It says "assumed weight" because **Delhivery does not return the weight it
scanned**, by any API this account can call: `ChargedWeight` is null on every
shipment and the charges API echoes back whatever weight you send it. So a
computed charge is this rate card applied to 500 g, and the real parcel might
have been billed at more. Every row built that way is flagged.

The only exact source is the statement. To upload one:

1. Delhivery One > Finances > Invoices > the AWB-wise backup for the month
   (or Finances > Wallet > Transactions). Save it as **CSV**.
2. Send it to the business WhatsApp number from an admin phone, as a **file**,
   with the caption `/pnl-ledger 2026-10`.
3. It replies with the rows and total it read. The file is kept in S3 whatever
   the parse said.
4. Run `/pnl 2026-10` again. It picks the statement up from the bucket on its
   own and the header flips to "ledger (exact)", with a per-AWB variance column
   on Courier Ledger. A gap over Rs 10 is flagged, which is usually a weight
   dispute.

XLSX is not parsed: save as CSV. The parser reads by HEADER NAME, never column
position, so a reordered export is fine and a renamed column is a clear warning
rather than a wrong number.

### Reading it: the one rule

**A row with a missing cost is excluded from every total**, and the Summary says
how many orders and how much money that is. It is never guessed and never
treated as zero. So if net profit looks better or worse than you expect, read
the DATA QUALITY block on Summary first: an order with no AWB, or a product with
no cost per item, leaves the totals entirely.

The two that recur:

- **no unit cost** - fix at Shopify admin > product > variant > Cost per item.
  October had two: "Toran" on #1174 and the custom "Dupatta" on #1233.
- **no AWB** - the parcel went out by another courier, or the tracking number
  never reached Shopify. `ref_ids` does NOT rescue these, verified. Either add
  the cost by hand in `RULES.pnl.manualCourierCostInr` keyed by AWB, or accept
  the exclusion.

### Config

Every number is in `messages/rules.mjs` under `RULES.pnl`, and every one of them
appears on the Assumptions sheet with VERIFIED, ASSUMED or CONFIG against it.
The switches are context in `iac/cdk.json`: `pnlEnabled`, `pnlAdminPhones`
(empty means whoever may run `/replace`), `pnlEmailTo`.

Still ASSUMED as of 2026-11-04, and each one moves the bottom line:

- `gatewayFeePct` 2.0 - Cashfree carries every prepaid order and we have no API
  keys for it. Razorpay is read live where it applies, which in October was
  nowhere: all its payment links expired unpaid.
- `gstInputCreditClaimed` false - while false, costs are booked GST-inclusive
  and the 18% on Meta is its own line. That understates profit rather than
  overstating it, which is the safe direction until your CA confirms.
- `assumedWeightGrams` 500 - see above; the ledger is the fix.
- `fixedMonthlyCosts` empty - shows as "not set" and net profit is flagged
  optimistic until the Shopify plan, COD King, domain and WhatsApp API figures
  are in.

### Before you trust a deploy

`cdk synth` REFUSES if the exceljs layer is missing, so run `npm run pnl:layer`
first. Without the layer the function deploys clean and then throws on its first
import, and the only symptom is a report that never arrives.

### Rerunning a month

Safe and idempotent: a re-run overwrites nothing. Each run writes its own
`reports/<month>/<runId>.xlsx` and `snapshots/<month>/<runId>.json`, the bucket
is versioned, and next month's "Last Month Update" block reads the newest
snapshot to show what has settled since.
