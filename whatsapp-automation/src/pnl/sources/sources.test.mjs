/*
 * sources.test.mjs — the P&L adapters, against the real October data.
 *
 * Every fixture in here is a real payload from the 2026-11-03 probes, with
 * customer names replaced. These are not tests of "does it return an array":
 * each one is aimed at a rule that has already been got wrong somewhere, and
 * each would fail if the rule regressed.
 *
 *   the IST boundary       Shopify's created_at filter ignores the time of day
 *   the 25-waybill chunk   courier tracking truncates instead of erring
 *   ss=RTO is both legs    a second forward call doubles the freight
 *   the Meta name prefix   one boost's objective is LINK_CLICKS
 *   ledger headers         a column moves and position-parsing books a pincode
 *   null is not zero       a cost we could not read must never read as free
 *
 * No network: global.fetch is stubbed and asserted on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOrders, normaliseOrder, searchWindow } from './shopify.mjs';
import { fetchShipments, fetchCharges, normaliseShipment, splitCharges, legFor, trackRaw } from './delhivery.mjs';
import { fetchMetaSpend, classifyCampaign, monthRange } from './meta.mjs';
import { fetchGatewayFees, linkRefFor } from './gateway.mjs';
import { parseLedger } from './ledger.mjs';
import { fetchReplacements } from './replacements.mjs';
import { table, _resetMemory } from '../../store/table.mjs';
import { _resetSecrets } from '../../secrets.mjs';
import { RULES } from '../../../messages/rules.mjs';
import { putSnapshot, getSnapshot, keys, _resetS3 } from '../snapshot.mjs';

/*
 * S3 is mocked rather than reached: the snapshot path is the one place the
 * report writes anything, and what matters is that it writes totals and not a
 * customer list. The mock keeps a Map so a put can be read back.
 */
vi.mock('@aws-sdk/client-s3', () => {
  const store = new Map();
  class Put {
    constructor(input) {
      this.input = input;
    }
    run() {
      store.set(this.input.Key, this.input.Body);
      return {};
    }
  }
  class Get {
    constructor(input) {
      this.input = input;
    }
    run() {
      const body = store.get(this.input.Key);
      if (body === undefined) throw new Error('NoSuchKey');
      return { Body: { transformToString: async () => body } };
    }
  }
  return {
    S3Client: class {
      async send(cmd) {
        return cmd.run();
      }
    },
    PutObjectCommand: Put,
    GetObjectCommand: Get,
  };
});

const OCT_START = '2026-09-30T18:30:00Z'; // 1 Oct 00:00 IST
const OCT_END = '2026-10-31T18:30:00Z'; // 1 Nov 00:00 IST

/* -------------------------------------------------------------- fixtures */

/*
 * All 73 orders Shopify returns for the October search window, by name and
 * real createdAt. #1168 (08:04Z) and #1169 (17:37Z) on 30 Sep are SEPTEMBER in
 * IST and the search returns them anyway.
 */
const OCT_WINDOW = [
  ["#1168","2026-09-30T08:04:34Z"], ["#1169","2026-09-30T17:37:20Z"], ["#1170","2026-10-01T03:45:53Z"], ["#1171","2026-10-01T08:15:12Z"],
  ["#1172","2026-10-01T09:27:44Z"], ["#1173","2026-10-02T11:23:54Z"], ["#1174","2026-10-02T17:45:44Z"], ["#1175","2026-10-03T03:59:32Z"],
  ["#1176","2026-10-03T14:05:44Z"], ["#1177","2026-10-03T16:28:50Z"], ["#1178","2026-10-04T19:30:14Z"], ["#1179","2026-10-05T02:39:09Z"],
  ["#1180","2026-10-05T04:07:57Z"], ["#1181","2026-10-05T04:22:33Z"], ["#1182","2026-10-05T10:39:11Z"], ["#1183","2026-10-05T11:22:33Z"],
  ["#1184","2026-10-06T06:50:08Z"], ["#1185","2026-10-07T05:05:08Z"], ["#1186","2026-10-07T06:40:05Z"], ["#1187","2026-10-08T05:28:32Z"],
  ["#1188","2026-10-08T06:10:11Z"], ["#1189","2026-10-08T12:10:00Z"], ["#1190","2026-10-08T12:10:59Z"], ["#1191","2026-10-08T12:11:37Z"],
  ["#1192","2026-10-08T12:13:09Z"], ["#1193","2026-10-08T12:14:19Z"], ["#1194","2026-10-09T03:46:26Z"], ["#1195","2026-10-09T03:51:44Z"],
  ["#1196","2026-10-09T06:36:05Z"], ["#1197","2026-10-09T13:48:52Z"], ["#1198","2026-10-09T18:38:25Z"], ["#1199","2026-10-13T06:54:22Z"],
  ["#1200","2026-10-15T20:27:56Z"], ["#1201","2026-10-16T01:39:12Z"], ["#1202","2026-10-16T04:03:39Z"], ["#1203","2026-10-16T05:40:40Z"],
  ["#1204","2026-10-16T08:05:17Z"], ["#1205","2026-10-16T19:41:29Z"], ["#1206","2026-10-17T02:51:54Z"], ["#1207","2026-10-17T03:50:36Z"],
  ["#1208","2026-10-17T04:08:25Z"], ["#1209","2026-10-17T04:09:57Z"], ["#1210","2026-10-17T13:58:09Z"], ["#1211","2026-10-18T14:44:58Z"],
  ["#1212","2026-10-18T16:09:58Z"], ["#1213","2026-10-19T04:36:40Z"], ["#1214","2026-10-20T08:38:21Z"], ["#1215","2026-10-21T04:55:21Z"],
  ["#1216","2026-10-21T17:43:27Z"], ["#1217","2026-10-21T19:51:36Z"], ["#1218","2026-10-22T05:35:09Z"], ["#1219","2026-10-22T11:43:54Z"],
  ["#1220","2026-10-22T16:33:30Z"], ["#1221","2026-10-23T10:53:18Z"], ["#1222","2026-10-23T12:23:10Z"], ["#1223","2026-10-24T05:11:41Z"],
  ["#1224","2026-10-24T06:54:04Z"], ["#1225","2026-10-25T02:19:07Z"], ["#1226","2026-10-26T06:05:42Z"], ["#1227","2026-10-26T06:19:40Z"],
  ["#1228","2026-10-26T09:40:35Z"], ["#1229","2026-10-26T15:22:02Z"], ["#1230","2026-10-26T18:21:34Z"], ["#1231","2026-10-27T07:30:56Z"],
  ["#1232","2026-10-28T06:06:47Z"], ["#1233","2026-10-29T07:42:33Z"], ["#1234","2026-10-30T09:55:02Z"], ["#1235","2026-10-30T15:38:40Z"],
  ["#1236","2026-10-30T19:21:51Z"], ["#1237","2026-10-31T06:46:35Z"], ["#1238","2026-10-31T11:58:28Z"], ["#1239","2026-10-31T13:18:55Z"],
  ["#1240","2026-10-31T13:42:08Z"],
];

