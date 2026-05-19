#!/usr/bin/env bash
# Publishes all 6 Tapi products to the Online Store sales channel.
# Requires `read_publications` + `write_publications` scopes.
set -e
STORE=yaaijv-6p.myshopify.com

# 1. Find the Online Store publication ID
PUB_QUERY='{ publications(first: 10) { nodes { id name } } }'
PUB_OUT=$(shopify store execute -s "$STORE" -j -q "$PUB_QUERY" 2>&1 | sed -n '/^{/,$p')
PUB_ID=$(echo "$PUB_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); pubs=d['publications']['nodes']; on=[p for p in pubs if p['name']=='Online Store']; print(on[0]['id'] if on else '')")
echo "Online Store publication: $PUB_ID"
[ -z "$PUB_ID" ] && { echo "!! Could not find Online Store publication"; exit 1; }

# 2. Publish each product
MUTATION='mutation Pub($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }'

PRODUCT_IDS=(
  "gid://shopify/Product/15066790199668"  # Saanjh
  "gid://shopify/Product/15066790232436"  # Roohi
  "gid://shopify/Product/15066790265204"  # Amba
  "gid://shopify/Product/15066790297972"  # Noor
  "gid://shopify/Product/15066790330740"  # Bageecha
  "gid://shopify/Product/15066790363508"  # Mehfil
)
COLLECTION_IDS=(
  "gid://shopify/Collection/638070784372"  # kurta-sets
  "gid://shopify/Collection/638070817140"  # co-ord-sets
  "gid://shopify/Collection/638070849908"  # festive
)

publish() {
  local id=$1
  local vars
  vars=$(jq -cn --arg i "$id" --arg p "$PUB_ID" '{id:$i,input:[{publicationId:$p}]}')
  echo ">> publish $id"
  shopify store execute -s "$STORE" --allow-mutations -j -q "$MUTATION" -v "$vars" 2>&1 | grep -E '"message"|userErrors' | head -3
}

for pid in "${PRODUCT_IDS[@]}"; do publish "$pid"; done
for cid in "${COLLECTION_IDS[@]}"; do publish "$cid"; done

echo "--- Done. Verifying onlineStoreUrl for all 6 products ---"
shopify store execute -s "$STORE" -j -q '{ products(first:6) { nodes { handle onlineStoreUrl } } }' 2>&1 | grep -E 'handle|onlineStoreUrl'
