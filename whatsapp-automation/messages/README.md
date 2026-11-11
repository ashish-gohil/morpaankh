# Editing customer copy

Every word a customer sees lives in this folder. Code never contains copy; it
references a message key. Files:

- `templates.mjs` — Meta-approved templates (business-initiated messages). Copy + buttons.
- `templates.hi.mjs` — the Hindi half of the same. Separate Meta names, no LEGACY.
- `session.mjs` — free-form messages, sent only inside an open 24h window. May carry offers/codes.
- `session.hi.mjs` — the Hindi half of those.
- `lang.mjs` — the fragment table: the phrases built in CODE and passed in as a variable.
- `labels.mjs` — button labels, RTO reasons, courier status wording, fixed strings.
- `rules.mjs` — every number and timing. Change a figure here, nowhere else.
- `pages.mjs` — the HTML the /r/ and /p/ redirects serve.
- `golden.snapshot.json` — every English payload, pinned. See the bottom of this file.
- `flows/review.flow.json` — the in-WhatsApp review form. English only.

## Hard rules (a test fails the build if you break these)

- No emoji. No em dash or en dash. Use plain words and commas.
- Courtesy words stay in English: Hello, Thank you, Please, Sorry, Yes, No, Order, Address, Size, Confirm.
- Utility templates carry no offer, discount, saving, or code wording. Offers/codes go only in
  session messages or the one marketing template (`prepaid_offer`).
- Body max 1024 chars; a placeholder is never at the very start or end and never touches another;
  every placeholder needs an example; button text max 25; footer max 60; session reply buttons max 3
  (titles max 20); cta display text max 20.

## Editing a SESSION message

Just edit the text in `session.mjs` and deploy. No approval needed. Keep the `{{placeholders}}`
the code supplies (a missing one throws at render). Run `npm run dryrun:render` to preview.

## Editing a TEMPLATE (needs Meta approval)

You cannot edit an approved template in place. To change one:

1. Bump its version suffix in `name` (e.g. `cod_confirm_v1` -> `cod_confirm_v2`).
2. Run `node scripts/templates-sync.mjs --live` to submit the new version to Meta.
3. The sender keeps using the old approved version until the new one is APPROVED, then switches
   automatically (active version = highest approved).

Adding a placeholder means also adding its `example`. Changing buttons may re-trigger Meta review
and can change the assigned category; `templates-sync` fails loudly if Meta's category differs
from the declared one.

## Preview everything

```
npm run dryrun:render
```

Renders every template and session message with sample data so you can read the exact wording a
customer receives.


## Editing HINDI copy

Hindi lives in `templates.hi.mjs` and `session.hi.mjs`, and the phrases that are
assembled in JavaScript live in `STR` in `lang.mjs`. The same hard rules apply,
plus these:

- Devanagari, formal **आप**, short sentences, danda **।** for a full stop.
- Latin script ONLY for: Hello, Thank you, Please, Sorry, Yes, No, Order,
  Address, Size, Confirm, Morpaankh, product titles, size letters, codes,
  amounts, Delhivery, COD, Cash on delivery, Prepaid, UPI, STOP, START, HINDI,
  ENGLISH. Every other loanword in Devanagari: पैक, डिस्पैच, डिलीवरी, कूरियर,
  ट्रैकिंग, पेमेंट, ऑनलाइन, लिंक, कोड, गिफ्ट, रिफंड, पिकअप, पार्सल,
  रिप्लेसमेंट. Keep the Latin share low, Meta rejects mixed-language bodies.
- **Gender-neutral about the customer.** Hindi verbs carry gender and we do not
  know theirs. "मैं उपलब्ध नहीं था" assumes a man; the RTO reasons are written
  as "घर पर कोई नहीं था" and "मैंने मन बदल लिया" for this reason.
- Same facts as the English. Nothing added, nothing dropped, no new promise.
- A body that names a button uses that button's Hindi text exactly.
- A UTILITY body carries none of: बचत, छूट, ऑफर, डिस्काउंट, गिफ्ट, मुफ़्त, फ्री.
  A test fails the build on each of these.

Run `npm run copy:hi` to regenerate `docs/hindi-copy-review.md`, which is every
Hindi message beside the English it is saying, rendered with sample values.
That file is what to read when judging the copy. Do not edit it; it is generated.

## A phrase that is built in code, not in a registry

If a sentence is assembled in JavaScript and passed to a message as a variable
(", size M", "today at 9:20 PM", "2 hours", "please keep Rs 1,499 ready"), it
does NOT belong in a registry and it must not be a literal at the call site.
Add it to `STR` in `lang.mjs` and pass it as `lazy((l) => str(l, 'yourKey'))`.
The send helper resolves it once it knows the recipient's language.

A lazy value must never be written to DynamoDB. Store the inputs and build the
phrase at send time. `Lazy.toJSON` throws so that getting this wrong is loud
rather than a hole in a message months later.

## The golden snapshot

`golden.snapshot.json` holds every rendered English payload as it stood before
Hindi existed. `golden.test.mjs` asserts it has not moved.

**Do not regenerate it to make a test pass.** The snapshot failing IS the test
working: it means an English payload changed, which is a decision and not a
refactor. Regenerate it only when changing English copy is the deliberate point
of the commit, and say so in the message.
