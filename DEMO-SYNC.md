# Demo bank sync (slice 8)

Proposed and decided 2026-11-02; 8a built the same day. The public demo
shows bank sync working: linked accounts on /accounts and a Sync now that
brings in new rows, all through the real sync code. Before it, the demo
built every bank row from CSV statements and /accounts said linking was not
available.

## What a visitor sees

- /accounts lists two synthetic logins, each with one account, last synced
  at the reset. The institution names carry "(demo)". Amex is verified and
  its boundary review is open with a row held; Chase checking is not yet
  verified (below, Showing the hard part).
- Sync now on Amex brings, one press each: a purchase and a pending dinner
  ("2 new (1 pending)"); the dinner posting with the tip ("1 posted"); a
  refund ("1 new"); the airline re-pricing the split flight ("1 updated, 1
  needs review"); then "no changes". Chase checking brings one purchase.
  Each row is categorized by the rules, else by the bank-category mapping
  (the bistro, which no rule names, is filed under Dining from the bank's
  category), as a real sync would.
- Each account's page shows its synced rows beside the CSV history before
  its cutover, by statement period, as for the owner; every account has
  closing dates recorded by hand, so every card has a cycle
  (ACCOUNTS-BOARD.md).
- Linking, reconnecting and managing a login are not offered: there is no
  real bank behind them, and their actions still refuse in demo mode. Sync
  now, the per-account sync switch, answering a held row, finishing the
  review and the statement check are allowed. "Record as not matching" does
  what it does in production, turning the account's sync off until the
  reset.

## Design

**Provider.** `createSyntheticProvider` implements `BankProvider`
(lib/bank-sync/synthetic/provider.ts). It is pure and deterministic. Each
account's feed comes from the seed for the reset day (rebuilt from the owner
row, db/demo-bank.ts): the seeded delivery, then one delivery per press. The
cursor is `v1:<reset day>:<presses applied>`; `syncTransactions` returns the
next delivery after it. A cursor from another reset day is refused, as Plaid refuses a
foreign cursor. `getItem` reports a healthy login, and `getAccounts` lists
its accounts. Link, update mode and removal throw "not available in the
demo", exactly where the actions already refuse.

**Selection.** lib/bank-sync/select-provider.ts: `chooseProvider` builds
the synthetic provider if and only if in demo mode, and `openStoredToken`
opens a synthetic connection only in demo mode and a Plaid one only outside
it. Tests pin every direction: production never constructs the synthetic
provider or opens a synthetic row, and the demo never constructs Plaid or
unseals a token (it holds no `PLAID_*` variable or `BANK_TOKEN_KEY`, and
the deploy guard refuses one).

**Seeded history through the real planner.** The seed applies each
account's seeded delivery through `splitAtCutover` and `planSync`, over the
CSV rows the commit would read, and writes the result with
`syncedRowValues` and `setAsideValues`, the same mappings the commit uses,
so its rows are the ones a sync writes. Synced rows take their raw row's id,
so seed splits can reference them. Sync now runs the full database path
(`syncAccounts` → `commitAccountSync`), including the lock and the cursor
check: of two presses at once, one applies and the other is refused, either
while the first holds the lock or after it (db/demo-bank.dbtest.ts).

**Cutover.** Each linked source keeps its CSV statements; its ledger
account's cutover is the day after its last CSV row (about nine days before
the reset), and its bank rows from then on are synced. Before this slice
those last days were in no source's ledger, so no existing demo row changed.
The bank's rows before the cutover arrive set aside (`before_cutover`). Chase
checking dates by posting, as its CSV does; Amex sends the purchase date and
posts a day later.

**Verification.** Synced rows of an unverified account count nowhere. The
seed generates a statement for each linked account from its own rows, so
the figures match by construction. Amex is seeded verified against its
statement; Chase checking is left for the visitor. The verify page (today a
404 in the demo) works as in production.