/* One real COD order: delivered in Shopify, RTO at Delhivery. */
const ORDER_1170 = {
  id: 'gid://shopify/Order/12666799620468',
  name: '#1170',
  createdAt: '2026-10-01T03:45:53Z',
  cancelledAt: null,
  cancelReason: null,
  sourceName: 'web',
  app: { name: 'Online Store' },
  tags: ['MEDIUM RTO Risk', 'RTO', 'rto-reason-changed-mind', 'wa-confirmed'],
  customer: { displayName: 'Priya T' },
  shippingAddress: { city: 'Nagpur', provinceCode: 'MH', zip: '440024' },
  displayFinancialStatus: 'PENDING',
  displayFulfillmentStatus: 'FULFILLED',
  paymentGatewayNames: ['Cash on Delivery (COD)'],
  taxesIncluded: true,
  currentTotalPriceSet: { shopMoney: { amount: '1149.0', currencyCode: 'INR' } },
  totalPriceSet: { shopMoney: { amount: '1149.0' } },
  totalDiscountsSet: { shopMoney: { amount: '150.0' } },
  totalRefundedSet: { shopMoney: { amount: '0.0' } },
  netPaymentSet: { shopMoney: { amount: '0.0' } },
  totalOutstandingSet: { shopMoney: { amount: '1149.0' } },
  shippingLines: { nodes: [{ title: 'Cash on Delivery', originalPriceSet: { shopMoney: { amount: '50.0' } } }] },
  taxLines: [{ title: 'IGST', rate: 0.05, ratePercentage: 5, priceSet: { shopMoney: { amount: '52.33' } } }],
  transactions: [
    {
      kind: 'SALE',
      status: 'PENDING',
      gateway: 'Cash on Delivery (COD)',
      amountSet: { shopMoney: { amount: '1149.0' } },
      createdAt: '2026-10-01T03:45:51Z',
    },
  ],
  fulfillments: [
    {
      status: 'SUCCESS',
      displayStatus: 'DELIVERED',
      createdAt: '2026-10-03T06:06:56Z',
      deliveredAt: '2026-10-13T11:17:45Z',
      trackingInfo: [{ company: 'Delhivery', number: '59152210001315' }],
    },
  ],
  customerJourneySummary: {
    lastVisit: { utmParameters: { source: 'facebook', medium: 'paid', campaign: '120249123427220056' } },
  },
  lineItems: {
    nodes: [
      {
        title: 'Khili Dhoop',
        sku: 'MP-KHD-XS',
        quantity: 1,
        currentQuantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1249.0' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '1099.0' } },
        variant: {
          id: 'gid://shopify/ProductVariant/54758494110068',
          inventoryItem: { unitCost: { amount: '500.0' } },
        },
      },
    ],
  },
};

/* COD King's partial: Cashfree gateway, 'Standard' shipping, a 5% deposit line
 * at currentQuantity 0, and only the deposit actually received. */
const ORDER_1197 = {
  ...ORDER_1170,
  id: 'gid://shopify/Order/12685305250164',
  name: '#1197',
  createdAt: '2026-10-09T13:48:52Z',
  tags: ['LOW RTO Risk'],
  customer: { displayName: 'Meera S' },
  shippingAddress: { city: 'Chennai', provinceCode: 'TN', zip: '600085' },
  displayFinancialStatus: 'PARTIALLY_PAID',
  paymentGatewayNames: ['1Cashfree Payments(UPI,Cards,Net Banking,Wallets)'],
  currentTotalPriceSet: { shopMoney: { amount: '1099.0', currencyCode: 'INR' } },
  netPaymentSet: { shopMoney: { amount: '62.45' } },
  totalOutstandingSet: { shopMoney: { amount: '1036.55' } },
  shippingLines: { nodes: [{ title: 'Standard', originalPriceSet: { shopMoney: { amount: '0.0' } } }] },
  transactions: [
    {
      kind: 'SALE',
      status: 'SUCCESS',
      gateway: '1Cashfree Payments(UPI,Cards,Net Banking,Wallets)',
      amountSet: { shopMoney: { amount: '62.45' } },
      createdAt: '2026-10-09T13:48:24Z',
    },
  ],
  fulfillments: [
    {
      status: 'SUCCESS',
      displayStatus: 'DELIVERED',
      createdAt: '2026-10-10T05:02:39Z',
      deliveredAt: '2026-10-21T09:59:43Z',
      trackingInfo: [{ company: 'Delhivery', number: '59152210001466' }],
    },
  ],
  lineItems: {
    nodes: [
      {
        title: 'Khili Dhoop',
        sku: 'MP-KHD-M',
        quantity: 1,
        currentQuantity: 0,
        originalUnitPriceSet: { shopMoney: { amount: '212.45' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '62.45' } },
        variant: {
          id: 'gid://shopify/ProductVariant/54758493946228',
          inventoryItem: { unitCost: { amount: '500.0' } },
        },
      },
      {
        title: 'Khili Dhoop',
        sku: 'MP-KHD-M',
        quantity: 1,
        currentQuantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1249.0' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '1099.0' } },
        variant: {
          id: 'gid://shopify/ProductVariant/54758493946228',
          inventoryItem: { unitCost: { amount: '500.0' } },
        },
      },
    ],
  },
};

/* #1233's third line: a custom "Dupatta" with no variant, so no cost exists. */
const ORDER_1233 = {
  ...ORDER_1170,
  id: 'gid://shopify/Order/12700000000000',
  name: '#1233',
  createdAt: '2026-10-29T07:42:33Z',
  displayFinancialStatus: 'PAID',
  shippingLines: { nodes: [] },
  fulfillments: [
    { status: 'SUCCESS', displayStatus: 'FULFILLED', createdAt: '2026-11-03T11:00:28Z', deliveredAt: null, trackingInfo: [] },
  ],
  lineItems: {
    nodes: [
      {
        title: 'Laal Sitara',
        sku: null,
        quantity: 1,
        currentQuantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '1799.0' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '1700.37' } },
        variant: { id: 'gid://shopify/ProductVariant/54848804979060', inventoryItem: { unitCost: { amount: '849.0' } } },
      },
      {
        title: 'Dupatta',
        sku: null,
        quantity: 1,
        currentQuantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '250.0' } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '236.3' } },
        variant: null,
      },
    ],
  },
};

