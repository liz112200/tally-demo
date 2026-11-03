# Statement cycles

Decided 2026-11-03. Each card closes on its own day of the month, a
different one per account, and the calendar date filter on Expenses lines
up with none of them. The owner wants to know what a card
has run up in its current cycle.

## Decisions

- **Boundaries: the owner sets each account's closing day**, with the date
  it takes effect. A change (one card's cycle moved when its issuer changed)
  is a second entry, never smoothed into the first. The days come from the
  owner's own statements and live only in the database.
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
- **Not chosen: inferring the cycle from verification.** Each account has one
  typed statement period: one data point.
- **Order.** First, and only this until the owner has lived with it for a
  week: "this cycle so far" per account. The period view (dividers in
  Expenses) waits for that.

## This cycle so far

On /accounts, under each account with a closing day, one line: the current
cycle's dates, how long until it closes, and its totals, as the statement
will count them:

- **The bank's rows, by posting date**, as statement verification counts
  them (`verificationRows`): synced rows and the rows set aside at the
  cutover, owner-deleted synced rows included (they are still on the
  statement), bank-removed and released rows not. So the current cycle is
  exact: no CSV row is involved, and the purchase-date caveat below does not
  apply to it.
- Charges, and payments and credits, apart, as the statement prints them;
  pending rows apart again, since a statement counts a row once it posts.
- An account not yet verified shows no total: its signs are not confirmed.
- **In the account's own words** (`cycleLine`). A card shows charges, and
  payments and credits, with its closing date stated. Checking shows
  withdrawals and deposits, never "credits" (which would name a paycheck), and
  its dates are "about" and its close "expected": checking statements often
  close on a nearby business day rather than the day set, so a fixed day of
  the month drifts there in a way it does not on the cards. The owner
  accepted that drift with option B; the line must not present the date as
  more certain than it is. The statement check's own sentences follow the
  same wording (2026-11-03: they said "credits" and "charges" on checking).
- The purchase-date caveat (a CSV that records the purchase date, as Amex
  and Discover do, can put a purchase on the closing day in the wrong
  period) belongs beside any total that includes CSV rows. The current
  cycle never does, and /accounts lists only linked accounts, so this slice
  has no such total; the period view must show the caveat on every period
  that reaches back before a cutover (owner's decision: in the UI, not only
  here).

Cycle arithmetic is pure (lib/statement-cycles.ts): a closing day past the
end of a month closes on its last day (the 31st closes February on the 28th
or 29th); the cycle containing a date runs from the day after the previous
closing to the next closing, inclusive; each closing uses the entry in
effect on that closing date.

## Open, for the period view

If an account picker lists ledger accounts while the source tabs still say
"Amex", the same word means two things on one screen: rows from the Amex
CSV, and everything in the Amex ledger account. Neither control is
confusing alone; together they are. When the period view comes back, decide
between the picker (smaller, leaves that conflict) and replacing the source
tabs with ledger-account tabs (bigger, and also closes PHASE11's "one
Expenses group per ledger account"). Not decided by default.
