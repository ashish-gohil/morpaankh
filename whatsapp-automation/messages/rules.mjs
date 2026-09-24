/*
 * rules.mjs — the single source for every number and timing (spec section 10).
 * Code references these; never hardcode a figure elsewhere. Times are IST
 * (Asia/Kolkata); all scheduling converts through src/lib/time.mjs.
 */
export const RULES = {
  // money
  // TOTAL the customer saves versus the COD price, inclusive of the COD fee we
  // stop charging. The line discount is derived from this, so the saving is
  // always exactly the tier number and never fee + discount stacked.
  //
  // Tiered on the ORDER VALUE, which here means the merchandise total WITHOUT
  // the COD fee: that is the number the customer thinks of as "my order", and
  // the fee is the thing we are about to stop charging, so counting it would
  // push a Rs 1,260 order over the line on the strength of a charge that is
  // about to disappear. Highest threshold first; the list is read top down.
  prepaidTiers: [
    { minOrderInr: 1299, savingInr: 150, gift: true },
    { minOrderInr: 0, savingInr: 100, gift: false },
  ],
  removeCodFee: true,

  // Flow A timings (minutes/hours)
  codFirstMessageDelayMin: 3,
  codReminderAfterMin: 180,
  codMarketingFallbackAfterMin: 360,
  highRiskCheckAfterHours: 24,
  payLinkMaxHours: 24,

  // Flow B timings
  reviewAskAfterDeliveryHours: 48,
  reviewReminderAfterHours: 72,
  untrackedDeliveryAssumeDays: 5,

  // review code
  reviewCodePercent: 5,
  reviewCodeMinSubtotalInr: 1500,
  reviewCodeValidDays: 60,
  reviewTextMin: 10,
  reviewTextMax: 600,

  // windows (IST, "HH:MM")
  quietHours: { start: '21:30', end: '09:30' }, // deferred sends go at 09:30
  reviewSendWindow: { start: '11:00', end: '20:00' },
  ndrSendWindow: { start: '08:00', end: '21:00' },

  // caps
  marketingCapDays: 7,
  reviewAskCapDays: 14,
  humanTakeoverHours: 12,
  windowSafetyMinutes: 10,

  // RTO
  rtoCodBlockCount: 2,

  // misc
  refundEtaText: '5 to 7 working days',
  stateRetentionDays: 180,
  timezone: 'Asia/Kolkata',
};
