# MorPaankh — finance

Per-order contribution ledger and period P&L. Joins Shopify revenue, Shopify
COGS, Delhivery freight, payment costs and Meta spend into one number that
answers: **on this order, did we make money or lose it.**

## Why this exists

Shopify reports revenue. Meta reports ROAS. Neither knows what a parcel cost to
ship, what the COD fee took, or what came back as RTO. Both numbers therefore
overstate the business. This module is the correction.

## The design rule

**The engine never invents a cost.** If freight, packaging or GST is missing for
an order, that order is marked incomplete and excluded from the verified totals,
and the report prints exactly which input is missing and how many orders it
blocks. A number here is either traceable to a verified input or it is not
reported. Rates that are assumed rather than verified are listed at the bottom of
every run.

## Run it

```bash
node pnl.mjs --from 2026-09-01 --to 2026-09-30
node pnl.mjs --from 2026-09-01 --to 2026-09-30 --csv
node pnl.mjs --from 2026-09-01 --to 2026-09-19 --model cost-model.scenario.json
```

Outputs land in `out/`.

## Files

| File | What it is |
|---|---|
| `cost-model.json` | Every rate, each tagged VERIFIED / ASSUMED / MISSING. The file to edit. |
| `cost-model.scenario.json` | Illustrative placeholders. Shows engine output shape. **Never quote these numbers.** |
| `data/orders.json` | Shopify orders. Claude writes this from the Shopify MCP. |
| `data/shipments.json` | Per-AWB Delhivery costs. Claude writes this from the Delhivery MCP. |
| `data/adspend.json` | Meta spend by campaign, tagged `online` or `offline`. |
| `pnl.mjs` | The engine. |

## Data flow

```
Shopify MCP  ──orders, line items, unitCost, AWB──┐
                                                  ├──▶ pnl.mjs ──▶ out/pnl_*.json + .csv
Delhivery MCP ──freight, COD fee, status by AWB───┤
Meta Ads MCP  ──spend by campaign─────────────────┘
```

The join key is the **Delhivery AWB**, which Shopify already stores on each
fulfillment as `trackingInfo.number`.

## Accounting decisions worth knowing

**RTO does not destroy COGS.** The garment comes back and is restockable. What is
lost on an RTO is both freight legs, the packaging, and the ad spend that bought
the order. Models that write off COGS on RTO overstate the damage; models that
ignore the return leg understate it. This engine does neither.

**COD collected implies delivered.** When Delhivery status is not yet loaded, a
COD order whose Shopify financial status flipped to PAID means the courier
collected cash, which only happens on delivery. The engine uses this and labels
those rows `DELIVERED*` with the inference declared.

**Partial-payment orders are refused, not guessed.** This store records a partial
payment as two line items for the same garment (a deposit line and a balance
line). Costing both double-counts COGS. The engine flags
`partial_payment_duplicate_lines` and drops the order from verified totals rather
than guessing which line is real.

**Offline boosts are excluded.** Instagram post boost campaigns drive offline
sales by standing rule, so their spend is reported separately and kept out of the
storefront P&L.

## Known gaps

These block full coverage. Each is listed in `cost-model.json` with `MISSING`.

1. **Per-AWB billed freight** — needs the Delhivery One MCP connected, or a
   billing CSV. Without it the engine cannot cost any shipment.
2. **Packaging cost per order** — needs a number from Ashish.
3. **GST** — slab, and whether listed prices are GST-inclusive. Swings net profit
   by 5-18%.
4. **Fixed monthly costs** — Shopify plan, COD King, domain, WhatsApp API.
5. **Gateway rate** — assumed 2% + 18% GST. Confirm from a settlement statement.
6. **COD remittance fee** — assumed higher of ₹40 or 1.5%. Confirm from an invoice.

## Data quality problems found in Shopify

- Most products have **weight 0**. Delhivery bills on actual or volumetric
  weight, whichever is higher. With no declared weight there is no way to catch
  weight-discrepancy overbilling, the most common silent margin leak in Indian
  D2C.
- **Kohra** and **Latkan** are set to `0.6 GRAMS`. Almost certainly meant to be
  0.6 kilograms.
- The **"Partial Payment" ₹0 product** is still ACTIVE.
- Several variants have `sku: null` (Anaar, Bandhan, Darpan, Morani, Shabnam),
  so cost attribution falls back to product title.
- Two orders per month ship via **Tirupati Courier** ("Other"), not Delhivery.
  They will never resolve against the Delhivery MCP and need manual cost entry.
