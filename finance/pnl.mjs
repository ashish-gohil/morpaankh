#!/usr/bin/env node
/**
 * MorPaankh P&L engine.
 *
 * Deterministic. Takes cleaned Shopify orders + Delhivery shipment costs and
 * produces a per-order contribution ledger and a period P&L.
 *
 * Hard rule: this engine never invents a cost. If an input is missing the order
 * is marked incomplete and excluded from the "verified" totals, and the report
 * says so. Assumed rates are carried through to the output so every number can
 * be traced back to VERIFIED or ASSUMED.
 *
 * Usage:
 *   node pnl.mjs --from 2026-09-01 --to 2026-09-19
 *   node pnl.mjs --from 2026-09-01 --to 2026-09-19 --csv
 *
 * Inputs (all relative to this file):
 *   cost-model.json     rates, tagged VERIFIED / ASSUMED / MISSING
 *   data/orders.json    Shopify orders, written by Claude from the Shopify MCP
 *   data/shipments.json Delhivery per-AWB costs, written by Claude from the Delhivery MCP
 *   data/adspend.json   optional: [{ date, amount, campaign, channel }]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const inr = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : '₹' + r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = { from: null, to: null, csv: false, json: true, model: 'cost-model.json' }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--from') a.from = argv[++i]
    else if (argv[i] === '--to') a.to = argv[++i]
    else if (argv[i] === '--model') a.model = argv[++i]
    else if (argv[i] === '--csv') a.csv = true
    else if (argv[i] === '--no-json') a.json = false
  }
  return a
}

function loadJson(rel, fallback) {
  const p = join(HERE, rel)
  if (!existsSync(p)) {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required input: ${rel}`)
  }
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ---------------------------------------------------------------- hygiene
// Mirrors the standing rule: clean test, family, refunded and voided orders
// before any calculation.

const FAMILY_MARKERS = ['test', 'testing', 'sample', 'demo']

function classifyOrder(o, opts = {}) {
  const reasons = []
  if (o.test) reasons.push('shopify_test_order')
  if (o.financialStatus === 'VOIDED') reasons.push('voided')
  if (o.cancelledAt) reasons.push('cancelled')
  if (o.tags?.some((t) => /^(test|family|internal|staff)$/i.test(t))) reasons.push('tagged_internal')
  const hay = `${o.customerEmail ?? ''} ${o.customerName ?? ''}`.toLowerCase()
  if (FAMILY_MARKERS.some((m) => hay.includes(m))) reasons.push('name_or_email_marker')
  if (opts.excludeEmails?.includes((o.customerEmail ?? '').toLowerCase())) reasons.push('known_internal_email')
  return reasons
}

// ---------------------------------------------------------------- costing

function val(node) {
  if (node === null || node === undefined) return null
  if (typeof node === 'object' && 'value' in node) return node.value
  return node
}

function codRemitFee(codValue, model) {
  const cfg = model.shipping.codRemittanceFee
  if (!cfg) return null
  const flat = cfg.flat ?? 0
  const pct = ((cfg.percentOfCodValue ?? 0) / 100) * codValue
  return cfg.rule === 'higher_of' ? Math.max(flat, pct) : flat + pct
}

function gatewayFee(amountOnline, model) {
  const pct = val(model.payment.gatewayPercent)
  const gst = val(model.payment.gatewayGstPercent)
  if (pct === null) return null
  const base = amountOnline * (pct / 100)
  return base * (1 + (gst ?? 0) / 100)
}

/**
 * Cost an order. Returns a row with every component and a `missing` array.
 * An order with a non-empty `missing` never contributes to verified totals.
 */