/* Real Delhivery payloads, Scans dropped and the consignee name replaced. */
const SHIP_DELIVERED = {
  AWB: '59152210001293',
  CODAmount: 0,
  ChargedWeight: null,
  Consignee: { City: 'Coimbatore', Name: 'A Customer', PinCode: 641002, State: 'Tamil Nadu' },
  DeliveryDate: '2026-10-09T20:26:59.002',
  InvoiceAmount: 1099,
  OrderType: 'Pre-paid',
  Origin: 'Surat_RingRd_C (Gujarat)',
  PickUpDate: '2026-10-02T13:01:30',
  PickedupDate: '2026-10-02T13:01:30',
  RTOStartedDate: null,
  ReferenceNo: '#1169',
  ReturnedDate: null,
  ReverseInTransit: false,
  Status: {
    Instructions: 'Delivered to consignee',
    Status: 'Delivered',
    StatusCode: 'EOD-38',
    StatusDateTime: '2026-10-09T20:26:59.002',
    StatusType: 'DL',
  },
};

/* #1170: StatusType 'DL' with an RTO status. Reading the type alone books a
 * return as a sale, which is the incident mapCourierStatus documents. */
const SHIP_RTO_DONE = {
  AWB: '59152210001315',
  CODAmount: 1149,
  ChargedWeight: null,
  Consignee: { City: 'Nagpur', Name: 'A Customer', PinCode: 440024, State: 'Maharashtra' },
  DeliveryDate: '2026-10-13T16:46:36.749',
  InvoiceAmount: 1149,
  OrderType: 'COD',
  Origin: 'Surat_RingRd_C (Gujarat)',
  PickedupDate: '2026-10-03T14:54:09',
  RTOStartedDate: '2026-10-07T06:32:12.24',
  ReferenceNo: '#1170',
  ReturnedDate: '2026-10-12T14:30:01.44',
  ReverseInTransit: false,
  Status: {
    Instructions: 'RETURN Accepted',
    Status: 'RTO',
    StatusCode: 'RD-AC',
    StatusDateTime: '2026-10-13T16:46:36.749',
    StatusType: 'DL',
  },
};

/* #1208/#1209's shared parcel, still coming back. */
const SHIP_RTO_MOVING = {
  AWB: '59152210001584',
  CODAmount: 3298,
  ChargedWeight: null,
  Consignee: { City: 'Bodhgaya', Name: 'A Customer', PinCode: 824231, State: 'Bihar' },
  DeliveryDate: null,
  InvoiceAmount: 3298,
  OrderType: 'COD',
  Origin: 'Surat_RingRd_C (Gujarat)',
  PickedupDate: '2026-10-19T15:15:37',
  RTOStartedDate: '2026-10-30T10:08:42.151',
  ReferenceNo: '#1208',
  ReturnedDate: null,
  ReverseInTransit: true,
  Status: {
    Instructions: 'Vehicle Departed',
    Status: 'In Transit',
    StatusCode: 'X-OLL4F',
    StatusDateTime: '2026-11-02T17:14:36.472',
    StatusType: 'RT',
  },
};

/* A waybill generated and never collected: #1222's test reverse pickup. */
const SHIP_NOT_PICKED = {
  AWB: '59152210001805',
  CODAmount: 0,
  ChargedWeight: null,
  Consignee: { City: 'Surat', Name: 'A Customer', PinCode: 395010, State: 'Gujarat' },
  DeliveryDate: null,
  InvoiceAmount: 0,
  OrderType: 'Pickup',
  Origin: 'Surat_RingRd_C (Gujarat)',
  ReferenceNo: 'RPL1222-1R',
  ReverseInTransit: false,
  Status: {
    Instructions: 'Seller cancelled the order',
    Status: 'Not Picked',
    StatusCode: 'DTUP-210',
    StatusDateTime: '2026-10-27T10:00:00',
    StatusType: 'UD',
  },
};

/*
 * The three charge rows verified against production for #1170 (zone D1, 500 g)
 * on 2026-11-03. The arithmetic in DECISIONS V is these numbers.
 */
const CHARGE_DELIVERED_COD = {
  status: 'Success',
  zone: 'D1',
  charged_weight: 500,
  charge_DL: 52,
  charge_RTO: 0,
  charge_DTO: 0,
  charge_COD: 40,
  charge_DPH: 1.92,
  charge_PEAK: 2,
  gross_amount: 95.92,
  total_amount: 113.18,
  tax_data: { SGST: 8.63, CGST: 8.63, IGST: 0 },
};
const CHARGE_RTO = {
  status: 'Success',
  zone: 'D1',
  charged_weight: 500,
  charge_DL: 52,
  charge_RTO: 52,
  charge_DTO: 0,
  charge_COD: 0,
  charge_DPH: 3.83,
  charge_PEAK: 2,
  gross_amount: 109.83,
  total_amount: 129.59,
  tax_data: { SGST: 9.88, CGST: 9.88, IGST: 0 },
};
const CHARGE_DTO = {
  status: 'Success',
  zone: 'D1',
  charged_weight: 500,
  charge_DL: 0,
  charge_RTO: 0,
  charge_DTO: 80,
  charge_COD: 0,
  charge_DPH: 2.95,
  charge_PEAK: 2,
  gross_amount: 84.95,
  total_amount: 100.25,
  tax_data: { SGST: 7.65, CGST: 7.65, IGST: 0 },
};

const META_CAMPAIGNS = [
  ["120249123427220056","MP | Creative Test | ABO | Premium124 | Sep26","OUTCOME_SALES"],
  ["120249415068300056","MP | Premium Push | ABO | Sep26","OUTCOME_SALES"],
  ["120249473725200056","Instagram post: Where Stories Bloom","OUTCOME_ENGAGEMENT"],
  ["120249501372350056","Instagram post: Where Stories Bloom","OUTCOME_ENGAGEMENT"],
  ["120249501560540056","MP | Office Wear | Rich Top10% | ABO | Sep26","OUTCOME_SALES"],
  ["120249557432750056","Instagram post: Where Stories Bloom","LINK_CLICKS"],
  ["120249558510380056","Instagram post: Where Stories Bloom","OUTCOME_ENGAGEMENT"],
  ["120249862443240056","MP | Morani Festive Carousel | Premium Cities | ABO | Oct26","OUTCOME_SALES"],
];

