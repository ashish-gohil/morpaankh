# baseline-cart.md — cart-to-checkout drop on morpaankh.in

**Date:** 2026-09-09
**Store:** yaaijv-6p.myshopify.com (storefront www.morpaankh.in)
**Scope of this doc:** measurement only. No code or discount changes have been made. This is CHECKPOINT 1.

---

## 1. The funnel, confirmed independently

I ran the numbers myself in Shopify Analytics (ShopifyQL `sessions` dataset) for 10 Aug to 9 Sep 2026. They match your figures.

| Step | Sessions | Rate |
|---|---|---|
| Sessions | 6,589 | — |
| Added to cart | 363 | 5.5% of sessions |
| Reached checkout | 115 | **31.7% of cart-adds** |
| Completed checkout | 67 | 58.3% of those who reached checkout |

- Cart to checkout: 115 / 363 = **31.68%**. Your 31.7% is correct.
- Checkout to purchase: 67 / 115 = **58.26%**. Your 58.3% is correct. Checkout is the healthy step, leave it alone.
- Whole cart-add to purchase: 67 / 363 = 18.5%.

**The gap, in customers:** to hit the 45% interim bar, cart to checkout needs 164 of 363 sessions, which is +49 more than today. To hit the 50% target it needs 182, which is +67. The problem sits entirely between "Add to cart" and the checkout page.

---

## 2. Cart page: URL, template, sections

- **URL:** https://www.morpaankh.in/cart (full page). `cart_type` is `notification`, so there is no slide-out drawer. After Add to cart a small notification popup shows, and the cart icon links to this `/cart` page. The real cart experience is this page.
- **Template:** `theme/templates/cart.json`
- **Sections rendered, in order:**
  1. `main-cart-items` (`theme/sections/main-cart-items.liquid`) — line items, the smart-offers panel (rendered at line 471), and a sticky desktop `.tapi-cart-aside` order summary (line 491).
  2. `main-cart-footer` (`theme/sections/main-cart-footer.liquid`) — subtotal/discount/total block, the Checkout button, and a 4-line assurance row.
  3. `featured-collection` — a "you may also like" grid.

**Note on your brief's wording:** you call the new saving line a "cart-drawer line." This store has no drawer (`cart_type: notification`). The equivalent surface is the `/cart` page and the notification popup. I will put the saving lines on the `/cart` page (and the popup where it fits). The DONE criteria match this (a 2-item cart recording on mobile is the `/cart` page).

---

## 3. App scripts on cart and checkout

**Caveat on method:** the Admin token exposed to me is denied the `read_script_tags` scope, so I could not enumerate ScriptTag injections through the API. The list below is built from the theme files, the app-embed config in `settings_data.json`, and the Customer Events pixel setup recorded in project memory. A definitive script list on the hosted checkout page would need checkout access I do not have. Confirmed vs inferred is marked.

**On the cart page (storefront, theme scope):**
- Theme JS (confirmed, `theme/layout/theme.liquid`): `constants.js`, `pubsub.js`, `global.js`, `details-disclosure.js`, `details-modal.js`, `search-form.js`, `tapi-motion.js`, `tapi-ux.js`, `localization-form.js`, `predictive-search.js`, `cart-drawer.js`.
- `tapi-offers.js` (confirmed) — loaded by `main-cart-items.liquid` (and the PDP). Runs the smart-offers panel and the auto-apply (see section 5).
- `tapi-analytics.js` (confirmed) — GA4 via gtag/googletagmanager. Already fires `add_to_cart` (AddToCart), `view_cart`, and `begin_checkout` (InitiateCheckout) in theme scope. These are real, reusable event hooks, but they are GA4/Meta, not Clarity.
- **COD King** (confirmed present) — installed as a theme **app embed** block (`shopify://apps/cod-king/blocks/app-embed/99553eb5-...`, `disabled: false` in `settings_data.json`). This injects COD King's storefront JS globally, including the OTP / partial-COD gate. See sections 6 and 7.
- Meta Pixel (inferred, from memory) — dataset 2138165280468636, wired via Shopify's Meta channel / web pixel, not the theme.