**Tokens.** The demo holds no `BANK_TOKEN_KEY`, and the guard refuses one
there. A synthetic token opens nothing, so there is nothing to seal. See
decision B.

**Schema.** Migration 0030 adds `synthetic` to the `bank_provider` enum. It
is additive and writes no row, but it must also run on production, since the
schema is shared.

**Wording.** "Plaid has sent only the last 30 days" becomes "The bank has
sent…", since the line is shown for any provider.

**Writing it.** db/demo-reset.ts `writeDemoSeed` wipes and writes every
table, now including the ledger and bank tables, after reading the database
marker itself: the demo's, or the test suite's, so the database test can
write the seed. Production carries neither.

**Data.** The feed is invented from the catalog: no real merchant row,
amount or date. The snapshot scan runs over it like everything else.

## Showing the hard part

Proposed and approved 2026-11-02, built in 8a. Sync working smoothly looks like any budgeting
app. What distinguishes this one is the cutover, holding a possible
duplicate across a date lag, verification to the cent, and the rule that the
bank never moves a balance. Each gets something on screen that a visitor
does, produced by the real code from seeded inputs, not by setting a flag.

1. **A held row at the cutover.** One Amex purchase is on the CSV on the day
   before the cutover. The synthetic bank sends it dated two days later with
   no authorized date, as Capital One does. Amex is the rarely used card, so
   this row, the raised car hire and the split flight are scripted rows
   rather than random draws; their amounts are still drawn. The seed's first sync runs
   `splitAtCutover`, which holds it, so the Amex boundary review is open
   with one possible duplicate. The visitor answers it: "Same purchase"
   keeps it out, and "A different purchase" adds it and the totals move.
   The review also shows one same-merchant row of another amount: a car
   hire whose CSV row the owner raised by $38.00 to fold in gas bought with
   Jordan, then split equally with Jordan (its note says so, in Expenses),
   stated in the review as a fact with both amounts and no guessed cause.
   Split equally, it is the one row the visitor can convert with Move:
   the $38.00 becomes a purchase paid alongside, $19.00 each, and no balance
   moves. (Split by amount until 2026-11-06, it was offered Move and always
   refused.)
2. **Verification the visitor runs.** Chase checking is linked and synced
   but not verified, so its synced rows show as not counted and are not
   splittable. The verify page shows the seed's statement for the period,
   with "Use these figures" and "Try it with a typo" (two adjacent digits
   of the charges swapped) to fill the form; typing other figures works too. Matching figures verify the account, and Expenses totals
   change as its rows start counting. Wrong figures show which side differs
   and by how much, and nothing changes.
3. **The bank changes a split row.** The fourth Sync now press re-prices
   the flight split with Jordan (+$35.00, a seat change). The row gets the
   production flag: shares kept, balances unchanged, until the owner
   re-saves or removes the split.