// [campaignIndex, dayOfMonth, spend, impressions, clicks] - the real 86 rows.
const META_ROWS = [
  [0,"01","528.21","2880","38"], [1,"01","508.67","2765","50"], [2,"01","64.34","1779","61"], [3,"01","232.09","10233","252"],
  [4,"01","844.65","2242","17"], [0,"02","435.88","2822","30"], [1,"02","305.94","2142","26"], [2,"02","37.3","2459","47"],
  [3,"02","137.93","6154","186"], [4,"02","763.93","2949","33"], [0,"03","453.24","2704","41"], [1,"03","365.82","2191","48"],
  [2,"03","13.45","999","16"], [3,"03","135.74","5897","165"], [4,"03","424.25","1797","6"], [5,"03","72.58","4244","202"],
  [6,"03","65.16","1976","30"], [0,"04","579.28","3259","55"], [1,"04","613.55","3710","78"], [3,"04","253.42","8382","317"],
  [5,"04","166.85","11002","514"], [6,"04","303.28","9362","217"], [0,"05","622.24","3441","71"], [1,"05","532.27","3212","63"],
  [5,"05","188.49","10901","572"], [6,"05","327.9","11468","223"], [0,"06","507.46","3625","57"], [1,"06","444.63","3388","45"],
  [5,"06","231.44","13597","662"], [6,"06","251.69","9919","214"], [0,"07","479.84","2450","28"], [1,"07","452.81","3148","52"],
  [5,"07","160.02","10119","486"], [6,"07","184.25","4864","208"], [0,"08","533.53","3702","45"], [1,"08","417.4","3180","56"],
  [5,"08","190.62","13984","499"], [0,"09","457.36","2447","33"], [1,"09","346.92","2567","36"], [5,"09","223.63","15320","566"],
  [0,"10","499.4","2950","51"], [1,"10","336.54","2481","51"], [5,"10","196.03","13321","466"], [0,"11","634.18","3733","53"],
  [1,"11","579.93","3520","72"], [5,"11","210.7","14861","469"], [0,"12","242.08","1183","24"], [1,"12","243.91","1054","30"],
  [5,"12","218.76","15507","557"], [5,"13","224.25","17326","618"], [5,"14","169.66","11745","493"], [0,"15","890.2","3613","45"],
  [1,"15","646.05","3218","77"], [5,"15","22.23","1312","54"], [0,"16","893.82","4289","95"], [1,"16","728.11","3974","86"],
  [0,"17","882.1","5138","86"], [1,"17","768.48","5373","108"], [0,"18","622.97","2935","53"], [1,"18","579.83","3699","86"],
  [0,"19","615.75","2945","56"], [1,"19","876.83","5073","111"], [0,"20","639.1","3740","69"], [1,"20","949.59","7124","134"],
  [0,"21","520.6","3594","55"], [1,"21","851.36","5613","107"], [0,"22","499.91","3042","54"], [1,"22","951.08","5598","112"],
  [0,"23","480.51","3751","54"], [1,"23","475.45","2346","70"], [0,"24","493.94","3046","42"], [1,"24","549.96","3180","80"],
  [0,"25","740.54","4345","56"], [1,"25","762.38","4478","80"], [0,"26","274.47","1769","30"], [1,"26","697.2","4168","104"],
  [1,"27","597.45","4306","108"], [7,"27","124.52","345","15"], [1,"28","671.95","4490","108"], [7,"28","732.86","2498","66"],
  [1,"29","472.63","3606","92"], [7,"29","858.49","6912","129"], [1,"30","506.95","4000","75"], [7,"30","691.87","6867","109"],
  [1,"31","190.38","1468","38"], [7,"31","488.15","4824","104"],
];

const metaRow = ([ci, day, spend, impressions, clicks]) => ({
  date_start: `2026-10-${day}`,
  date_stop: `2026-10-${day}`,
  campaign_id: META_CAMPAIGNS[ci][0],
  campaign_name: META_CAMPAIGNS[ci][1],
  objective: META_CAMPAIGNS[ci][2],
  spend,
  impressions,
  clicks,
});

/* ----------------------------------------------------------------- stubs */

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  _resetMemory();
  _resetSecrets();
  process.env.DELHIVERY_TOKEN = 'test-delhivery-token';
  process.env.META_ADS_TOKEN = 'test-meta-token';
  process.env.META_AD_ACCOUNT_ID = '1046985611096981';
  process.env.RAZORPAY_KEY_ID = 'rzp_test';
  process.env.RAZORPAY_KEY_SECRET = 'secret';
});
afterEach(() => {
  global.fetch = realFetch;
  _resetSecrets();
  delete process.env.META_ADS_TOKEN;
  delete process.env.META_AD_ACCOUNT_ID;
  vi.restoreAllMocks();
});

/** A fake Shopify that pages the given nodes 25 at a time, like the real one. */
function fakeShopify(nodes) {
  const calls = [];
  return {
    calls,
    async graphql(query, vars, opts) {
      calls.push({ query, vars, opts });
      const start = vars.cursor ? Number(vars.cursor) : 0;
      const page = nodes.slice(start, start + 25);
      return {
        orders: {
          nodes: page,
          pageInfo: { hasNextPage: start + 25 < nodes.length, endCursor: String(start + 25) },
        },
      };
    },
  };
}

/* ---------------------------------------------------------------- shopify */

describe('shopify: the IST month cohort', () => {
  it('asks for a day wider on each side, because created_at: ignores the time of day', () => {
    const q = searchWindow(OCT_START, OCT_END);
    expect(q).toBe('created_at:>=2026-09-29T18:30:00.000Z created_at:<2026-11-01T18:30:00.000Z');
  });

  it('drops #1168 and #1169 and keeps exactly #1170..#1240', async () => {
    const nodes = OCT_WINDOW.map(([name, createdAt]) => ({
      ...ORDER_1170,
      id: `gid://shopify/Order/${name.replace('#', '')}`,
      name,
      createdAt,
    }));
    const clients = { shopify: fakeShopify(nodes) };
    const orders = await fetchOrders({ monthStartUtc: OCT_START, monthEndUtc: OCT_END, clients });

    expect(nodes).toHaveLength(73);
    expect(orders).toHaveLength(71);
    expect(orders[0].name).toBe('#1170');
    expect(orders[orders.length - 1].name).toBe('#1240');
    expect(orders.map((o) => o.name)).not.toContain('#1168');
    expect(orders.map((o) => o.name)).not.toContain('#1169');
    // The reads are declared idempotent, so withRetry may repeat them.
    expect(clients.shopify.calls.every((c) => c.opts.idempotent === true)).toBe(true);
  });

  it('pages until Shopify says it is done', async () => {
    const nodes = OCT_WINDOW.map(([name, createdAt]) => ({ ...ORDER_1170, name, createdAt }));
    const clients = { shopify: fakeShopify(nodes) };
    await fetchOrders({ monthStartUtc: OCT_START, monthEndUtc: OCT_END, clients });
    expect(clients.shopify.calls).toHaveLength(3); // 73 orders, 25 a page
  });
});