**On the checkout page (Shopify native hosted):**
- The live checkout is Shopify's native hosted checkout (Basic plan), confirmed in memory. It is not a theme file, not Razorpay, not COD King's own page.
- Tracking there: the "GA4 Ecommerce" Customer Events custom pixel (id 203161972, from memory) fires checkout and purchase events; the Meta pixel fires there too.
- COD King operates **before** the redirect to hosted checkout (OTP gate) and through its `partial-payment` utility product, rather than by injecting into the hosted checkout page (Basic cannot take custom checkout scripts). Inferred from the app-embed wiring and theme comments.
- Dynamic checkout ("Buy it now") buttons are enabled and surface on the cart footer via `content_for_additional_checkout_buttons`.

**Microsoft Clarity:** not present anywhere in the theme (grep returned nothing). Step (d) adds it from scratch.

---

## 4. Discount configuration, live (confirmed via Admin API)

All discounts read live from the store today:

| Code / name | Type | Value | Threshold | Status | Uses | Per-customer |
|---|---|---|---|---|---|---|
| **BUY2** ("Buy 2, get 10% off") | DiscountCodeBasic (code-entry) | 10% | min qty **2** | ACTIVE, no end | **1** | no |
| **BUY3** ("Buy 3, get 15% off") | DiscountCodeBasic (code-entry) | 15% | min qty **3** | ACTIVE, no end | **0** | no |
| WELCOME150 | DiscountCodeBasic (code-entry) | Rs.150 off | min subtotal Rs.1,199 | ACTIVE (from 2 Sep) | 3 | yes (first order) |
| (a free-shipping code) | DiscountCodeFreeShipping | free ship | — | present | — | — |
| OFF20 | DiscountCodeBasic | 20% | min Rs.3,000 | EXPIRED (28 Jul) | 0 | yes |
| WELCOME200 | DiscountCodeBasic | Rs.200 off | min Rs.1,000 | EXPIRED (28 Jul) | 0 | yes |

**Automatic discounts:** seven exist, **all EXPIRED**. There is currently **no active automatic discount** of any kind. This confirms memory: the old Buy2/Buy3 automatics were turned off, codes were kept.

**So your brief is confirmed:** BUY2 and BUY3 are code-entry `DiscountCodeBasic` with quantity thresholds 2 and 3, at 10% and 15%, both ACTIVE, BUY2 used once, BUY3 never used. They apply only if the shopper types the code or the theme JS applies it for them.

---

## 5. The offers panel today (the logic you want preserved)

This is the "showing available codes" logic. It stays; only the application becomes automatic.

- **`theme/snippets/tapi-smart-offers.liquid`** reads four offer slots from Theme settings (Offers), which are a hand-maintained **mirror** of the Admin codes (the theme cannot read Admin discounts live). For this cart it computes each offer's eligibility (min qty, min subtotal) and real saving, lists every public code as a coupon card, labels first-order codes, and tags the largest eligible one "Biggest saving."
- **`theme/assets/tapi-offers.js`** already **auto-applies the best general (non first-order) code once** on cart load, by POSTing `{ discount: CODE }` to `/cart/update.js`. The shopper can switch or remove. Apply/Remove buttons re-post and re-render the cart sections.

**Why this still leaks, and why your fix is right:** the saving only lands if (1) JavaScript runs and completes its round trip, and (2) the code is a valid, applicable `DiscountCodeBasic`. A shopper on a slow phone, or before the JS settles, sees the cart total with **no saving applied** even though the marquee promised one. Converting BUY2/BUY3 to **automatic** discounts makes the saving land server-side on page render, with zero dependency on JS or on the code being applied. The panel keeps listing the offers; it just reflects an already-applied automatic saving instead of having to apply a code.

**Known integration note for the fix (from memory):** when a discount is automatic, `cart.cart_level_discount_applications[].title` is the discount's **name**, not the code. The panel currently matches applied state by code string. So when I convert to automatic, I must adapt the panel's applied-state detection, or it will show the saving line (section 2 of the footer already reads `total_discount` correctly) but the coupon card's "Applied" badge may not light up. I will handle that in the fix so the panel behaves exactly as today while the discount is automatic, and still auto-applies whichever is best for the cart. No code change yet.

---

## 6. COD fee: where Rs.50 is first shown

