/*
 * session.hi.mjs — the Hindi half of the free-form (session) registry.
 *
 * One entry per CUSTOMER-FACING key in session.mjs. The owner keys (the ops
 * digest, the alerts, /replace, the P&L replies) stay English on purpose: they
 * are incident reports read by one person who reads English, and translating
 * them makes them harder to act on, not easier. pay_link_expired_page is dead
 * code (sess() returns null for type 'html') so it is not translated either.
 * renderSession falls back to English for any key missing here, so this file
 * can never cost a customer a message.
 *
 * IMPORTS NOTHING. session.mjs imports this file, so reaching back for
 * anything in it would be a cycle. Where a session message is the free-form
 * twin of a Meta template, the Hindi is COPIED from templates.hi.mjs rather
 * than imported, and the copies are kept word for word: a customer must not be
 * told two different stories about the same parcel depending on which door the
 * message came through.
 *
 * COPY RULES, enforced by session.hi.test.mjs:
 *   Devanagari, formal आप, short sentences, danda for full stops.
 *   Gender-neutral about the customer: prefer wording that does not inflect.
 *   Latin only for Hello, Thank you, Please, Sorry, Order, Address, Size,
 *   Confirm, Morpaankh, product titles, sizes, codes, amounts, Delhivery,
 *   COD, Cash on delivery, Prepaid, UPI, STOP, START, HINDI, ENGLISH.
 *   Every other loanword in Devanagari.
 *   Same facts as the English twin. Nothing added, nothing dropped.
 *   A body that names a button uses that button's Hindi title exactly.
 *   Body <= 4096, button titles <= 20 CHARACTERS (tight in Devanagari), and a
 *   cta button text <= 20 once a real amount is substituted into it.
 */