describe('shopify: normalisation', () => {
  it('reads a COD order, its COD fee and its waybill', () => {
    const o = normaliseOrder(ORDER_1170);
    expect(o.paymentType).toBe('cod');
    expect(o.codFeePaise).toBe(5000);
    expect(o.currentTotalPaise).toBe(114900);
    expect(o.awbs).toEqual(['59152210001315']);
    expect(o.lines[0].unitCostPaise).toBe(50000);
    expect(o.pin).toBe('440024');
    expect(o.channel).toBe('Online Store');
    expect(o.utm).toEqual({ source: 'facebook', medium: 'paid', campaign: '120249123427220056' });
    // A COD SALE sits at PENDING from the minute the order is placed. Counting
    // it would book every unshipped COD order as money received.
    expect(o.prepaidReceivedPaise).toBe(0);
    expect(o.numericId).toBe('12666799620468');
  });

  it('calls COD King a partial and counts only the deposit as received', () => {
    const o = normaliseOrder(ORDER_1197);
    expect(o.paymentType).toBe('partial');
    expect(o.prepaidReceivedPaise).toBe(6245);
    expect(o.outstandingPaise).toBe(103655);
    expect(o.codFeePaise).toBe(0);
  });

  it('leaves a line with no variant at null, never zero', () => {
    const o = normaliseOrder(ORDER_1233);
    const dupatta = o.lines.find((l) => l.title === 'Dupatta');
    expect(dupatta.variantGid).toBeNull();
    expect(dupatta.unitCostPaise).toBeNull();
    expect(dupatta.unitCostPaise).not.toBe(0);
    expect(o.lines[0].unitCostPaise).toBe(84900);
    expect(o.paymentType).toBe('cod'); // gateway alone, no COD shipping line
  });

  it('carries no phone, email or street anywhere in its output', () => {
    const json = JSON.stringify([normaliseOrder(ORDER_1170), normaliseOrder(ORDER_1197)]);
    expect(json).not.toMatch(/phone|email|address1|street/i);
  });
});

/* -------------------------------------------------------------- delhivery */

describe('delhivery: tracking', () => {
  it('chunks 60 waybills into 3 calls and loses none', async () => {
    const awbs = Array.from({ length: 60 }, (_, i) => `591522100${String(10000 + i)}`);
    const calls = [];
    const clients = {
      courier: {
        async trackRaw(chunk) {
          calls.push(chunk);
          return chunk.map((awb) => ({ ...SHIP_DELIVERED, AWB: awb }));
        },
      },
    };
    const ships = await fetchShipments(awbs, { clients });
    expect(RULES.pnl.trackingBatchSize).toBe(25);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.length)).toEqual([25, 25, 10]);
    expect(ships).toHaveLength(60);
    expect(new Set(ships.map((s) => s.awb)).size).toBe(60);
  });

  it('refuses to put more than 25 waybills on one call', async () => {
    const awbs = Array.from({ length: 26 }, (_, i) => `x${i}`);
    await expect(trackRaw(awbs)).rejects.toThrow(/truncates past 25/);
  });

  it('maps an RTO that arrives as StatusType DL to RTO, not DELIVERED', () => {
    const s = normaliseShipment(SHIP_RTO_DONE);
    expect(s.statusType).toBe('DL');
    // The shared mapper answers RTO_INITIATED for every stage of a return,
    // because Delhivery's status string is the bare word "RTO" throughout.
    // What matters here is that StatusType 'DL' did NOT make this a delivery.
    expect(s.state).toBe('RTO_INITIATED');
    expect(s.state).not.toBe('DELIVERED');
    // DeliveryDate on an RTO is the return-accepted time. The engine must read
    // `state` first; the value is still carried so it can.
    expect(s.deliveredAt).toBe('2026-10-13T16:46:36.749+05:30');
    expect(s.rtoStartedAt).toBe('2026-10-07T06:32:12.24+05:30');
    expect(s.destPin).toBe('440024');
    expect(s.codAmountPaise).toBe(114900);
    expect(s.orderType).toBe('cod');
    expect(s.chargedWeightGrams).toBeNull();
    expect(s.refs).toEqual(['#1170']);
  });

  it('reads a clean delivery and a reverse leg still moving', () => {
    expect(normaliseShipment(SHIP_DELIVERED).state).toBe('DELIVERED');
    const moving = normaliseShipment(SHIP_RTO_MOVING);
    expect(moving.state).toBe('RTO_INITIATED');
    expect(moving.reverseInTransit).toBe(true);
    expect(normaliseShipment(SHIP_NOT_PICKED).state).toBe('CANCELLED');
  });
});

