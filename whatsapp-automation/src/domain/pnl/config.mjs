/*
 * config.mjs — RULES.pnl (rupees, as a human writes them) -> PnlConfig
 * (integer paise, as the engine does arithmetic), plus the source label and
 * note behind every value, which is what the Assumptions sheet is made of.
 *
 * The labels are the point of the sheet. A number that is policy (what we pay
 * for a poly bag) and a number that is a guess (the gateway rate, because
 * Cashfree has no keys) look identical in a total, and the owner may hand this
 * workbook to an accountant. So each one carries VERIFIED, ASSUMED or CONFIG
 * and says why.
 */
import { RULES } from '../../../messages/rules.mjs';
import { rupeesToPaise } from '../../lib/money.mjs';

/** @typedef {import('./types.mjs').PnlConfig} PnlConfig */
/** @typedef {'VERIFIED'|'ASSUMED'|'CONFIG'} AssumptionSource */
/** @typedef {{key:string, label:string, value:string|number|boolean, source:AssumptionSource, note:string}} AssumptionRow */

/**
 * Off by more than this against the owner's rule of thumb and Data Checks says
 * so. It lives here rather than in PnlConfig because types.mjs is the frozen
 * contract between the three halves of the feature and has no slot for it.
 */
export const RULE_OF_THUMB_TOLERANCE_PCT = RULES.pnl.ruleOfThumbTolerancePct;

/**
 * @param {typeof RULES.pnl} [pnl]
 * @returns {PnlConfig}
 */
export function toPnlConfig(pnl = RULES.pnl) {
  return {
    packingCostPerOrderPaise: rupeesToPaise(pnl.packingCostPerOrderInr),
    originPin: pnl.originPin,
    shippingMode: pnl.shippingMode,
    /*
     * The open-ended top slab is Infinity, not null: `upToPaise` is a number in
     * the contract, and Infinity is the honest reading of "and everything
     * above", so pickSlabRatePct needs no null branch.
     */
    gstSlabs: pnl.gstSlabs.map((s) => ({
      ratePct: s.ratePct,
      upToPaise: s.upToInr == null ? Infinity : rupeesToPaise(s.upToInr),
    })),
    gstThresholdFlagPaise: rupeesToPaise(pnl.gstThresholdFlagInr),
    gstInputCreditClaimed: pnl.gstInputCreditClaimed,
    metaGstPct: pnl.metaGstPct,
    gatewayFeePct: pnl.gatewayFeePct,
    gatewayGstPct: pnl.gatewayGstPct,
    weightAlertGrams: pnl.weightAlertGrams,
    assumedWeightGrams: pnl.assumedWeightGrams,
    ledgerVarianceAlertPaise: rupeesToPaise(pnl.ledgerVarianceAlertInr),
    // Annotated because RULES.pnl.fixedMonthlyCosts is deliberately [], which
    // infers as never[] and would make f.label a type error rather than a
    // reminder that the owner has not supplied the figures yet.
    fixedMonthlyCosts: /** @type {{label:string, amountInr:number}[]} */ (pnl.fixedMonthlyCosts).map((f) => ({
      label: f.label,
      amountPaise: rupeesToPaise(f.amountInr),
    })),
    excludeCustomers: [...pnl.excludeCustomers],
    excludeCustomerIds: [...pnl.excludeCustomerIds],
    excludeTags: [...pnl.excludeTags],
    manualCourierCostPaise: Object.fromEntries(
      Object.entries(pnl.manualCourierCostInr).map(([awb, inr]) => [awb, rupeesToPaise(inr)]),
    ),
    campaignTypeOverrides: { ...pnl.campaignTypeOverrides },
    ruleOfThumbPrepaidPaise: rupeesToPaise(pnl.ruleOfThumbPrepaidInr),
    ruleOfThumbCodPaise: rupeesToPaise(pnl.ruleOfThumbCodInr),
  };
}

/** The config the service runs on. */
export const pnlConfig = toPnlConfig(RULES.pnl);

const inr = (paise) => (paise / 100).toFixed(2);

/**
 * Every config value with its source and a note. Generated, so a rate change
 * in RULES.pnl shows up on the sheet without anyone editing the sheet.
 * @param {PnlConfig} config
 * @returns {AssumptionRow[]}
 */
