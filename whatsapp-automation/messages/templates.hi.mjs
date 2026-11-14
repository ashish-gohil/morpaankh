/*
 * templates.hi.mjs — the Hindi half of the Meta template registry.
 *
 * SEPARATE META NAMES, deliberately. cod_confirm_hi_v1 is its own template at
 * Meta, not a second language on cod_confirm_v3. Every name-keyed map in this
 * service keeps working unchanged that way: templates-sync's `existing`,
 * NO_FALLBACK, the status webhook, the category webhook, Flow W's
 * templatesReady check. And Hindi copy can be re-versioned without putting
 * English back through review, which matters because the owner will edit this
 * file at gate G1 and the English must not move when they do.
 *
 * NO HINDI LEGACY REGISTRY. A Hindi template that Meta will not accept falls
 * back to the ENGLISH chain that already exists (English current, then LEGACY,
 * then NO_PRICE), not to an older Hindi version. One language problem must
 * never cost a customer a message, and English is always the thing we know
 * works.
 *
 * PLAIN_HI is the Hindi twin of the no-image / no-price branch in send.mjs:
 * the version to send when there is no product photo or no prepaid price to
 * quote. It stands in for whichever of NO_PRICE[key] or LEGACY[key] the
 * English path would have used.
 *
 * COPY RULES, enforced by templates.hi.test.mjs:
 *   Devanagari, formal आप, short sentences, danda for full stops.
 *   Latin only for Hello, Thank you, Please, Sorry, Order, Address, Size,
 *   Confirm, Morpaankh, product titles, sizes, codes, amounts, Delhivery,
 *   COD, Prepaid, STOP, START. Every other loanword in Devanagari.
 *   A UTILITY body carries no offer wording at all.
 *   Same facts as the English twin. Nothing added, nothing dropped.
 *   A body that names a button uses that button's Hindi text exactly.
 */
import {
  qr, urlBtn, trackBtn, flowBtn, reviewFormBtn, imageHeader, SAMPLE_PRODUCT_IMAGE,
} from './templates.mjs';

const STOP_FOOTER = 'ये संदेश बंद करने के लिए STOP लिखें';

/* Shared examples. Amounts, dates, codes, product titles and sizes are read
 * the same way in both languages, so they are the English ones unchanged. */
const EX = {
  customer_name: 'Aarav',
  order_number: '#1234',
  item_line: 'Khili Dhoop, Size M',
  order_total: 'Rs 1,499',
  cod_total: 'Rs 1,499',
  prepaid_total: 'Rs 1,349',
  amount_paid: 'Rs 1,399',
  cod_amount: 'Rs 1,499',
  saving: 'Rs 150',
  valid_until: '21 Sep, 8:00 PM',
  refund_eta: '5 से 7 कार्य दिवस',
  delivered_date: '20 Sep',
  attempt_date: '20 Sep',
  awb: '59152210001142',
  courier: 'Delhivery',
};

