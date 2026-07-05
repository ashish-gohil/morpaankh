# MorPaankh marketing, analytics, and ads integrations

How each platform connects to the store, what is already wired in the theme, and what Claude can automate once access exists. Companion to `docs/seo-geo.md` (search + AI discovery) and `docs/SETUP-CHECKLIST.md` (automation stack accounts). Updated 2026-07-05 against live theme 189198631284.

## Already wired in the theme (paste an ID, it goes live)

Theme settings → Analytics (Online Store → Themes → Customize → Theme settings):

| Setting | What it enables | Where to get it |
|---|---|---|
| GA4 Measurement ID | Full GA4 event stream: page_view, view_item, add_to_cart, begin_checkout, view_promotion, select_promotion, add_to_wishlist | analytics.google.com → Admin → Data streams (looks like G-XXXXXXXXXX) |
| GTM container ID | Loads Google Tag Manager and pushes every event above into the dataLayer, so any tag (Google Ads, remarketing, etc.) can be managed in GTM without theme edits | tagmanager.google.com (looks like GTM-XXXXXXX) |
| Meta Pixel ID | PageView, ViewContent, AddToCart, InitiateCheckout as Meta standard events with product name, id, value | business.facebook.com → Events Manager |

All three are independent, load lazily (idle or first interaction, off the critical path), and nothing ships to the browser until at least one ID is set. Implementation: `assets/tapi-analytics.js`, gated in `layout/theme.liquid`.

Two double-counting traps, called out in the settings UI too:

- If GA4 is configured directly here AND as a tag inside GTM, every event counts twice. Pick one home for GA4.
- If the Facebook & Instagram sales channel app is installed later, clear the theme Meta Pixel ID. The channel injects its own pixel.

## Checkout and purchase events (needs a Customer Events pixel, not theme code)

Shopify's checkout is sandboxed; theme JavaScript cannot see it. Purchase tracking lives in Settings → Customer events → Add custom pixel. Paste this, filling in the IDs:

```js
const GA4_ID = 'G-XXXXXXXXXX';   // same ID as in theme settings

const s = document.createElement('script');
s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
document.head.appendChild(s);
window.dataLayer = window.dataLayer || [];
function gtag(){ dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', GA4_ID);

analytics.subscribe('checkout_started', (event) => {
  gtag('event', 'begin_checkout', {
    currency: event.data.checkout.currencyCode,
    value: Number(event.data.checkout.totalPrice?.amount || 0)
  });
});

analytics.subscribe('checkout_completed', (event) => {
  const c = event.data.checkout;
  gtag('event', 'purchase', {
    transaction_id: c.order?.id || c.token,
    currency: c.currencyCode,
    value: Number(c.totalPrice?.amount || 0),
    items: c.lineItems.map((li) => ({
      item_id: li.variant?.sku || li.variant?.id,
      item_name: li.title,
      quantity: li.quantity,
      price: Number(li.variant?.price?.amount || 0)
    }))
  });
});
```

For Meta purchase events, prefer the Facebook & Instagram channel app (below): it adds checkout + Purchase tracking and the Conversions API server-side, which a hand-written pixel cannot.

## Platform-by-platform

### Google Search Console (free, do first)

1. search.google.com/search-console → Add property → Domain → morpaankh.in. Verify by DNS TXT record (domain is on Shopify: Settings → Domains → morpaankh.in → DNS settings → add TXT).
2. Submit sitemap: `https://www.morpaankh.in/sitemap.xml`.
3. URL Inspection → Request indexing for the homepage, top collections, and top products (a handful per day is enough).
4. The four "Rule ignored by Googlebot" robots.txt warnings were fixed 2026-07-04 (crawl-delay lines removed); they clear on Google's next robots fetch. "Blocked by robots.txt" entries for `/search?q=...` and `/cart/...` are correct behaviour, not errors.

### Bing Webmaster Tools (free, 2 minutes)

bing.com/webmasters → "Import from Google Search Console". Covers Bing and Microsoft Copilot answers.

