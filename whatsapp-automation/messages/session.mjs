/*
 * session.mjs — free-form (session) messages, sent only inside an open 24h
 * window. No Meta approval needed: edit and deploy. These may carry offers and
 * codes (templates may not). No emoji, no em/en dash (enforced by the test).
 *
 * Each entry: { type: 'text'|'buttons'|'cta_url'|'list'|'html', body, buttons?, ctaText?, listButton? }.
 * A 'list' carries no rows here: the rows are per-order (live sizes, live
 * stock) so the caller passes them to sess() in ctx.rows.
 * buttons carry an `action` used to build the reply id payload at render time.
 */
import { encodePayload } from '../src/lib/ids.mjs';

/**
 * The one line in the prepaid offer that changes with the saving tier.
 *
 * Always a real benefit, never blank: an empty line would leave a hole in the
 * middle of the list, and for the Meta templates an empty variable is rejected
 * outright. flowA picks by `amt.gift`.
 */
export const OFFER_GIFT_LINE = '*A gift from us*, wrapped in with your order';
export const OFFER_NO_GIFT_LINE = '*Nothing to arrange* at the door on the day';

export const SESSION = {
  confirmed_with_offer: {
    type: 'cta_url',
    body:
      'Thank you, {{customer_name}}. Order {{order_number}} is confirmed and we have started getting it ready.\n\n' +
      'You can still switch to paying online, and it is worth the thirty seconds:\n\n' +
      '*You pay {{new_total}}* instead of {{order_total}}\n' +
      '*{{saving}} stays with you*\n' +
      '{{gift_line}}\n' +
      '*Packed first and dispatched on priority*, so it reaches you sooner\n\n' +
      'The link is open until {{valid_until}}. Nothing about your order changes unless you use it.',
    ctaText: 'Pay {{new_total}}',
  },
  pay_online_offer: {
    type: 'cta_url',
    body:
      'Here it is, {{customer_name}}. Your link for order {{order_number}}.\n\n' +
      '*You pay {{new_total}}* instead of {{order_total}}\n' +
      '*{{saving}} stays with you*\n' +
      '{{gift_line}}\n' +
      '*Packed first and dispatched on priority*, so it reaches you sooner\n\n' +
      'The link is open until {{valid_until}}. Nothing about your order changes unless you use it.',
    ctaText: 'Pay {{new_total}}',
  },
  /*
   * Flow R, sent INSIDE the 24 hour service window.
   *
   * Same offer as cart_recovery_v1, as a free-form message instead of a
   * MARKETING template. This exists because of Meta error 131049: the per-user
   * marketing cap counts templates from EVERY business that messages that
   * person, so our own low volume cannot avoid it, and it refused two of this
   * flow's first three sends. A session message is not a template. It carries
   * no category, the cap does not apply to it at all, and it is free. So
   * whenever the window is open this is both the only reliable way to land and
   * the cheaper one, and the template is what we fall back to, not the reverse.
   */
  cart_recovery: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, your bag is still waiting for you.\n\n' +
      '{{item_line}}\n\n' +
      'Every Morpaankh piece is checked by hand before it leaves us, and we would love for yours to be next. ' +
      'So we have made you a private code:\n\n' +
      '*{{code}}*\n\n' +
      'That is *{{saving}} off* this bag, plus *a gift from us* wrapped in with your order. ' +
      'It is yours alone, works once, and closes *{{expires_at}}*.\n\n' +
      'Tap below and it is applied for you.',
    ctaText: 'Complete my order',
  },
  cart_final: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, a gentle reminder before your private code closes.\n\n' +
      '*{{code}}* closes *{{expires_at}}*, about {{time_left}} from now.\n\n' +
      '{{item_line}}\n\n' +
      'That is still *{{saving}} off* this bag, plus *a gift from us* wrapped in with your order. ' +
      'Your bag is saved just as you left it, so finishing takes less than a minute.\n\n' +
      'When the code closes, the offer closes with it.',
    ctaText: 'Complete my order',
  },
  keep_cod_ack: {
    type: 'text',
    body:
      'Done, {{customer_name}}. Order {{order_number}} stays on cash on delivery. ' +
      'We will send you the tracking link the moment it leaves us.',
  },
  /*
   * Their money arrived and it does not match what the order now needs.
   *
   * The order was edited after the link was made, so converting would mark
   * Shopify paid for an amount nobody paid, and refunding would reverse a
   * payment they meant to make. Which way it goes is the owner's decision, and
   * the customer should not be left holding a receipt and silence meanwhile.
   */
  payment_received_checking: {
    type: 'text',
    body:
      'Hello {{customer_name}}, thank you, we have received {{amount_paid}} for order {{order_number}}. ' +
      'Our team is checking it against your order and will confirm here shortly.',
  },
  /*
   * They asked to pay online and we could not make a link.
   *
   * keep_cod_ack used to go here, and "Done, your order stays on cash on
   * delivery" is the wrong answer to a request: it reads as though the tap
   * chose the opposite of what they tapped.
   */
  pay_online_unavailable: {
    type: 'text',
    body:
      'Hello {{customer_name}}, thank you. Online payment is not available for order {{order_number}} ' +
      'right now, so it stays cash on delivery. Please reply here if you need help.',
  },
  /*
   * TWINS OF THE TEMPLATES, FOR WHEN THE WINDOW IS OPEN.
   *
   * Since 1 Oct 2026 a UTILITY template is billed even inside the 24 hour
   * window, while a free-form message in that window is free up to 1,000
   * service messages a number a month. These say the same words and carry the
   * SAME button actions, so the router needs no changes and a customer cannot
   * tell which door a message came through.
   *
   * sendBest in worker/send.mjs picks: window open and a twin here, free-form;
   * otherwise the template. A `_session` key with no twin falls back silently,
   * which is why adding one is all it takes to make a key free in-window.
   *
   * The two review keys have NO twin on purpose. delivered_review and
   * review_reminder open a WhatsApp Flow and carry a signed flow token, and
   * the free-form equivalent is an interactive Flow message the client does
   * not implement. They stay templates until it does.
   */
  order_shipped_session: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, order {{order_number}} is packed and labelled and ready for pickup.\n\n' +
      'Item: {{item_line}}\n' +
      'At delivery: {{payment_line}}\n' +
      'Courier: {{courier}}\n' +
      'Tracking number: {{awb}}\n\n' +
      'Tracking starts updating once the courier collects it. Tap below to follow it.',
    ctaText: 'Track your order',
  },
  cod_reminder_session: {
    type: 'buttons',
    body:
      'Hello {{customer_name}}, we are still holding your order {{order_number}}.\n\n' +
      '{{item_line}}\n\n' +
      'Cash on delivery: {{cod_total}}\n' +
      'Pay online instead: {{prepaid_total}}\n\n' +
      'One tap is all we need to send it for packing. Prepaid orders go out on priority.\n\n' +
      'Need a different size or colour? Tap Change or cancel and we will sort it out.',
    buttons: [
      { title: 'Pay online now', flow: 'A', action: 'pay_online' },
      /*
       * "Confirm this order", not the template's "Confirm cash on delivery":
       * a free-form reply button title is capped at 20 characters and that one
       * is 24. The ACTION is identical, so the tap does exactly what it does
       * on the template, and the body two lines up has already said the order
       * is on cash on delivery.
       */
      { title: 'Confirm this order', flow: 'A', action: 'confirm' },
      { title: 'Change or cancel', flow: 'A', action: 'cancel' },
    ],
  },
  /*
   * The MARKETING one, and the biggest saving here: inside the window this
   * carries no category at all, so the per-user cap behind 131049 does not
   * apply to it. Meta refuses roughly a third of this store's marketing sends.
   */
  prepaid_offer_session: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, your order {{order_number}} is still set to cash on delivery.\n\n' +
      '{{item_line}}\n\n' +
      '*Pay online and you pay {{prepaid_total}}* instead of {{cod_total}}\n' +
      '*{{saving}} stays with you*\n' +
      '{{gift_line}}\n' +
      '*Packed first and dispatched on priority*, so it reaches you sooner\n\n' +
      'The link below is open until {{valid_until}}.',
    ctaText: 'Pay online',
  },
  ndr_action_session: {
    type: 'buttons',
    body:
      'Hello {{customer_name}}, our courier partner tried to reach you with order {{order_number}} on ' +
      '{{attempt_date}} and could not complete the delivery.\n\n' +
      'Nothing is lost. Tell us what suits you and we will arrange it.',
    buttons: [
      { title: 'Deliver tomorrow', flow: 'C', action: 'ndr_reattempt' },
      { title: 'Change address', flow: 'C', action: 'ndr_address' },
      { title: 'Cancel order', flow: 'C', action: 'ndr_cancel' },
    ],
  },
  /*
   * A LIST, not buttons: the template offers six reasons and a free-form
   * message may carry at most three reply buttons. The row actions are the
   * template's own, so onRtoReason reads them unchanged.
   */
  rto_reason_session: {
    type: 'list',
    flow: 'C',
    body:
      'Hello {{customer_name}}, order {{order_number}} could not be delivered and is on its way back to us.\n\n' +
      'If you can spare a moment, tell us what went wrong. We read every one of these.',
    listButton: 'Tell us why',
  },
  /*
   * OWNER MESSAGES, FREE INSIDE THE WINDOW.
   *
   * ops_digest is MARKETING, as Meta categorised it, so the daily summary was
   * about 30 marketing templates a month per owner phone, each one exposed to
   * the per-user cap behind 131049: some days the digest was simply refused.
   * ops_alert and ops_error are UTILITY and, since 1 Oct 2026, are billed even
   * when the owner's window is open.
   *
   * These twins say exactly what the templates say. The "Got it" button is the
   * point of the whole thing: a tap reopens the owner's 24 hour window, so the
   * next day's digest and the next alert are free as well. Without it the
   * window closes and every message falls back to a billed template.
   */
  ops_digest_session: {
    type: 'buttons',
    body: '{{date}}\n\n{{summary}}',
    buttons: [{ title: 'Got it', flow: 'O', action: 'ack' }],
  },
  ops_alert_session: {
    type: 'buttons',
    body: '{{order_number}}: {{alert_text}}',
    buttons: [{ title: 'Got it', flow: 'O', action: 'ack' }],
  },
  /*
   * THE THREE REPLIES FOR A BUTTON THAT OUTLIVED ITS ORDER.
   *
   * WhatsApp buttons never expire. The confirmation sent three minutes after
   * the order sits in the chat for as long as the chat does, and a customer
   * scrolling back taps it days later. Each of these says what is true now and
   * asks for nothing, because the order has already moved past the question.
   */
  order_closed: {
    type: 'text',
    body:
      'Hello {{customer_name}}, thank you for writing to us. Order {{order_number}} is cancelled, ' +
      'so there is nothing to confirm or pay. Please reply here if that is not right.',
  },
  already_paid: {
    type: 'text',
    body:
      'Hello {{customer_name}}, thank you. Order {{order_number}} is already paid online, ' +
      'so there is nothing to pay at delivery.',
  },
  already_shipped: {
    type: 'text',
    body:
      'Hello {{customer_name}}, thank you. Order {{order_number}} has already left us with Delhivery. ' +
      'Tracking number: {{awb}}.',
  },
  /*
   * They tapped "Pay online" on a parcel Delhivery has already collected.
   *
   * Saying "it stays on cash on delivery" there reads as the tap having
   * failed, and saying nothing is worse. Delhivery refuses an edit after
   * pickup, so the switch genuinely cannot happen, and the useful thing to
   * give them is the amount to have ready.
   */
  pay_at_door: {
    type: 'text',
    body:
      'Hello {{customer_name}}, thank you. Order {{order_number}} is already on its way, ' +
      'so it can no longer switch to online payment. Please keep {{cod_total}} ready at delivery.',
  },
  cancel_check: {
    type: 'buttons',
    body: 'Just to be sure before we stop the packing: should we cancel order {{order_number}}?',
    buttons: [
      { title: 'Yes, cancel', flow: 'A', action: 'cancel_yes' },
      { title: 'No, keep it', flow: 'A', action: 'cancel_no' },
    ],
  },
  cancel_done: {
    type: 'text',
    body:
      'Order {{order_number}} is cancelled. Sorry it did not work out this time. ' +
      'Thank you for telling us, and we hope to dress you for the next occasion.',
  },
  cancel_kept: { type: 'text', body: 'Good. Order {{order_number}} stays exactly as it is.' },
  cancel_too_late: {
    type: 'text',
    body:
      'Order {{order_number}} has already left for delivery, so we cannot stop it from here. ' +
      'Someone from our team will call you shortly and sort it out with you.',
  },
  // Deliberately NOT cancel_too_late: nothing has left, the order is simply
  // paid for. Saying "already left for delivery" to someone whose money we are
  // holding would be the wrong reason and would read as a brush off.
  cancel_refund_review: {
    type: 'text',
    body:
      'Order {{order_number}} is already paid, so we want a person to handle the cancellation and ' +
      'your refund rather than do it automatically. Someone from our team will call you shortly.',
  },
  // ---- variant change (size or colour swap) -------------------------------
  // Entry point. Replaces cancel_check when the order is still changeable, so
  // someone who only wants a different size is not pushed down the cancel path.
  // That is how order #1187 became #1188: cancelled, then reordered one size up
  // 36 minutes later.
  change_or_cancel: {
    type: 'buttons',
    body:
      'Before we stop the packing: would you like to change the size or colour on order {{order_number}}, ' +
      'or cancel it altogether?',
    buttons: [
      { title: 'Change size/colour', flow: 'A', action: 'vc' },
      { title: 'Cancel order', flow: 'A', action: 'cancel_yes' },
      { title: 'Keep my order', flow: 'A', action: 'cancel_no' },
    ],
  },

  // Which line, when the order has more than one changeable item.
  vc_pick_item: {
    type: 'list',
    body: 'Which item would you like to change on order {{order_number}}?',
    listButton: 'Choose item',
  },

  // Size or colour, for a product that has other colours in stock.
  vc_pick_option: {
    type: 'buttons',
    body: 'You have {{item_desc}}. What would you like to change?',
    buttons: [
      // action: null means the caller MUST supply one in ctx.actions, because it
      // carries a line item id. renderSession throws rather than emit a dead button.
      { title: 'Size', flow: 'A', action: null },
      { title: 'Colour', flow: 'A', action: null },
      { title: 'Keep as it is', flow: 'A', action: 'cancel_no' },
    ],
  },

  vc_pick_size: {
    type: 'list',
    body: 'You have {{item_desc}}. Please choose the size you would like instead.',
    listButton: 'Choose size',
  },

  vc_pick_colour: {
    type: 'list',
    body: 'You have {{item_desc}}. Please choose the colour you would like instead.',
    listButton: 'Choose colour',
  },

  // NOTHING is written to the order until the customer taps Yes here. The
  // amount is shown unchanged on purpose: the first thing a person fears when
  // changing an order is that the price will move.
  /*
   * THE LAST LINE IS THE IMPORTANT ONE. The first version of this said
   * "order {{n}} changes from X to Y", present tense, as a statement. A real
   * customer on order #1196 tapped through to here, read it, and stopped: they
   * had just picked a size from a list, so a message announcing the change
   * read as confirmation that it had already happened. Four messages went out,
   * none came back, and the order stayed on the old size.
   *
   * It is now a question, and it says outright that nothing has changed yet.
   */
  vc_confirm: {
    type: 'buttons',
    body:
      'Almost done, {{customer_name}}. Shall we change order {{order_number}} from {{from_desc}} ' +
      'to {{to_desc}}?\n\n' +
      'The amount stays {{order_total}}.\n\n' +
      'Nothing has changed yet. Tap below to confirm.',
    buttons: [
      { title: 'Yes, change it', flow: 'A', action: null }, // needs ctx.actions: carries line + variant
      { title: 'Go back', flow: 'A', action: 'vc' },
    ],
  },

  /*
   * The customer taps a confirm button for a change that has ALREADY happened,
   * usually because a human fixed the order in Shopify in the meantime. That
   * is not a failure and must not read like one: the old path fell through to
   * vc_handoff, which told them we could not do it and raised an owner alert
   * for an order that was already correct.
   */
  vc_already_done: {
    type: 'text',
    body: 'Good news, {{customer_name}}. Order {{order_number}} is already {{to_desc}}, so there is nothing left to change.',
  },

  vc_changed: {
    type: 'text',
    body:
      'Done. Order {{order_number}} is now {{to_desc}}, and the amount stays {{order_total}}. ' +
      'We will pack this one instead.',
  },

  vc_nothing_available: {
    type: 'text',
    body:
      'We do not have another size or colour of {{item_desc}} in stock right now, so order {{order_number}} ' +
      'stays as it is. Reply here and someone from our team will help you.',
  },

  // Any failure, any ineligible case, anything we are not certain about. The
  // order is never left half changed.
  vc_handoff: {
    type: 'text',
    body:
      'We could not make that change from here. Someone from our team will message you shortly. ' +
      'Order {{order_number}} stays exactly as it is until then.',
  },

  payment_received: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. Your payment of {{amount_paid}} for order {{order_number}} has come through.\n\n' +
      'The order is fully prepaid now, so there is nothing to hand over at the door. Prepaid orders are packed ' +
      'and dispatched on priority, so yours is already moving up the queue.',
  },
  prepaid_refund: {
    type: 'text',
    body:
      'Order {{order_number}} had already left for delivery when your payment reached us, so we could not ' +
      'switch it to prepaid.\n\n' +
      'Your {{amount_paid}} is on its way back to the same account and usually lands within {{refund_eta}}. ' +
      'Please keep {{cod_amount}} ready at delivery as planned.\n\nSorry for the extra step.',
  },
  /*
   * The code is BOLD and alone on its line. Monospace was tried first as a
   * stand-in for a copy button and read worse on a phone than it did on paper,
   * so it went. A true one-tap copy button exists only as a TEMPLATE component
   * (authentication and coupon-code templates), never for free-form messages,
   * and turning this into a template would make it MARKETING: opt-in, a
   * frequency cap and a per-message cost, for something that is free inside
   * the window the customer just opened by submitting the form. Bold on its
   * own line is what is left, and it is the clearest of the three.
   */
  review_code: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. We read every one of these properly.\n\n' +
      '{{amount}} towards your next piece:\n\n' +
      '*{{code}}*\n\n' +
      'It is yours alone, works once on an order of {{min_order}} or more, ' +
      'and is good until {{valid_until}}.\n\n' +
      'Come and see what is new at morpaankh.in',
  },

  review_code_pending: {
    type: 'text',
    body: 'Thank you for writing in, {{customer_name}}. Your thank you code will reach you here shortly.',
  },
  ndr_reattempt_ok: {
    type: 'text',
    body: 'Done. Our courier partner will try again on the next working day.',
  },
  ndr_address_ask: {
    type: 'text',
    body:
      'Please send your full address in one message: house or flat number, street, landmark, ' +
      'and the 6 digit pincode.',
  },
  ndr_address_retry: {
    type: 'text',
    body:
      'We could not find a 6 digit pincode in that one. Please send the full address again with the pincode ' +
      'included.',
  },
  /*
   * The courier write failed. Delhivery's /api/p/update field names are still
   * unverified (DECISIONS E4-E6), so this is a live possibility, and the two
   * handlers below used to acknowledge the tap INSIDE the try: a customer who
   * tapped "Try again" and hit a failure got silence while only the owner was
   * told. Silence after a tap is the one thing this flow cannot do.
   */
  ndr_handoff: {
    type: 'text',
    body: 'Thank you. Our team will arrange this by hand and call you shortly.',
  },
  ndr_address_saved: {
    type: 'text',
    body: 'Thank you. Our courier partner has the new address and will try the delivery again.',
  },
  ndr_pincode_changed: {
    type: 'text',
    body:
      'Thank you. That address is in a different pincode, which the courier cannot switch to once a parcel ' +
      'is already on the road. Our team will call you shortly and work it out.',
  },
  ndr_cancel_ack: {
    type: 'text',
    body: 'Noted. The parcel will come back to us. Thank you for telling us rather than leaving it.',
  },
  rto_other_ask: { type: 'text', body: 'Tell us in a line or two what went wrong. We read every one of these.' },
  rto_thanks: { type: 'text', body: 'Thank you for telling us. It is noted and it will not be wasted.' },
  optout_done: {
    type: 'text',
    body: 'You will not get order updates from us here anymore. Reply START whenever you want them back.',
  },
  optin_done: { type: 'text', body: 'Thank you. Your order updates will come here again.' },
  /*
   * Flow R: the reply to "Talk to us". Two versions, because promising a code
   * is open when it has already closed is worse than not mentioning it.
   * Sending these also cancels the reminder, so this is the last thing the
   * automation says to them.
   */
  cart_help_ack: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. Someone from our team will message you here shortly. ' +
      'Your bag stays saved, and your code {{code}} is open until {{expires_at}}.',
  },
  cart_help_ack_closed: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. Someone from our team will message you here shortly, ' +
      'and your bag stays saved.',
  },
  /*
   * /replace: the free-form TWIN of the replacement_raised template, word for
   * word. Whenever the window is open this is what goes out, because a session
   * message is not a template: no category, no per-user cap, no cost, and no
   * dependence on Meta having approved the current copy.
   */
  replacement_raised: {
    type: 'text',
    body:
      'Hello {{customer_name}}, we are sending a replacement for your order {{order_number}}.\n\n' +
      'Our delivery partner will collect {{return_item}} from your address. The next working day after ' +
      'that, we will dispatch {{new_item}} to you.\n\n' +
      'Please keep it unused with the tags on, packed and ready for pickup.',
  },

  /*
   * The /replace preview's two buttons, for the ADMIN who typed the command.
   *
   * The body is composed by the caller like ops_reply, because the preview is
   * assembled from a live order, a live address and two live freight quotes:
   * there is no fixed sentence to store. Both actions are null because each
   * carries the request sequence and its nonce, so renderSession demands them
   * in ctx.actions rather than emitting a button that routes nowhere.
   */
  replace_confirm: {
    type: 'buttons',
    body: '{{text}}',
    buttons: [
      { title: 'Confirm', flow: 'P', action: null },
      { title: 'Cancel', flow: 'P', action: null },
    ],
  },

  /*
   * The only message here that is not customer copy. It answers a slash command
   * the owner typed, so the words are composed by the caller: a fixed body
   * would need one SESSION entry per outcome of every command.
   */
  /*
   * The monthly P&L, to the owner only. None of this copy ever reaches a
   * customer, but it still obeys the registry rules (no dashes, no emoji) so
   * one lint covers the whole registry and nobody has to remember which half
   * is exempt.
   *
   * The summary is six lines on purpose: it is what the owner reads on a phone
   * before deciding whether to open the workbook. Every number in it is also in
   * the workbook, so the two can never disagree.
   */
  pnl_working: {
    type: 'text',
    body: 'Building the P&L for {{month}}. It takes about two minutes. I will send the workbook here when it is ready.',
  },
  pnl_summary: {
    type: 'text',
    body: [
      'P&L {{month}} ({{state}})',
      'Net: {{net}} ({{margin}} of net revenue)',
      'Delivered {{delivered}} | RTO {{rto}} ({{rto_pct}}) | Pending {{pending}}',
      'RTO loss both ways: {{rto_loss}}',
      'Meta {{meta_basis}}: {{meta}} | per delivered order {{meta_per_order}}',
      'Courier charges: {{charge_basis}}',
    ].join('\n'),
  },
  pnl_usage: {
    type: 'text',
    body:
      'Usage: /pnl for last month, /pnl 2026-10 for a month, /pnl oct or /pnl oct 2026, ' +
      'or /pnl mtd for this month so far. Send the Delhivery ledger as a file with the ' +
      'caption /pnl-ledger 2026-10 to lock the actual courier charges.',
  },
  pnl_running: {
    type: 'text',
    body: 'A P&L for {{month}} is already being built. I will send it here as soon as it finishes.',
  },
  pnl_ledger_saved: {
    type: 'text',
    body:
      'Ledger saved for {{month}}: {{rows}} rows, {{total}}. Run /pnl {{month}} again and the ' +
      'report will use these actual charges instead of computed ones.',
  },
  /*
   * A report that could not be built says so, with the reason, rather than
   * going quiet. A month the owner never hears about is a month they assume
   * was fine.
   */
  pnl_failed: {
    type: 'text',
    body: 'The P&L for {{month}} could not be built. {{reason}}',
  },
  ops_reply: { type: 'text', body: '{{text}}' },
  pay_link_expired_page: {
    type: 'html',
    body: 'This payment link has expired. Please reply on WhatsApp and we will help you.',
  },

  /*
   * Flow W: the reply to "Talk to us". Two versions for the same reason as
   * Flow R's pair above, and with Flow R's wording minus the bag: a welcome
   * offer has no cart behind it, so "your bag stays saved" would be a sentence
   * about something that does not exist.
   */
  subscriber_help_ack: {
    type: 'text',
    body:
      'Thank you, {{customer_name}}. Someone from our team will message you here shortly. ' +
      'Your code {{code}} stays open until {{expires_at}}.',
  },
  subscriber_help_ack_closed: {
    type: 'text',
    body: 'Thank you, {{customer_name}}. Someone from our team will message you here shortly.',
  },

  /*
   * Flow W's free-form twin, word for word with subscriber_offer_v1.
   *
   * Same reason as cart_recovery's: a session message carries no category, so
   * Meta's per-user MARKETING cap does not apply to it and it is free. 131049
   * is exactly what parks a Flow W offer, and this is what onWindowOpen
   * delivers it with when the customer writes in, carrying the SAME code
   * rather than minting a fresh one.
   *
   * registry.test.mjs asserts this body is byte-identical to the template's.
   */
  subscriber_offer: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, thank you for joining Morpaankh.\n\n' +
      'To welcome you, we have made a special code just for you:\n\n' +
      '*{{code}}*\n\n' +
      'It takes *{{saving}} off* any order above {{min_order}}, and *a gift from us* comes wrapped in your parcel. ' +
      'It is yours alone, works once, and closes *{{expires_at}}*.\n\n' +
      'Most loved right now: {{top_picks}}.\n\n' +
      'Every piece is checked by hand before it leaves us, and what you see is exactly what arrives. ' +
      'Prepaid orders ship free.\n\n' +
      'Tap below and your code is applied for you.',
    ctaText: 'Shop best sellers',
  },
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function fill(str, vars, key) {
  const names = [];
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(str))) if (!names.includes(m[1])) names.push(m[1]);
  const missing = names.filter((n) => vars[n] === undefined);
  if (missing.length) throw new Error(`session ${key} missing vars: [${missing}]`);
  return str.replace(PLACEHOLDER, (_, n) => String(vars[n]));
}

