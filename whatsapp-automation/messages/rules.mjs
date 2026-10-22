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
  // 6h, was 3h. Measured 2026-10-10: 27 of 40 COD orders resolved on the first
  // message alone and never saw this one at all, so chasing at 3h mostly just
  // reached people who were always going to tap.
  codReminderAfterMin: 360,
  // 12h, was 360. THESE TWO MUST NOT BE EQUAL. They were both 360 for one
  // commit while prepaidOfferEnabled was false, which was harmless only while
  // nothing read the second one: turning the offer back on at 360 would have
  // fired the reminder and the offer within seconds of each other, which is
  // worse than the 3h/6h it replaced. 12h also keeps the first six hours to two
  // messages while still leaving the offer inside payLinkMaxHours (24h), and
  // deferPastQuietHours moves it to 09:30 when it lands overnight.
  // flowA.test.mjs asserts the two are distinct.
  codMarketingFallbackAfterMin: 720,

  // The MARKETING prepaid offer, now at 12h. ON at the owner's instruction
  // 2026-10-10: a COD order that converts to prepaid is worth more than the
  // message costs, and 11 sends is too thin a sample to close the door on it.
  //
  // What the 11 actually did, so nobody has to re-measure it: the pay link was
  // opened ZERO times (every hit on /p/{token} in 30 days took the
  // token-not-found branch, so all of it was bot traffic), no payment arrived,
  // prepaid_confirmed has never been sent, and no order has reached step
  // 'converted'. Worth re-checking after another 30 or so sends rather than
  // trusting either answer. It is also the ONLY MARKETING template a customer
  // gets, so it carries the opt-out footer and is the only one that can pull the
  // WABA quality rating down; it is capped by marketingCapDays.
  prepaidOfferEnabled: true,
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
  // Kept as a switch after the 2026-10-10 false alarm, because it is the only
  // thing that can stop an ask mid-flight and it cost one deploy to add.
  //
  // THERE WAS NO BUG. The four asks sent at 21:00 (#1169 #1171 #1172 #1175)
  // looked like they had a dead "Rate your order" button, but a Flow button
  // only renders interactive in the CONSUMER WHATSAPP MOBILE APP. On WhatsApp
  // Web, WhatsApp Desktop, the WhatsApp Business app and inside Meta's own
  // WhatsApp Manager / Business Suite message views it is shown greyed and
  // inert by design, whether or not it works. Checking four customers' messages
  // necessarily meant a desktop or Meta-side view, so all four looked broken.
  // Proved by sending the EXACT single-item data shape to the owner's own
  // handset: the button opened the form. Do not re-diagnose this from a desktop
  // view again; the only valid test is a tap in the phone app.
  reviewAskEnabled: true,
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

  /*
   * Flow R - abandoned cart recovery.
   *
   * sendWindow is DELIBERATELY WIDER than quietHours (21:30 to 09:30). Every
   * other flow defers past quiet hours because it is reaching someone who is
   * not thinking about us. This one reaches someone who was standing in our
   * checkout twenty minutes ago, and a bag abandoned at 22:00 is dead by 09:30
   * the next morning. 22:30 is the latest that is still defensible as a reply
   * to something they just did.
   *
   * maxCheckoutAgeHours exists because `updatedAt` on an abandoned checkout is
   * NOT customer activity: a checkout created 3 Aug read updatedAt 12 Oct.
   * Age is measured from createdAt only, and anything past 12h is a cold lead
   * who would read a sudden discount as a mailing list.
   *
   * The offer numbers are not a flat percentage on purpose. Measured 2026-10-12
   * against the last ten reachable carts: a flat 10% was equal to or WORSE than
   * what eight of them already had or could type in themselves (a Rs 1,249 bag
   * gets Rs 125 at 10% against WELCOME150's Rs 150; a two-piece bag gets exactly
   * what BUY2 gives). A "private code" that saves less than the code printed on
   * the cart page is worse than sending nothing. So the offer is derived from
   * what the bag can ALREADY get: beat it by beatPublicByInr, never exceed
   * maxPercentOfBag, and if that is impossible send nothing at all.
   */
  cartRecovery: {
    firstAfterMin: 20,
    maxCheckoutAgeHours: 12,
    sendWindow: { start: '09:30', end: '22:30' },
    codeValidHours: 24,
    finalBeforeEndMin: 120,
    finalMinRemainingMin: 30,
    cooldownDays: 30,
    percentOff: 10,
    /*
     * THE HARD CEILING ON WHAT A RECOVERY CODE MAY BE WORTH.
     * Owner's numbers, 2026-10-20, after MORPAANKHHEMISHA92 went out at Rs 200
     * on a Rs 1,249 bag, which is 16% off.
     *
     * That was not a bug in the arithmetic, it was beatPublicByInr doing
     * exactly what it says: WELCOME150 gives Rs 150 on anything over Rs 1,199,
     * so every bag just past that threshold got dragged to Rs 150 + Rs 50
     * whatever its size. A percentage cap could not catch it either, because
     * 20% of Rs 1,249 is Rs 249. The ceiling has to be stated in rupees
     * against the bag, which is what this table does.
     *
     * Read in order, first match wins, ascending. upToInr null is the top band.
     */
    minOfferBagInr: 1249, // at or below this, send NOTHING at all
    offerTiers: [
      { upToInr: 1500, maxInr: 160 },
      { upToInr: 2000, maxInr: 200 },
      /*
       * Rs 300 on the biggest bags, owner's call 2026-10-20, and it exists to
       * answer BUY2. BUY2 is a PERCENTAGE, so on a two piece bag it outruns a
       * flat ceiling and we have nothing better to put on the table: at
       * Rs 2,698 it already gives Rs 269.80. Rs 300 beats that. It stops
       * beating it around Rs 3,000, and BUY3's 15% is out of reach at any bag
       * size, so those carts stay silent on purpose rather than carry a code
       * worse than the one on the cart page.
       */
      { upToInr: null, maxInr: 300 },
    ],
    /*
     * The code's own minimum purchase never drops below this, whatever
     * minSubtotalFactor works out to. Without it a Rs 1,249 bag minted a code
     * usable on a Rs 1,124 order, so the discount was reachable on a basket
     * smaller than the one we are not willing to discount at all.
     */
    minSubtotalFloorInr: 1250,
    beatPublicByInr: 50,
    maxPercentOfBag: 20,
    roundToInr: 10,
    minSubtotalFactor: 0.9,
    codePrefix: 'MORPAANKH',
    codeFallbackName: 'VIP',
    codeNameMaxLen: 10,
    attributionGraceHours: 24,
    // How the /r/ link hands the code to Shopify. Both are RULES switches and
    // never a template change, because the template's URL button is fixed at
    // Meta approval time and the token is all it carries.
    linkTarget: 'checkout',
    /*
     * 'path' because it is the one that was measured on this store, 13 Oct:
     *   GET /discount/BUY2?redirect=/cart  -> 302 + set-cookie discount_code
     *   GET /cart?discount=BUY2            -> 200, no cookie, no code
     * The redirect target keeps its own query string intact, so the recover
     * URL's `key=` survives, and an unknown code still redirects rather than
     * erroring, so a deleted code cannot cost them their bag. 'query' is kept
     * as a switch in case the recover endpoint turns out to read it directly.
     */
    checkoutLinkStyle: 'path',
    skipPartialAdvance: true,
    recoveredTag: 'wa-cart-recovered',
    giftTag: 'gift-in-parcel',
  },

  /*
   * Replacement shipments (/replace).
   *
   * A replacement is two parcels: a reverse pickup of what the customer has,
   * and a new prepaid forward parcel for what they should have had. Nothing
   * here charges anyone. `pays` is recorded so the owner can settle freight by
   * hand, because we have no way to collect it on a reverse leg.
   */
  replace: {
    // How long after delivery a replacement is still routine. Past this the
    // command still works, it just wants `force` first.
    windowDays: 7,
    // A preview goes stale because stock, serviceability and freight all move.
    confirmMinutes: 15,
    maxSwapsPerCommand: 5,
    /*
     * An e-waybill is a separate compliance document this service does not
     * generate, so a parcel at or above this declared value has to be booked by
     * hand. The threshold is the statutory one for intra-state movement.
     */
    ewaybillThresholdInr: 50000,
    /*
     * Replacement records outlive stateRetentionDays (180) on purpose: a return
     * that never reaches the warehouse becomes a dispute months later, and the
     * only record of what was promised is this row.
     */
    recordTtlDays: 400,
    /*
     * What the owner typed -> the canonical size token. The product's own Size
     * option values stay the only authority on what exists; this just means
     * "m", "M" and "medium" all reach the same lookup.
     */
    sizeAliases: {
      xs: 'XS',
      s: 'S',
      small: 'S',
      m: 'M',
      medium: 'M',
      l: 'L',
      large: 'L',
      xl: 'XL',
      xxl: 'XXL',
      '2xl': 'XXL',
      xxxl: 'XXXL',
      '3xl': 'XXXL',
      '4xl': '4XL',
      '5xl': '5XL',
      free: 'Free Size',
      fs: 'Free Size',
      'free size': 'Free Size',
    },
    /*
     * Delhivery wants a weight and a box on every shipment. This is the
     * studio's usual poly bag for one kurta set. Override by product handle
     * when something is genuinely heavier or bulkier.
     */
    parcel: { weightGrams: 500, lengthCm: 30, breadthCm: 25, heightCm: 5 },
    parcelByHandle: {},
    /*
     * DELIBERATELY EMPTY. The HSN code on the shipping label is a tax
     * declaration, and guessing one would put a wrong figure on a GST document
     * in the owner's name. Missing HSN is a hard stop that names this key, so
     * the first /replace refuses until a real code is filled in here (or per
     * handle below). Apparel sits in chapter 61/62 but the exact code depends
     * on the garment, so it is the owner's to set, not ours to assume.
     */
    hsn: '',
    hsnByHandle: {},
  },

  // misc
  refundEtaText: '5 to 7 working days',
  stateRetentionDays: 180,
  timezone: 'Asia/Kolkata',
};