export const SESSION_HI = {
  /*
   * The prepaid offer block is the same four lines in all three offer
   * messages, worded as prepaid_offer_hi_v1 words them, so the switch reads
   * identically whether it arrives as a template or in the open window.
   */
  confirmed_with_offer: {
    type: 'cta_url',
    body:
      'Thank you {{customer_name}}। आपका Order {{order_number}} Confirm हो गया है और हमने इसे तैयार करना शुरू कर दिया है।\n\n' +
      'इसे अब भी ऑनलाइन पेमेंट में बदला जा सकता है, और इसमें लगने वाले तीस सेकंड इसके लायक हैं:\n\n' +
      '*आप {{new_total}} देंगे*, {{order_total}} नहीं\n' +
      '*{{saving}} आपके पास रहेंगे*\n' +
      '{{gift_line}}\n' +
      '*सबसे पहले पैक और डिस्पैच*, ताकि यह आपको जल्दी मिले\n\n' +
      'लिंक {{valid_until}} तक खुला है। जब तक आप इसका इस्तेमाल न करें, आपके Order में कुछ नहीं बदलता।',
    // "{{new_total}} दें" and not "पेमेंट करें": the cta is capped at 20
    // characters WITH the amount in it, and the amount is the useful half.
    ctaText: '{{new_total}} दें',
  },
  pay_online_offer: {
    type: 'cta_url',
    body:
      'यह लीजिए {{customer_name}}। आपके Order {{order_number}} के लिए आपका लिंक।\n\n' +
      '*आप {{new_total}} देंगे*, {{order_total}} नहीं\n' +
      '*{{saving}} आपके पास रहेंगे*\n' +
      '{{gift_line}}\n' +
      '*सबसे पहले पैक और डिस्पैच*, ताकि यह आपको जल्दी मिले\n\n' +
      'लिंक {{valid_until}} तक खुला है। जब तक आप इसका इस्तेमाल न करें, आपके Order में कुछ नहीं बदलता।',
    ctaText: '{{new_total}} दें',
  },
  // Word for word with cart_recovery_hi_v1's body, as the English pair is word
  // for word with cart_recovery_v1's.
  cart_recovery: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, आपका बैग अब भी आपका इंतज़ार कर रहा है।\n\n' +
      '{{item_line}}\n\n' +
      'Morpaankh का हर पीस हमारे यहाँ से निकलने से पहले हाथ से जाँचा जाता है, और हम चाहेंगे कि अगला आपका हो। इसलिए हमने आपके लिए एक निजी कोड बनाया है:\n\n' +
      '*{{code}}*\n\n' +
      'यह इस बैग पर *{{saving}} कम* करता है, और साथ में *हमारी तरफ़ से एक गिफ्ट* आपके पार्सल में आता है। यह सिर्फ़ आपका है, एक बार चलता है, और *{{expires_at}}* बंद हो जाता है।\n\n' +
      'नीचे दबाएँ और यह अपने आप लग जाएगा।',
    ctaText: 'Order पूरा करें',
  },
  cart_final: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, आपका निजी कोड बंद होने से पहले एक याद दिला रहे हैं।\n\n' +
      '*{{code}}* *{{expires_at}}* बंद हो जाता है, यानी अब से करीब {{time_left}} में।\n\n' +
      '{{item_line}}\n\n' +
      'यह अब भी इस बैग पर *{{saving}} कम* करता है, और साथ में *हमारी तरफ़ से एक गिफ्ट* आपके पार्सल में आता है। आपका बैग वैसे ही सहेजा हुआ है जैसे आपने छोड़ा था, इसलिए पूरा करने में एक मिनट से भी कम लगेगा।\n\n' +
      'कोड बंद होते ही यह बात भी बंद हो जाएगी।',
    ctaText: 'Order पूरा करें',
  },
  keep_cod_ack: {
    type: 'text',
    body:
      'हो गया {{customer_name}}। आपका Order {{order_number}} Cash on delivery पर ही रहेगा। ' +
      'जैसे ही यह हमारे यहाँ से निकलेगा, हम आपको ट्रैकिंग लिंक भेज देंगे।',
  },
  payment_received_checking: {
    type: 'text',
    body:
      'Hello {{customer_name}}, Thank you, Order {{order_number}} के लिए आपका {{amount_paid}} हमें मिल गया है। ' +
      'हमारी टीम इसे आपके Order से मिला रही है और थोड़ी देर में यहीं पुष्टि कर देगी।',
  },
  pay_online_unavailable: {
    type: 'text',
    body:
      'Hello {{customer_name}}, Thank you। Order {{order_number}} के लिए ऑनलाइन पेमेंट अभी उपलब्ध नहीं है, ' +
      'इसलिए यह Cash on delivery पर ही रहेगा। कोई मदद चाहिए हो तो यहीं जवाब दें।',
  },
  /*
   * The amount is the whole point of this message, so it stays in a variable
   * and the reason for it stays in words: two courier trips, not a fee.
   */
  replacement_pay_request: {
    type: 'text',
    body:
      'Hello {{customer_name}}, Order {{order_number}} में धैर्य रखने के लिए Thank you।\n\n' +
      'Size बदलने में कूरियर के दो चक्कर लगते हैं, पिकअप और नई डिलीवरी, और इसका खर्च {{total}} है। ' +
      'यह हमें मिल जाने पर हम पिकअप तुरंत बुक कर देंगे।\n\n' +
      '{{pay_line}}\n\n' +
      'कृपया पेमेंट का स्क्रीनशॉट यहीं भेज दें, आगे का काम हम संभाल लेंगे।',
  },

  /*
   * TWINS OF THE TEMPLATES, FOR WHEN THE WINDOW IS OPEN.
   *
   * Bodies copied from templates.hi.mjs, so the free-form message and the
   * template say the same words in Hindi as well as in English.
   */
  order_shipped_session: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, Order {{order_number}} पैक हो गया है, लेबल लग गया है और पिकअप के लिए तैयार है।\n\n' +
      'आइटम: {{item_line}}\n' +
      'डिलीवरी पर: {{payment_line}}\n' +
      'कूरियर: {{courier}}\n' +
      'ट्रैकिंग नंबर: {{awb}}\n\n' +
      'कूरियर इसे उठा लेने के बाद ट्रैकिंग अपडेट होने लगती है। नीचे दबाकर इसे देखते रहें।',
    ctaText: 'Order ट्रैक करें',
  },
  cod_reminder_session: {
    type: 'buttons',
    body:
      'Hello {{customer_name}}, आपका Order {{order_number}} हमने अब तक रोक रखा है।\n\n' +
      '{{item_line}}\n\n' +
      'Cash on delivery: {{cod_total}}\n' +
      'ऑनलाइन पेमेंट करने पर: {{prepaid_total}}\n\n' +
      'पैकिंग के लिए भेजने में सिर्फ़ एक टैप लगता है। Prepaid Order सबसे पहले जाते हैं।\n\n' +
      'Size या रंग बदलना है? नीचे बदलें या रद्द करें दबाएँ, हम तुरंत मदद करेंगे।',
    buttons: [
      { id: 'pay_online', title: 'ऑनलाइन पेमेंट करें', flow: 'A', action: 'pay_online' },
      /*
       * The template's own title, unchanged. The English twin had to shorten
       * "Confirm cash on delivery" to fit 20 characters; "COD Confirm करें" is
       * 16, so Hindi keeps the template wording exactly.
       */
      { id: 'confirm', title: 'COD Confirm करें', flow: 'A', action: 'confirm' },
      { id: 'cancel', title: 'बदलें या रद्द करें', flow: 'A', action: 'cancel' },
    ],
  },
  /*
   * prepaid_offer_hi_v1's body MINUS its last sentence. The template ends with
   * "अगर आप नहीं चाहते, तो COD ही रखें दबाएँ", which names a quick reply this
   * free-form version does not carry: a cta_url message has one button.
   */
  prepaid_offer_session: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, आपका Order {{order_number}} अभी Cash on delivery पर है।\n\n' +
      '{{item_line}}\n\n' +
      '*ऑनलाइन पेमेंट करने पर आप {{prepaid_total}} देंगे*, {{cod_total}} नहीं\n' +
      '*{{saving}} आपके पास रहेंगे*\n' +
      '{{gift_line}}\n' +
      '*सबसे पहले पैक और डिस्पैच*, ताकि यह आपको जल्दी मिले\n\n' +
      'नीचे दिया लिंक {{valid_until}} तक खुला है।',
    ctaText: 'ऑनलाइन पेमेंट करें',
  },
  ndr_action_session: {
    type: 'buttons',
    body:
      'Hello {{customer_name}}, हमारे कूरियर पार्टनर ने {{attempt_date}} को Order {{order_number}} के साथ आपसे संपर्क करने की कोशिश की और डिलीवरी पूरी नहीं हो सकी।\n\n' +
      'कुछ नहीं खोया है। आपको जो ठीक लगे वह बताएँ और हम वैसा कर देंगे।',
    buttons: [
      { id: 'ndr_reattempt', title: 'कल डिलीवरी करें', flow: 'C', action: 'ndr_reattempt' },
      { id: 'ndr_address', title: 'Address बदलें', flow: 'C', action: 'ndr_address' },
      { id: 'ndr_cancel', title: 'Order रद्द करें', flow: 'C', action: 'ndr_cancel' },
    ],
  },
  /*
   * A list, like the English twin: six reasons do not fit in three reply
   * buttons. The rows are the template's own actions, so the list button only
   * has to say what the list is.
   */
  rto_reason_session: {
    type: 'list',
    flow: 'C',
    body:
      'Hello {{customer_name}}, Order {{order_number}} डिलीवर नहीं हो सका और हमारे पास वापस आ रहा है।\n\n' +
      'अगर एक पल निकाल सकें, तो बताएँ कि क्या गड़बड़ हुई। हम इनमें से हर एक पढ़ते हैं।',
    listButton: 'कारण बताएँ',
  },

  /*
   * THE REPLIES FOR A BUTTON THAT OUTLIVED ITS ORDER. Each says what is true
   * now and asks for nothing.
   */
  order_closed: {
    type: 'text',
    body:
      'Hello {{customer_name}}, हमें लिखने के लिए Thank you। Order {{order_number}} रद्द हो चुका है, ' +
      'इसलिए अब कुछ Confirm करने या देने की ज़रूरत नहीं है। अगर यह ठीक नहीं है, तो यहीं जवाब दें।',
  },
  already_paid: {
    type: 'text',
    body:
      'Hello {{customer_name}}, Thank you। Order {{order_number}} का पेमेंट ऑनलाइन हो चुका है, ' +
      'इसलिए डिलीवरी के समय कुछ नहीं देना है।',
  },
  already_shipped: {
    type: 'text',
    body:
      'Hello {{customer_name}}, Thank you। Order {{order_number}} Delhivery के साथ हमारे यहाँ से निकल चुका है। ' +
      'ट्रैकिंग नंबर: {{awb}}।',
  },
  // No "यह बदल नहीं सकता" without the reason, and no apology either: the
  // useful thing here is the amount to keep ready.
  pay_at_door: {
    type: 'text',
    body:
      'Hello {{customer_name}}, Thank you। Order {{order_number}} रास्ते में है, इसलिए अब इसे ऑनलाइन पेमेंट ' +
      'में नहीं बदला जा सकता। कृपया डिलीवरी के समय {{cod_total}} तैयार रखें।',
  },
  cancel_check: {
    type: 'buttons',
    body: 'पैकिंग रोकने से पहले एक बार पूछ लें: क्या हम Order {{order_number}} रद्द कर दें?',
    buttons: [
      { id: 'cancel_yes', title: 'हाँ, रद्द करें', flow: 'A', action: 'cancel_yes' },
      { id: 'cancel_no', title: 'नहीं, रहने दें', flow: 'A', action: 'cancel_no' },
    ],
  },
  cancel_done: {
    type: 'text',
    body:
      'Order {{order_number}} रद्द हो गया है। Sorry, इस बार बात नहीं बन सकी। ' +
      'बताने के लिए Thank you, और उम्मीद है कि अगले मौके पर आपको सजाने का काम हमें मिलेगा।',
  },
  cancel_kept: { type: 'text', body: 'ठीक है। Order {{order_number}} जैसा है वैसा ही रहेगा।' },
  cancel_too_late: {
    type: 'text',
    body:
      'Order {{order_number}} डिलीवरी के लिए निकल चुका है, इसलिए हम इसे यहाँ से रोक नहीं सकते। ' +
      'हमारी टीम से कोई थोड़ी देर में आपको कॉल करेगा और आपके साथ इसे सुलझा देगा।',
  },
  // Not cancel_too_late's reason: nothing has left, the order is simply paid
  // for, and we are holding their money.
  cancel_refund_review: {
    type: 'text',
    body:
      'Order {{order_number}} का पेमेंट हो चुका है, इसलिए रद्द करने और आपके रिफंड का काम हम अपने आप नहीं, ' +
      'किसी व्यक्ति से करवाना चाहते हैं। हमारी टीम से कोई थोड़ी देर में आपको कॉल करेगा।',
  },
  // ---- variant change (size or colour swap) -------------------------------
  change_or_cancel: {
    type: 'buttons',
    // "बदलना है" and not "बदलना चाहेंगे": the second form inflects for the
    // customer's gender, and this is the first question we ask them.
    body:
      'पैकिंग रोकने से पहले: Order {{order_number}} में Size या रंग बदलना है, ' +
      'या इसे पूरी तरह रद्द करना है?',
    buttons: [
      { id: 'vc', title: 'Size या रंग बदलें', flow: 'A', action: 'vc' },
      { id: 'cancel_yes', title: 'Order रद्द करें', flow: 'A', action: 'cancel_yes' },
      { id: 'cancel_no', title: 'Order वैसा ही रखें', flow: 'A', action: 'cancel_no' },
    ],
  },

  vc_pick_item: {
    type: 'list',
    body: 'Order {{order_number}} में कौन सा आइटम बदलना है?',
    listButton: 'आइटम चुनें',
  },

  vc_pick_option: {
    type: 'buttons',
    body: 'आपके पास {{item_desc}} है। क्या बदलना है?',
    buttons: [
      // Size stays Latin (it is how the sizes themselves are written: M, XL).
      // रंग is the word renderSession's own comment expects here.
      { id: 'pick_size', title: 'Size', flow: 'A', action: null },
      { id: 'pick_colour', title: 'रंग', flow: 'A', action: null },
      { id: 'cancel_no', title: 'जैसा है वैसा रखें', flow: 'A', action: 'cancel_no' },
    ],
  },

  vc_pick_size: {
    type: 'list',
    body: 'आपके पास {{item_desc}} है। कृपया वह Size चुनें जो आपको चाहिए।',
    listButton: 'Size चुनें',
  },

  vc_pick_colour: {
    type: 'list',
    body: 'आपके पास {{item_desc}} है। कृपया वह रंग चुनें जो आपको चाहिए।',
    listButton: 'रंग चुनें',
  },

  /*
   * A QUESTION, and it says outright that nothing has changed yet, for the
   * reason the English twin carries: a customer who has just picked a size
   * from a list reads a statement here as confirmation and stops replying.
   */
  vc_confirm: {
    type: 'buttons',
    body:
      'बस थोड़ा और, {{customer_name}}। क्या हम Order {{order_number}} को {{from_desc}} से {{to_desc}} ' +
      'कर दें?\n\n' +
      'रकम {{order_total}} ही रहेगी।\n\n' +
      'अभी कुछ नहीं बदला है। पुष्टि के लिए नीचे दबाएँ।',
    buttons: [
      { id: 'confirm_change', title: 'हाँ, बदल दें', flow: 'A', action: null },
      { id: 'vc', title: 'पीछे जाएँ', flow: 'A', action: 'vc' },
    ],
  },

  vc_already_done: {
    type: 'text',
    body: 'अच्छी खबर {{customer_name}}। Order {{order_number}} पहले से ही {{to_desc}} है, इसलिए अब कुछ बदलना बाकी नहीं है।',
  },

  vc_changed: {
    type: 'text',
    body:
      'हो गया। Order {{order_number}} अब {{to_desc}} है, और रकम {{order_total}} ही रहेगी। ' +
      'अब हम यही पैक करेंगे।',
  },

  vc_nothing_available: {
    type: 'text',
    body:
      'अभी हमारे पास {{item_desc}} का दूसरा Size या रंग स्टॉक में नहीं है, इसलिए Order {{order_number}} ' +
      'जैसा है वैसा ही रहेगा। यहीं जवाब दें, हमारी टीम से कोई आपकी मदद करेगा।',
  },

  vc_handoff: {
    type: 'text',
    body:
      'हम वह बदलाव यहाँ से नहीं कर सके। हमारी टीम से कोई थोड़ी देर में आपको संदेश करेगा। ' +
      'तब तक Order {{order_number}} जैसा है वैसा ही रहेगा।',
  },

  // prepaid_confirmed_hi_v1's second paragraph, unchanged.
  payment_received: {
    type: 'text',
    body:
      'Thank you {{customer_name}}। Order {{order_number}} के लिए आपका {{amount_paid}} का पेमेंट हमें मिल गया है।\n\n' +
      'यह Order अब पूरा Prepaid है, इसलिए दरवाज़े पर कुछ नहीं देना है। Prepaid Order सबसे पहले पैक और डिस्पैच किए जाते हैं, तो आपका Order पहले ही आगे बढ़ चुका है।',
  },
  /*
   * prepaid_refund_hi_v1 without its "Hello {{customer_name}}": the session
   * twin carries no customer_name, and the refund window stays {{refund_eta}}
   * rather than a number, because we do not know the bank's.
   */
  prepaid_refund: {
    type: 'text',
    body:
      'आपका पेमेंट हमें मिलने तक Order {{order_number}} डिलीवरी के लिए निकल चुका था, इसलिए हम इसे Prepaid में नहीं बदल सके।\n\n' +
      'आपके {{amount_paid}} उसी खाते में वापस भेजे जा रहे हैं और आम तौर पर {{refund_eta}} में पहुँच जाते हैं। कृपया डिलीवरी के समय {{cod_amount}} पहले की तरह तैयार रखें।\n\n' +
      'Sorry, आपको एक अतिरिक्त कदम उठाना पड़ा।',
  },
  // The code is bold and alone on its line, as in the English: there is no
  // one-tap copy button for a free-form message.
  review_code: {
    type: 'text',
    body:
      'Thank you {{customer_name}}। हम इनमें से हर एक को ध्यान से पढ़ते हैं।\n\n' +
      'आपके अगले पीस के लिए {{amount}}:\n\n' +
      '*{{code}}*\n\n' +
      'यह सिर्फ़ आपका है, एक बार चलता है, {{min_order}} या उससे ऊपर के Order पर, ' +
      'और {{valid_until}} तक चलेगा।\n\n' +
      'Morpaankh पर क्या नया आया है, देखने आइए: morpaankh.in',
  },

  review_code_pending: {
    type: 'text',
    body: 'लिखने के लिए Thank you {{customer_name}}। आपका धन्यवाद कोड थोड़ी देर में यहीं पहुँच जाएगा।',
  },
  ndr_reattempt_ok: {
    type: 'text',
    body: 'हो गया। हमारा कूरियर पार्टनर अगले कार्य दिवस पर दोबारा कोशिश करेगा।',
  },
  ndr_address_ask: {
    type: 'text',
    body:
      'कृपया अपना पूरा Address एक ही संदेश में भेजें: घर या फ्लैट नंबर, गली, नज़दीकी निशानी, ' +
      'और 6 अंकों का पिनकोड।',
  },
  ndr_address_retry: {
    type: 'text',
    body:
      'उसमें हमें 6 अंकों का पिनकोड नहीं मिला। कृपया पूरा Address पिनकोड के साथ दोबारा भेजें।',
  },
  ndr_handoff: {
    type: 'text',
    body: 'Thank you। हमारी टीम यह काम खुद संभालेगी और थोड़ी देर में आपको कॉल करेगी।',
  },
  ndr_address_saved: {
    type: 'text',
    body: 'Thank you। हमारे कूरियर पार्टनर के पास नया Address पहुँच गया है और वे डिलीवरी दोबारा कोशिश करेंगे।',
  },
  ndr_pincode_changed: {
    type: 'text',
    body:
      'Thank you। वह Address दूसरे पिनकोड में है, और पार्सल एक बार रास्ते पर आ जाने के बाद कूरियर उसे ' +
      'बदल नहीं सकता। हमारी टीम थोड़ी देर में आपको कॉल करेगी और इसे सुलझा देगी।',
  },
  ndr_cancel_ack: {
    type: 'text',
    body: 'नोट कर लिया। पार्सल हमारे पास वापस आ जाएगा। इसे वैसे ही छोड़ने के बजाय हमें बताने के लिए Thank you।',
  },
  rto_other_ask: { type: 'text', body: 'एक या दो पंक्तियों में बताएँ कि क्या गड़बड़ हुई। हम इनमें से हर एक पढ़ते हैं।' },
  rto_thanks: { type: 'text', body: 'बताने के लिए Thank you। यह नोट हो गया है और बेकार नहीं जाएगा।' },
  // START stays Latin: it is the keyword the webhook matches on.
  optout_done: {
    type: 'text',
    body: 'अब आपको यहाँ हमारी तरफ़ से Order के अपडेट नहीं आएँगे। जब भी दोबारा चाहिए हों, START लिखकर भेजें।',
  },
  optin_done: { type: 'text', body: 'Thank you। आपके Order के अपडेट यहाँ दोबारा आने लगेंगे।' },
  // Two versions, because promising a code is open when it has closed is
  // worse than not mentioning it at all.
  cart_help_ack: {
    type: 'text',
    body:
      'Thank you {{customer_name}}। हमारी टीम से कोई थोड़ी देर में आपको यहीं संदेश करेगा। ' +
      'आपका बैग सहेजा हुआ है, और आपका कोड {{code}} {{expires_at}} तक खुला है।',
  },
  cart_help_ack_closed: {
    type: 'text',
    body:
      'Thank you {{customer_name}}। हमारी टीम से कोई थोड़ी देर में आपको यहीं संदेश करेगा, ' +
      'और आपका बैग सहेजा हुआ है।',
  },
  // replacement_raised_hi_v1's body, word for word.
  replacement_raised: {
    type: 'text',
    body:
      'Hello {{customer_name}}, हम आपके Order {{order_number}} के लिए रिप्लेसमेंट भेज रहे हैं।\n\n' +
      'हमारा डिलीवरी पार्टनर आपके Address से {{return_item}} लेने आएगा। उसके अगले कार्य दिवस पर हम आपको {{new_item}} डिस्पैच कर देंगे।\n\n' +
      'कृपया इसे बिना इस्तेमाल किए, टैग लगे हुए, पैक करके पिकअप के लिए तैयार रखें।',
  },

  // Flow W's pair, with Flow R's wording minus the bag: a welcome offer has no
  // cart behind it.
  subscriber_help_ack: {
    type: 'text',
    body:
      'Thank you {{customer_name}}। हमारी टीम से कोई थोड़ी देर में आपको यहीं संदेश करेगा। ' +
      'आपका कोड {{code}} {{expires_at}} तक खुला रहेगा।',
  },
  subscriber_help_ack_closed: {
    type: 'text',
    body: 'Thank you {{customer_name}}। हमारी टीम से कोई थोड़ी देर में आपको यहीं संदेश करेगा।',
  },

  // subscriber_offer_hi_v1's body, word for word, as the English pair is.
  subscriber_offer: {
    type: 'cta_url',
    body:
      'Hello {{customer_name}}, Morpaankh से जुड़ने के लिए Thank you।\n\n' +
      'आपका स्वागत करने के लिए हमने सिर्फ़ आपके लिए एक खास कोड बनाया है:\n\n' +
      '*{{code}}*\n\n' +
      'यह {{min_order}} से ऊपर के किसी भी Order पर *{{saving}} कम* करता है, और *हमारी तरफ़ से एक गिफ्ट* आपके पार्सल में लिपटा आता है। यह सिर्फ़ आपका है, एक बार चलता है, और *{{expires_at}}* बंद हो जाता है।\n\n' +
      'अभी सबसे पसंद किए जा रहे हैं: {{top_picks}}।\n\n' +
      'हर पीस हमारे यहाँ से निकलने से पहले हाथ से जाँचा जाता है, और जो आप देखते हैं वही आपके पास पहुँचता है। Prepaid Order पर शिपिंग फ्री है।\n\n' +
      'नीचे दबाएँ और आपका कोड अपने आप लग जाएगा।',
    ctaText: 'सबसे पसंदीदा देखें',
  },

  /*
   * THE PICKER. Bilingual on purpose, like the English one and in the same
   * order of priority: Hindi first here, because this copy is what a reader
   * who chose Hindi, or whom we guessed into Hindi, sees. Each button carries
   * its language in its own script.
   */
  language_select: {
    type: 'buttons',
    body:
      'नमस्ते {{customer_name}}, हम आपसे English या हिंदी में बात कर सकते हैं। नीचे चुनें।\n\n'
      + 'Hello, we can write to you in English or in Hindi. Please choose below.',
    buttons: [
      { id: 'lang_en', title: 'English', flow: 'L', action: 'lang_en' },
      { id: 'lang_hi', title: 'हिंदी', flow: 'L', action: 'lang_hi' },
    ],
  },

  /*
   * The receipt after choosing HINDI, so it is the mirror of the English one:
   * it says Hindi from now on, and names ENGLISH as the way back. ENGLISH
   * stays Latin because it is the keyword the router matches, not a word.
   */
  language_set: {
    type: 'text',
    body: 'Thank you। अब से हम आपसे हिंदी में बात करेंगे। English पर लौटने के लिए कभी भी ENGLISH लिखकर भेजें।',
  },
};
