# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary customer: women aged 24 to 45 in metro India (Mumbai, Pune, Bengaluru, Hyderabad, Delhi NCR, Ahmedabad, Chennai, Kolkata), shopping for premium Indian ethnic wear online. The core splits by occasion: 25 to 34 for co-ord sets and kurtis, 30 to 45 for festive and 3-piece sets. They are engaged online shoppers who mostly browse on a phone and often arrive from Instagram or Meta ads, with WhatsApp as a closing channel. Men and under-22 shoppers are out of scope except for retargeting.

## Product Purpose

Morpaankh (operated by Morpaankh Collection, GSTIN 24CAOPG7375L1Z4) is a women's Indian ethnic-wear label selling direct to customers at www.morpaankh.in. The catalogue is curated kurta sets, co-ord sets, anarkali and lehenga sets, festive and 3-piece pieces, kurtis, and tunics, chosen for honest fabric and a fit made for real bodies. It exists to sell premium ethnic wear honestly, where what a shopper sees in the photographs is what arrives. Success right now means turning existing traffic into the first real paying orders: conversion, not reach, is the lever at this stage.

## Positioning

Honest-premium, and a hybrid maker: some pieces are made in-house and some are sourced. The brand-level claim is that honest position itself, never a per-piece handcrafted claim, because half the range is sourced. What a neighbouring label cannot truthfully copy is the promise that what you see is what we send: photo-accurate listings, honest fabric and fit description, clean full pricing with no inflated MRPs, and no fake urgency. Morpaankh is not framed as a reseller or middleman, and is never framed as small, new, or apologetic.

## Operating Context

A Shopify store on the Basic plan. Store host `sawri-bawri.myshopify.com` (permanent `yaaijv-6p.myshopify.com`), live domain www.morpaankh.in, theme "Morpaankh" (#189198631284), a Dawn base with a custom "Tapi" design layer. Checkout is Shopify's native hosted checkout, not themeable on this plan. Both COD and prepaid are offered: prepaid delivery is free, COD carries a flat ₹50 fee; OTP and COD behaviour run through the COD King app. Fulfilment and tracking run through Shiprocket, surfaced on a `/pages/track-order` page. Discounts are entered as codes (for example BUY2, BUY3, WELCOME150); the cart auto-applies whichever eligible code saves the most. The business is based in Surat (B-36 Dangigev society, Punagam, Surat 395010). Customer support is at support@morpaankh.in. Most shoppers are on mobile, discovering through Instagram and Meta, with WhatsApp used to close.

## Capabilities and Constraints

Confirmed storefront capabilities: mobile-first hero with per-viewport crops, a full-screen product gallery (pinch, double-tap, drag-to-pan zoom, keyboard and swipe, focus trap), a localStorage wishlist that works for guests and signed-in shoppers (hearts on cards and PDP, live header count, a `/pages/wishlist` page, adapter-ready for future server sync), a mobile bottom nav with cart and wishlist bubbles, a recently-viewed rail, native share with a branded fallback, an inline accessible size guide, and COD/prepaid nudges on the PDP.

Durable constraints:
- Basic plan: no themeable checkout (no `checkout.liquid`); COD enforcement, some collection filters, and the OTP flow are app- or settings-gated, not editable in the theme.
- Discounts must stay as codes. Automatic order discounts previously stacked (about 25%) and broke the cart offer panel, so they are never re-created; the theme cannot read Admin discounts live, so the cart offer list is a mirror maintained in theme settings.
- Catalogue is roughly 40-plus products across five categories: Kurta Set, One Piece, Festival Set, Co-ord Set, Short Kurti.
- Supplier and wholesaler names are private (kept in an admin-only `internal.supplier` metafield) and must never reach the storefront; public vendor is always "Morpaankh".

## Brand Commitments

- Name: always written "Morpaankh" in running text, and "MORPAANKH" only for large display lockups. Never "MorPaankh" (camelCase, retired mid-2026) and never "Mor Paankh". The repo README still shows the retired camelCase form and is stale on this point.
- Voice: honest and premium, confident and human. Never small, new, or humble. "What you see is what arrives."
- Never claim pieces are handcrafted (untrue for the sourced half); describe fabric, fit, and occasion honestly instead. Never fabricate reviews, ratings, testimonials, customer counts, or revenue.
- No em dashes or en dashes anywhere in customer-facing copy.
- The brand's soul is the peacock feather (morpaankh): product names and copy draw from the peacock's world, and the identity carries that motif.

## Evidence on Hand

- A real, live catalogue (~40-plus products) with product photography, fabric metafields, and SEO metadata, at www.morpaankh.in.
- Registered entity: Morpaankh Collection, GSTIN 24CAOPG7375L1Z4.
- Live legal and support pages: shipping policy, refund/returns policy, privacy, terms, and a Shiprocket-backed order-tracking page.
- Marketing infrastructure: Meta ad account 1046985611096981, an active WhatsApp events dataset, and a Meta Outcomes CAPI service that feeds delivered-purchase signals to Meta.
- No real customer proof yet. As of mid-2026 all historical orders were internal test orders (self-placed, refunded or voided) and there was zero real customer revenue and zero genuine reviews. Future work must not invent reviews, ratings, testimonials, order counts, or revenue claims to fill the gap.

## Product Principles

1. Honesty is the product. What ships matches the photographs. No inflated MRPs, no fake urgency, no fabricated social proof, and no handcrafted claims on sourced pieces.
2. Conversion is the current lever, not traffic. Serve the shopper already on the page toward a first real order before spending to bring more people in.
3. Premium and established, never apologetic. The brand carries itself with confidence; restraint and polish signal premium, not discount theatrics.
4. Built for the phone first. Most shoppers arrive on mobile from Instagram, so the path from first tap to a trusted checkout must feel effortless, with COD kept and prepaid gently rewarded.
5. Protect what is private and true. Supplier identities stay internal and every claim stays defensible.

## Accessibility & Inclusion

No formal external standard is mandated, but the storefront is built as progressive enhancement: it is keyboard navigable, traps focus in dialogs and the full-screen gallery, and respects `prefers-reduced-motion`. Future work should preserve these as existing commitments.
