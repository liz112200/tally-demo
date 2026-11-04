# Statement cycles

Decided 2026-11-03. Each card closes on its own day of the month, a
different one per account, and the calendar date filter on Expenses lines
up with none of them. The owner wants to know what a card
has run up in its current cycle.

## Decisions

- **Recorded statements are the truth.** A statement as the bank issued it
  (its closing date, its period's first day when known, and the next closing
  date when it prints one) fixes its cycle exactly. Only the current cycle's
  end is ever projected, because it has not closed yet. Decided 2026-11-03,
  replacing a closing day the owner typed and the app projected every cycle
  from: two of four accounts close on a different day from month to month,
  so that drew every past boundary as a guess while the real dates existed.
- **Where statements come from.** Every passing statement check adds its
  period (it used to keep only the latest check per account; migration 0032
  copied the four recorded then). The owner records one directly, or pastes
  the bank's own list of closing dates; each closing then also bounds the
  next period. A first statement can be short (an account opened mid-cycle),
  so a period's start is never inferred from a single closing.
- **The projection says what it rests on.** The next closing is the day the
  recorded closings share, stated only when at least three agree; when they
  differ it is a range over every closing since the last change of cycle, so
  one later outlier reopens it; with fewer than three it is approximate. The
  number of statements is always shown (owner's condition: "the 11th, from 3
  statements" and "from 12 statements" deserve different trust). How much
  the date is hedged follows the drift recorded for that account, not its
  type.
- **A change of cycle** (an issuer moving the closing day) is marked on the
  first statement after it: closings before it stop counting toward the
  projection, and stay as the record of their own cycles.
- **Declined: Plaid Liabilities as a source or a check.** It reports a
  card's `last_statement_issue_date` and is in the Trial bundle, and Sandbox
  showed it can be called on a login linked for Transactions alone, with no
  update mode (2026-11-03). But the first call permanently adds
  `liabilities` to that login's billed products. On the Trial that is free;
  after an upgrade off the Trial (one-way, CLAUDE.md) each of the three card
  logins would be billed for Liabilities as well as Transactions, at a price
  Plaid does not publish, to confirm a date the owner can read off a
  statement. An irreversible decision with an unknown future cost, bought for
  a problem the owner does not have: the same objection that kept a Vercel
  token and a Neon key out of CI. Do not call `/liabilities/get` on a
  production login without the owner deciding again.
- **Not viable: Plaid Statements.** It supports only depository accounts
  (three of the four are cards), Chase only in early access, Amex and Capital
  One not listed, and it returns PDFs with a month, a year and a posted date,
  no period start or end (Plaid docs, 2026-11-03).
- **Order.** First, and only this until the owner has lived with it for a
  week: "this cycle so far" per account. The period view (dividers in
  Expenses) waits for that.

## This cycle so far

On /accounts, under each account, one line: the current cycle's dates, when
it closes and on what basis, and its totals, as the statement will count
them (`cycleLine`, lib/statement-cycles.ts):

- **Start**: the day after the latest recorded closing, stated. When a
  statement has closed since and is not recorded, the start is projected
  too, marked "about", and the line asks for that statement.
- **End**: a recorded closing, or the next closing date the last statement
  printed, stated as such; else the projection above, with its count.
- **Totals**: the bank's rows by posting date, as statement verification
  counts them (`verificationRows`): synced rows and the rows set aside at
  the cutover, owner-deleted synced rows included (they are still on the
  statement), bank-removed and released rows not. Pending rows apart, since
  a statement counts a row once it posts, and each side of them apart again:
  a pending withdrawal and a pending deposit netted into one figure hid both
  (2026-11-03: $19.99 out and $338.00 in read as "-$318.01 pending"). An account not yet verified shows
  no total: its signs are not confirmed.
- **Words**: charges, and payments and credits, on a card; withdrawals and
  deposits on checking, never "credits", which would name a paycheck. The
  statement check's own sentences follow the same rule (2026-11-03: they
  said "credits" and "charges" on checking).
- The purchase-date caveat (a CSV that records the purchase date, as Amex
  and Discover do, can put a purchase on the closing day in the wrong
  period) belongs beside any total that includes CSV rows. The current
  cycle never does, and /accounts lists only linked accounts, so this slice
  has no such total; the period view must show the caveat on every period
  that reaches back before a cutover (owner's decision: in the UI, not only
  here).

Recording happens under the same line: "Record a statement" (closing date,
period start if printed, next closing date if printed, and whether the
closing day changed with it), or "Paste closing dates", which reads the list
back (dates without a year are their latest occurrence) and records nothing
while any part of it is unreadable. The owner's dates live only in the
database, never in the repository.

## Open, for the period view

Ask the owner again on or after 2026-11-10, after a week of living with the
cycle line, whether the period view is still wanted. If it is, these three
are decided with the owner, not by default:

- **Tabs or picker.** If an account picker lists ledger accounts while the
  source tabs still say "Amex", the same word means two things on one
  screen: rows from the Amex CSV, and everything in the Amex ledger account.
  Neither control is confusing alone; together they are. The choice is
  between the picker (smaller, leaves that conflict) and replacing the
  source tabs with ledger-account tabs (bigger, and also closes PHASE11's
  "one Expenses group per ledger account"). Answer the conflict; do not
  assume the picker is additive.
- **The purchase-date caveat in the UI**, beside every period that reaches
  back before a cutover (above).
- **Rows with no statement stay visible**: manual entries, CSV rows before a
  cutover, rows of an unverified account, pending rows. Each has its place
  (above and in the earlier proposal); none may drop out of a period view
  unremarked.
