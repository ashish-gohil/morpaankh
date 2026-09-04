# Deploying meta-outcomes to AWS

One idempotent script puts the whole service on AWS: a **Lambda** on an
**EventBridge** timer (11:00 & 17:00 IST), with state in a private **S3** bucket.
Cost is effectively **$0/month** (all within free allowances).

It must run where there is both AWS access and the code + `.env` — i.e. your own
terminal (or AWS CloudShell). It cannot run from inside Claude's sandbox (no AWS
network there).

## Option A — your Mac (simplest, no re-typing secrets)

1. Create an access key for `ashish-admin`: AWS console → IAM → Users →
   ashish-admin → Security credentials → Create access key (CLI).
2. Configure the CLI once:
   ```bash
   aws configure          # paste the key/secret, region ap-south-1, output json
   aws sts get-caller-identity   # should show your account
   ```
3. Deploy (reads `meta-outcomes/.env`, forces DRY_RUN=true):
   ```bash
   bash meta-outcomes/deploy/deploy.sh
   ```
   It prints the invocation response and the CloudWatch logs of a real dry-run.

## Option B — AWS CloudShell (browser, already signed in as ashish-admin)

1. Zip the folder on your Mac: `cd ~/garment-seller && zip -r mo.zip meta-outcomes`
2. Open AWS CloudShell (top bar), Actions → Upload file → `mo.zip`.
3. In CloudShell:
   ```bash
   unzip -o mo.zip && bash meta-outcomes/deploy/deploy.sh
   ```

## What to check after the dry-run
The logs should show something like `DELIVERED_PAID: 26`, lines like
`#1086 -> DELIVERED_PAID [sent-DeliveredPurchase, audience-add:delivered]`, and
`(dry-run: nothing sent to Meta)`. Share that output.

## Going live (only after the dry-run looks right)
1. Add a **Test Events** code: in `.env` set `META_TEST_EVENT_CODE=` to the code
   from Events Manager → your dataset → Test Events, then re-run
   `bash deploy.sh` and watch DeliveredPurchase appear in the Test Events tab.
2. Remove the test code, then `bash meta-outcomes/deploy/deploy.sh --live`.

## What it creates (all idempotent)
- S3 bucket `meta-outcomes-state-<accountid>` (private) — the state/ledger file.
- IAM role `meta-outcomes-lambda-role` (basic logs + GetObject/PutObject on the
  state prefix only).
- Lambda `meta-outcomes` (Node 20, 256MB, 120s, reserved concurrency 1).
- EventBridge rule `meta-outcomes-twice-daily` → `cron(30 5,11 * * ? *)` UTC.

## Rollback / pause
- Pause: `aws events disable-rule --name meta-outcomes-twice-daily`
- Remove: delete the Lambda, the rule, the role, and the S3 bucket.
