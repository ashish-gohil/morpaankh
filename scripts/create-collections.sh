#!/usr/bin/env bash
set -e
STORE=yaaijv-6p.myshopify.com
MANIFEST=/Users/ashishgohil/garment-seller/scripts/manifest.json

QUERY='mutation Create($input: CollectionInput!) { collectionCreate(input: $input) { collection { id handle title } userErrors { field message } } }'

mkdir -p "$(dirname "$MANIFEST")"
echo '{"collections":{},"products":{},"pages":{},"files":{}}' > "$MANIFEST"

create_coll() {
  local handle=$1 title=$2 blurb=$3
  local vars
  vars=$(jq -cn --arg t "$title" --arg h "$handle" --arg b "$blurb" '{input:{title:$t,handle:$h,descriptionHtml:$b,seo:{title:$t,description:$b}}}')
  echo ">> collection: $handle"
  local out
  out=$(shopify store execute -s "$STORE" --allow-mutations -j -q "$QUERY" -v "$vars" 2>&1 | tail -20)
  local id
  id=$(echo "$out" | grep -oE 'gid://shopify/Collection/[0-9]+' | head -1)
  echo "   id: $id"
  jq --arg h "$handle" --arg i "$id" '.collections[$h]=$i' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
}

create_coll kurta-sets   "Kurta Sets"   "Three pieces, every day. Kurta, pants and dupatta — cut for movement, finished by hand."
create_coll co-ord-sets  "Co-ord Sets"  "Two pieces, one story. Cropped jackets, wide pants, matching tops and bottoms."
create_coll festive      "Festive Edit" "For the days that ask to be remembered. Silk-cotton dobby, hand-finished tassels, gold thread."

echo "--- manifest ---"
cat "$MANIFEST"