/**
 * @param {string} key
 * @param {Record<string,string>} vars
 * @param {{orderId?:string, url?:string}} [ctx]  url for cta_url; orderId for button ids
 * @returns a shape the whatsapp client can send (or {type:'html',body} for the page)
 */
export function renderSession(key, vars = {}, ctx = {}) {
  const m = SESSION[key];
  if (!m) throw new Error(`unknown session message: ${key}`);
  const body = fill(m.body, vars, key);
  if (m.type === 'text' || m.type === 'html') return { type: m.type, body };
  if (m.type === 'cta_url') return { type: 'cta_url', body, buttonText: fill(m.ctaText, vars, key), url: ctx.url };
  if (m.type === 'buttons') {
    return {
      type: 'buttons',
      body,
      // ctx.actions overrides a button's static action by title, for the two
      // variant-change messages whose buttons must carry a line and variant id.
      buttons: m.buttons.map((b) => {
        // A button whose action is null carries per-order ids and MUST be given
        // one. Falling back to a literal would emit a payload that routes
        // nowhere: the customer taps and nothing whatsoever happens.
        const action = (ctx.actions && ctx.actions[b.title]) || b.action;
        if (!action) throw new Error(`session ${key} button "${b.title}" needs ctx.actions["${b.title}"]`);
        return { id: encodePayload({ flow: b.flow, orderId: ctx.orderId, action }), title: b.title };
      }),
    };
  }
  if (m.type === 'list') {
    // Rows are per-order, so they arrive in ctx.rows as [{id, title, description?}]
    // where id is a full action string (it carries ids, so it is built by the
    // caller rather than from a static `action` like buttons are).
    /*
     * `m.flow` with 'A' as the default. This was a hardcoded 'A', which was
     * true of every list that existed (the variant-change ones) and silently
     * wrong for the first list belonging to another flow: rto_reason_session's
     * rows are flow C taps, and a row built as 'A' routes nowhere.
     */
    const rows = (ctx.rows || []).map((r) => ({
      id: encodePayload({ flow: m.flow || 'A', orderId: ctx.orderId, action: r.action }),
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
    }));
    return { type: 'list', body, buttonText: m.listButton, rows };
  }
  throw new Error(`session ${key} has unknown type ${m.type}`);
}