export const TEMPLATES_HI = {
  cod_confirm: {
    name: 'cod_confirm_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, आपका Order {{order_number}} हमें मिल गया है और पैक होने के लिए तैयार है।\n\n' +
      '{{item_line}}\n\n' +
      'Cash on delivery: {{cod_total}}\n' +
      'ऑनलाइन पेमेंट करने पर: {{prepaid_total}}\n\n' +
      'Prepaid Order सबसे पहले पैक और डिस्पैच किए जाते हैं। नीचे एक विकल्प चुनें, आगे का काम हम संभाल लेंगे।\n\n' +
      'Size या रंग बदलना है? नीचे बदलें या रद्द करें दबाएँ, हम तुरंत मदद करेंगे।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      item_line: EX.item_line,
      cod_total: EX.cod_total,
      prepaid_total: EX.prepaid_total,
    },
    buttons: [
      qr('ऑनलाइन पेमेंट करें', 'A', 'pay_online'),
      qr('COD Confirm करें', 'A', 'confirm'),
      qr('बदलें या रद्द करें', 'A', 'cancel'),
    ],
  },

  cod_reminder: {
    name: 'cod_reminder_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, आपका Order {{order_number}} हमने अब तक रोक रखा है।\n\n' +
      '{{item_line}}\n\n' +
      'Cash on delivery: {{cod_total}}\n' +
      'ऑनलाइन पेमेंट करने पर: {{prepaid_total}}\n\n' +
      'पैकिंग के लिए भेजने में सिर्फ़ एक टैप लगता है। Prepaid Order सबसे पहले जाते हैं।\n\n' +
      'Size या रंग बदलना है? नीचे बदलें या रद्द करें दबाएँ, हम तुरंत मदद करेंगे।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      item_line: EX.item_line,
      cod_total: EX.cod_total,
      prepaid_total: EX.prepaid_total,
    },
    buttons: [
      qr('ऑनलाइन पेमेंट करें', 'A', 'pay_online'),
      qr('COD Confirm करें', 'A', 'confirm'),
      qr('बदलें या रद्द करें', 'A', 'cancel'),
    ],
  },

  prepaid_offer: {
    name: 'prepaid_offer_hi_v1',
    language: 'hi',
    category: 'MARKETING',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, आपका Order {{order_number}} अभी Cash on delivery पर है।\n\n' +
      '{{item_line}}\n\n' +
      '*ऑनलाइन पेमेंट करने पर आप {{prepaid_total}} देंगे*, {{cod_total}} नहीं\n' +
      '*{{saving}} आपके पास रहेंगे*\n' +
      '{{gift_line}}\n' +
      '*सबसे पहले पैक और डिस्पैच*, ताकि यह आपको जल्दी मिले\n\n' +
      'नीचे दिया लिंक {{valid_until}} तक खुला है। अगर आप नहीं चाहते, तो COD ही रखें दबाएँ और कुछ नहीं बदलेगा।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      item_line: EX.item_line,
      prepaid_total: EX.prepaid_total,
      cod_total: EX.cod_total,
      saving: EX.saving,
      gift_line: 'हमारी तरफ़ से एक गिफ्ट, आपके पार्सल के साथ',
      valid_until: EX.valid_until,
    },
    footer: STOP_FOOTER,
    buttons: [urlBtn('ऑनलाइन पेमेंट करें'), qr('COD ही रखें', 'A', 'keep_cod')],
  },

  prepaid_confirmed: {
    name: 'prepaid_confirmed_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, Order {{order_number}} के लिए आपका {{amount_paid}} का पेमेंट हमें मिल गया है।\n\n' +
      'यह Order अब पूरा Prepaid है, इसलिए दरवाज़े पर कुछ नहीं देना है। Prepaid Order सबसे पहले पैक और डिस्पैच किए जाते हैं, तो आपका Order पहले ही आगे बढ़ चुका है।',
    examples: { customer_name: EX.customer_name, amount_paid: EX.amount_paid, order_number: EX.order_number },
    buttons: [],
  },

  prepaid_refund: {
    name: 'prepaid_refund_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, आपका पेमेंट हमें मिलने तक Order {{order_number}} डिलीवरी के लिए निकल चुका था, इसलिए हम इसे Prepaid में नहीं बदल सके।\n\n' +
      'आपके {{amount_paid}} उसी खाते में वापस भेजे जा रहे हैं और आम तौर पर {{refund_eta}} में पहुँच जाते हैं। कृपया डिलीवरी के समय {{cod_amount}} पहले की तरह तैयार रखें।\n\n' +
      'Sorry, आपको एक अतिरिक्त कदम उठाना पड़ा।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      amount_paid: EX.amount_paid,
      refund_eta: EX.refund_eta,
      cod_amount: EX.cod_amount,
    },
    buttons: [],
  },

  order_confirmed: {
    name: 'order_confirmed_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, आपके Order {{order_number}} के लिए Thank you।\n\n' +
      '{{item_line}}\n' +
      'Order कुल: {{order_total}}\n\n' +
      'यह अभी हमारी पैकिंग टीम के पास है। जैसे ही यह हमारे यहाँ से निकलेगा, हम आपको ट्रैकिंग लिंक भेज देंगे।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      item_line: EX.item_line,
      order_total: EX.order_total,
    },
    buttons: [],
  },

  /*
   * NO CLAIM THAT THE PARCEL HAS MOVED, same as the English. This fires on a
   * Shopify fulfillment, which only means a label and a waybill exist: the
   * courier has not collected anything yet. "डिस्पैच हो गया" here would be
   * false for as long as it sits at MANIFESTED, which on four real orders was
   * days.
   */
  order_shipped: {
    name: 'order_shipped_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, Order {{order_number}} पैक हो गया है, लेबल लग गया है और पिकअप के लिए तैयार है।\n\n' +
      'आइटम: {{item_line}}\n' +
      'डिलीवरी पर: {{payment_line}}\n' +
      'कूरियर: {{courier}}\n' +
      'ट्रैकिंग नंबर: {{awb}}\n\n' +
      'कूरियर इसे उठा लेने के बाद ट्रैकिंग अपडेट होने लगती है। नीचे दबाकर इसे देखते रहें।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      item_line: EX.item_line,
      payment_line: 'कृपया Rs 1,499 तैयार रखें',
      courier: EX.courier,
      awb: EX.awb,
    },
    buttons: [trackBtn('Order ट्रैक करें')],
  },

  /*
   * The two review asks that hang on the native WhatsApp Flow. Both are in the
   * registry and both are SKIPPED BY SYNC, exactly like their English twins:
   * Meta requires business verification to publish a Flow and ours has not
   * been through it. delivered_review_link below is the one that actually goes
   * out, and it has a plain URL button instead.
   */
  delivered_review: {
    name: 'delivered_review_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, आपका Order {{order_number}} आपके पास {{delivered_date}} को पहुँच गया।\n\n' +
      'हम जानना चाहेंगे कि नाप कैसा रहा और पहनने में कैसा लगा। इसमें एक मिनट लगता है, और इससे तय होता है कि हम आगे क्या बनाएँ।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number, delivered_date: EX.delivered_date },
    buttons: [flowBtn('Order को रेटिंग दें')],
  },

  delivered_review_link: {
    name: 'delivered_review_link_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, आपका Order {{order_number}} आपके पास {{delivered_date}} को पहुँच गया।\n\n' +
      'हम जानना चाहेंगे कि नाप कैसा रहा और पहनने में कैसा लगा। इसमें एक मिनट लगता है, और इससे तय होता है कि हम आगे क्या बनाएँ।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number, delivered_date: EX.delivered_date },
    // The SAME Google Form. There is no Hindi form to point at, and a form in
    // a language the shopper did not choose is worse than an English one they
    // can still fill in. See DECISIONS.md.
    buttons: [reviewFormBtn('अपनी राय बताएँ')],
  },

  review_reminder: {
    name: 'review_reminder_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, हमें अब भी जानना है कि Order {{order_number}} आपके लिए कैसा रहा।\n\n' +
      'अगर एक मिनट हो, तो बताइए। आपकी सच्ची बात हमारे लिए जितनी काम की है, आप सोच भी नहीं सकते।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number },
    buttons: [flowBtn('Order को रेटिंग दें')],
  },

  out_for_delivery: {
    name: 'out_for_delivery_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, आपके Order {{order_number}} के लिए Thank you। यह आज Delhivery के साथ डिलीवरी के लिए निकल चुका है। कृपया {{cod_total}} तैयार रखें।\n\n' +
      'अगर आप उपलब्ध नहीं रहेंगे, तो यहीं जवाब दें और हम इसे दोबारा तय कर देंगे।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number, cod_total: EX.cod_total },
    buttons: [trackBtn('Order ट्रैक करें')],
  },

  ndr_action: {
    name: 'ndr_action_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, हमारे कूरियर पार्टनर ने {{attempt_date}} को Order {{order_number}} के साथ आपसे संपर्क करने की कोशिश की और डिलीवरी पूरी नहीं हो सकी।\n\n' +
      'कुछ नहीं खोया है। आपको जो ठीक लगे वह बताएँ और हम वैसा कर देंगे।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number, attempt_date: EX.attempt_date },
    buttons: [
      qr('कल डिलीवरी करें', 'C', 'ndr_reattempt'),
      qr('Address बदलें', 'C', 'ndr_address'),
      qr('Order रद्द करें', 'C', 'ndr_cancel'),
    ],
  },

  rto_reason: {
    name: 'rto_reason_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, Order {{order_number}} डिलीवर नहीं हो सका और हमारे पास वापस आ रहा है।\n\n' +
      'अगर एक पल निकाल सकें, तो बताएँ कि क्या गड़बड़ हुई। हम इनमें से हर एक पढ़ते हैं।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number },
    buttons: [
      qr('घर पर कोई नहीं था', 'C', 'rto_not_available'),
      qr('मैंने मन बदल लिया', 'C', 'rto_changed_mind'),
      qr('Size ठीक नहीं था', 'C', 'rto_size_fit'),
      qr('डिलीवरी में बहुत देर हुई', 'C', 'rto_delivery_late'),
      qr('मैंने यह Order नहीं किया', 'C', 'rto_did_not_order'),
      qr('कोई और कारण', 'C', 'rto_other'),
    ],
  },

  cart_recovery: {
    name: 'cart_recovery_hi_v1',
    language: 'hi',
    category: 'MARKETING',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, आपका बैग अब भी आपका इंतज़ार कर रहा है।\n\n' +
      '{{item_line}}\n\n' +
      'Morpaankh का हर पीस हमारे यहाँ से निकलने से पहले हाथ से जाँचा जाता है, और हम चाहेंगे कि अगला आपका हो। इसलिए हमने आपके लिए एक निजी कोड बनाया है:\n\n' +
      '*{{code}}*\n\n' +
      'यह इस बैग पर *{{saving}} कम* करता है, और साथ में *हमारी तरफ़ से एक गिफ्ट* आपके पार्सल में आता है। यह सिर्फ़ आपका है, एक बार चलता है, और *{{expires_at}}* बंद हो जाता है।\n\n' +
      'नीचे दबाएँ और यह अपने आप लग जाएगा।',
    examples: {
      customer_name: EX.customer_name,
      item_line: EX.item_line,
      code: 'MORPAANKHAARAV47',
      saving: '₹200',
      expires_at: 'कल रात 9:20 बजे',
    },
    footer: STOP_FOOTER,
    buttons: [urlBtn('Order पूरा करें', 'r'), qr('हमसे बात करें', 'R', 'help')],
  },

  cart_final: {
    name: 'cart_final_hi_v1',
    language: 'hi',
    category: 'MARKETING',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      /*
       * REJECTED BY META AS INCORRECT_CATEGORY ON 2026-11-14, as MARKETING,
       * while the identical English cart_final_v1 and the Hindi sibling
       * cart_recovery_hi_v1 are both APPROVED as MARKETING.
       *
       * The category was right; the copy was not. The first version read as a
       * UTILITY status reminder wearing a MARKETING label: it opened on "एक
       * याद दिला रहे हैं" (we are sending a reminder), and it never once named
       * the thing as an offer. The English closes on "the offer closes with
       * it"; this had softened that to "यह बात भी बंद हो जाएगी" ("this matter
       * will also close"). cart_recovery_hi_v1 passed because it CREATES the
       * offer out loud ("हमने आपके लिए एक निजी कोड बनाया है").
       *
       * So ऑफ़र and छूट are named explicitly, which is what the English always
       * did. Placeholders are unchanged, because templates.hi.test.mjs pins
       * them to the English twin's set.
       */
      'Hello {{customer_name}}, आपके निजी ऑफ़र का कोड बंद होने में अब थोड़ा ही समय बाकी है।\n\n' +
      '*{{code}}* *{{expires_at}}* बंद हो जाता है, यानी अब से करीब {{time_left}} में।\n\n' +
      '{{item_line}}\n\n' +
      'इस ऑफ़र में आपको इस बैग पर *{{saving}} की छूट* मिलती है, और साथ में *हमारी तरफ़ से एक गिफ्ट* आपके पार्सल में आता है। आपका बैग वैसे ही सहेजा हुआ है जैसे आपने छोड़ा था, इसलिए पूरा करने में एक मिनट से भी कम लगेगा।\n\n' +
      'कोड बंद होते ही यह ऑफ़र भी बंद हो जाएगा।',
    examples: {
      customer_name: EX.customer_name,
      code: 'MORPAANKHAARAV47',
      expires_at: 'आज रात 9:20 बजे',
      time_left: '2 घंटे',
      item_line: EX.item_line,
      saving: '₹200',
    },
    footer: STOP_FOOTER,
    buttons: [urlBtn('Order पूरा करें', 'r'), qr('हमसे बात करें', 'R', 'help')],
  },

  replacement_raised: {
    name: 'replacement_raised_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, हम आपके Order {{order_number}} के लिए रिप्लेसमेंट भेज रहे हैं।\n\n' +
      'हमारा डिलीवरी पार्टनर आपके Address से {{return_item}} लेने आएगा। उसके अगले कार्य दिवस पर हम आपको {{new_item}} डिस्पैच कर देंगे।\n\n' +
      'कृपया इसे बिना इस्तेमाल किए, टैग लगे हुए, पैक करके पिकअप के लिए तैयार रखें।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      return_item: 'Noor, Size M',
      new_item: 'Noor, Size XL',
    },
    buttons: [trackBtn('पिकअप ट्रैक करें')],
  },

  replacement_shipped: {
    name: 'replacement_shipped_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}}, आपके Order {{order_number}} का रिप्लेसमेंट रास्ते में है।\n\n' +
      'आइटम: {{new_item}}\n' +
      'कूरियर: Delhivery\n' +
      'ट्रैकिंग नंबर: {{awb}}\n\n' +
      'इस अदला बदली में धैर्य रखने के लिए Thank you।',
    examples: {
      customer_name: EX.customer_name,
      order_number: EX.order_number,
      new_item: 'Noor, Size XL',
      awb: EX.awb,
    },
    buttons: [trackBtn('रिप्लेसमेंट ट्रैक करें')],
  },

  subscriber_offer: {
    name: 'subscriber_offer_hi_v1',
    language: 'hi',
    category: 'MARKETING',
    header: imageHeader(SAMPLE_PRODUCT_IMAGE),
    body:
      'Hello {{customer_name}}, Morpaankh से जुड़ने के लिए Thank you।\n\n' +
      'आपका स्वागत करने के लिए हमने सिर्फ़ आपके लिए एक खास कोड बनाया है:\n\n' +
      '*{{code}}*\n\n' +
      'यह {{min_order}} से ऊपर के किसी भी Order पर *{{saving}} कम* करता है, और *हमारी तरफ़ से एक गिफ्ट* आपके पार्सल में लिपटा आता है। यह सिर्फ़ आपका है, एक बार चलता है, और *{{expires_at}}* बंद हो जाता है।\n\n' +
      'अभी सबसे पसंद किए जा रहे हैं: {{top_picks}}।\n\n' +
      'हर पीस हमारे यहाँ से निकलने से पहले हाथ से जाँचा जाता है, और जो आप देखते हैं वही आपके पास पहुँचता है। Prepaid Order पर शिपिंग फ्री है।\n\n' +
      'नीचे दबाएँ और आपका कोड अपने आप लग जाएगा।',
    examples: {
      customer_name: 'Priya',
      code: 'MORPAANKHPRIYA4729',
      saving: '₹200',
      min_order: '₹1,500',
      expires_at: 'कल सुबह 11:00 बजे',
      top_picks: 'Khili Dhoop, Bandhan और Morani',
    },
    footer: STOP_FOOTER,
    buttons: [urlBtn('सबसे पसंदीदा देखें', 'w'), qr('हमसे बात करें', 'W', 'help')],
  },
};