4. **The strip points there.** "Four things to try": "Sync a bank"
   (/accounts), "Check an account against its statement" (the unverified
   account's verify page, looked up per request in demo mode only), "Split a
   dinner", "Simplify balances". "Import a sample statement" left it;
   Discover stays CSV-only and the sample import keeps its button on
   Expenses.
5. **One line of context on /accounts, demo only.** Under each card: "CSV
   history to <date>, bank sync from <date>. Rows that could be either are
   held for you." Production's /accounts is unchanged.

Everything a visitor changes here is shared until the daily reset, like the
rest of the demo.

## Local testing

Settled before building (DEMO.md, Local demo): a local Postgres
(docker-compose.demo-local.yml) and a Blob store of its own, both marked by
`demo:mark` like the real ones. The demo scripts take `DEMO_ENV=local` to
read `.env.demo-local`, and no other file. The demo-mode dev server runs in
a separate worktree, because the main checkout's `.env.local` holds
credentials the guard refuses in demo mode. Nothing touches tally-demo, and
the guard is unchanged. The one thing only the owner can do is create the
empty Blob store and put its token in `.env.demo-local`.

## Decisions taken

A. **Which sources become linked.** Taken: Chase checking and Amex.
   Discover stays CSV-only, so "Import a sample statement" keeps working as
   it does today: a later CSV skips rows a bank already covers, which would
   empty the sample on a linked source. A visitor then sees both ingestion
   paths side by side, which is how the real ledger runs.

B. **Tokens.** Taken, option 1: a synthetic connection stores a fixed, non-secret
   token value (`synthetic:<item id>`) unsealed. The open path skips
   decryption only for provider `synthetic`, and only in demo mode; outside
   demo mode, opening a synthetic connection is refused. Alternative: a
   demo-only `BANK_TOKEN_KEY`, rejected: it would weaken the guard from "no
   key on the demo" to "not production's key", and that class of guard has
   caught a real misconfiguration before. The guard stays absolute.

C. **What Sync now brings.** Taken: new rows and a pending one; the pending
   one posting at another amount; a refund; then (added with item 3 above)
   the bank changing the split flight. All dated today. After that, "no
   changes" until the daily reset or the banner's Reset. The demo is
   shared, so a visitor may arrive after someone else has pressed.

D. **Scope.** Taken: 8a now. Whether 8b follows is decided once 8a is in
   front of the owner. 8b would add a
   synthetic Link (choose an institution with CSV history, confirm the
   cutover, see the boundary review with a held possible duplicate) and a
   login that needs signing in again, fixed through update mode. 8b shows
   the hardest part of the real work, but needs a stand-in for Plaid's Link
   UI.

## Found in the browser check (2026-11-02)

All seven checklist steps passed. Three things worked and showed nothing
wrong, and no test noticed:

- **No way to /accounts.** The demo nav still hid Accounts, under a comment
  saying it would until the synthetic provider landed, while the strip's
  first card sent visitors there. The sweep for demo gating had searched
  for `isDemoMode()` calls; the nav hides through a `demo` prop. The nav is
  now data (lib/nav.ts), and lib/demo/orientation.test.ts fails if the strip
  points at a page the demo nav does not offer (shown failing with Accounts
  hidden again).
- **A dismissed strip could not come back.** The banner now offers "Things
  to try" while it is dismissed, and Reset demo brings it back
  (lib/demo/orientation.ts, tested with working and refusing storage).
- **The cards swapped places after a sync.** Both demo logins had the same
  link time, and the cards ordered by link time alone, so a tie came back in
  whatever order Postgres found the rows. Logins now order by link time,
  then name, then id (and the seed links Amex a quarter hour after Chase);
  imports likewise break ties by id. db/demo-bank.dbtest.ts checks the order
  through a sync, including a forced tie (shown failing without the
  tie-break).

Also added: rules for rent and payroll, whose CSV rows the owner had
categorized by hand, so the synced ones arrived uncategorized (the rules
now file the CSV rows too, as rule rather than manual); and the Transfers
category with a rule for card payments and the savings transfer
(PHASE11.md).

## Tests

- lib/bank-sync/select-provider.test.ts: both directions of provider choice
  and token opening.
- lib/bank-sync/synthetic/provider.test.ts: the cursor, a foreign day's
  cursor and an unknown token refused, nothing linked.
- lib/demo/seed.test.ts: every bank row in exactly one place (set aside
  before the cutover or synced from it), the held row, the raised row's hash
  kept from import, both statements matching their rows, the presses; the
  year sweep checks the held row and the split flight on every third day.
- db/demo-bank.dbtest.ts: the seed written as a reset writes it, then the
  review, the five presses through the real commit, two presses at once,
  the statement check (figures pass, a typo is refused and records
  nothing), and both answers to the held row.

Remaining before release: the browser checklist on the local demo, then
migration 0030 on production with counts either side and the owner's
approval, then the push.