- **The theme does not render the COD fee anywhere.** Grep across all `.liquid` and `.js` found no COD-fee line on the cart. The cart footer's assurance line says "Free delivery on prepaid orders" (that is the shipping promise, not the Rs.50 COD fee).
- Every place the store mentions the COD fee, it says it appears **at checkout**: the FAQ ("Cash on Delivery carries a delivery fee, which you see at checkout before you confirm") and the PDP ("Cash on Delivery available across India, with a delivery fee shown at checkout").
- **Conclusion:** the Rs.50 COD fee is first shown to the customer **on the Shopify checkout page**, added by COD King when COD is chosen, **not on the cart**. That matches your hypothesis for fix (b): surface it earlier, as "Free on prepaid, pay online and save Rs.50," so no cost appears for the first time at checkout.
- **Caveat to confirm before I hardcode the amount:** the Rs.50 figure comes from COD King's Payment Rules (app config, per memory), not from any theme value. I will confirm the current exact amount in the COD King dashboard (or a live checkout test) before writing it into cart copy, so the cart never states a number that disagrees with checkout.

---

## 7. COD King OTP: where it sits in the flow

- COD King runs as a storefront app embed and its OTP / partial-COD gate hooks the checkout-initiating buttons (the native "Buy it now" dynamic checkout, and the cart Checkout submit), firing **before** the redirect to Shopify's hosted checkout. Theme comments in `main-product-tapi.liquid` confirm the gate attaches to these buttons and that the mobile sticky buy button was mirrored specifically so the OTP gate fires on phones too.
- On Basic, payment-method selection happens **inside** Shopify's hosted checkout, which is after that redirect.
- **Conclusion:** the OTP gate runs **before** the customer sees payment options. That is the "wall" in your fix (c): a phone-verification step the shopper hits before they have chosen anything.
- **Caveat:** the exact trigger and sequence, and whether COD King can defer the OTP to after payment selection, depend on COD King's flow settings (Same Order vs New Order, pre-checkout popup config). That is an app-settings change, not theme code, and per your sequencing it is deferred until after (a) has 72 hours of data. I will confirm the live sequence with a mobile screen recording during the fix phase rather than trigger a real OTP SMS now.

---

## 8. Finding that bears directly on the drop (for your decision, no action taken)

While verifying, I found an expectation gap that likely contributes to the cart-to-checkout loss and is worth a decision from you:

- The **live announcement bar** (`tapi-announcement`) currently reads: **"Minimum 40% off · Ends tomorrow · Then full price returns."** It is not the "Buy 2 save 10% · Buy 3 save 15%" line from your brief.
- The **"Buy 2 save 10% · Buy 3 save 15%"** promise is in the **trust marquee** (`trust-marquee.liquid`), which runs as a storefront strip.
- So a shopper is told "minimum 40% off" up top, then at the cart the best real saving is 10% to 15% (BUY2/BUY3) or Rs.150 (WELCOME150, first order). A shopper who came for 40% and sees 10% at the cart has a strong reason to bounce. This is plausibly a bigger lever than the mechanics in (a) to (d).
- I have not changed this. It touches pricing honesty, which is a sensitive brand area, and it is outside (a) to (d). Flagging it so you can decide whether to correct the announcement copy alongside the cart fixes.

---

## 9. What I propose to do next (pending your go)

In your order, on a **duplicate theme**, publishing only at the final checkpoint after your approval:

- **(a)** Create automatic quantity-break discounts: 10% at qty 2, 15% at qty 3, same thresholds, whole-order, so the biggest applicable one lands automatically with no code. Keep BUY2/BUY3 codes alive for 30 days so existing links do not 404. Keep the offers panel exactly as it shows today; adapt its applied-state detection so it still reflects the now-automatic saving and still surfaces which offer is best. Add a cart line showing the saving applied and a line showing what one more piece would save.
- **(b)** Surface the COD fee on the cart as a line plus "Free on prepaid, pay online and save Rs.50," after I confirm the exact amount in COD King.
- **(c)** Move the COD King OTP to after payment-method selection (app settings), so COD is a choice, not a wall. Deferred until (a) has 72 hours of data.
- **(d)** Add Microsoft Clarity with custom tags on add_to_cart, cart_view, checkout_click, discount_applied, and set up the "added to cart, no checkout_click" segment. Deferred until (a) has 72 hours of data.

**CHECKPOINT 2** is after (a) ships on the duplicate and runs 72 hours: I report cart-to-checkout before and after, and do not ship (b)(c)(d) until then.

**Waiting for your go before any code change.**
