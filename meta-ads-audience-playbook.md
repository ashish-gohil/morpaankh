# Morpaankh — Meta Ads + Audience Playbook
As of 16 Jul 2026. Data: Meta ad account 1046985611096981 (17 Apr–15 Jul 2026, ₹625 spend), Shopify (last 90d). Note: all 18 Shopify orders to date are internal test orders — excluded from all analysis.

## CAMPAIGN BUILT (16 Jul 2026) — all PAUSED, awaiting activation
**Campaign:** Morpaankh | Sales | Women 24-45 Metro | Jul 2026 (ID 120248170309630056, objective: Sales)

| Ad set | Audience | Budget | Ads |
|---|---|---|---|
| AS1 (120248170321400056) | Women 24–34, 7 metros | ₹200/day | Ad 1: Sky-blue kurti reel |
| AS2 (120248170328440056) | Women 35–45, 7 metros | ₹200/day | Ad 2: Block-print carousel · Ad 3: Sky-blue kurti reel |

Metros (radius-targeted 40–50 km): Mumbai, Pune, Bengaluru, Hyderabad, Delhi NCR, Ahmedabad, Chennai. Optimization: Landing Page Views (upgrade to Purchase once pixel has ~50 purchase events). Old boosted-post campaigns: all paused.

**Blocker before activation:** no Meta pixel/dataset exists on the account. Link Shopify → Facebook & Instagram sales channel first (creates pixel + Conversions API + product catalog automatically). Without it, Meta cannot measure landing-page views or purchases and delivery quality collapses.

## Platform linking checklist (do these once, ~30 min)
1. **Shopify → Facebook & Instagram channel** (Shopify admin → Sales channels → add "Facebook & Instagram", log in with the Business Manager owning ad account 1046985611096981). Creates pixel + CAPI + catalog. CRITICAL — do before activating ads.
2. **Verify domain morpaankh.in** in Meta Business Manager → Brand Safety → Domains.
3. **Instagram professional account** already linked to the FB page (ad posts exist) — confirm in Meta Business Settings → Instagram accounts.
4. **GA4**: Shopify admin → add "Google & YouTube" channel → connect GA4 property. Gives an independent second opinion on traffic/conversion vs Meta's attribution.
5. Existing WhatsApp events dataset (1029264589473232) is active — good; later enables click-to-WhatsApp ads and message-based retargeting.

## What the live data says

### Meta ads (last 90 days, ₹625 total, 3 boosted posts, LINK_CLICKS objective)
| Segment | Impressions | Spend share | CTR |
|---|---|---|---|
| Age 18–24 | 44,352 (61%) | 53% | 0.94% (worst) |
| Age 25–34 | 15,941 | 24% | 1.32% |
| Age 35–44 | 5,636 | 10% | 1.83% |
| Age 45–54 | 3,026 | 5% | 2.25% |
| Female | 29,112 (40%) | 48% | 1.25% |
| Male | 43,683 (60%) | 52% | 1.23% |

Top states by delivery: Maharashtra (22.1k), UP (11.7k), Delhi (9.5k), Telangana (8.1k), Gujarat (3.6k), Rajasthan (3.4k). Best CTR with meaningful volume: Tamil Nadu 2.47%, Chhattisgarh 2.48%, Karnataka 1.83%, Gujarat 1.59%.

### Shopify (last 90 days)
Sessions 1,967 · add-to-cart 83 (4.2%) · reached checkout 71 · completed 16 · CVR 0.81%. All 18 orders are internal test orders (self-placed, refunded/voided). Zero real customer revenue so far.

## The 3 problems with current ads
1. **Wrong objective.** LINK_CLICKS buys cheap clickers, not buyers. Meta optimizes for the click, then delivery drifts to whoever clicks most (18–24, men). Switch to Sales objective (purchase conversion) once the pixel has real purchase events.
2. **No audience shaping.** 52% of spend reached MEN and 61% of impressions hit 18–24 — the segment least able to buy premium ethnic wear. For a women's ethnic-wear brand this is majority-wasted delivery.
3. **Ad-gate not met.** Store CVR is 0.81% (gate: ≥1.5%), zero real orders, zero reviews, pixel has no genuine purchase data. Paid scaling now = burning cash to send traffic into a leaky store.

## Target audience definition (for when ads restart)
- **Who:** Women 24–45 (core 25–34 for co-ords/kurtis, 30–45 for festive/3-piece sets), engaged online shoppers.
- **Where (high online-spend metros):** Mumbai, Pune, Bengaluru, Hyderabad, Delhi NCR, Ahmedabad, Chennai, Kolkata. Radius-target the cities, not whole states — state targeting drags in low-intent tier-3 delivery.
- **Interests to layer:** ethnic wear, kurta, saree, Libas, FabIndia, Biba, W for Woman, festive shopping + "Engaged Shoppers" behavior.
- **Exclusions:** men (100% female), under 22 unless retargeting.

## Restart sequence (do in order, don't skip)
1. **Now:** keep ads OFF or ≤₹100/day boost only to seed the pixel. Fix checkout leak (71 reached checkout → 16 completed, mostly tests: check COD option, shipping cost surprise, payment failures).
2. **Get 10–15 real orders + reviews organically** (reels engine, WhatsApp closing).
3. **Then:** ₹300–500/day, Sales objective, Advantage+ placements, audience above. One campaign, 2 ad sets (broad-female-metro vs interest-stacked), 2–3 creatives each — reels that already earned sends/saves organically.
4. **Retarget first rupees:** IG engagers 90d + site visitors 30d converts cheapest.
5. **Scale only at LTV/CAC ≥ 2–3×.**

## Weekly ad review checklist
- CPM, CTR (link), cost per purchase by ad set — kill anything 2× worse than sibling after ₹500 spend.
- Delivery drift: % impressions to women 24–45 in target metros (should stay >75%).
- Frequency <2.5 on retargeting.
- Creative fatigue: CTR drop >30% week-over-week = swap creative.

## Reference library
47 marketing skills installed at `morpaankh-ai-system/marketing-skills-reference/skills/` (paid-ads, ad-creative, marketing-psychology, page-cro, ab-test-setup are the relevant ones for this phase).
