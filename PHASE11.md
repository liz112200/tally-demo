# Phase 11 candidates

Deferred work surfaced while building phase 10 (bank sync, BANK-SYNC.md),
captured here so it is neither lost nor built early. PHASE10.md's candidates
roll forward unchanged.

## Surfaced in slice 2

- **Inline edits on synced rows.** Resolved in slice 3: date, amount and
  description of a synced row are the bank's and cannot be edited; note and
  category still can.
- **Plaid's own category is stored, not used.** `provider_raw` keeps
  `personal_finance_category`; the Transfers work may read it as a signal,
  and an LLM-free categorization fallback could later.
- **Identical group headers.** Two Items at one institution show each shared
  account twice, under identical headers. Different logins at one bank
  (personal and business) hold different accounts, whose names and masks
  already differ, so identical headers only arise when the same account is
  linked twice — the Item-budget mistake. Slice 4 warns about that on
  /accounts instead of disambiguating it, and slice 7's ledger accounts
  replace these headers.

## Surfaced in the Transfers slice

- **Plaid's category as a transfer signal.** Synced rows carry
  `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` and `TRANSFER_*` in `provider_raw`.
  Using it needs a third category source beside `rule` and `manual` (the
  retroactive apply re-runs rules over `'rule'` rows and would clear it).
  Decided at slice 7, against real descriptions.
- **No category editing.** Categories can be created but not renamed,
  re-flagged, or deleted in the app; a non-spending category's delete is
  refused by trigger regardless.

## Noticed in production Insights (2026-10-25)

- **Payments to people count as spending.** A person-to-person bank payment
  (Zelle) that settles or pays a share appears in Insights as spending; one
  month in the real ledger carries a single such payment of four figures.
  It is not a transfer between the owner's own accounts, so the Transfers
  category is the wrong fix. The general problem is linking a bank row to a
  settlement (PHASE10.md, "External payment tracking"), larger in the real
  data than assumed.
- **Uncategorized rent.** A large uncategorized bucket comes from rent
  payments with no rule yet. The owner adds the rule; no code change.
- **Demo loses Transfers on reset.** db/demo-reset.ts truncates `categories`
  and reseeds from lib/demo/catalog.ts, which has no Transfers, so the demo
  drops the category daily. Harmless until slice 8's synthetic provider
  produces transfer rows; add it to the catalog then.

## Surfaced in slice 3

- **Credit does not pay down older shares.** When a re-saved split shrinks a
  share, the overpaid part becomes credit that applies to the person's next
  share, not to an older share they still owe (the PHASE10.md credit model).
  The numbers stay right, but a person can show an amount owed and credit at
  once.
- **Re-save moves attribution.** Re-saving a split drops its allocations and
  re-consumes credit oldest first, so which payment covers which share can
  move between payments; per-person totals do not. Preserving the original
  pairing would mean rewriting the save for every split edit.
- **Inline amount edits on CSV rows stay unflagged.** A split row's amount can
  still be edited by hand on CSV and manual rows with only a warning in the
  form; the bank flag covers synced rows. Flagging hand edits the same way is
  possible with the same column.
- **Item splits and a bank amount change.** An item split's shares follow the
  receipt, not the amount, so a split saved after the bank changed the amount
  is not refused; the receipt's total-mismatch warning shows the difference.
- **Displayed shares did not sum to the displayed total.** Resolved
  2026-10-26: $54.07 split three ways stored 18,024 + 18,023 + 18,023 mills,
  each displayed $18.02, so the parts read $54.06, and a person who paid the
  $18.02 they were shown would leave 3 mills outstanding (partial, displaying
  $0.00 owed). Shares now divide in whole cents (18,030 + 18,020 + 18,020).
  Rejected alternative: rounding the parts as a group for display, which
  changes no stored value but can show one share as $18.03 in its split and
  $18.02 in the person's list on /people, and leaves the payment residue.
  Splits saved earlier keep their mills until re-saved.

## Surfaced in slice 4

- **Actions that fail silently.** Resolved in the action-results slice
  (ACTION-RESULTS.md); the convention test found three more than the nine
  below (`setImportHidden`, `showAllImports`, `removeReceipt`). Nine Server
  Actions return nothing and
  their callers ignore the result: `deletePerson`, `hardDeletePerson`,
  `deleteRule`, `deleteSettlement`, `deleteExternalExpense`, `removeSplit`,
  `deleteTransaction`, `bulkDeleteTransactions` and `undoImport`, plus
  Restore on an undone import, which runs on a plain click.
  `ConfirmDialog` closes whatever happened, so a refusal (and slices 3 and 4
  added CHECKs and triggers that refuse legitimately) either does nothing
  visible or reaches the error boundary. On splits and settlements that can
  leave balances other than what the owner believes. Next slice, first:
  a convention in CLAUDE.md (every Server Action returns a result, every
  caller renders it, ConfirmDialog stays open on error) and a helper that
  makes following it the easy path, then applied everywhere.
- **Actions that succeed silently.** Resolved in the same slice. Saving a
  split, an expense you paid, a
  receipt review or a settlement, adding a person, rule or transaction, and
  every delete close a dialog or clear a form and say nothing. Same slice,
  after the above. Saving a rule also gains "Applies to new rows; existing
  rows change when you apply rules": a rule does not touch existing rows,
  and nothing said so.
- **Pages are prerendered.** No page opted out, so on Vercel each is built
  from the build's database and refreshed only by `revalidatePath`. /accounts
  and /people now render per request (consent expiry, today's date).
  Resolved by slice 6: every private page reads the session cookie, so none
  is prerendered from the build's database any more, and slice 5's cron
  needs no revalidation to keep pages current.

## Surfaced in slice 7

- **One Expenses group per ledger account.** Synced groups take the ledger
  account's name, but its CSV batches stay groups of their own. Merging them
  is display only.
- **Renaming a ledger account.** Names are given at the backfill
  (db/ledger-backfill.ts --name); a CSV source first imported later gets a
  default name ("Chase"). There is no rename yet.
- **Amounts with more than three decimals** stop a sync (Sandbox's Tartan
  Bank sends them). If a real institution ever does, it surfaces as that
  account's sync error, never as a rounded amount.

