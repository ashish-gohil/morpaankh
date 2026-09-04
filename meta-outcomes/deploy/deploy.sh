#!/usr/bin/env bash
#
# meta-outcomes AWS deploy — Lambda + EventBridge + S3. Idempotent (safe to
# re-run). Near-zero cost (Lambda + EventBridge + S3 within free allowances).
#
# Prereqs:
#   1. AWS CLI installed and configured as an admin (e.g. `aws configure` with an
#      ashish-admin access key). Verify with:  aws sts get-caller-identity
#   2. meta-outcomes/.env filled in (it already is).
#   3. Run from anywhere:  bash meta-outcomes/deploy/deploy.sh
#
# Usage:
#   bash deploy.sh          # deploy / update; DRY_RUN forced TRUE (safe)
#   bash deploy.sh --live   # same, but DRY_RUN=false (go live) — only after a
#                           # clean dry-run + Test Events check
#
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"     # Mumbai
FN="meta-outcomes"
ROLE="meta-outcomes-lambda-role"
RULE="meta-outcomes-twice-daily"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"          # the meta-outcomes/ dir
ENV_FILE="$ROOT/.env"

LIVE=false
[ "${1:-}" = "--live" ] && LIVE=true

command -v aws >/dev/null || { echo "ERROR: aws CLI not found. Install it and run 'aws configure'."; exit 1; }
command -v zip >/dev/null || { echo "ERROR: zip not found."; exit 1; }
[ -f "$ENV_FILE" ] || { echo "ERROR: .env not found at $ENV_FILE"; exit 1; }

# Read a single key from .env safely (values may contain spaces, e.g. audience names).
getenv() { grep -E "^$1=" "$ENV_FILE" | head -1 | sed -E "s/^$1=//"; }

SHOPIFY_STORE_DOMAIN="$(getenv SHOPIFY_STORE_DOMAIN)"
SHOPIFY_ADMIN_TOKEN="$(getenv SHOPIFY_ADMIN_TOKEN)"
SHOPIFY_WEBHOOK_SECRET="$(getenv SHOPIFY_WEBHOOK_SECRET)"
SHOPIFY_API_VERSION="$(getenv SHOPIFY_API_VERSION)"
META_DATASET_ID="$(getenv META_DATASET_ID)"
META_BUSINESS_ID="$(getenv META_BUSINESS_ID)"
META_ACCESS_TOKEN="$(getenv META_ACCESS_TOKEN)"
META_AD_ACCOUNT_ID="$(getenv META_AD_ACCOUNT_ID)"
META_TEST_EVENT_CODE="$(getenv META_TEST_EVENT_CODE)"
META_GRAPH_VERSION="$(getenv META_GRAPH_VERSION)"
META_DELIVERED_EVENT_NAME="$(getenv META_DELIVERED_EVENT_NAME)"
META_AUDIENCE_DELIVERED="$(getenv META_AUDIENCE_DELIVERED)"
META_AUDIENCE_LOST="$(getenv META_AUDIENCE_LOST)"
BACKFILL_SINCE="$(getenv BACKFILL_SINCE)"

[ -n "$SHOPIFY_ADMIN_TOKEN" ] || { echo "ERROR: SHOPIFY_ADMIN_TOKEN missing in .env"; exit 1; }
[ -n "$META_ACCESS_TOKEN" ]   || { echo "ERROR: META_ACCESS_TOKEN missing in .env"; exit 1; }

DRY_RUN=true; $LIVE && DRY_RUN=false

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="meta-outcomes-state-$ACCOUNT"
echo ">> account=$ACCOUNT region=$REGION bucket=$BUCKET DRY_RUN=$DRY_RUN"

# ---------- S3 bucket (private) for the state file ----------
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  echo ">> created bucket $BUCKET"
fi
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

