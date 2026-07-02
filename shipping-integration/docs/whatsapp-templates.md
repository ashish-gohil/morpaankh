# WhatsApp message templates to submit in Meta Business Manager

Submit each under WhatsApp Manager → Message templates. Names and variable
order must match exactly (the code passes positional {{n}} params). Language:
English. After approval, set `WHATSAPP_ENABLED=true`.

Voice rules: MorPaankh one word, honest, warm, no pressure tactics, no em
dashes, no handcrafted claims.

## 1. `abandoned_checkout_reminder` — category: MARKETING

Sent once, at least an hour after a checkout is abandoned. Requires the
customer's phone number to be subscribed to marketing (default config).

Body:
> Hi {{1}}, you left {{2}} in your bag at MorPaankh. It is saved for you, and delivery is free on prepaid orders.

Button: URL button, text "Complete my order", URL `https://www.morpaankh.in/{{1}}`
(dynamic suffix; the code passes the recovery path).

## 2. `cod_order_confirmation` — category: UTILITY

Sent once for new Cash on Delivery orders.

Body:
> Hi {{1}}, thank you for your MorPaankh order {{2}} ({{3}}, Cash on Delivery). We are preparing it for dispatch. Reply YES to confirm your order, or reply CHANGE if anything needs correcting.

## 3. `order_shipped` — category: UTILITY

Sent once when the shipment is picked up.

Body:
> Hi {{1}}, your MorPaankh order {{2}} is on its way. Track it any time with AWB {{3}} on our website under Track Order.

## 4. `order_delivered` — category: UTILITY

Sent once on delivery.

Body:
> Hi {{1}}, your MorPaankh order {{2}} has been delivered. We hope you love it. If anything is not right, returns are easy within 7 days.

## 5. `review_request` — category: MARKETING

Sent once, 3 days after delivery, marketing-consented customers only.

Body:
> Hi {{1}}, it has been a few days since your MorPaankh order {{2}} arrived. If you have a minute, we would love to hear how it fits and feels. Your words help other women choose well.

## Notes

- Marketing templates need opt-in. `REQUIRE_MARKETING_CONSENT=true` (default)
  restricts them to customers whose phone number shows SUBSCRIBED in Shopify.
  Relaxing it increases reach but risks Meta quality-rating penalties and
  violates consent norms. Recommendation: leave it on and grow the opt-in list
  honestly (checkout SMS/WhatsApp consent checkbox is in Shopify Settings →
  Checkout → Marketing options).
- Utility templates (2-4) are order updates and need no marketing opt-in.
- Free tier is about 1,000 conversations/month; utility messages after that
  cost roughly Rs 0.35, marketing roughly Rs 0.80.
- The "Reply YES" line in template 2 works without any code: replies land in
  the WhatsApp Business inbox, and a customer reply opens a free 24h service
  window. Check the inbox daily while order volume is small.
