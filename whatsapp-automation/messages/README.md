# Editing customer copy

Every word a customer sees lives in this folder. Code never contains copy; it
references a message key. Files:

- `templates.mjs` — Meta-approved templates (business-initiated messages). Copy + buttons.
- `session.mjs` — free-form messages, sent only inside an open 24h window. May carry offers/codes.
- `labels.mjs` — button labels, RTO reasons, courier status wording, fixed strings.
- `rules.mjs` — every number and timing. Change a figure here, nowhere else.
- `flows/review.flow.json` — the in-WhatsApp review form.

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