describe('delhivery: charges', () => {
  const ORDERS = [
    { ...normaliseOrder(ORDER_1170) },
    { ...normaliseOrder(ORDER_1197), awbs: ['59152210001466'] },
  ];

  /** Records every charges call and answers from the leg asked for. */
  function fakeCharges(answer = {}) {
    const calls = [];
    return {
      calls,
      fn: async (args) => {
        calls.push(args);
        if (args.ss === 'RTO') return answer.RTO === undefined ? CHARGE_RTO : answer.RTO;
        if (args.ss === 'DTO') return answer.DTO === undefined ? CHARGE_DTO : answer.DTO;
        return answer.Delivered === undefined ? CHARGE_DELIVERED_COD : answer.Delivered;
      },
    };
  }

  it('asks ss=RTO ONCE for an RTO and never adds a forward call', async () => {
    const f = fakeCharges();
    const charges = await fetchCharges({
      shipments: [normaliseShipment(SHIP_RTO_DONE)],
      orders: ORDERS,
      charges: f.fn,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].ss).toBe('RTO');
    expect(f.calls.some((c) => c.ss === 'Delivered')).toBe(false);
    // Both legs came out of that one row.
    expect(charges[0].forwardPaise).toBe(5783);
    expect(charges[0].rtoPaise).toBe(5200);
    expect(charges[0].flags).toEqual(['rto_both_legs']);
    // #1208's parcel is still coming back, so its RTO is not final yet.
    const moving = await fetchCharges({
      shipments: [normaliseShipment(SHIP_RTO_MOVING)],
      orders: ORDERS,
      charges: fakeCharges().fn,
    });
    expect(moving[0].flags).toEqual(['rto_both_legs', 'leg_not_final']);
  });

  it('quotes from the studio pin at the assumed weight, and says the weight is assumed', async () => {
    const f = fakeCharges();
    const charges = await fetchCharges({
      shipments: [normaliseShipment(SHIP_RTO_DONE)],
      orders: ORDERS,
      charges: f.fn,
    });
    expect(f.calls[0].fromPin).toBe(RULES.pnl.originPin);
    expect(f.calls[0].toPin).toBe('440024');
    expect(f.calls[0].weightGrams).toBe(RULES.pnl.assumedWeightGrams);
    expect(f.calls[0].mode).toBe(RULES.pnl.shippingMode);
    expect(f.calls[0].paymentType).toBe('COD');
    expect(f.calls[0].codAmountInr).toBe(1149);
    expect(charges[0].weightAssumed).toBe(true);
    expect(charges[0].source).toBe('computed');
  });

  it('caches a lane, so the same pin at the same weight is one call', async () => {
    const f = fakeCharges();
    const twins = [
      normaliseShipment(SHIP_RTO_DONE),
      normaliseShipment({ ...SHIP_RTO_DONE, AWB: '59152210009999' }),
      normaliseShipment({ ...SHIP_RTO_DONE, AWB: '59152210008888' }),
    ];
    const charges = await fetchCharges({ shipments: twins, orders: ORDERS, charges: f.fn });
    expect(charges).toHaveLength(3);
    expect(f.calls).toHaveLength(1);
  });

  it('splits a row so forward + rto + dto + cod + gst reconciles to total_amount', () => {
    for (const row of [CHARGE_DELIVERED_COD, CHARGE_RTO, CHARGE_DTO]) {
      const s = splitCharges(row);
      const sum = (s.forwardPaise || 0) + (s.rtoPaise || 0) + (s.dtoPaise || 0) + (s.codChargePaise || 0) + s.gstPaise;
      expect(sum).toBe(s.totalPaise);
    }
    // The figures DECISIONS V verified, in paise.
    expect(splitCharges(CHARGE_DELIVERED_COD).totalPaise).toBe(11318);
    expect(splitCharges(CHARGE_DELIVERED_COD).codChargePaise).toBe(4000);
    expect(splitCharges(CHARGE_RTO).totalPaise).toBe(12959);
    expect(splitCharges(CHARGE_DTO).dtoPaise).toBe(8495);
    expect(splitCharges(CHARGE_DTO).forwardPaise).toBeNull();
  });

  it('picks the leg off the state and skips a parcel that was never collected', async () => {
    expect(legFor(normaliseShipment(SHIP_DELIVERED)).ss).toBe('Delivered');
    expect(legFor(normaliseShipment(SHIP_RTO_MOVING)).ss).toBe('RTO');
    expect(legFor(normaliseShipment(SHIP_NOT_PICKED)).ss).toBe('DTO');

    const f = fakeCharges();
    const cancelled = normaliseShipment({ ...SHIP_NOT_PICKED, OrderType: 'COD' });
    const charges = await fetchCharges({ shipments: [cancelled], orders: [], charges: f.fn });
    expect(f.calls).toHaveLength(0);
    expect(charges[0].source).toBe('missing');
    expect(charges[0].flags).toContain('not_picked_up');
    expect(charges[0].totalPaise).toBeNull();
  });

  it('records a failed charges call as missing with every amount null, never zero', async () => {
    const charges = await fetchCharges({
      shipments: [normaliseShipment(SHIP_DELIVERED)],
      orders: [],
      charges: async () => {
        throw new Error('delhivery 503');
      },
    });
    expect(charges[0].source).toBe('missing');
    expect(charges[0].flags).toContain('charges_call_failed');
    for (const k of ['forwardPaise', 'rtoPaise', 'dtoPaise', 'codChargePaise', 'gstPaise', 'totalPaise']) {
      expect(charges[0][k]).toBeNull();
    }
  });

  it('uses a hand-entered cost for a parcel sent by another courier', async () => {
    const f = fakeCharges();
    const charges = await fetchCharges({
      shipments: [normaliseShipment(SHIP_DELIVERED)],
      orders: [],
      config: { manualCourierCostPaise: { '59152210001293': 9000 } },
      charges: f.fn,
    });
    expect(f.calls).toHaveLength(0);
    expect(charges[0].source).toBe('manual');
    expect(charges[0].totalPaise).toBe(9000);
  });
});

/* ------------------------------------------------------------------- meta */

describe('meta: the month of ad spend', () => {
  it('classifies by the Instagram post name before the objective', () => {
    // The real boost whose objective is LINK_CLICKS, which no engagement list
    // would catch. Reading the objective first books a boost as sales spend.
    expect(classifyCampaign({ campaign_name: 'Instagram post: Bigger the order', objective: 'LINK_CLICKS' })).toBe(
      'boost',
    );
    expect(classifyCampaign({ campaign_name: 'MP | Premium Push | ABO', objective: 'OUTCOME_SALES' })).toBe('sales');
    expect(classifyCampaign({ campaign_name: 'MP | Something New', objective: 'OUTCOME_LEADS' })).toBe('other');
    // An override wins over both.
    expect(
      classifyCampaign({ campaign_id: '9', campaign_name: 'Instagram post: x', objective: 'LINK_CLICKS' }, { 9: 'sales' }),
    ).toBe('sales');
  });

  it('totals the real 86 October rows to sales 34879.40 and boost 4281.81, with nothing unclassified', async () => {
    const pages = [META_ROWS.slice(0, 50).map(metaRow), META_ROWS.slice(50).map(metaRow)];
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      const i = seen.length - 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: pages[i],
            paging: i + 1 < pages.length ? { next: 'https://graph.facebook.com/next-page' } : {},
          }),
      };
    };

    const rows = await fetchMetaSpend({ month: '2026-10' });
    expect(rows).toHaveLength(86);
    const total = (type) => rows.filter((r) => r.type === type).reduce((n, r) => n + r.spendPaise, 0);
    expect(total('sales')).toBe(3487940);
    expect(total('boost')).toBe(428181);
    expect(total('other')).toBe(0);
    expect(rows.filter((r) => r.type === 'other')).toHaveLength(0);
    expect(total('sales') + total('boost')).toBe(3916121); // 39,161.21
    expect(new Set(rows.map((r) => r.date)).size).toBe(31);
    // Every page followed, campaign level, daily.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('level=campaign');
    expect(seen[0]).toContain('time_increment=1');
    expect(seen[0]).toContain(encodeURIComponent('{"since":"2026-10-01","until":"2026-10-31"}'));
  });

  it('is a source failure, not zero spend, when the token is missing', async () => {
    delete process.env.META_ADS_TOKEN;
    _resetSecrets();
    await expect(fetchMetaSpend({ month: '2026-10' })).rejects.toThrow(/metaAdsToken/);
  });

  it('is a source failure when the ad account is not configured', async () => {
    delete process.env.META_AD_ACCOUNT_ID;
    await expect(fetchMetaSpend({ month: '2026-10' })).rejects.toThrow(/META_AD_ACCOUNT_ID/);
  });

  it('ends a month on its real last day', () => {
    expect(monthRange('2026-10')).toEqual({ since: '2026-10-01', until: '2026-10-31' });
    expect(monthRange('2026-02')).toEqual({ since: '2026-02-01', until: '2026-02-28' });
    expect(monthRange('2028-02').until).toBe('2028-02-29');
  });
});

