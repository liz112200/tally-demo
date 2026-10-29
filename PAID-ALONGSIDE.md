# Paid alongside

Recording what the owner paid off-card next to a charge (cash for gas and
food on a trip, another card), split with the same people, without editing
the charge's amount. Editing the amount was the habit for CSV rows; a synced
row cannot be edited at all (BANK-SYNC.md), so once an account is linked this
is the only way to record it. A prerequisite for using a linked account the
way CSV accounts were used. Replaces the earlier "owes me" entry: what the
owner did was spend the money, so it is a purchase, and it counts as spending.

## Above everything

No work in this slice may change what anybody owes the owner or what they
have already paid (CLAUDE.md, Invariants). Recorded settlements stay exactly
as recorded. Adding the feature writes no existing row. A conversion keeps
every person's owed, paid and credit identical to the mill, and the owner's
spending total identical; it is refused otherwise, and shows both numbers.
The ten rows edited after import are left as they are until the owner
converts one, one at a time.

## The purchase

A "paid alongside" purchase is an ordinary manual transaction (it counts as
spending, can be split, appears under Manual on Expenses) with one addition:
`transactions.alongside_transaction_id`, a link to the charge it went with
(migration 0029; CHECK that only a manual row has one). The link is context
only: no amount is read from it.

- Created from a transaction's detail: "Add what you paid alongside this".
  The owner types what it was (required; nothing is guessed) and the amount.
  Date and category default to the charge's; its split defaults to the same
  people and method; all can be changed, as for any manual row.
- The charge's detail lists what was paid alongside it, with amounts. Its own
  amount and split are untouched.
- Deleting either leaves the other as it is.

## Converting an edited row (by hand, one at a time)

Offered only for a row from the edited-rows list whose original amount is
recovered from its dedup_hash with date and description unchanged, whose
split is equal, and whose extra divides evenly in whole cents among its
people. Others are not offered.

The owner types what the extra was. In one database transaction:

1. The row's amount returns to the amount it came in with (which also makes
   its dedup_hash describe it again).
2. A paid-alongside purchase is added: the extra (current amount minus
   original), the owner's description, the row's date and category, split
   equally among the same people.
3. Each person's share of the row drops by exactly their share of the extra.
   The split is adjusted, not re-divided: re-dividing under the whole-cents
   rule would move half a cent between people (a $100.33 charge raised to
   $110.33 and split in two: the shares go $55.165 to $50.165, and the $10.00
   extra is $5.00 each).
4. Where a share was paid, the part of its allocation above the new share
   moves to the person's share of the extra: same settlement, same amount.
   No settlement is written, and what was paid stays paid.

Before anything is written the dialog shows, for every person on the split,
owed, paid and credit before and after, the owner's spending total before
and after, and the Insights effect (month, category, merchant). The action
recomputes all of them inside the transaction and refuses unless every
person's figures and the spending total are identical; the result line
repeats them.

## Tests

Database tests: a paid-alongside purchase counts as spending and splits like
any manual row; a conversion leaves every person's owed, paid and credit and
the spending total identical to the mill, moves allocations without writing a
settlement, restores the row's amount, and refuses a row not offered;
deleting the charge leaves the purchase. Structural tests cover the actions.

## Not built

An "owes me" entry that is not spending: none of the edited rows is that
case, so it waits for one.

## As built (2026-10-29)

Migration 0029 (`transactions.alongside_transaction_id`, CHECK manual
only); `db/alongside.ts` (the insert, the original-amount recovery, the
conversion with its before/after comparison); `app/_actions/alongside.ts`;
the block in a transaction's detail (`app/_components/paid-alongside.tsx`):
the link both ways, "Add what you paid alongside this", and, on a row whose
values no longer match its dedup_hash, "Move the extra into a purchase paid
alongside", which previews every person's share, owed, paid and credit, the
spending total and the month's Insights before anything is written. The
preview is the conversion itself, rolled back. Database tests: exact figures
before and after, a partly paid share, the allocation moved within the same
settlement, refusals (amount as it came in, uneven extra, synced row, no
description).

Found on dev (2026-10-29): after the owner added "Gas $10.00" alongside a
raised row, converting it with the description "Gas" restored the row's
amount and then hit the duplicate; the error was returned inside the
transaction, which committed the amount alone, leaving the shares on the old
amount. Every check now runs before the first write, a refusal after it
throws, an extra already recorded alongside the row is refused by name (it
would be counted twice), a clashing manual row is named with what to do,
Convert stays disabled under a refusal, and a row already at the amount it
came in with says so. Tests cover both sequences and assert nothing is
written.

Found in the re-test (2026-10-29): after deleting the clashing row as the
refusal told them to, the owner was refused again, naming the row they had
deleted. The clash check counted soft-deleted rows. A deleted twin now never
blocks (the new row goes in dedup_exempt, past the index that still holds
the deleted row's hash); a live one is still refused by name. The sweep found
manual entry silently dropping such a row while reporting success, the Set
up dialog's cutover default counting undone imports without saying so, and
verification leaving out synced rows the owner deleted; all three fixed.