/*
 * PLAIN_HI — no product photo, or no prepaid price to quote.
 *
 * The Hindi stand-in for whichever of NO_PRICE[key] or LEGACY[key] the English
 * path would reach in the same situation, so the two registries are picked in
 * the same circumstances and say the same thing.
 */
export const PLAIN_HI = {
  cod_confirm: {
    name: 'cod_confirm_noprice_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'आपके Order {{order_number}} के लिए Thank you।\n\n' +
      'Order कुल: {{order_total}}\n' +
      'पेमेंट: Cash on delivery\n\n' +
      'कृपया अपना Order Confirm करें, ताकि हम इसे पैक करके डिस्पैच कर सकें।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number, order_total: EX.order_total },
    buttons: [
      qr('Order Confirm करें', 'A', 'confirm'),
      qr('ऑनलाइन पेमेंट करें', 'A', 'pay_online'),
      qr('Order रद्द करें', 'A', 'cancel'),
    ],
  },

  cod_reminder: {
    name: 'cod_reminder_noprice_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body:
      'Hello {{customer_name}},\n' +
      'हमारे साथ खरीदारी के लिए Thank you। आपका {{order_total}} का Order {{order_number}} आपके Confirm करने का इंतज़ार कर रहा है।\n\n' +
      'कृपया Confirm करें, ताकि हम इसे समय पर डिस्पैच कर सकें।',
    examples: { customer_name: EX.customer_name, order_number: EX.order_number, order_total: EX.order_total },
    buttons: [
      qr('Order Confirm करें', 'A', 'confirm'),
      qr('ऑनलाइन पेमेंट करें', 'A', 'pay_online'),
      qr('Order रद्द करें', 'A', 'cancel'),
    ],
  },

  order_confirmed: {
    name: 'order_confirmed_plain_hi_v1',
    language: 'hi',
    category: 'UTILITY',
    body: TEMPLATES_HI.order_confirmed.body,
    examples: TEMPLATES_HI.order_confirmed.examples,
    buttons: [],
  },

  cart_recovery: {
    name: 'cart_recovery_plain_hi_v1',
    language: 'hi',
    category: 'MARKETING',
    body: TEMPLATES_HI.cart_recovery.body,
    examples: TEMPLATES_HI.cart_recovery.examples,
    footer: STOP_FOOTER,
    buttons: TEMPLATES_HI.cart_recovery.buttons,
  },

  cart_final: {
    name: 'cart_final_plain_hi_v1',
    language: 'hi',
    category: 'MARKETING',
    body: TEMPLATES_HI.cart_final.body,
    examples: TEMPLATES_HI.cart_final.examples,
    footer: STOP_FOOTER,
    buttons: TEMPLATES_HI.cart_final.buttons,
  },

  subscriber_offer: {
    name: 'subscriber_offer_plain_hi_v1',
    language: 'hi',
    category: 'MARKETING',
    body: TEMPLATES_HI.subscriber_offer.body,
    examples: TEMPLATES_HI.subscriber_offer.examples,
    footer: STOP_FOOTER,
    buttons: TEMPLATES_HI.subscriber_offer.buttons,
  },
};

/*
 * The two that templates-sync must NOT submit yet, by Meta name, for the same
 * reason their English twins are skipped: the review Flow cannot be published
 * until the business is verified, and a FLOW button with no flow id is not a
 * template Meta will take.
 */
export const HI_NOT_SUBMITTED = new Set(['delivered_review_hi_v1', 'review_reminder_hi_v1']);
