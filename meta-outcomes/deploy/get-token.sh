#!/usr/bin/env bash
#
# get-token.sh — mint a real OAuth Admin API access token (shpat_...) for the
# "Meta Outcomes Sync" app and write it into .env. Dev Dashboard apps must use
# an OAuth token; the atkn_ "app automation token" is NOT valid for the Admin API.
#
# ONE-TIME PREREQUISITE (do this in your browser first):
#   Dev Dashboard -> Meta Outcomes Sync -> Versions -> Create version:
#     - tick "Use legacy install flow"
#     - Allowed redirection URL(s): add exactly   https://example.com/
#     - Release
#
# Then run:  bash meta-outcomes/deploy/get-token.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/.env"
[ -f "$ENV" ] || { echo "ERROR: .env not found at $ENV"; exit 1; }
getenv() { grep -E "^$1=" "$ENV" | head -1 | sed -E "s/^$1=//"; }

CID="$(getenv SHOPIFY_APP_CLIENT_ID)"
SECRET="$(getenv SHOPIFY_WEBHOOK_SECRET)"     # the app's client secret (shpss_...)
SHOP="$(getenv SHOPIFY_STORE_DOMAIN)"
SCOPES="read_orders,read_fulfillments,read_merchant_managed_fulfillment_orders,read_assigned_fulfillment_orders"
REDIRECT="https://example.com/"

[ -n "$CID" ] && [ -n "$SECRET" ] && [ -n "$SHOP" ] || { echo "ERROR: SHOPIFY_APP_CLIENT_ID / SHOPIFY_WEBHOOK_SECRET / SHOPIFY_STORE_DOMAIN missing in .env"; exit 1; }

echo "STEP 1 — open this URL in your browser (signed into the store admin), then click Install/Update:"
echo
echo "https://$SHOP/admin/oauth/authorize?client_id=$CID&scope=$SCOPES&redirect_uri=$REDIRECT"
echo
echo "STEP 2 — it redirects to  https://example.com/?code=XXXXXXXX&...  (the page may say"
echo "         'Example Domain' — that's fine). Copy the value of 'code' from the address bar."
echo "         Do it promptly; the code expires in a few minutes."
echo
read -rp "Paste the code here: " CODE
[ -n "$CODE" ] || { echo "No code entered."; exit 1; }

echo ">> exchanging code for an access token..."
RESP="$(curl -s -X POST "https://$SHOP/admin/oauth/access_token" \
  -d "client_id=$CID" -d "client_secret=$SECRET" -d "code=$CODE")"
TOKEN="$(printf '%s' "$RESP" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { echo "ERROR: no access_token in response:"; echo "$RESP"; exit 1; }

# Write into .env (portable, no sed -i).
if grep -qE '^SHOPIFY_ADMIN_TOKEN=' "$ENV"; then
  awk -v t="$TOKEN" '/^SHOPIFY_ADMIN_TOKEN=/{print "SHOPIFY_ADMIN_TOKEN=" t; next} {print}' "$ENV" > "$ENV.tmp" && mv "$ENV.tmp" "$ENV"
else
  printf 'SHOPIFY_ADMIN_TOKEN=%s\n' "$TOKEN" >> "$ENV"
fi

echo ">> success. SHOPIFY_ADMIN_TOKEN updated (starts ${TOKEN:0:6}...)."
echo ">> now redeploy:  bash meta-outcomes/deploy/deploy.sh"