function costOrder(order, shipment, model) {
  const missing = []
  const assumed = []

  // --- revenue -------------------------------------------------------
  const gross = Number(order.totalPrice ?? 0)
  const refunded = Number(order.totalRefunded ?? 0)
  const discounts = Number(order.totalDiscounts ?? 0)

  const isRto = shipment?.status === 'RTO' || order.tags?.some((t) => /^rto$/i.test(t))

  // Delivery inference when Delhivery data is not yet loaded.
  // A COD order whose financial status flipped to PAID means the courier
  // collected the cash, which only happens on delivery. This is an inference,
  // not courier-confirmed, and is labelled as such in the output.
  let isDelivered = shipment?.status === 'DELIVERED'
  let inferredDelivery = false
  if (!shipment && !isRto && order.paymentMethod === 'cod' && order.financialStatus === 'PAID') {
    isDelivered = true
    inferredDelivery = true
    assumed.push('delivery_inferred_from_cod_collected')
  }
  const inFlight = !isRto && !isDelivered

  // On RTO the goods come back and are restockable, so COGS is recovered.
  // What is NOT recovered: both freight legs, packaging, and the ad spend that
  // bought the order. This distinction is where most D2C P&L models go wrong.
  const netRevenue = isRto ? 0 : gross - refunded

  // --- COGS ----------------------------------------------------------
  // Partial-payment orders in this store are recorded as TWO line items for the
  // SAME garment: a small deposit line and the balance line. Costing both
  // double-counts COGS. Detect and refuse rather than silently halve or double.
  const items = (order.lineItems ?? []).filter(
    (li) => li.title !== 'Partial Payment' && Number(li.price) !== 0,
  )
  const byTitle = new Map()
  for (const li of items) byTitle.set(li.title, (byTitle.get(li.title) ?? 0) + 1)
  const dupTitles = [...byTitle.entries()].filter(([, n]) => n > 1).map(([t]) => t)
  if (dupTitles.length && order.totalDiscounts > 0) {
    missing.push('partial_payment_duplicate_lines')
  }

  let cogs = 0
  let cogsComplete = true
  for (const li of items) {
    if (li.unitCost === null || li.unitCost === undefined) {
      cogsComplete = false
      continue
    }
    cogs += Number(li.unitCost) * Number(li.quantity ?? 1)
  }
  if (!cogsComplete) missing.push('unit_cost')
  const cogsApplied = isRto ? 0 : cogs

  // --- freight -------------------------------------------------------
  let freight = null
  if (shipment?.forwardFreight !== null && shipment?.forwardFreight !== undefined) {
    freight = Number(shipment.forwardFreight)
    if (isRto) {
      if (shipment.rtoFreight !== null && shipment.rtoFreight !== undefined) {
        freight += Number(shipment.rtoFreight)
      } else {
        const mult = val(model.shipping.rtoFreightMultiplier) ?? 1
        freight += Number(shipment.forwardFreight) * mult
        assumed.push('rto_freight_estimated_from_forward')
      }
    }
  } else {
    missing.push('freight')
  }

  // --- COD remittance fee --------------------------------------------
  let codFee = 0
  if (order.paymentMethod === 'cod' && isDelivered) {
    if (shipment?.codFee !== null && shipment?.codFee !== undefined) {
      codFee = Number(shipment.codFee)
    } else {
      codFee = codRemitFee(gross, model)
      if (codFee === null) missing.push('cod_remittance_fee')
      else assumed.push('cod_remittance_fee')
    }
  }

  // --- gateway -------------------------------------------------------
  let gw = 0
  const onlineAmount =
    order.paymentMethod === 'prepaid' ? gross : order.paymentMethod === 'partial' ? Number(order.amountPrepaid ?? 0) : 0
  if (onlineAmount > 0) {
    gw = gatewayFee(onlineAmount, model)
    if (gw === null) missing.push('gateway_rate')
    else assumed.push('gateway_rate')
  }

  // --- packaging -----------------------------------------------------
  const pack = val(model.shipping.packagingCostPerOrder)
  if (pack === null) missing.push('packaging')

  // --- GST -----------------------------------------------------------
  const gstPct = val(model.tax.gstOnSalesPercent)
  const gstInclusive = val(model.tax.pricesAreGstInclusive)
  let outputGst = 0
  if (gstPct === null || gstInclusive === null) {
    missing.push('gst')
  } else if (gstInclusive && !isRto) {
    outputGst = netRevenue - netRevenue / (1 + gstPct / 100)
  }

  const costs = [cogsApplied, freight ?? 0, codFee ?? 0, gw ?? 0, pack ?? 0, outputGst]
  const totalCost = costs.reduce((a, b) => a + b, 0)
  const contribution = netRevenue - totalCost

  return {
    order: order.name,
    date: (order.createdAt ?? '').slice(0, 10),
    awb: order.awb ?? null,
    courier: order.courier ?? null,
    payment: order.paymentMethod,
    status: isRto ? 'RTO' : isDelivered ? (inferredDelivery ? 'DELIVERED*' : 'DELIVERED') : 'IN_FLIGHT',
    grossRevenue: r2(gross),
    discounts: r2(discounts),
    refunded: r2(refunded),
    netRevenue: r2(netRevenue),
    cogs: r2(cogsApplied),
    freight: freight === null ? null : r2(freight),
    codFee: codFee === null ? null : r2(codFee),
    gatewayFee: gw === null ? null : r2(gw),
    packaging: pack === null ? null : r2(pack),
    outputGst: r2(outputGst),
    totalCost: r2(totalCost),
    contribution: r2(contribution),
    complete: missing.length === 0,
    missing,
    assumed,
    inFlight,
  }
}

