/*
 * types.mjs — the contract between the three halves of the P&L feature.
 *
 * Adapters in src/pnl/sources/ produce these shapes. The engine in engine.mjs
 * consumes them and produces Report. The workbook builder only renders a Report.
 * Nothing here imports anything: it is JSDoc only, so it costs nothing at runtime
 * and still type-checks (this folder is inside the jsconfig include set).
 *
 * MONEY IS INTEGER PAISE everywhere, per src/lib/money.mjs. The only floats in the
 * feature are percentages and ratios. finance/pnl.mjs used rupee floats plus a
 * r2() rounder; that is the thing we are deliberately not carrying over.
 *
 * A value that is genuinely unknown is `null`, never 0. The difference between
 * "no cost" and "cost we could not read" is the whole point of the report, so the
 * types keep them distinct and every consumer must branch on null.
 */

/**
 * @typedef {'cod'|'prepaid'|'partial'} PaymentType
 * @typedef {'DELIVERED'|'RTO'|'PENDING'|'LOST'|'CANCELLED'|'EXCLUDED'} Outcome
 * @typedef {'ledger'|'computed'|'manual'|'missing'} ChargeSource
 * @typedef {'Shopify'|'Delhivery ledger'|'Delhivery computed'|'Meta'|'Razorpay'|'Cashfree'|'config'} CellSource
 */

/**
 * One line of an order, after normalisation.
 * `unitCostPaise` is null when the variant carries no cost, or there is no variant
 * at all (a custom line such as the "Dupatta" on #1233). Null means the row's COGS
 * is incomplete and the order leaves the COGS total, it never means free.
 * @typedef {Object} NormLine
 * @property {string} title
 * @property {string|null} sku
 * @property {number} quantity          as ordered
 * @property {number} currentQuantity   after edits; this is what COGS uses
 * @property {number} originalUnitPaise
 * @property {number} discountedUnitPaise  after all discounts, incl. GST
 * @property {string|null} variantGid
 * @property {number|null} unitCostPaise
 */

/**
 * @typedef {Object} NormFulfillment
 * @property {string} status
 * @property {string} displayStatus     Shopify's word. DELIVERED here proves nothing.
 * @property {string} createdAt
 * @property {string|null} deliveredAt
 * @property {string|null} awb
 * @property {string|null} company
 */

/**
 * An order in the month's cohort.
 * @typedef {Object} NormOrder
 * @property {string} name              '#1170'
 * @property {string} gid
 * @property {string} numericId
 * @property {string} createdAt         ISO UTC, straight from Shopify
 * @property {string|null} cancelledAt
 * @property {string|null} cancelReason
 * @property {string} sourceName
 * @property {string|null} appName
 * @property {string[]} tags
 * @property {string|null} customerName  display name; no phone, no email, no street
 * @property {string|null} city
 * @property {string|null} state         provinceCode
 * @property {string|null} pin
 * @property {string} financialStatus
 * @property {string} fulfillmentStatus
 * @property {string[]} gateways
 * @property {boolean} taxesIncluded
 * @property {PaymentType} paymentType
 * @property {string} channel            'Online Store' | 'Manual' | app name
 * @property {number} currentTotalPaise  incl. GST and the COD fee
 * @property {number} totalPaise
 * @property {number} discountsPaise
 * @property {number} refundedPaise
 * @property {number} netPaymentPaise
 * @property {number} outstandingPaise
 * @property {number} codFeePaise        from the 'Cash on Delivery' shipping line
 * @property {number} prepaidReceivedPaise  cash actually in, for a partial order
 * @property {{title:string, ratePct:number, pricePaise:number}[]} shopifyTaxLines
 *           Recorded for the mismatch list on Data Checks. NEVER used to compute GST:
 *           they are wrong on Gujarat orders (CGST 2.5% + SGST 5%).
 * @property {{kind:string,status:string,gateway:string,amountPaise:number,createdAt:string}[]} transactions
 * @property {NormFulfillment[]} fulfillments
 * @property {string[]} awbs             distinct, in fulfilment order
 * @property {{source:string|null,medium:string|null,campaign:string|null}|null} utm
 * @property {NormLine[]} lines
 */

/**
 * A parcel as Delhivery knows it. Delhivery is the truth; Shopify is the fallback.
 * @typedef {Object} NormShipment
 * @property {string} awb
 * @property {string} state         mapCourierStatus() output, e.g. RTO_DELIVERED
 * @property {string} rawStatus     Status.Status verbatim
 * @property {string} statusType    DL | RT | UD
 * @property {string} statusCode
 * @property {string|null} statusAt
 * @property {'cod'|'prepaid'|'pickup'} orderType
 * @property {number} codAmountPaise
 * @property {number} invoiceAmountPaise
 * @property {string|null} destPin   Consignee.PinCode
 * @property {string|null} originName
 * @property {string|null} pickedUpAt
 * @property {string|null} deliveredAt
 *           On an RTO this is the RETURN-accepted time, not customer delivery.
 *           Branch on `state` before you read it.
 * @property {string|null} rtoStartedAt
 * @property {string|null} returnedAt
 * @property {boolean} reverseInTransit
 * @property {number|null} chargedWeightGrams
 *           Null on every shipment this account has ever had. Kept in the type
 *           because the uploaded ledger can fill it.
 * @property {string[]} refs         ReferenceNo values seen on this AWB
 */

