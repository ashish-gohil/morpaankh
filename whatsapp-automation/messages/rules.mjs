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
  /*
   * How many failed-delivery prompts one order may get, counted per IST day of
   * the ATTEMPT.
   *
   * Three, because that is Delhivery's own attempt limit. The guard used to be
   * one per ORDER, so attempts 2 and 3 got nothing and the parcel went to RTO
   * with the customer never asked again. A fourth failure is not something a
   * template can fix, so past this the owner is told to call instead.
   */
  ndrMaxPrompts: 3,
  /*
   * N1. The out-for-delivery nudge.
   *
   * 08:00 to 19:00 IST: the point is to reach them BEFORE the rider does, and
   * a message at 21:00 about a delivery that already failed is Flow C's job,
   * not this one's. Past the window it is skipped rather than deferred, because
   * tomorrow it will not be true.
   */
  ofdSendWindow: { start: '08:00', end: '19:00' },

  // caps
  marketingCapDays: 7,
  /*
   * How the owner's own messages reach them.
   *
   * 'window-else-email': a free session message while their 24 hour window is
   * open, and otherwise email for the digest and a template for an alert. The
   * digest is MARKETING, as Meta categorised ops_digest, so it was about 30
   * marketing templates a month per owner phone, each exposed to the per-user
   * cap behind 131049. Some days it was refused outright, which is the worst
   * version: a summary that silently does not arrive.
   *
   * 'template' restores the old behaviour exactly, for when something about
   * this is wrong and the owner needs the digest back today.
   *
   * An ALERT always goes, whatever the channel: a template is billed but it
   * arrives, and an alert that waits for a window is not an alert.
   */
  /*
   * N9. Meta's India rate card, in rupees, per DELIVERED template.
   *
   * Edit these when Meta changes them, which it does only on 1 Jan, 1 Apr,
   * 1 Jul and 1 Oct. They are here rather than inferred because Meta does not
   * tell us the price in the webhook, only the category and whether the
   * message was billable.
   *
   * marketing is roughly seven times utility, which is the whole reason O9 and
   * O8 exist and the reason a template silently recategorised to MARKETING
   * (N10) is worth an URGENT alert.
   *
   * service is 0 up to the first 1,000 a number a month and then the utility
   * rate; the meter counts them so the digest can say how close that is.
   */
  waRatesInr: { marketing: 0.86, utility: 0.115, service: 0.115, authentication: 0.115 },

  digestChannel: 'window-else-email',
  /*
   * Deleting the one-off discount codes this service mints.
   *
   * Every cart recovery, welcome offer and review thanks creates its own
   * DiscountCodeBasic. The store held 81 expired discounts on 2026-11-07, 72 of
   * them these, growing by two or three a day: every discount listing pages
   * through the lot and the admin's own list becomes unusable.
   *
   * 60 days past the code's end date. Nothing in this service reads an expired
   * private code: publicCodeDiscounts asks for status:active, and
   * discountByCode is a collision check at creation time against a code minted
   * minutes earlier. The grep is in the commit message.
   *
   * dryRun TRUE to begin with, on purpose. The first run reports a count to
   * the owner and deletes nothing, because the thing being deleted is money
   * that was promised to somebody and the selection is a title prefix. Flip it
   * once the count looks right.
   */
  codeCleanup: { enabled: true, dryRun: true, olderThanDays: 60, maxPerRun: 100 },
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
   * Flow W - the 24 hour private welcome offer for someone who joined and has
   * never ordered.
   *
   * THE TWO FIGURES THAT DECIDE WHETHER THIS FLOW SENDS ANYTHING AT ALL are
   * amountInr and minOrderAboveInr, and they are measured against Flow R's
   * numbers above, not against a second set of their own. The guard is: beat
   * the best live PUBLIC code on an order of minOrderAboveInr by
   * cartRecovery.beatPublicByInr, and never exceed cartRecovery.offerTiers for
   * that figure. With WELCOME150 live that is Rs 150 + Rs 50 = Rs 200 as the
   * floor, and the Rs 2,000 tier's Rs 200 as the ceiling, so Rs 200 sits
   * exactly on both lines. It is the most generous offer the rules allow and
   * there is no slack in either direction: raising amountInr breaks the
   * ceiling, lowering it stops beating WELCOME150, and either way the flow
   * goes silent with outcome public-offer-better rather than sending something
   * worse than the cart page already offers.
   *
   * The code's Shopify minimum is minOrderAboveInr + 0.01, which is what makes
   * "above Rs 1,500" literally true AND what lands the guard in the Rs 2,000
   * tier. At a flat Rs 1,500 the ceiling is Rs 160 and nothing is ever sent.
   *
   * requireAnyTag EMPTY means every new customer record counts as a signup,
   * which is the shipped default; ['popup-subscriber','newsletter'] narrows it
   * to the popup's own subscribers. maxPerRun is a blast radius, not a
   * throughput limit: a bot signing up 500 accounts overnight must stop the
   * run dead rather than cost 500 private codes.
   *
   * sendWindow is NARROWER than Flow R's on purpose. Flow R answers something
   * the customer did twenty minutes ago; this is an unprompted marketing
   * message to someone who has never bought, so it keeps to sociable hours.
   */
  subscriberOffer: {
    amountInr: 200,
    minOrderAboveInr: 1500,
    codeValidHours: 24,
    gift: true,
    codeDigits: 4,
    maxPerRun: 100,
    /*
     * N5. How many previous IST days the sweep will go back and pick up.
     *
     * The day marker is written on SUCCESS, so a run that failed, was blocked
     * by an unapproved template, or never fired lost that day's subscribers
     * for good: nothing went back to look.
     *
     * Three, for the same reason the welcome code lives 24 hours: a welcome
     * message a week late is not a welcome. 1 restores the old behaviour.
     */
    catchUpDays: 3,
    sendWindow: { start: '10:00', end: '21:00' },
    collectionHandle: 'best-sellers',
    excludeTags: ['cod-block', 'no-marketing'],
    requireAnyTag: [],
    // SECURITY names "cost runaway (non +91 numbers)": a WhatsApp template to
    // an international number is billed at that country's rate, and nobody on
    // this store's list is outside India.
    countryPrefixes: ['+91'],
    convertedTag: 'wa-subscriber-converted',
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
    /*
     * N4. The owner's policy: when the fault is the customer's, which for this
     * store means a size change, they pay two-way freight upfront by UPI
     * before anything is booked. `pays: 'customer'` was RECORDED and nothing
     * ever collected, so every size change shipped two parcels at the store's
     * expense while the record said otherwise.
     *
     * 48 hours, because the preview's own stock and freight numbers are only
     * minutes fresh and the quote is what the customer is being asked to pay:
     * past two days it has to be re-quoted rather than honoured.
     *
     * upiQrUrl is empty until the owner provides one. Empty means the amount
     * still goes out, as text, with no image: asking for money with no way to
     * send it is worse than asking without a picture.
     */
    payWindowHours: 48,
    upiQrUrl: '',
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
     * DELIBERATELY EMPTY, and a WARNING rather than a refusal.
     *
     * The HSN code on the shipping label is a tax declaration, so guessing one
     * would put a wrong figure on a GST document in the owner's name. It stays
     * empty for that reason and nothing fills it in automatically.
     *
     * It does not block, though. The owner's GST details already sit on the
     * Delhivery account the token belongs to, and HSN is optional on a B2C
     * label, so refusing here only made them re-enter what the courier already
     * had. The preview says the label will print without one. Apparel sits in
     * chapter 61/62 but the exact code depends on the garment, so it is the
     * owner's to set when they want it on the label.
     */
    hsn: '',
    hsnByHandle: {},
  },

  /*
   * The monthly profit and loss report. Every number the P&L leans on lives
   * here so a rate change is one edit, and the Assumptions sheet of the
   * workbook is generated from this block plus the source labels in
   * src/domain/pnl/config.mjs.
   *
   * Nothing here is allowed to stand in for a cost we could actually read. A
   * missing cost flags its row and leaves the totals; these are the values that
   * are genuinely policy (what we pay for a poly bag) or genuinely statutory
   * (the GST slabs), not guesses dressed up as data.
   */
  pnl: {
    // A poly bag, the label and the tape, per parcel. Owner's figure.
    packingCostPerOrderInr: 15,
    // The studio. Every forward leg is quoted from here.
    originPin: '395010',
    // S is Delhivery's surface mode; E would be express and costs more.
    shippingMode: 'S',
    /*
     * Apparel GST is slab-based and the slabs were revised in Sep 2025: 5% up
     * to Rs 2,500 before GST, 18% above it. Our prices are GST-inclusive, so
     * the boundary in shelf-price terms is 2500 * 1.05 = Rs 2,625.
     *
     * Checked per LINE, on the discounted unit price, not on the order total.
     * Shopify gets this wrong in two ways we have measured, so its own
     * taxLines are recorded for the mismatch list and never used to compute:
     * it bills Gujarat orders as CGST 2.5% + SGST 5% instead of 2.5% + 2.5%,
     * and it taxed #1227 (Raat Rani, Rs 2,749 after discount) at 5% when the
     * slab says 18%.
     */
    gstSlabs: [
      { ratePct: 5, upToInr: 2625 },
      { ratePct: 18, upToInr: null },
    ],
    // A line this close to a slab boundary gets flagged, because a small
    // discount change moves it across and swings the tax on it by 13 points.
    gstThresholdFlagInr: 100,
    /*
     * FALSE until the owner's CA confirms it. While false, every cost is
     * booked GST-inclusive and the 18% on Meta is its own line, which is the
     * conservative reading: it understates profit rather than overstating it.
     * Flipping it to true makes costs ex-GST and removes the Meta GST line.
     */
    gstInputCreditClaimed: false,
    metaGstPct: 18,
    /*
     * ASSUMED. Cashfree carries every prepaid order on this store and we have
     * no API keys for it, so the fee is a rate until keys exist. Razorpay is
     * read live where it applies, which in October was nowhere: all its
     * payment links expired unpaid.
     */
    gatewayFeePct: 2.0,
    gatewayGstPct: 18,
    /*
     * Delhivery never returns the weight it actually scanned: ChargedWeight is
     * null on every shipment this account has had, and the charges API echoes
     * back whatever cgm you send it. So a computed charge has to assume a
     * weight, and every row built that way says so.
     *
     * assumedWeightGrams is the same poly bag as RULES.replace.parcel.
     * weightAlertGrams is the line past which a parcel looks like a weight
     * dispute rather than a kurta set; the owner will set it from a weighed one.
     *
     * 500 IS A FLOOR, NOT A MIDPOINT, AND THE REPORT SAYS SO. Delhivery bills
     * the greater of dead weight and volumetric weight, and every charges row
     * it returns carries `divisor: 5000` and `wt_sop_type: "dead_lt"` to say
     * which one it priced. We send a dead weight and no dimensions, so the
     * quote can only ever come back at or below the invoice. Measured on four
     * real October lanes (2026-11-05, zones B/D1/D2/E): at 500 g the parcels
     * quote 68.94 to 127.86, at 1000 g 131.82 to 202.49. The owner reports
     * being billed above 120 per order, which 500 g cannot produce on a
     * prepaid parcel at all, so freight here is understated until either this
     * number comes off a Delhivery invoice line or the billing export is
     * uploaded. Raising it without that measurement would be inventing a cost.
     */
    assumedWeightGrams: 500,
    weightAlertGrams: 600,
    // Past this, ledger and computed disagree enough to be worth a human look.
    ledgerVarianceAlertInr: 10,
    /*
     * N6. Remind the owner to send last month's Delhivery statement.
     *
     * The ledger is the ONLY exact source of what a parcel actually cost.
     * Without it the report computes freight at an assumed 500 g, which is a
     * floor rather than an estimate: the Assumptions sheet says so, and the
     * owner reports being billed more than Rs 120 a parcel against computed
     * charges well under that. Every month without a ledger is a month whose
     * profit is optimistic by an unknown amount.
     *
     * The 5th and the 6th, before the 7th. Two reminders, not a daily nag: one
     * that arrives every day is one nobody reads, and this is the one that has
     * to be believed.
     */
    ledgerReminderDays: [5, 6],
    /*
     * DELIBERATELY EMPTY. Shopify plan, the COD King app, the domain and the
     * WhatsApp API are all real monthly money, but the owner has not given the
     * figures, and inventing them would put a wrong net profit on a document
     * they may hand to an accountant. Empty shows as "not set" on Summary and
     * the report says net profit is therefore optimistic.
     */
    fixedMonthlyCosts: [],
    /*
     * The founder's own orders and the service's test orders. These are real
     * rows in Shopify and would otherwise read as sales.
     *
     * EXCLUDE BY IDENTITY, NEVER BY SURNAME.
     *
     * This carried excludeSurnames: ['Gohil', 'Gohel'], which dropped EVERY
     * customer with that surname from the report. Gohil is one of the most
     * common surnames in Surat, which is this store's own city, so the rule
     * quietly deleted real customers' revenue AND their costs from every total.
     * A paying customer who shares the founder's surname is a customer.
     *
     * A surname match now keeps the order and raises a flag on Data Checks
     * instead, with the fix named: tag it `family` in Shopify.
     *
     * excludeCustomerIds holds Shopify customer gids or their numeric tails.
     *
     * THERE IS NO excludePhones, DELIBERATELY. Matching a phone would mean
     * carrying one through the P&L pipeline, and the Shopify adapter has a test
     * asserting its output contains no phone, email or street address at all.
     * Two levers already do the job without one: this list, and the `family`
     * tag below, which needs no config edit and no deploy.
     */
    excludeCustomers: ['Ashish Gohil'],
    excludeCustomerIds: [],
    excludeTags: ['replace-payload-test', 'test', 'family'],
    // awb -> rupees, for a parcel sent by some other courier.
    manualCourierCostInr: {},
    // campaign id -> 'sales' | 'boost' | 'other', when the name and objective
    // are not enough. One October boost carries objective LINK_CLICKS, so the
    // "Instagram post:" name prefix is what classifies it.
    campaignTypeOverrides: {},
    /*
     * The owner's own rule of thumb for delivery plus packing per order. Used
     * only as a soft check on Data Checks: off by more than 30% means either
     * the rates moved or we are reading the wrong leg.
     */
    ruleOfThumbPrepaidInr: 110,
    ruleOfThumbCodInr: 170,
    ruleOfThumbTolerancePct: 30,
    // Delhivery takes 25 waybills per tracking call and silently truncates
    // past that rather than erring, so this is a correctness limit, not a tuning knob.
    trackingBatchSize: 25,
    // How long a month's lock is held, so a double trigger cannot run twice.
    lockMinutes: 20,
    // Keep a month's snapshot long enough to restate it next month and to
    // answer "what did the report say at the time" for a year.
    snapshotTtlDays: 400,
  },

  /*
   * The customer's own language. SHIPS OFF.
   *
   * `enabled: false` is exactly today's behaviour and not an approximation of
   * it: langFor() returns 'en' without reading the profile at all, so there is
   * no extra read, no Hindi registry lookup and no new failure mode on the path
   * every order confirmation takes. Turning it on is one line here.
   *
   * askMode
   *   'template'  the picker is its own UTILITY template, sent at the Flow A
   *               confirmation moment and answered with a tap.
   *   'session'   plan B, for if Meta rejects the picker or classifies it
   *               MARKETING: no template, the free-form picker goes once per
   *               phone right after our reply to their first tap on an order.
   *   'off'       never ask. A language can still be set by keyword or by the
   *               owner's /lang command.
   *
   * waitMinutes is how long the confirmation waits for an answer. It is short
   * on purpose: an unanswered picker must not delay the message that tells
   * someone their order exists. Reconcile's 20 minute grace already covers it.
   *
   * maxAsks is per PHONE and across all their orders, not per order. Being
   * asked the same question on every order is how an automation starts to feel
   * like a machine.
   *
   * allowPhones non-empty means ONLY those phones get the picker and Hindi.
   * This is the G4 pilot switch: the owner's own handsets first.
   *
   * hiDisabledKeys forces one key back to English without touching Meta and
   * without a registry edit, for when one Hindi template turns out wrong after
   * it is already approved.
   */
  language: {
    /*
     * ON FOR EVERY CUSTOMER as of 2026-11-14 (gate G5).
     *
     * All 64 templates are APPROVED at Meta, English and Hindi. The owner's
     * pilot (G4) ran on order #1255 and the whole path held: the picker was
     * asked and delivered, the confirmation was held behind it, the Hindi tap
     * was stored, cod_confirm_hi_v1 went out in Hindi, and an in-flow variant
     * change and a cancel were both honoured afterwards. askCount stayed at 1,
     * so nobody is asked twice, and no lambda logged an error.
     *
     * Three ways back, smallest first:
     *   hiDisabledKeys: ['<key>']   one Hindi template back to English
     *   pilotOwnerPhonesOnly: true  back to the owner's handsets only
     *   enabled: false              full rollback, everyone on English
     *
     * A stored language survives all three, so a customer who picked Hindi
     * keeps it when the feature comes back on.
     */
    enabled: true,
    default: 'en',
    askMode: 'template',
    waitMinutes: 5,
    maxAsks: 2,
    /*
     * Empty on purpose. The pilot list comes from OWNER_ALERT_PHONES via
     * langAllowList() in store/phoneProfile.mjs, because this file is
     * committed to a PUBLIC repo and a number here would be published.
     * Set this only to pilot on a phone that is not an owner handset.
     */
    allowPhones: [],
    pilotOwnerPhonesOnly: false,
    hiDisabledKeys: [],
  },

  // misc
  refundEtaText: '5 to 7 working days',
  stateRetentionDays: 180,
  /*
   * How long an order's STATE row lives.
   *
   * Longer than stateRetentionDays, and deliberately: the message rows are a
   * log and the state row is the order's memory. The P&L restates closed
   * months, Flow R's repeat-customer checks read back, and a replacement
   * record is kept 400 days for the same reason, so a state row that expired
   * at 180 would leave those reading a month whose orders had vanished.
   *
   * Nothing had a TTL before this. Every order added STATE and MSG# rows
   * forever: storage, point-in-time-recovery size and every remaining scan all
   * grew with the catalogue's age rather than with the work.
   */
  stateTtlDays: 400,
  timezone: 'Asia/Kolkata',
};
