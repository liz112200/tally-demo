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

## The period view (decided and built 2026-11-03)

The owner asked for it the day "this cycle so far" shipped: the cycle line
gives one number per card, and what they wanted was to see where one
statement ends and the next begins while reading the list.

### Tabs: one per ledger account (option Y, the owner's choice)

The source tabs (All, Chase, Discover, Amex, Linked, Manual) date from CSV
imports: "Amex" means rows from the Amex CSV. Since linking, one card's
history is split across two tabs (Amex's rows before the cutover under
Amex, after it under Linked), and Venture X, with no CSV, appears only under
Linked. No source tab can show a statement period that spans a cutover. A
ledger-account picker beside them would put the same word on two controls
meaning different things, and two controls filtering one axis can combine to
nothing (the Amex CSV tab with Venture X picked).

So the tabs become: **All · one tab per ledger account · Manual**. Linked
and the source tabs go. A ledger tab holds every row of that account, CSV
and synced, grouped by statement period. All keeps today's grouping (manual
entries, each linked account, each CSV upload), because Undo import, Restore,
rename and hide live on upload headers. This closes PHASE11's "one Expenses
group per ledger account". Old links with `?source=` open the matching
ledger tab, or All.

### Periods within a ledger tab

- **Boundaries** come from the recorded statements; a row belongs to the
  period its statement counts it in: the posting date for synced rows,
  which is what the statement uses. A row bought on the closing day and
  posted the next day therefore sits in the next period, with its purchase
  date showing; the period header says so when it holds one.
- **Headers** replace the single date range: the newest is the current
  cycle, worded as on /accounts (its close and what that rests on); past
  periods read "Statement Sep 12 – Oct 11 · 41 rows · charges, credits" and
  are collapsed; the current one is open. In All, each linked account's
  header names its current cycle instead of one long range.
- **Totals** in a header are the rows listed, counted as a statement counts
  them: posted rows of every category, card payments and other transfers
  included, with pending rows and purchases paid alongside left out and
  named. The owner first chose "as the Expenses summary counts them"; that
  leaves transfers out, and a statement counts a card payment as a credit,
  so no period could ever match its statement, which the comparison below
  needs. The Expenses spending and credit totals stay in the summary strip.
  The header labels its figures "statement figures" (with a tooltip saying
  transfers are in them), so a period's charges, which include card
  payments, are not read against Insights and taken for an error.
  Rows of an unverified account are in a period's totals (they are on the
  statement) and named, as not yet in spending.
- **The statement beside its rows.** Where a recorded statement carries its
  totals (every statement check records them; one recorded by hand may),
  the header states both: "the statement says $X and $Y: matches", or, per
  side that differs, the statement's figure, the rows' and the difference.
  Never an error: a difference is an amount edited on purpose, a row
  deleted, or a row missing, and the owner wants to see which.
- **CSV rows carry no posting date** (Amex, Discover), so they can only be
  placed by their own date, the purchase date: the same limitation as the
  caveat below, not a second rule. Chase's CSV records the posting date.
- **Collapsed by default.** All opens with every group closed; an
  account's tab with only its current period open. With a search or filter
  active every group opens, so a match is never hidden behind a header (the
  demo strip's "Split a dinner" opens a search). Tabs show names only: a
  figure per tab would be noise, and /accounts has it.

### The purchase-date caveat, in the UI

Every period holding CSV rows from a CSV that records the purchase date
(Amex, Discover; Chase's records the posting date) says beside its total
that a purchase near the closing day may belong to the neighbouring
statement.

### Rows with no statement never drop out

- Rows before the earliest recorded statement form one group, "Before the
  recorded statements", by date, with no boundaries invented.
- Rows after the latest closing are the current cycle, its start marked
  "about" when a statement is missing.
- Pending rows stay in the current cycle, marked, out of its total, counted
  in its header.
- Rows of an unverified account stay in their period, marked not counted,
  out of its total.
- Manual entries belong to no account: the Manual and All tabs, as now. A
  purchase paid alongside a card row (PAID-ALONGSIDE.md) is shown under that
  row's period too, marked as manual and left out of the period's total
  (it is not on the statement), so it does not vanish from the account it
  was paid beside.
- Every ledger tab's period counts add up to its row count, tested.