/**
 * What one parcel cost, per leg. `source` says how much to trust it.
 * @typedef {Object} CourierCharge
 * @property {string} awb
 * @property {ChargeSource} source
 * @property {number|null} forwardPaise
 * @property {number|null} rtoPaise      the return leg of an RTO
 * @property {number|null} dtoPaise      a reverse pickup
 * @property {number|null} codChargePaise
 * @property {number|null} gstPaise
 * @property {number|null} totalPaise    incl. GST
 * @property {string|null} zone
 * @property {number|null} chargedWeightGrams
 * @property {boolean} weightAssumed     true whenever the weight was not weighed
 * @property {number|null} variancePaise ledger minus computed, when both exist
 * @property {string[]} flags
 */

/**
 * @typedef {Object} MetaDay
 * @property {string} date
 * @property {string} campaignId
 * @property {string} campaignName
 * @property {string} objective
 * @property {'sales'|'boost'|'other'} type
 * @property {number} spendPaise
 * @property {number} impressions
 * @property {number} clicks
 */

/**
 * @typedef {Object} GatewayFee
 * @property {string} orderName
 * @property {'razorpay'|'cashfree'|'config'} source
 * @property {number|null} feePaise      excl. GST
 * @property {number|null} gstPaise
 * @property {boolean} assumed
 */

/**
 * @typedef {Object} ReplacementJob
 * @property {string} orderName
 * @property {number} seq
 * @property {string} state
 * @property {string|null} reason
 * @property {'us'|'customer'|null} pays
 * @property {string|null} forwardAwb
 * @property {string|null} returnAwb
 * @property {number|null} quoteForwardPaise
 * @property {number|null} quoteReturnPaise
 * @property {boolean} reimbursementReceived  only true when the money is recorded in
 *           Shopify. Otherwise the sheet says "expected, not verified" and the P&L
 *           does not count it.
 * @property {string} createdAt
 */

/**
 * Whether each source answered. A source that failed must never read as a zero.
 * @typedef {Object} SourceStatus
 * @property {boolean} shopify
 * @property {boolean} delhiveryTracking
 * @property {boolean} delhiveryCharges
 * @property {boolean} meta
 * @property {boolean} gateway
 * @property {'ledger'|'computed'} courierChargeBasis
 * @property {string[]} failures   human-readable, names the source and the reason
 */

/**
 * Everything the engine is allowed to see. Deterministic: same inputs, same report.
 * @typedef {Object} PnlInputs
 * @property {string} month            '2026-10'
 * @property {string} monthStartUtc    IST month start expressed in UTC
 * @property {string} monthEndUtc      exclusive
 * @property {string} generatedAt
 * @property {'schedule'|'whatsapp'|'cli'|'invoke'} trigger
 * @property {NormOrder[]} orders
 * @property {NormShipment[]} shipments
 * @property {CourierCharge[]} charges
 * @property {MetaDay[]} meta
 * @property {GatewayFee[]} gateway
 * @property {ReplacementJob[]} replacements
 * @property {PnlConfig} config
 * @property {SourceStatus} sourceStatus
 * @property {Object|null} previousSnapshot  last month's stored totals, for the restated block
 */

/**
 * Section 5.6. Every value appears on the Assumptions sheet with its source.
 * @typedef {Object} PnlConfig
 * @property {number} packingCostPerOrderPaise
 * @property {string} originPin
 * @property {string} shippingMode
 * @property {{ratePct:number, upToPaise:number}[]} gstSlabs
 * @property {number} gstThresholdFlagPaise   flag a line within this of a boundary
 * @property {boolean} gstInputCreditClaimed
 * @property {number} metaGstPct
 * @property {number} gatewayFeePct
 * @property {number} gatewayGstPct
 * @property {number} weightAlertGrams
 * @property {number} assumedWeightGrams      what a computed charge has to assume
 * @property {number} ledgerVarianceAlertPaise
 * @property {{label:string, amountPaise:number}[]} fixedMonthlyCosts
 * @property {string[]} excludeCustomers
 * @property {string[]} excludeSurnames
 * @property {string[]} excludeTags
 * @property {Record<string, number>} manualCourierCostPaise   awb -> paise
 * @property {Record<string, 'sales'|'boost'|'other'>} campaignTypeOverrides
 * @property {number} ruleOfThumbPrepaidPaise
 * @property {number} ruleOfThumbCodPaise
 */

/**
 * One order as the report sees it, whatever bucket it lands in.
 * @typedef {Object} ReportRow
 * @property {NormOrder} order
 * @property {Outcome} outcome
 * @property {string} outcomeReason
 * @property {boolean} outcomeInferred   true when Delhivery had no record
 * @property {string[]} awbs
 * @property {number} parcelShare        1 when the parcel is this order's alone,
 *                                       else this order's value share of it
 * @property {number|null} grossSalePaise
 * @property {number|null} outputGstPaise
 * @property {number|null} netRevenuePaise
 * @property {number|null} cogsPaise
 * @property {number|null} forwardFreightPaise
 * @property {number|null} rtoFreightPaise
 * @property {number|null} codChargePaise
 * @property {number|null} packingPaise
 * @property {number|null} gatewayFeePaise
 * @property {number|null} advanceKeptPaise
 * @property {number|null} totalCostPaise
 * @property {number|null} contributionPaise
 * @property {ChargeSource} chargeSource
 * @property {boolean} complete          false when anything it needs is null
 * @property {string[]} missing          machine codes: unit_cost, freight, awb, ...
 * @property {string[]} assumed
 * @property {string[]} flags            human-readable, shown on the row
 */
