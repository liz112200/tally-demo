# The accounts board

Decided 2026-11-04 and 2026-11-05, built 2026-11-05. The screens had grown
by accretion: each slice added a line to an existing row, and the period
view came out as sentences written for /accounts pasted into table rows. The
owner asked for a redesign with the information the app works hardest to
earn visible without reading sentences: where each account is in its cycle,
whether anything disagrees with a statement, what awaits verification, what
holds an unanswered question.

## Pages

- **`/`, Accounts (home).** The Needs you band, then one card per ledger
  account, and a card for each linked account not yet set up. What a
  recruiter on the demo lands on.
- **`/accounts/<ledger account id>`.** One account: its cycle and how the
  close is known, rows to answer (the boundary review), verification, its
  statement periods with their rows, the statements recorded for it, and its
  uploads (Hide, Show, Undo, Restore, rename) with the rows its imports left
  out.
- **`/accounts/logins`, Bank logins.** Linking, Reconnect, Set up, sync
  switches, Manage: what was /accounts, minus the cycle line, statement entry
  and boundary review, which moved to each account's page.
- **`/expenses`.** One list by calendar month, with an account filter. A
  hidden import's rows are named above the table ("12 rows not shown: they
  are in 2 hidden imports · Show them"). An account chosen in the filter
  links to its page.
- **`/settings`.** Categories, rules, the bank's categories, and devices.
- `/accounts`, `/rules` and `/devices` redirect. `/` with any query string
  redirects to `/expenses` with it, since every such link was to Expenses.

## The card and the cycle

- The account's name is the largest thing on the card.
- The close is short ("Oct 22 – closes Nov 21") with **the statement count
  beside it, always** ("5 statements"); the owner's one condition on the
  whole feature, never moved into a hover. A range when the days have varied
  ("closes Nov 12–14"), "about" when fewer than three agree.