export function assumptionRows(config) {
  const slabText = config.gstSlabs
    .map((s) => (Number.isFinite(s.upToPaise) ? `${s.ratePct}% up to ${inr(s.upToPaise)}` : `${s.ratePct}% above`))
    .join(', ');
  return [
    {
      key: 'packingCostPerOrder',
      label: 'Packing per parcel',
      value: Number(inr(config.packingCostPerOrderPaise)),
      source: 'CONFIG',
      note: "Owner's figure: poly bag, label and tape. Split by order value when one parcel carries several orders.",
    },
    {
      key: 'originPin',
      label: 'Origin pin',
      value: config.originPin,
      source: 'CONFIG',
      note: 'The studio. Every forward leg is quoted from here.',
    },
    {
      key: 'shippingMode',
      label: 'Shipping mode',
      value: config.shippingMode,
      source: 'CONFIG',
      note: 'S is Delhivery surface. E is express and costs more.',
    },
    {
      key: 'gstSlabs',
      label: 'GST slabs (on the discounted unit price, incl. GST)',
      value: slabText,
      source: 'VERIFIED',
      note: 'Statutory, revised Sep 2025: 5% up to Rs 2,500 before GST, 18% above. Prices here are GST-inclusive, so the shelf-price boundary is 2500 x 1.05.',
    },
    {
      key: 'gstThresholdFlag',
      label: 'Flag a line within',
      value: Number(inr(config.gstThresholdFlagPaise)),
      source: 'CONFIG',
      note: 'A line this close to a slab boundary is flagged: a small discount change moves it across and swings the tax by 13 points.',
    },
    {
      key: 'gstInputCreditClaimed',
      label: 'Input credit claimed on costs',
      value: config.gstInputCreditClaimed,
      source: 'CONFIG',
      note: 'FALSE until the CA confirms. While false every cost is booked GST-inclusive and the GST on Meta is its own line, which understates profit rather than overstating it.',
    },
    {
      key: 'metaGstPct',
      label: 'GST on Meta spend',
      value: config.metaGstPct,
      source: 'VERIFIED',
      note: 'Statutory 18% on advertising. Shown as its own line while input credit is not claimed.',
    },
    {
      key: 'gatewayFeePct',
      label: 'Payment gateway fee',
      value: config.gatewayFeePct,
      source: 'ASSUMED',
      note: 'Cashfree carries every prepaid order and we hold no API keys for it, so this is a rate, not a reading. Razorpay is read live where it applies; in October every Razorpay link expired unpaid, so its fees are genuinely 0.00.',
    },
    {
      key: 'gatewayGstPct',
      label: 'GST on gateway fee',
      value: config.gatewayGstPct,
      source: 'VERIFIED',
      note: 'Statutory 18% on the fee.',
    },
    {
      key: 'assumedWeightGrams',
      label: 'Assumed parcel weight',
      value: config.assumedWeightGrams,
      source: 'ASSUMED',
      note: 'A FLOOR, NOT AN ESTIMATE. Delhivery never returns the weight it scanned (ChargedWeight is null on every shipment this account has had) and the charges API echoes back whatever weight you send it, so every computed charge rests on this number. Delhivery bills the greater of dead weight and volumetric weight (its rows carry divisor 5000), and we send a dead weight with no dimensions, so a computed charge cannot come out above the invoice. Freight, and therefore profit, is optimistic on this line until this is set from a Delhivery invoice line or the billing export is uploaded.',
    },
    {
      key: 'weightAlertGrams',
      label: 'Weight alert above',
      value: config.weightAlertGrams,
      source: 'CONFIG',
      note: 'Past this a parcel looks like a weight dispute rather than a kurta set. To be set from a weighed packed order.',
    },
    {
      key: 'ledgerVarianceAlert',
      label: 'Ledger vs computed alert above',
      value: Number(inr(config.ledgerVarianceAlertPaise)),
      source: 'CONFIG',
      note: 'Past this the uploaded ledger and our computed charge disagree enough to be worth a human look.',
    },
    {
      key: 'fixedMonthlyCosts',
      label: 'Fixed monthly costs',
      value: config.fixedMonthlyCosts.length
        ? config.fixedMonthlyCosts.map((f) => `${f.label} ${inr(f.amountPaise)}`).join(', ')
        : 'not set',
      source: 'CONFIG',
      note: 'Shopify plan, COD King, the domain and the WhatsApp API are real monthly money. While this is empty net profit is OPTIMISTIC and the report says so. Inventing figures would put a wrong net profit on a document an accountant may read.',
    },
    {
      key: 'excludeCustomers',
      label: 'Excluded customers',
      value: config.excludeCustomers.join(', ') || 'none',
      source: 'CONFIG',
      note: "The founder's own orders. Real rows in Shopify that would otherwise read as sales.",
    },
    {
      key: 'excludeCustomerIds',
      label: 'Excluded customer ids',
      value: config.excludeCustomerIds.join(', ') || 'none',
      source: 'CONFIG',
      note: 'Shopify customer ids. This replaced an excluded-SURNAME list, which dropped every real customer named Gohil or Gohel, a common surname in Surat, out of every total.',
    },
    {
      key: 'excludeTags',
      label: 'Excluded tags',
      value: config.excludeTags.join(', ') || 'none',
      source: 'CONFIG',
      note: "The service's own test orders. Matched exactly, so 'test' does not catch 'wa-throwaway-variant-test'.",
    },
    {
      key: 'manualCourierCost',
      label: 'Manual courier costs',
      value: Object.keys(config.manualCourierCostPaise).length
        ? Object.entries(config.manualCourierCostPaise).map(([a, p]) => `${a} ${inr(p)}`).join(', ')
        : 'none',
      source: 'CONFIG',
      note: 'For a parcel sent by another courier. Two orders a month ship via Tirupati and will never resolve against Delhivery.',
    },
    {
      key: 'campaignTypeOverrides',
      label: 'Campaign type overrides',
      value: Object.keys(config.campaignTypeOverrides).length
        ? Object.entries(config.campaignTypeOverrides).map(([c, t]) => `${c}=${t}`).join(', ')
        : 'none',
      source: 'CONFIG',
      note: 'When the name and objective are not enough. One October boost carries objective LINK_CLICKS, so the "Instagram post:" name prefix is what classifies it.',
    },
    {
      key: 'ruleOfThumbPrepaid',
      label: 'Rule of thumb: prepaid delivery + packing',
      value: Number(inr(config.ruleOfThumbPrepaidPaise)),
      source: 'CONFIG',
      note: `Owner's own figure. A soft check only: off by more than ${RULE_OF_THUMB_TOLERANCE_PCT}% means either the rates moved or we are reading the wrong leg.`,
    },
    {
      key: 'ruleOfThumbCod',
      label: 'Rule of thumb: COD delivery + packing',
      value: Number(inr(config.ruleOfThumbCodPaise)),
      source: 'CONFIG',
      note: `Owner's own figure. Soft check, tolerance ${RULE_OF_THUMB_TOLERANCE_PCT}%.`,
    },
  ];
}
