#!/usr/bin/env bash
set -e
STORE=yaaijv-6p.myshopify.com

QUERY='mutation Create($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id namespace key name } userErrors { field message code } } }'

create_def() {
  local owner=$1 key=$2 name=$3 type=$4 desc=$5
  local vars
  vars=$(printf '{"definition":{"namespace":"tapi","key":"%s","name":"%s","ownerType":"%s","type":"%s","description":"%s","access":{"storefront":"PUBLIC_READ"}}}' "$key" "$name" "$owner" "$type" "$desc")
  echo ">> $owner.$key ($type)"
  shopify store execute -s "$STORE" --allow-mutations -j -q "$QUERY" -v "$vars" 2>&1 | tail -20
  echo "---"
}

# Product-level
create_def PRODUCT subtitle       "Subtitle"          single_line_text       "Short subtitle shown under title"
create_def PRODUCT gsm            "GSM"               number_integer         "Fabric weight in grams per square metre"
create_def PRODUCT blend          "Blend"             single_line_text       "Fabric blend description"
create_def PRODUCT weave          "Weave"             single_line_text       "Weave type description"
create_def PRODUCT weave_key      "Weave key"         single_line_text       "Slug used to render the fabric swatch pattern"
create_def PRODUCT fit_type       "Fit type"          single_line_text       "Relaxed / Regular / Slim"
create_def PRODUCT opacity_note   "Opacity"           single_line_text       "Opacity note"
create_def PRODUCT breathability  "Breathability"     single_line_text       "Plain-language breathability"
create_def PRODUCT wash_care      "Wash care"         single_line_text       "Care instructions"
create_def PRODUCT pieces         "Pieces"            "list.single_line_text" "Pieces included in the set"
create_def PRODUCT model_height   "Model height"      single_line_text       "Model height"
create_def PRODUCT model_size     "Model size"        single_line_text       "Size the model is wearing"
create_def PRODUCT model_bust     "Model bust"        number_integer         "Model bust in inches"
create_def PRODUCT model_waist    "Model waist"       number_integer         "Model waist in inches"
create_def PRODUCT fit_note       "Fit note"          single_line_text       "Model fit feedback"
create_def PRODUCT fit_pct_true   "Fit pct true"      number_integer         "% buyers reporting runs-true"
create_def PRODUCT fit_pct_up     "Fit pct up"        number_integer         "% buyers reporting size-up"
create_def PRODUCT fit_pct_down   "Fit pct down"      number_integer         "% buyers reporting size-down"
create_def PRODUCT story          "Story"             multi_line_text_field  "Studio-voice paragraph"
create_def PRODUCT color_options  "Color options"     json                   "Cosmetic color list [{name,hex,weave}]"
create_def PRODUCT demo_reviews   "Demo reviews"      json                   "Seeded review entries"
create_def PRODUCT rating         "Rating"            number_decimal         "Average star rating"
create_def PRODUCT review_count   "Review count"      number_integer         "Total review count"
create_def PRODUCT stock_by_size  "Stock by size"     json                   "Per-size stock snapshot"