- The days left share one slot and one kind of fact: time to close.
- The reasoning sentence ("Every one of the 5 recorded statements closed on
  the 21st, so the day is stated.") is the hover on the card and is always
  shown on the account's page. Whatever is trimmed for space, not that.
- Figures are this cycle so far as the statement counts them (statement
  figures, transfers included), in the account's own words.
- Chips: whether the latest compared statement agrees, questions waiting,
  not verified yet, no statements.
- Cards share grid rows (subgrid), so a name that wraps moves its
  neighbours' rows with it. A grid on a laptop, one column on a phone; no
  horizontal scroll at four accounts.
- Sync times are relative ("synced 5h ago"), computed in the browser and
  updated each minute, with the exact time as the hover: a server-printed
  relative time freezes in an open tab as the timestamp did (2026-11-04).

## The Needs you band

A line earns its place only if it is something the owner can act on and the
data can tell is outstanding. It disappears when the data says it is
resolved; there is no "not now", since a line hidden by hand would be an
omission that looks resolved (DEFAULTS.md). Empty, the band is one line,
"All clear".

- **?** Held rows unanswered, per account.
- **!** A recorded statement whose totals differ from its period's rows; a
  login that needs the owner (as soon as it does); an account whose daily
  sync has not run for 36 hours on a healthy login. A sync that failed on a
  healthy login is not raised: the next daily sync retries it, and Bank
  logins shows it.
- **i** A syncing account not yet checked against a statement.
- **+** A statement closed and not recorded; an account with rows and no
  statement; the latest statement with no totals (the latest only, or every
  statement ever pasted would be a line); split rows the bank changed or
  removed; raised rows still offering Move.

Each line opens with its subject in bold, then the fact, then one action.
The band replaced the stale lines on Expenses (SCHEDULED-SYNC.md). Counts
are not lines.
Past five lines the list scrolls inside the band, under its heading and
count, so the accounts stay in reach; its height is a little under five
rows, so a cut-off row shows there is more.

A point-out rule (below) adds a **+** line for the uncategorized rows it
matches. A reviewed difference or a raised row kept raised (below) is not a
line while its review applies.

### Which lines can get stuck, and what clears them (swept 2026-11-06)

Every kind was checked for an action that clears it. Four could not be
cleared: a correct difference (a purchase placed in another period than the
bank's), a raised row the owner decides to keep, a closed account's
statements, and, suspected, verification of an account that no longer
syncs. The first two take a review, the third a closed date; the fourth was
checked and is not stuck: the statement check compares stored rows and
passes for an account whose sync is off or which the bank stopped sharing,
as long as its stored rows cover a statement period
(db/reviews.dbtest.ts). One that stopped before any full period was stored
has nothing that could match; that is a fact about its rows, not a bug.

## Reviews (migration 0037)

A difference the owner has looked at and accepted, with a note, is a review:
a third state between unresolved and hidden. It is a record, not a
dismissal, under five conditions:

1. It stores the note, the time, and the exact figures it accepted ("$3.00
   less in charges").
2. **It applies only while the difference is still those figures, to the
   cent. When either side moves it lapses, the band raises the difference
   again, and the period says an earlier review no longer applies.** This
   is the condition the whole state rests on, and the reason it exists: we
   ruled out dismissing because a dismissed line looks resolved and records
   nothing, so whatever happens afterwards is accepted unseen. A review
   that survived its figures changing would be exactly that: it would
   accept a number nobody looked at. It is not to be relaxed to a
   tolerance, to "same sign", or to "smaller than before", for convenience
   or otherwise (lib/review.ts, reviewApplies). The review is also refused
   if the figures changed between the page showing them and the owner
   sending it.
3. It stays visible where the difference lives: the period shows the
   difference, the facts and "Reviewed <date>: <note>"; the card's chip
   keeps the difference and adds "reviewed". Only the band line goes.
4. It needs a typed reason, one at a time; nothing prefilled, nothing in
   bulk.
5. It applies only where accepting is a real decision: a statement's
   difference, or a raised row kept raised. Held rows, verification and
   logins already have their answer as the record.

Before the owner reviews, the app states what accounts for the difference,
as facts (lib/difference-explain.ts): a held bank row answered the same
purchase whose posting and CSV twin fall in different periods ("A held bank
row posted Sep 13, answered the same purchase on Nov 4, matches a CSV row
dated Sep 10, in the previous period: $3.00 less here."), and CSV rows
raised after import, with both amounts. It says whether they account for the
whole difference or what they leave. The owner's note goes on top of the
facts, not instead of them: the review is agreeing with evidence, not
composing a justification from memory.

Reviews are append-only (statement_reviews, raised_row_reviews); the latest
for a statement or row is the one read.

## Point-out rules (migration 0037)

A rule's mode is 'apply' (sets the category, as every rule did) or
'point_out': it never writes a category. Every path that categorizes reads
apply-mode rules only (getRules: import, sync, a released held row, Apply to
existing), so a point-out rule cannot write one by any of them
(db/reviews.dbtest.ts). It points out live rows it matches that have no
category, as a band line ("Settling up: 27 rows match your "ZELLE PAYMENT"
rule and have no category.") opening Expenses filtered to them for bulk
categorizing. A row with any category, the owner's or a rule's, is decided
and not pointed out, so the owner's own categories (Dining, Lending on some
Zelle payments) are left alone, and giving a wrongly matched row another
category (a settlement payout as Income) resolves it.

For Zelle on the owner's data (2026-11-06): ZELLE PAYMENT as a substring
matches all 34 Zelle rows; 27 have no category and would be pointed out; one
is a payout, not a person. It does not catch Venmo, Cash App, PayPal, checks
or cash. The rule is the owner's to create, on Settings.

## Closed accounts (migration 0037)

An account that closed is its own fact, recorded once on its page
(ledger_accounts.closed_on): no statement is expected after it, so the band
asks for none, its card says "Closed <date>" in place of a cycle, and its
page says so. A difference on a statement it did issue is still raised.
Clearing the date is for one recorded by mistake.

## The demo

The demo records closing dates by hand for every account, four on one day of
the month, so every card has a cycle. Its band opens with real items: the
held Amex row, Amex's verified statement disagreeing with its CSV rows
(produced by the seed's own rows: the car hire raised after import and the
held purchase's CSV twin, which the bank posted after the close), Chase
checking to verify, and the raised car hire, which converts with Move. A recruiter landing
on "All clear" would see nothing of what the app does; db/demo-bank.dbtest.ts
fails if the demo opens with fewer than three lines.
