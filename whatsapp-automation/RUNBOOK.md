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
