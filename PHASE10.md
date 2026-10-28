# Phase 10 candidates

Deferred work, captured here so it is neither lost nor built early. Batch B
shipped the bidirectional balance model: `payer_person_id` on splits,
nullable `transaction_id` for external splits, directional settlements, the
`settlement_allocations` junction with FIFO allocation and unallocated-credit
carry-forward, the rewritten /people expanded view, and per-participant share
status on /expenses. Everything below rolls forward.

## New deferrals from batch B

- **Multi-payer external splits.** An external split tracks only what the
  owner owes the payer, with a single owner share. Recording what *other*
  participants owe that external payer (a full third-party split ledger) is
  deferred.
- **Editing an external split.** Amount, description, and date of an external
  split are not editable; delete and re-create instead. (The delete path
  returns any applied settlement credit to its unallocated pool, so
  re-creating is clean.)
- **Credit expiration or manual reversal.** Unallocated settlement credit
  carries forward indefinitely and auto-applies to the next same-direction
  share. There is no way to expire it, refund it, or manually detach an
  allocation from a share.
- **Multi-currency.** All amounts remain single-currency integer cents.
- **Debt simplification.** Three-way netting ("Alex owes you $30, you owe Sam
  $20, Sam owes Alex $10" → one transfer) is not modeled; balances are
  strictly per-person against the owner.
- **External payment tracking.** No Venmo/Zelle/transfer ids or links on
  settlements.
- **Reminders / notifications** for outstanding balances.
- **Restore-from-trash** for anything soft-deleted (transactions, imports,
  persons), and for the hard-deleted external splits and settlements.

## Rolled forward from earlier phases

- All existing deferrals carry over unchanged (PHASE8.md is the latest
  deferrals doc — there is no PHASE9.md): orphan receipts, PDF/HEIC receipts,
  batch upload, receipt gallery, re-extraction of a stored image, OCR-only
  fallback, cross-source merchant normalization, per-item confidence,
  multi-account / Plaid, and the "receipt edited since split saved" hint.
