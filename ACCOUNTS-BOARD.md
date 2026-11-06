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

Not built, waiting on a migration (its own release): a rule the owner can
set to point out rows rather than categorize them, for Zelle payments not
in Settling up.

## The demo

The demo records closing dates by hand for every account, four on one day of
the month, so every card has a cycle. Its band opens with real items: the
held Amex row, Amex's verified statement disagreeing with its CSV rows
(produced by the seed's own rows: the car hire raised after import and the
held purchase's CSV twin, which the bank posted after the close), Chase
checking to verify, and the raised car hire, which converts with Move. A recruiter landing
on "All clear" would see nothing of what the app does; db/demo-bank.dbtest.ts
fails if the demo opens with fewer than three lines.