### Google Analytics 4 (free)

Create the property at analytics.google.com, copy the G- ID into theme settings, add the custom pixel above for purchases. Turn on theme setting "Debug mode" and confirm events in Admin → DebugView, then turn it off.

### Google Tag Manager (optional)

Only worth adding when you want to manage Google Ads/remarketing tags yourself. Create a container, paste GTM-XXXXXXX into theme settings. Every tapi-analytics event arrives as a dataLayer event of the same name (view_item, add_to_cart, ...), so GTM triggers can key on them directly.

### Google Ads + Merchant Center

- Install the **Google & YouTube channel app** from the Shopify App Store. It creates/links Merchant Center, syncs the product feed (titles, prices, availability stay in sync automatically), and sets up conversion tracking for Shopping/Performance Max.
- The Product schema now carries per-offer shipping (free, 1-2 day dispatch, 3-7 day transit, IN) and 7-day return policy, which Merchant Center reads for free-listing eligibility.
- Link Google Ads ↔ GA4 (GA4 Admin → Product links) so campaigns can bid on GA4 conversions.

### Meta Pixel + Meta Ads

- Fast start: paste the Pixel ID into theme settings (storefront events flow immediately).
- Proper setup for running ads: install the **Facebook & Instagram channel app**, connect the same pixel, enable Conversions API. Then clear the theme Pixel ID field to avoid double-firing.
- Catalog sync from the channel app enables dynamic product ads and Instagram Shopping tags.

### WhatsApp / Brevo / order automation

Covered in `docs/SETUP-CHECKLIST.md` and `docs/automation-analytics-program.md` (hub + node-workflow flows are built and tested; deploy blocked on those accounts).

## What Claude can automate, and what needs you

Claude (this CLI) can, once credentials exist:

- **Search Console API** (service account JSON, kept gitignored): pull query/page performance, coverage issues, submit sitemaps, and produce weekly reports. You add the service account email as a user in GSC once.
- **GA4 Data API** (same service-account pattern): traffic/conversion reports, funnel drop-off analysis, comparisons after changes ship.
- **Shopify Admin API** (already in use): product feed hygiene, price/inventory checks, discount verification, ShopifyQL sales analytics.
- **Meta Marketing API** (system-user token from Business Manager): read campaign performance, adjust budgets, pause/enable ad sets, build reports.
- **Google Ads API**: needs a developer token (manual Google approval, days to weeks) plus OAuth. Until then, reporting via the GA4 link is the practical path.

Always manual, by design of the platforms:

- Account creation, domain verification, and billing on every platform.
- Meta WhatsApp template approvals; Google Ads developer-token approval.
- Ad creative approval and any spend decisions: Claude can draft campaigns and recommend budgets, launching them stays a human click.

## Verification checklist

Theme side (all verified live 2026-07-05):

- [x] robots.txt: AI crawlers allowed, no crawl-delay warnings, cart/search correctly blocked
- [x] sitemap.xml 200 + referenced in robots.txt (includes Shopify's agentic-discovery sitemap for AI shopping agents)
- [x] Canonical, meta description fallback chain, OG/Twitter cards on every page
- [x] JSON-LD parses machine-clean: Organization, WebSite+SearchAction, Product (offers per variant, fabric facts, country of origin), OfferShippingDetails, MerchantReturnPolicy, BreadcrumbList, CollectionPage+ItemList, FAQPage
- [x] Analytics: GA4/GTM/Meta Pixel settings exist, zero bytes load until an ID is set

Merchant side (each unlocks the next win):

- [ ] GSC verified + sitemap submitted + homepage/top pages requested for indexing
- [ ] Bing Webmaster imported from GSC
- [ ] GA4 property created, G- ID pasted in theme settings, purchase pixel added in Customer events, DebugView checked
- [ ] Google & YouTube channel app installed (Merchant Center + Shopping feed + Ads conversions)
- [ ] Meta Pixel ID pasted (or channel app installed with Conversions API)
- [ ] After both: rich-results spot check at search.google.com/test/rich-results on one product URL