# ---------- IAM role for the Lambda ----------
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  echo ">> created role $ROLE (waiting ~12s for IAM propagation)"; sleep 12
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name s3-state \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::'"$BUCKET"'/meta-outcomes/*"}]}' >/dev/null
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"

# ---------- package the code (no deps; @aws-sdk is in the Lambda runtime) ----------
cd "$ROOT"
rm -f "$HERE/function.zip"
zip -r "$HERE/function.zip" src package.json -x 'src/*.test.mjs' >/dev/null
echo ">> packaged $(du -h "$HERE/function.zip" | cut -f1) zip"

# ---------- env vars (temp file; contains secrets, deleted on exit) ----------
ENVJSON="$(mktemp)"; trap 'rm -f "$ENVJSON"' EXIT
cat > "$ENVJSON" <<JSON
{"Variables":{
"DRY_RUN":"$DRY_RUN",
"STATE_BACKEND":"s3",
"STATE_S3_BUCKET":"$BUCKET",
"STATE_S3_KEY":"meta-outcomes/state.json",
"SHOPIFY_STORE_DOMAIN":"$SHOPIFY_STORE_DOMAIN",
"SHOPIFY_API_VERSION":"$SHOPIFY_API_VERSION",
"SHOPIFY_ADMIN_TOKEN":"$SHOPIFY_ADMIN_TOKEN",
"SHOPIFY_WEBHOOK_SECRET":"$SHOPIFY_WEBHOOK_SECRET",
"META_DATASET_ID":"$META_DATASET_ID",
"META_BUSINESS_ID":"$META_BUSINESS_ID",
"META_ACCESS_TOKEN":"$META_ACCESS_TOKEN",
"META_AD_ACCOUNT_ID":"$META_AD_ACCOUNT_ID",
"META_TEST_EVENT_CODE":"$META_TEST_EVENT_CODE",
"META_GRAPH_VERSION":"$META_GRAPH_VERSION",
"META_DELIVERED_EVENT_NAME":"$META_DELIVERED_EVENT_NAME",
"META_AUDIENCE_DELIVERED":"$META_AUDIENCE_DELIVERED",
"META_AUDIENCE_LOST":"$META_AUDIENCE_LOST",
"BACKFILL_SINCE":"$BACKFILL_SINCE",
"CAPI_MAX_AGE_DAYS":"7"
}}
JSON

# ---------- create or update the function ----------
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$HERE/function.zip" >/dev/null
  aws lambda wait function-updated --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --handler src/handler.handler --runtime nodejs20.x --timeout 120 --memory-size 256 \
    --environment "file://$ENVJSON" >/dev/null
  echo ">> updated function $FN"
else
  aws lambda create-function --function-name "$FN" --runtime nodejs20.x --role "$ROLE_ARN" \
    --handler src/handler.handler --timeout 120 --memory-size 256 \
    --zip-file "fileb://$HERE/function.zip" --environment "file://$ENVJSON" >/dev/null
  echo ">> created function $FN"
fi
aws lambda wait function-updated --function-name "$FN"
aws lambda put-function-concurrency --function-name "$FN" --reserved-concurrent-executions 1 >/dev/null
FN_ARN="$(aws lambda get-function --function-name "$FN" --query Configuration.FunctionArn --output text)"

# ---------- schedule: 11:00 & 17:00 IST == 05:30 & 11:30 UTC, twice daily ----------
aws events put-rule --name "$RULE" --schedule-expression 'cron(30 5,11 * * ? *)' --state ENABLED >/dev/null
RULE_ARN="$(aws events describe-rule --name "$RULE" --query Arn --output text)"
aws lambda add-permission --function-name "$FN" --statement-id "eventbridge-$RULE" \
  --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null 2>&1 || true
aws events put-targets --rule "$RULE" --targets "Id=1,Arn=$FN_ARN" >/dev/null
echo ">> scheduled $RULE (11:00 & 17:00 IST)"

# ---------- verify: invoke once now, show response + logs ----------
echo ">> invoking once for verification (DRY_RUN=$DRY_RUN)..."
aws lambda invoke --function-name "$FN" --payload '{}' --cli-binary-format raw-in-base64-out "$HERE/out.json" >/dev/null || true
echo "----- response -----"; cat "$HERE/out.json"; echo
echo "----- recent logs (wait a few seconds) -----"; sleep 8
aws logs tail "/aws/lambda/$FN" --since 3m 2>/dev/null || echo "(logs not ready yet; open CloudWatch Logs group /aws/lambda/$FN)"
echo
echo ">> DONE. DRY_RUN=$DRY_RUN. Re-run with --live to send for real (after Test Events check)."
