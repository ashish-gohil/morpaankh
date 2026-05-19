#!/usr/bin/env bash
set -e
STORE=yaaijv-6p.myshopify.com
MANIFEST=/Users/ashishgohil/garment-seller/scripts/manifest.json

QUERY='mutation P($page: PageCreateInput!) { pageCreate(page: $page) { page { id handle title } userErrors { field message code } } }'

create_page() {
  local handle=$1 title=$2 body=$3
  local vars
  vars=$(jq -cn --arg t "$title" --arg h "$handle" --arg b "$body" '{page:{title:$t,handle:$h,body:$b,isPublished:true}}')
  echo ">> page: $handle"
  local out
  out=$(shopify store execute -s "$STORE" --allow-mutations -j -q "$QUERY" -v "$vars" 2>&1 | tail -25)
  local id
  id=$(echo "$out" | grep -oE 'gid://shopify/Page/[0-9]+' | head -1)
  echo "   id: $id"
  jq --arg h "$handle" --arg i "$id" '.pages[$h]=$i' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
}

ABOUT_BODY='<p><em>— Our story · est. Surat</em></p>
<h2>A studio above my father&rsquo;s shop.</h2>
<p>I&rsquo;m Aanya. My husband Vikrant and I started Tapi &amp; Co. in a single room in Rampura, Surat. Today the cousins help with operations, the studio is bigger, and the fabric still comes from eleven weavers within walking distance.</p>
<h3>The name</h3>
<p>The Tapi flows past Surat into the Arabian Sea. Our city has been a textile port for four centuries &mdash; its handlooms once dressed half the world. We took her name because we wanted our label to feel like it belonged here, not anywhere else.</p>
<h3>How we work &mdash; three principles, nothing else</h3>
<ol>
  <li><strong>Tell the truth in numbers.</strong> GSM, blend, weave, fit-type, opacity, model&rsquo;s measurements &mdash; on every product page. If you&rsquo;d ask us in person, it should be written down.</li>
  <li><strong>Size-true, always.</strong> Our chart is built from the bodies of our family, friends, and customers &mdash; not industry standards. We list fit feedback from real buyers below every size selector.</li>
  <li><strong>Show what arrives.</strong> No filters, no stretched models, no posed photography that disagrees with the garment. What you see on screen is what comes out of the box.</li>
</ol>
<h3>Visit the studio</h3>
<p>Rampura Main Rd, 2nd floor &middot; Surat 395003, Gujarat<br>Mon&ndash;Sat &middot; 10am&ndash;7pm &middot; Closed Sundays</p>'

CONTACT_BODY='<p>We answer WhatsApp fastest. For everything else, the email below works.</p>
<ul>
  <li><strong>WhatsApp:</strong> +91 XX-XXXX-XXXX</li>
  <li><strong>Email:</strong> hello@tapi.co</li>
  <li><strong>Studio:</strong> Rampura Main Rd, 2nd floor, Surat 395003</li>
  <li><strong>Hours:</strong> Mon&ndash;Sat &middot; 10am&ndash;7pm</li>
</ul>'

FABRIC_BODY='<p><em>Know your fabric.</em></p>
<h2>120 GSM is summer. 180 GSM is the wedding.</h2>
<p>We list the weight, weave, and blend on every piece. Here&rsquo;s how to read those numbers.</p>
<h3>GSM &mdash; grams per square metre</h3>
<ul>
  <li><strong>110&ndash;130 GSM:</strong> Featherweight cottons (mulmul, voile). Light, airy, breathable. Best for Mumbai-summer, layering, and everyday.</li>
  <li><strong>140&ndash;160 GSM:</strong> Mid-weight (cotton-modal, twill). Hold shape, drape well, work as office wear.</li>
  <li><strong>170&ndash;200 GSM:</strong> Heavier (dobby, silk-cotton). Hold structure. Better for festive, photographs, the camera.</li>
</ul>
<h3>Weave types</h3>
<p><strong>Plain</strong> &mdash; the everyday workhorse. Even threads, soft drape.<br><strong>Voile</strong> &mdash; loose plain weave. Almost translucent.<br><strong>Satin</strong> &mdash; smooth one-side, soft sheen.<br><strong>Twill</strong> &mdash; diagonal lines. Strong, drapes structurally.<br><strong>Dobby</strong> &mdash; small geometric texture. Holds light differently.<br><strong>Block-print</strong> &mdash; carved wooden block printed by hand. No two pieces identical.</p>'

PRIVACY_BODY='<p><em>Last updated: 19 May 2026.</em></p>
<p>This is a placeholder privacy policy for the Tapi &amp; Co. development store. The merchant must replace this with a final policy reviewed by legal counsel before launching.</p>
<h3>What we collect</h3>
<ul>
  <li>Order details (name, shipping address, contact)</li>
  <li>Payment information (handled by our payment processor &mdash; we never see card data)</li>
  <li>Browsing analytics (cookies, page views)</li>
</ul>
<h3>How we use it</h3>
<ul>
  <li>Fulfilling your order</li>
  <li>Customer support and exchanges</li>
  <li>Marketing emails (only if you opt in)</li>
</ul>
<p>Reach out to <a href="mailto:hello@tapi.co">hello@tapi.co</a> for any data requests.</p>'

TERMS_BODY='<p><em>Last updated: 19 May 2026.</em></p>
<p>This is a placeholder Terms of Service for the Tapi &amp; Co. development store. Replace with reviewed legal copy before launching.</p>
<h3>Orders</h3>
<p>All prices are inclusive of GST. Orders ship from Surat, Gujarat. Free shipping on orders above &#8377;2,499.</p>
<h3>Exchanges &amp; returns</h3>
<p>Free exchange on your first order. See our Refund Policy for full details.</p>
<h3>Intellectual property</h3>
<p>The Tapi &amp; Co. name, logos, and original photography belong to us.</p>'

REFUND_BODY='<p><em>Last updated: 19 May 2026.</em></p>
<p><strong>Free exchange on your first order.</strong> If the size isn&rsquo;t right, we&rsquo;ll swap it. No questions asked.</p>
<h3>Eligibility</h3>
<ul>
  <li>Within 7 days of delivery</li>
  <li>Unworn, unwashed, tags attached</li>
  <li>Original packaging</li>
</ul>
<h3>How to request</h3>
<p>WhatsApp us at +91 XX-XXXX-XXXX or email hello@tapi.co with your order number and what you&rsquo;d like to swap to. We&rsquo;ll send a return waybill.</p>
<h3>Refunds</h3>
<p>If we can&rsquo;t fulfill an exchange, we refund to your original payment method within 7 business days of receiving the return.</p>'

create_page about         "Our Story"      "$ABOUT_BODY"
create_page contact       "Contact"        "$CONTACT_BODY"
create_page fabric-guide  "Fabric Guide"   "$FABRIC_BODY"
create_page privacy       "Privacy Policy" "$PRIVACY_BODY"
create_page terms         "Terms of Service" "$TERMS_BODY"
create_page refund        "Refund Policy"  "$REFUND_BODY"

echo "--- pages manifest ---"
jq '.pages' "$MANIFEST"
