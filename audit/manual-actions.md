# Manual actions (things I cannot do from here, with exact click paths)

Status legend: **P0** = do first, blocks everything; **admin** = Shopify admin / GSC, no code.

---

## P0 — Get the site indexed by Google (off-site; needs your Google account)

The theme is fully indexable (robots index,follow, canonicals, valid sitemap). The site just isn't in Google's index yet (`site:morpaankh.in` returns nothing). Fix, in order:

1. **Google Search Console** — go to https://search.google.com/search-console and add a **Domain property** for `morpaankh.in`.
   - Verify via DNS TXT: GSC gives you a `google-site-verification=...` TXT record. Add it at your domain registrar (where morpaankh.in DNS is managed) → verify. (Domain property covers www + non-www + http/https in one.)
2. **Submit the sitemap** — in GSC → Sitemaps → enter `sitemap.xml` → Submit. (Full URL: https://www.morpaankh.in/sitemap.xml)
3. **Request indexing for the key pages** — GSC → URL Inspection → paste each, click **Request Indexing**:
   - Homepage: `https://www.morpaankh.in/`
   - Top collections: `/collections/kurta-sets`, `/collections/co-ord-sets`, `/collections/festive`, `/collections/new-arrivals`
   - 5-10 best products (e.g. `/products/bandhan`, `/products/taana`, `/products/morani`)
4. **Check for blockers** — GSC → **Pages** (Coverage) report and **Security & Manual actions → Manual actions**. If "Manual action" shows anything, that's the real cause; tell me what it says.
5. **Off-site signals** (why a new domain stays unindexed): get a few real inbound links — your Instagram bio/link, WhatsApp Business catalog, Google Business Profile, any press/marketplace listing. Even 3-5 real links + GSC submission usually gets a young store crawled within days to ~2 weeks.

Verify success: GSC Pages shows URLs moving to "Indexed", and `site:morpaankh.in` starts returning your pages.

---

## Store-data fixes — HELD pending your OK (Phase 7 rule: ask before writing outside the theme)

These are Shopify **data** writes, not theme code. Your earlier instruction was "do not write to the store," so I've prepared but not applied them. Say "apply the store fixes" and I'll do them via the Admin API (all reversible). Or do them by hand:

1. **partial-payment → Draft.** The COD deposit utility SKU is live on the storefront as a product. Admin → Products → "Partial Payment" → set **Status: Draft** (or remove from the Online Store sales channel). It is not merchandise and should not be browseable/indexable.
2. **ghera productType.** Admin → Products → Ghera → set **Product type = Festival Set** (currently empty). Also affects its collection membership logic.
3. **Meta descriptions (38 products).** All the tightened <=155-char versions are in `audit/seo-import.csv` (column `meta_description`). Apply per product: Admin → product → Search engine listing → Edit → paste. (Or I batch them via API.)
4. **toran + haldi SEO.** Full new SEO title + meta description + featured-image alt are in the CSV (they shipped with none). Apply via product → Search engine listing + image alt.
5. **Image alt backfill (5 products): toran, haldi, nazakat, anaar, ghera** (0 alts each). Suggested featured-image alt is in the CSV; set per image under the product's Media.
6. **best-sellers collection title** is thin ("Best Sellers", 12 chars). New title in `audit/seo-import-collections.csv`. Apply: Admin → Collections → Best Sellers → Search engine listing.
7. **Collection meta descriptions** slightly over 155 (anarkali-sets, co-ord-sets, festive, one-piece) — tightened versions in the collections CSV.

---

## Deploys done (for reference)
- C1 (og:price comma fix) is LIVE on theme 189198631284, verified (renders `1349.00`).
- A throwaway preview theme "AUDIT-C1-preview" (id 193424687476) was created for verification. Safe to delete: Admin → Themes → AUDIT-C1-preview → Remove. (Tell me and I can delete it too.)

## Still pending (needs a tool/session, not you)
- Phase 4 lab CWV + Phase 5 flow-walk: needs the Chrome session (extension now appears connected). Say "run the Chrome session".
