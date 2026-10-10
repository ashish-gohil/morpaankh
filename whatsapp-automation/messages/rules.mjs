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
  // 6h, was 3h. With prepaidOfferEnabled off this is the ONLY follow-up, so it
  // no longer has to leave room for a third message three hours later. Measured
  // 2026-10-10: 27 of 40 COD orders resolved on the first message alone and
  // never saw this one at all.
  codReminderAfterMin: 360,
  codMarketingFallbackAfterMin: 360,

  // The 6h MARKETING prepaid offer. OFF since 2026-10-10 on the numbers, not on
  // taste: 11 customers were sent it, the pay link was opened ZERO times (every
  // hit on /p/{token} in 30 days took the token-not-found branch, so all of it
  // was bot traffic), no payment ever arrived, prepaid_confirmed has never been
  // sent once, and no order has ever reached step 'converted'. It was also the
  // only MARKETING template in the customer journey, so it was the only one
  // carrying an opt-out footer and the only one that could pull the WABA quality
  // rating down. Flip to true to bring it back; nothing else has to change.
  prepaidOfferEnabled: false,
  highRiskCheckAfterHours: 24,
  payLinkMaxHours: 24,

  // Flow B timings
  //
  // ONE fixed slot a day, not an offset from each delivery. Owner's call
  // 2026-10-09: an offset scattered the asks across every hour of the working
  // day (11:27, 12:20, 16:29 on three consecutive orders), which reads as a
  // machine firing at random rather than a shop that writes in the evening.
  // 21:00 is deliberately before quietHours.start (21:30) and is when people
  // are actually on WhatsApp, so the ask arrives when it can be answered.
  // KILL SWITCH, OFF since 2026-10-10 22:5x. The owner checked the four asks
  // sent at 21:00 tonight (#1169 #1171 #1172 #1175) and the "Rate your order"
  // Flow button is not tappable on any of them, the 2-item order included, so
  // it is not the hidden-Dropdown case. Until the cause is found and proven
  // fixed, NO customer gets a review ask: an ask with a dead button spends the
  // one chance we get and teaches the customer our messages do not work.
  // Tomorrow's 3 queued asks were deleted by hand and backed up. Turn this back
  // on ONLY after a real tap on a real handset has been seen to work.
  reviewAskEnabled: false,
  reviewAskAtIST: '21:00',
  // Whole IST days after delivery, so "1" is the evening of the day after it
  // arrived. Raise to 2 to go back to roughly the old 48h gap.
  reviewAskAfterDeliveryDays: 1,
  reviewReminderAfterDays: 3,
  // The SECOND review ask, 3 days after the first. OFF since 2026-10-10. A
  // review is a favour, and someone who let the first ask pass has already
  // answered it. It is also the highest-volume message in the system by future
  // count, since every delivered order earns one, which makes it the single
  // biggest source of "they keep messaging me". Flip to true to bring it back.
  reviewReminderEnabled: false,
  untrackedDeliveryAssumeDays: 5,
  // How far back the nightly sweep will look for a delivered order whose review
  // was never scheduled. Deliberately SHORT: it exists to repair a fresh hole (a
  // dropped webhook, a flag that was off for an hour), not to mass-message
  // customers whose parcel arrived a fortnight ago. Widening this sends real
  // messages to everyone it newly reaches, so it is the owner's decision.
  reviewSweepLookbackDays: 3,

  // review code
  // A FLAT RUPEE amount, not a percentage. Owner's call 2026-10-09: a customer
  // understands "Rs 150 off" instantly, where "5% off" needs arithmetic before
  // it means anything. It also caps the give: 5% of a large basket was open
  // ended, Rs 150 never is.
  reviewCodeAmountInr: 150,
  reviewCodeMinSubtotalInr: 1500,
  reviewCodeValidDays: 30,
  // 4, not 10. Ten is a desktop-form number and this is WhatsApp: "Loved it"
  // is 8 characters and "Nice" is 4, and both are genuine reviews. A rejected
  // review is not a silent no-op either, it sends the customer a "your code is
  // coming" message and lands manual follow-up on the owner. Quality is judged
  // by moderationStatus, not by length.
  reviewTextMin: 4,
  reviewTextMax: 600,

  // windows (IST, "HH:MM")
  quietHours: { start: '21:30', end: '09:30' }, // deferred sends go at 09:30
  reviewSendWindow: { start: '11:00', end: '20:00' },
  ndrSendWindow: { start: '08:00', end: '21:00' },

  // caps
  marketingCapDays: 7,
  reviewAskCapDays: 14,
  humanTakeoverHours: 12,
  // How long a 131026 bounce keeps a number on the do-not-send list. Meta sends
  // that code for causes the customer fixes themselves (no WhatsApp account yet,
  // terms not accepted, app too old), so it must expire or one bad day silences
  // them forever. See isUndeliverable in store/phoneProfile.mjs.
  undeliverableRetryDays: 30,
  windowSafetyMinutes: 10,

  // Variant change (Flow A, self-service size or colour swap)
  // ONE change per order, and only while no AWB exists. Owner's rule 2026-10-08.
  // A second swap means a second pick-and-pack on an order that is already
  // being prepared, and once an AWB is printed the label carries the old SKU.
  variantChangeMaxPerOrder: 1,

  // RTO
  rtoCodBlockCount: 2,

  // misc
  refundEtaText: '5 to 7 working days',
  stateRetentionDays: 180,
  timezone: 'Asia/Kolkata',
};