// ---------------------------------------------------------------- report

function main() {
  const args = parseArgs(process.argv)
  const model = loadJson(args.model)
  const orders = loadJson('data/orders.json', [])
  const shipments = loadJson('data/shipments.json', [])
  const adspend = loadJson('data/adspend.json', [])

  if (!orders.length) {
    console.error('No orders in data/orders.json. Ask Claude to pull them from the Shopify MCP first.')
    process.exit(1)
  }

  const shipByAwb = new Map(shipments.map((s) => [String(s.awb), s]))

  const inRange = (o) => {
    const d = (o.createdAt ?? '').slice(0, 10)
    if (args.from && d < args.from) return false
    if (args.to && d > args.to) return false
    return true
  }

  const scoped = orders.filter(inRange)
  const excluded = []
  const kept = []
  for (const o of scoped) {
    const reasons = classifyOrder(o)
    if (reasons.length) excluded.push({ order: o.name, reasons })
    else kept.push(o)
  }

  const rows = kept.map((o) => costOrder(o, shipByAwb.get(String(o.awb)), model))

  const complete = rows.filter((r) => r.complete)
  const incomplete = rows.filter((r) => !r.complete)
  const settled = rows.filter((r) => !r.inFlight)
  const rto = rows.filter((r) => r.status === 'RTO')

  const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0)

  // Only online-attributed spend belongs in the storefront P&L. Reel / IG post
  // boosts are offline-sales campaigns by standing rule and are reported apart.
  const adOnline = adspend.filter((a) => (a.attribution ?? 'online') === 'online')
  const adOffline = adspend.filter((a) => a.attribution === 'offline')
  const adTotal = adOnline.reduce((a, b) => a + Number(b.amount || 0), 0)
  const adOfflineTotal = adOffline.reduce((a, b) => a + Number(b.amount || 0), 0)
  const metaClaimedPurchases = adOnline.reduce((a, b) => a + Number(b.metaReportedPurchases || 0), 0)

  const fixed = Object.entries(model.fixedMonthly)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => [k, val(v)])
  const fixedKnown = fixed.filter(([, v]) => v !== null)
  const fixedMissing = fixed.filter(([, v]) => v === null).map(([k]) => k)
  const fixedTotal = fixedKnown.reduce((a, [, v]) => a + Number(v), 0)

  const contribComplete = sum(complete, 'contribution')
  const netProfit = contribComplete - adTotal - fixedTotal

  // ---- print -------------------------------------------------------
  const W = 92
  const line = (c = '─') => c.repeat(W)
  const p = (s = '') => console.log(s)

  p()
  p(line('═'))
  p(`  MORPAANKH P&L   ${args.from ?? 'start'} → ${args.to ?? 'today'}`)
  p(line('═'))
  p()
  p(`  Orders in range        ${scoped.length}`)
  p(`  Excluded (hygiene)     ${excluded.length}`)
  p(`  Costed                 ${rows.length}`)
  p(`  Fully verified         ${complete.length}   ← only these are in the totals below`)
  p(`  Incomplete             ${incomplete.length}`)
  p(`  Settled (delivered/RTO)${String(settled.length).padStart(3)}`)
  p(`  RTO                    ${rto.length}${rows.length ? `  (${r2((rto.length / rows.length) * 100)}%)` : ''}`)
  p()

  if (complete.length) {
    p(line())
    p('  CONTRIBUTION (verified orders only)')
    p(line())
    p(`  Net revenue            ${inr(sum(complete, 'netRevenue')).padStart(16)}`)
    p(`  − COGS                 ${inr(sum(complete, 'cogs')).padStart(16)}`)
    p(`  − Freight              ${inr(sum(complete, 'freight')).padStart(16)}`)
    p(`  − COD remittance       ${inr(sum(complete, 'codFee')).padStart(16)}`)
    p(`  − Gateway              ${inr(sum(complete, 'gatewayFee')).padStart(16)}`)
    p(`  − Packaging            ${inr(sum(complete, 'packaging')).padStart(16)}`)
    p(`  − Output GST           ${inr(sum(complete, 'outputGst')).padStart(16)}`)
    p(line())
    p(`  = Contribution         ${inr(contribComplete).padStart(16)}`)
    const nr = sum(complete, 'netRevenue')
    if (nr > 0) p(`    margin               ${(r2((contribComplete / nr) * 100) + '%').padStart(16)}`)
    p()
    p(line())
    p('  BELOW THE LINE')
    p(line())
    p(`  − Meta ad spend        ${inr(adTotal).padStart(16)}${adTotal === 0 ? '   (none loaded)' : '   (online campaigns)'}`)
    p(`  − Fixed monthly        ${inr(fixedTotal).padStart(16)}${fixedMissing.length ? `   (${fixedMissing.length} unknown)` : ''}`)
    p(line('═'))
    p(`  NET PROFIT             ${inr(netProfit).padStart(16)}`)
    p(line('═'))
    if (nr > 0) {
      p(`  MER (rev / ad spend)   ${adTotal > 0 ? r2(nr / adTotal) : '—'}`)
      p(`  Contribution / order   ${inr(contribComplete / complete.length)}`)
      if (adTotal > 0) {
        p(`  Breakeven contribution ${inr(adTotal + fixedTotal).padStart(16)}  ← what you must clear`)
        p(`  Gap                    ${inr(netProfit).padStart(16)}`)
      }
      if (adOfflineTotal > 0) {
        p()
        p(`  Offline boosts (excluded from above) ${inr(adOfflineTotal)}`)
      }
      if (metaClaimedPurchases > 0) {
        p(`  Meta claims ${metaClaimedPurchases} purchases; Shopify has ${rows.length} real orders after hygiene`)
      }
    }
    p()
  }

  // ---- trust report -------------------------------------------------
  p(line())
  p('  WHAT THIS NUMBER IS WORTH')
  p(line())
  const coverage = rows.length ? r2((complete.length / rows.length) * 100) : 0
  p(`  Cost coverage          ${coverage}% of costed orders have every input`)
  if (incomplete.length) {
    const tally = {}
    for (const r of incomplete) for (const m of r.missing) tally[m] = (tally[m] ?? 0) + 1
    p()
    p('  Missing inputs blocking the rest:')
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      p(`    ${String(v).padStart(4)} orders   ${k}`)
    }
  }
  const allAssumed = new Set(rows.flatMap((r) => r.assumed))
  if (allAssumed.size) {
    p()
    p('  Rates ASSUMED, not verified (correct these in cost-model.json):')
    for (const a of allAssumed) p(`    • ${a}`)
  }
  if (fixedMissing.length) {
    p()
    p(`  Fixed costs not supplied: ${fixedMissing.join(', ')}`)
    p('  Net profit above is therefore OPTIMISTIC.')
  }
  if (excluded.length) {
    p()
    p('  Excluded by hygiene:')
    for (const e of excluded) p(`    ${e.order.padEnd(10)} ${e.reasons.join(', ')}`)
  }
  p()

  // ---- worst offenders ----------------------------------------------
  const losers = complete.filter((r) => r.contribution < 0).sort((a, b) => a.contribution - b.contribution)
  if (losers.length) {
    p(line())
    p(`  LOSS-MAKING ORDERS (${losers.length})`)
    p(line())
    for (const r of losers.slice(0, 15)) {
      p(`  ${r.order.padEnd(8)} ${r.date}  ${r.payment.padEnd(8)} ${r.status.padEnd(10)} ${inr(r.contribution).padStart(12)}`)
    }
    p()
  }

  // ---- write --------------------------------------------------------
  const outDir = join(HERE, 'out')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const stamp = `${args.from ?? 'all'}_${args.to ?? 'now'}`

  if (args.json) {
    const payload = {
      range: { from: args.from, to: args.to },
      generatedAt: new Date().toISOString(),
      summary: {
        ordersInRange: scoped.length,
        excluded: excluded.length,
        costed: rows.length,
        verified: complete.length,
        incomplete: incomplete.length,
        rtoCount: rto.length,
        contribution: r2(contribComplete),
        adSpend: r2(adTotal),
        fixedCosts: r2(fixedTotal),
        netProfit: r2(netProfit),
        coveragePercent: coverage,
        fixedCostsMissing: fixedMissing,
      },
      rows,
      excluded,
    }
    const f = join(outDir, `pnl_${stamp}.json`)
    writeFileSync(f, JSON.stringify(payload, null, 2))
    p(`  → ${f}`)
  }

  if (args.csv) {
    const cols = [
      'order', 'date', 'awb', 'courier', 'payment', 'status',
      'grossRevenue', 'discounts', 'refunded', 'netRevenue',
      'cogs', 'freight', 'codFee', 'gatewayFee', 'packaging', 'outputGst',
      'totalCost', 'contribution', 'complete', 'missing',
    ]
    const esc = (v) => {
      const s = Array.isArray(v) ? v.join('|') : v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
    const f = join(outDir, `pnl_${stamp}.csv`)
    writeFileSync(f, csv)
    p(`  → ${f}`)
  }
  p()
}

main()
