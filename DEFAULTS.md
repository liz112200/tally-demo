# Defaults and what the data records

A control that arrives filled in is answered by pressing on. Whether the
owner considered the value or accepted it is usually not stored. That is
acceptable when the value itself is stored and can be checked later. It is
not acceptable when accepting the default destroys information or hides an
omission, because then nothing is left to check (CLAUDE.md).

Swept 2026-11-04, after a held row's "answer" turned out to be a closed
review with nothing stored.

## Recorded

| Choice | Record |
|---|---|
| A held possible duplicate | `sync_skipped_rows.resolution` and `resolved_at`. The boundary review refuses to close while one is unanswered, and a review closed over one before that rule comes back on /accounts. |
| A row an import leaves out | `import_skipped_rows`, with why (duplicate of a live row, of a deleted row, covered by a bank, index collision). Listed under Expenses as "Rows not imported". |
| A bank flag cleared | `bank_flag_resolutions`: the bank's earlier amount or removal date, the row's amount, what was done, and when. Shown on the row as its bank changes. |
| A row excluded from a statement check | `bank_accounts.verification.excluded`. An unticked row cannot pass by default: the totals must match to the cent. |

## Stored, but not whether it was the default

Each value is kept and can be read at any time. The data cannot say whether
it was considered or accepted as offered. Not instrumented, by decision.

- **Ledger account in Set up.** The first free ledger account with CSV
  history is preselected. Choosing a new one takes an extra tick; accepting
  the preselection does not.
- **Cutover date in Set up.** Prefilled with the day after the last CSV row.
  `cutover_confirmed_at` records when, not whether it was edited.
- **"Closing day changed" on a recorded statement.** Unticked saves
  `starts_new_cycle = false`, the same as having checked and found no change.
- **Settlement allocations.** FIFO unless the owner picks shares. The
  allocations are stored; which of the two produced them is not.
- **"I checked every row" on a statement check.** One tick covers every
  listed row. A pass implies it; the list it covered is not stored.

## Not recoverable from before the records existed

Both lists start at migration 0036. They are complete from then on and
silent about everything before it: an empty or short list says nothing about
earlier imports or flags. Do not read either as the whole history.

- Rows skipped by imports confirmed before migration 0036. Every import
  before it may have left rows out; which, and how many, was never stored
  and cannot be reconstructed (the uploaded files are not kept).
- Bank flags cleared before migration 0036, by any path. Such a row now
  reads as never flagged, and its earlier bank amount is gone.
