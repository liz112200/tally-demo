# Phase 5 candidates

Out of scope for phase 4, captured here so they are neither lost nor built
early.

- **Item-level splits (receipts).** The core of phase 5: receipt upload to
  Vercel Blob, LLM line-item extraction, and per-item participant
  assignment. Requires extending the `split_method` enum with `'item'` (an
  `ALTER TYPE ... ADD VALUE` migration) and an item table; `tax_cents` /
  `tip_cents` already exist on splits and already divide equally per the
  locked invariant.
- **Zelle → Settlement auto-mapping.** The Chase export's "Zelle payment
  from <person>" rows land as ordinary negative transactions. Candidate:
  auto-propose a settlement (matched by name) instead of a ledger row.
  Carried over from PHASE3.md.
- **Transfers as a non-splittable category.** Card-to-card payments
  (`DISCOVER E-PAYMENT`), fee payments, and "Zelle payment to <person>"
  rows import as positive uncategorized spending, so they currently show
  the split affordance. A seeded "Transfers" category with
  `is_splittable=false` plus rules for the obvious patterns would mute
  them like Rent/Income.
- **Multi-currency.** Cents are USD-only; the foreign-currency fixture row imports at its
  USD-settled amount, which is correct for v1.
- **Debt simplification (min-transactions).** Meaningless until there are
  multiple payers; balances are all owed to the owner in v1.
- **Reminders / notifications.**
- **Sharing balances externally / export.**
- **Recurring split templates.** "Split like last time" currently exists
  only as the editor defaulting to the most recent split's participants.
- **Bulk edits across past splits.** Editing one person's contribution
  across many splits at once (e.g. after a rename or a standing-agreement
  change) is out; edits are per-split full overwrites.

Surfaced while building phase 4:

- **Settlements for deleted persons.** The add-settlement form also shows
  for a soft-deleted person while their balance is nonzero, so outstanding
  money can still be received and zeroed. Once their balance hits zero
  they disappear from /balances entirely.
- **Editing a split that includes a deleted person drops their share.**
  The editor's participant list only offers active persons, and saving is
  a full overwrite, so re-saving an old split silently sheds the deleted
  participant. Acceptable for v1; worth a warning banner if it ever bites.
- **Percent inputs are whole integers.** Locked so percent share math
  stays off the float path. 33.3/33.3/33.4 is not expressible; use
  by-amount for that.
- **Settlement dates trust the client default.** The form defaults to the
  server's UTC "today", which can be off by one near midnight for a
  US-timezone user. Cosmetic; the date is editable.
- **Cash withdrawals are splittable.** `WITHDRAWAL` rows are positive
  spending and uncategorized, so they show the split affordance. This is
  by design (cash spending can be shared); categorize them under a
  non-splittable category to hide them.
