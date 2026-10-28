# "Owes me" entries (spec, not built)

A way to record that someone owes the owner for things that never went
through a tracked account (cash on a trip, another card), without changing a
transaction's amount. Editing the amount was the habit for CSV rows; a synced
row cannot be edited at all (BANK-SYNC.md), so once an account is linked this
is the only way to record it. A prerequisite for using a linked account the way
CSV accounts were used.

## Above everything

No work in this slice may change what anybody owes the owner or what they have
already paid (CLAUDE.md, Invariants). Recorded settlements stay exactly as
recorded. Adding the feature changes no balance: it adds a kind of entry and
writes no existing row. Any later action that moves a balance (adding,
editing, or deleting an entry; a conversion) shows every affected person's
total before and after, and a conversion is refused unless they are equal.

The ten rows edited after import (CLAUDE.md, and the list of 2026-10-28) are
left exactly as they are. Nothing converts them; the owner may, one at a time.

## The entry

An "owes me" entry is the mirror of the existing external expense ("an expense
they paid", where the owner owes them): a split with no transaction, the owner
as payer, and one share for the person who owes. The balance query already
treats a share like that as a debt owed to the owner (`getDebtShares`:
payer = owner gives direction `incoming`), so balances, FIFO allocation,
credit, netting and share links need no new arithmetic.

- Fields: person, date, description (as external expenses, 120 characters),
  amount in whole cents, optional note, and an optional link to one
  transaction (`splits.related_transaction_id`, nullable, migration). The link
  is context only: never read for an amount, never part of the transaction's
  own split, and a deleted transaction leaves the entry and its link intact.
- The rule that the owner may never be the payer of an external split narrows
  to: the owner may be the payer only with no transaction and exactly one
  share, belonging to a non-owner. Still enforced in the action layer.
- It is not spending: it is not a transaction, so it appears in no Expenses or
  Insights total.
- Credit: like any new incoming share, creating it consumes the person's
  unallocated incoming credit, oldest first. Its FIFO date is its creation
  time, as for external expenses today.

## Where it shows

- People: "Add what Ana owes you" beside the existing "Log expense they
  paid"; each entry in the person's history as "Owes you: description, date,
  amount", with the linked transaction named.
- Expenses: a linked transaction's detail shows "Also owed: <person>
  <amount>" with a link to People. Its amount and split are untouched.
- Share links: an entry is a line in the person's snapshot like any other
  incoming share.

## Converting an edited row (later, by hand, one at a time)

For a row whose amount was raised to fold in what someone owed: restore the
amount it came in with (recovered from its dedup_hash), re-save its split with
the same method and people, and add an "owes me" entry for each person's
difference, in one database transaction. The dialog shows each person's total
owed (and paid, and credit) before and after; the action refuses unless every
total is identical, and the result line repeats both numbers. Settlements are
not edited: the re-saved share frees its allocation, and the new share and
the entry take that credit back, oldest first, so what was paid stays paid.
A row recovered only partly (description changed too, or edited before the
Jul 30 rescale) is not offered.

## Tests

Database tests: an entry adds exactly its amount to the person's balance and
nothing else; it consumes existing credit; deleting one with an allocation
shows the change and returns the amount to credit; a conversion leaves every
person's owed, paid and credit identical to the mill and refuses when it
would not; a settled share stays settled. The structural tests (actions,
auth) cover the new actions as usual.

## Out of scope

Trips (grouping transactions and entries). The conversion tool may follow the
entry itself as a second step.