/* ---------------------------------------------------------------- gateway */

describe('gateway: what the processors took', () => {
  const COD = normaliseOrder(ORDER_1170);
  const PARTIAL = normaliseOrder(ORDER_1197);
  const PREPAID = normaliseOrder({
    ...ORDER_1197,
    name: '#1226',
    displayFinancialStatus: 'PAID',
    currentTotalPriceSet: { shopMoney: { amount: '2099.0', currencyCode: 'INR' } },
    netPaymentSet: { shopMoney: { amount: '2099.0' } },
    totalOutstandingSet: { shopMoney: { amount: '0.0' } },
    transactions: [
      {
        kind: 'SALE',
        status: 'SUCCESS',
        gateway: '1Cashfree',
        amountSet: { shopMoney: { amount: '2099.0' } },
        createdAt: '2026-10-26T06:05:42Z',
      },
    ],
    lineItems: { nodes: ORDER_1197.lineItems.nodes.slice(1) },
  });

  it('gives a COD order no gateway fee at all', async () => {
    const fees = await fetchGatewayFees({ orders: [COD], reader: async () => new Map() });
    expect(fees).toHaveLength(0);
  });

  it('uses the real Razorpay fee, less the tax it includes', async () => {
    const reader = async ({ refs }) => {
      expect(refs.has('1226-P1')).toBe(true);
      // A real payment: fee 4956 paise INCLUDING tax 756.
      return new Map([['1226-P1', { feePaise: 4956 - 756, taxPaise: 756 }]]);
    };
    const fees = await fetchGatewayFees({ orders: [PREPAID], reader });
    expect(fees[0]).toEqual({
      orderName: '#1226',
      source: 'razorpay',
      feePaise: 4200,
      gstPaise: 756,
      assumed: false,
    });
  });

  it('falls back to the configured rate, flagged assumed, for a Cashfree order', async () => {
    const fees = await fetchGatewayFees({ orders: [PREPAID], reader: async () => new Map() });
    expect(fees[0].source).toBe('config');
    expect(fees[0].assumed).toBe(true);
    // 2% of Rs 2,099 = Rs 41.98, plus 18% GST on the fee.
    expect(fees[0].feePaise).toBe(4198);
    expect(fees[0].gstPaise).toBe(756);
  });

  it('charges a partial order on the deposit that went through the gateway, not the order total', async () => {
    const fees = await fetchGatewayFees({ orders: [PARTIAL], reader: async () => new Map() });
    // The customer paid Rs 62.45 online and the rest is cash. 2% of the total
    // would be Rs 21.98 of fee that nobody ever charged.
    expect(fees[0].feePaise).toBe(125);
    expect(fees[0].assumed).toBe(true);
  });

  it('still answers for every order when Razorpay is unreachable', async () => {
    const fees = await fetchGatewayFees({
      orders: [PREPAID, PARTIAL],
      reader: async () => {
        throw new Error('razorpay 503');
      },
    });
    expect(fees).toHaveLength(2);
    expect(fees.every((f) => f.source === 'config' && f.assumed)).toBe(true);
  });

  it('maps an order to a payment link the way Flow A writes it', () => {
    expect(linkRefFor('#1170')).toBe('1170-P1');
    expect(linkRefFor('1170')).toBe('1170-P1');
  });
});

/* ----------------------------------------------------------------- ledger */

describe('ledger: parsed by header name', () => {
  it('finds the columns wherever they are, and nets credits against debits', () => {
    const csv = [
      'Morpaankh Collection - billing export',
      'Date,Destination Pin,Waybill Number,Charge Type,Debit,Credit',
      '01-10-2026,440024,59152210001315,Forward Freight,52.00,0',
      '12-10-2026,440024,59152210001315,RTO Freight,52.00,0',
      '13-10-2026,440024,59152210001315,Weight dispute reversal,0,10.00',
      '09-10-2026,641002,59152210001293,Forward Freight,48.50,0',
    ].join('\n');
    const { rows, warnings } = parseLedger(csv, 'oct.csv');
    const byAwb = Object.fromEntries(rows.map((r) => [r.awb, r]));
    expect(rows).toHaveLength(2);
    expect(byAwb['59152210001315'].chargeInr).toBe(94);
    expect(byAwb['59152210001315'].kind).toBe('forward+other+rto');
    expect(byAwb['59152210001293'].chargeInr).toBe(48.5);
    expect(warnings.some((w) => /Skipped 1 line/.test(w))).toBe(true);
  });

  it('reads the same file with the columns moved, because position means nothing', () => {
    const a = 'AWB,Amount\n59152210001315,113.18\n';
    const b = 'Amount,Zone,AWB\n113.18,D1,59152210001315\n';
    expect(parseLedger(a, 'a.csv').rows[0]).toMatchObject({ awb: '59152210001315', chargeInr: 113.18 });
    expect(parseLedger(b, 'b.csv').rows[0]).toMatchObject({ awb: '59152210001315', chargeInr: 113.18 });
  });

  it('reads a TSV and quoted fields', () => {
    const tsv = 'Waybill\tParticulars\tTotal Amount\n59152210001315\t"COD charges, collected"\t"1,129.59"\n';
    const { rows } = parseLedger(tsv, 'oct.tsv');
    expect(rows[0].awb).toBe('59152210001315');
    expect(rows[0].chargeInr).toBe(1129.59);
    expect(rows[0].kind).toBe('cod');
  });

  it('says whether the amounts carry GST, and null when the headers do not say', () => {
    expect(parseLedger('AWB,Total Amount\n59152210001315,113.18\n', 'a.csv').rows[0].gstIncluded).toBe(true);
    expect(parseLedger('AWB,Taxable Value,GST\n59152210001315,95.92,17.26\n', 'b.csv').rows[0].gstIncluded).toBe(false);
    const vague = parseLedger('AWB,Charge\n59152210001315,95.92\n', 'c.csv');
    expect(vague.rows[0].gstIncluded).toBeNull();
    expect(vague.warnings.some((w) => /includes GST/.test(w))).toBe(true);
  });

  it('refuses a file with no waybill column instead of guessing one', () => {
    const { rows, warnings } = parseLedger('Date,Amount\n01-10-2026,52.00\n', 'oct.csv');
    expect(rows).toHaveLength(0);
    expect(warnings.some((w) => /No AWB column/.test(w))).toBe(true);
  });

  it('tells the owner to save an Excel file as CSV', () => {
    const { rows, warnings } = parseLedger(Buffer.from('PK\u0003\u0004rest-of-a-zip'), 'ledger.xlsx');
    expect(rows).toHaveLength(0);
    expect(warnings[0]).toMatch(/Save As > CSV/);
  });

  it('counts the rows it could not read', () => {
    const csv = 'AWB,Amount\n59152210001315,52.00\n,52.00\nTOTAL,104.00\n';
    const { rows, warnings } = parseLedger(csv, 'oct.csv');
    expect(rows).toHaveLength(1);
    expect(warnings.some((w) => /Skipped 2 row/.test(w))).toBe(true);
  });
});

