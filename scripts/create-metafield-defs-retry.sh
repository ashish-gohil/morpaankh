#!/usr/bin/env bash
set -e
STORE=yaaijv-6p.myshopify.com

QUERY='mutation Create($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id namespace key name } userErrors { field message code } } }'

create_def() {
  local owner=$1 key=$2 name=$3 type=$4 desc=$5
  local vars
  vars=$(printf '{"definition":{"namespace":"tapi","key":"%s","name":"%s","ownerType":"%s","type":"%s","description":"%s","access":{"storefront":"PUBLIC_READ"}}}' "$key" "$name" "$owner" "$type" "$desc")
  echo ">> $owner.$key ($type)"
  shopify store execute -s "$STORE" --allow-mutations -j -q "$QUERY" -v "$vars" 2>&1 | grep -E '"id"|message' | head -3
}

create_def PRODUCT subtitle       "Subtitle"          single_line_text_field       "Short subtitle"
create_def PRODUCT blend          "Blend"             single_line_text_field       "Fabric blend description"
create_def PRODUCT weave          "Weave"             single_line_text_field       "Weave type description"
create_def PRODUCT weave_key      "Weave key"         single_line_text_field       "Swatch pattern slug"
create_def PRODUCT fit_type       "Fit type"          single_line_text_field       "Relaxed / Regular / Slim"
create_def PRODUCT opacity_note   "Opacity"           single_line_text_field       "Opacity note"
create_def PRODUCT breathability  "Breathability"     single_line_text_field       "Breathability"
create_def PRODUCT wash_care      "Wash care"         single_line_text_field       "Care instructions"
create_def PRODUCT pieces         "Pieces"            "list.single_line_text_field" "Pieces in the set"
create_def PRODUCT model_height   "Model height"      single_line_text_field       "Model height"
create_def PRODUCT model_size     "Model size"        single_line_text_field       "Model size worn"
create_def PRODUCT fit_note       "Fit note"          single_line_text_field       "Fit feedback note"