/* ----------------------------------------------------------- replacements */

describe('replacements', () => {
  const REQ = {
    PK: 'REPL#12698000000000',
    SK: 'REQ#1',
    orderId: '12698000000000',
    orderName: '#1222',
    seq: 1,
    state: 'CANCELLED',
    reason: 'wrong size',
    pays: 'customer',
    returnAwb: '59152210001805',
    forwardAwb: '59152210001794',
    quoteReturnInr: 84.95,
    quoteForwardInr: 100.25,
    createdAt: '2026-10-23T12:25:00Z',
  };

  it('reads the month and never claims a reimbursement nobody recorded', async () => {
    await table.put(REQ);
    const jobs = await fetchReplacements({
      monthStartUtc: OCT_START,
      monthEndUtc: OCT_END,
      orders: [{ numericId: '12698000000000' }],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      orderName: '#1222',
      seq: 1,
      state: 'CANCELLED',
      pays: 'customer',
      quoteReturnPaise: 8495,
      quoteForwardPaise: 10025,
      reimbursementReceived: false,
    });
  });

  it('turns true only once the money is on the row', async () => {
    await table.put({ ...REQ, reimbursementPaise: 8495 });
    const jobs = await fetchReplacements({
      monthStartUtc: OCT_START,
      monthEndUtc: OCT_END,
      orders: [{ numericId: '12698000000000' }],
    });
    expect(jobs[0].reimbursementReceived).toBe(true);
  });

  it('leaves out a job from another month', async () => {
    await table.put({ ...REQ, createdAt: '2026-09-15T10:00:00Z' });
    const jobs = await fetchReplacements({
      monthStartUtc: OCT_START,
      monthEndUtc: OCT_END,
      orders: [{ numericId: '12698000000000' }],
    });
    expect(jobs).toHaveLength(0);
  });

  it('finds the row without an order list, by scanning the REQ sort keys', async () => {
    await table.put(REQ);
    const jobs = await fetchReplacements({ monthStartUtc: OCT_START, monthEndUtc: OCT_END });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].orderName).toBe('#1222');
  });
});

/* --------------------------------------------------------------- snapshot */

describe('snapshot', () => {
  it('names the keys the uploader and the reader both have to agree on', () => {
    expect(keys.report('2026-10', 'r1')).toBe('reports/2026-10/r1.xlsx');
    expect(keys.snapshot('2026-10', 'r1')).toBe('snapshots/2026-10/r1.json');
    expect(keys.inputsPrefix('2026-10')).toBe('inputs/delhivery/2026-10/');
  });

  it('skips rather than throws when there is no bucket', async () => {
    delete process.env.REPORTS_BUCKET;
    const r = await putSnapshot({ month: '2026-10', runId: 'r1', totals: { net: 1 } });
    expect(r).toEqual({ skipped: 'no-bucket' });
  });

  it('stores totals, indexes the run, and keeps every customer out of the bucket', async () => {
    process.env.REPORTS_BUCKET = 'test-bucket';
    _resetS3();
    const inputs = {
      month: '2026-10',
      monthStartUtc: OCT_START,
      monthEndUtc: OCT_END,
      trigger: 'cli',
      orders: [normaliseOrder(ORDER_1170), normaliseOrder(ORDER_1197)],
      shipments: [normaliseShipment(SHIP_RTO_DONE)],
      sourceStatus: { shopify: true, failures: [] },
    };
    const res = await putSnapshot({
      month: '2026-10',
      runId: 'run-1',
      inputs,
      totals: { netProfitPaise: 123456 },
      now: new Date('2026-11-01T06:00:00Z'),
    });
    expect(res).toEqual({ key: 'snapshots/2026-10/run-1.json' });

    const rows = await table.query('PNL#2026-10');
    expect(rows).toHaveLength(1);
    expect(rows[0].SK).toBe('SNAPSHOT#run-1');
    // activeShipment is GSI1's hash key: a PNL row holding one would put the
    // month into the courier poller's queue.
    expect(rows[0].activeShipment).toBeUndefined();
    expect(rows[0].reportKey).toBe('reports/2026-10/run-1.xlsx');
    expect(rows[0].expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const back = await getSnapshot('2026-10');
    expect(back.totals).toEqual({ netProfitPaise: 123456 });
    expect(back.inputs.counts).toEqual({
      orders: 2,
      shipments: 1,
      charges: null,
      metaDays: null,
      gateway: null,
      replacements: null,
    });
    const json = JSON.stringify(back);
    expect(json).not.toContain('Priya T');
    expect(json).not.toContain('Meera S');
    expect(json).not.toContain('440024');
    delete process.env.REPORTS_BUCKET;
  });

  it('has no previous month to restate on the first run', async () => {
    process.env.REPORTS_BUCKET = 'test-bucket';
    _resetS3();
    expect(await getSnapshot('2026-09')).toBeNull();
    delete process.env.REPORTS_BUCKET;
  });
});
