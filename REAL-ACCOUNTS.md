# Real accounts (bank sync slice 7)

The owner's own banks syncing: Chase, Capital One (the migrated Discover
card, and the Venture X if chosen) and Amex, three Items of the ten.
BANK-SYNC.md holds the decisions this builds on: ledger accounts and
cutover, sign verification, re-issued account ids, and the worked Discover
example. This file is how the slice is built and run.

## The existing ledger is not touched

The 302 live transactions (6 Amex, 95 Chase, 193 Discover from CSV, 8
manual) survive this slice exactly: not deleted, modified, recategorized,
hidden from totals, or duplicated. That outranks everything else here.

- **Duplication, and why the cutover is required.** A CSV row is identified
  by its content hash, a synced row by its account and Plaid's transaction
  id; the two never match, and the descriptions differ anyway. So without a
  cutover the same purchase would arrive from both sources and count twice
  over the whole overlap (Plaid fetches up to two years). The cutover is
  therefore enforced, not offered:
  - an account can only sync once it is mapped onto a ledger account and
    that ledger account's cutover is confirmed by the owner (the sync and
    the sync toggle both refuse otherwise);
  - the cutover defaults to the day after the ledger account's last CSV row,
    counting rows in undone imports (a later Restore must not bring back a
    CSV row past the cutover), and the owner sees and may change it before
    anything syncs; an earlier date is refused, since it would duplicate; a
    later one is allowed, with a warning that rows between are in neither
    source;
  - synced rows dated before it (in the account's basis) are never inserted
    (kept aside in `sync_skipped_rows`, never counted);
  - the other direction too: a CSV imported later for a ledger account with
    a cutover skips its rows on or after the cutover, in the preview, as
    "covered by bank sync";
  - choosing "a new ledger account" while ledger accounts with CSV history
    and no bank are left asks the owner to confirm this account has no CSV
    history here.
- **What this slice writes to existing rows, plainly:** the ledger-account
  backfill sets `imports.ledger_account_id` on the 15 import rows (batch
  metadata: which account a batch belongs to). No `transactions` row is
  written by the migration, the backfill, the cutover, or the
  verification. Bank sync inserts only rows dated on or after a cutover, and
  only ever updates or removes rows it inserted itself. Rules are applied to
  synced rows as they arrive; the retroactive "Apply to existing" stays a
  button only the owner presses. Expenses' grouping by ledger account is
  display only.
- **Verification, option (a):** enforcement applies only to rows synced
  from a bank (`source = 'plaid'`) on an account not yet verified. CSV and
  manual rows count as they always have.
- **Restore point.** Every production write in this slice (migration 0027,
  the backfill, each first sync) is preceded by printing production's
  `now()`, the timestamp to restore to with Neon's point-in-time restore,
  and the owner confirms the restore window covers it first.

The slice has two halves with a hard line between them.

- **Build (Sandbox only).** Everything below, tested on dev with Sandbox
  Items standing in for real ones, then pushed.
- **Go live (production, irreversible).** One Item at a time, each step
  approved before it runs. Nothing in the build half spends an Item.

## Build

### Ledger accounts (migration 0027)

- `ledger_accounts`: id, display name ("Discover it ••NNNN"), `cutover_date`
  (nullable until a Plaid account maps onto it), `cutover_basis`
  (`posted` | `transaction`, from the account's CSV parser), created_at.
- `imports.ledger_account_id` and `bank_accounts.ledger_account_id`
  (nullable, FK). Manual entries belong to no ledger account.
- **Backfill.** Production's CSV imports are mapped onto ledger accounts by
  a one-time script that previews the mapping (import, source, row count,
  proposed ledger account) and applies only on approval, with counts before
  and after. The proposed mapping is one ledger account per source and
  account label seen in the imports; the owner names them.
- Expenses names a synced account's group after its ledger account. CSV
  batches stay groups of their own; merging the two into one group per
  ledger account is display only and deferred (PHASE11.md).
- Plaid accounts that synced before this slice each got a ledger account of
  their own with no CSV history (migration 0027); ones that never synced are
  set up like new ones.

### Linking an account onto a ledger account

When an account is turned on to sync, the owner chooses: a new ledger
account (no CSV history, so no cutover: its synced history starts at the
beginning), or an existing one (its CSV history), whose cutover defaults
to the day after its last CSV row, shown and editable, and confirmed before
sync turns on (see above). Only ledger accounts not in use are offered (and
accepted): one with CSV history and no bank, or one whose bank accounts have
all stopped, unshared or on a removed login. A ledger account takes one syncing Plaid account
at a time. The mapping and cutover can be changed until the account's first
sync; after it they are fixed in the app (changing them would mean removing
synced rows, which this slice never does).

### Cutover and the boundary review

- The planner skips synced rows dated before the cutover. Skipped rows are
  kept in `sync_skipped_rows` (account, provider id, posted date, amount,
  description), never counted and never shown in Expenses, for two reads:
  the verification view (a statement period can lie before the cutover)
  and the boundary review.
- **Boundary review.** After an account's first sync, /accounts lists the
  skipped rows from the seven days before its cutover beside the ledger's
  CSV rows from those days, once, read-only. A purchase pending when the CSV
  was exported is in neither source; this is where the owner sees it, and
  adds it by hand if it is real.
- **Held rows match on merchant too.** A bank row in the first week is held
  when a CSV row within three days has its amount or its merchant (the first
  word of the normalized description past wallet and processor prefixes such
  as APLPAY and TST*, one key a prefix of the other, since the bank runs the
  city on). The amount alone missed real cases: the owner edits CSV amounts
  on purpose, and a hold can settle at another amount. Holding too much
  costs an answer; holding too little counts a purchase twice. The review
  states a same-merchant difference as a fact, both amounts, no cause
  (found on the first real card, 2026-10-28: a CSV row the owner had
  raised on purpose, which a guessed cause would have called a hold).
- **Dates on the account's basis.** For Chase checking the cutover, the
  boundary review and the held-row match all use the posting date, the date
  its CSV rows carry; a purchase date can be days earlier (up to eight on
  the first sync, 2026-10-29). The cutover itself was always judged on the
  posting date (all 731 rows set aside had posted by Sep 10, and none posted
  later was set aside); the review showed the purchase date and the match
  compared it, both now on the basis.
- A new login's history arrives in two parts: Plaid sends the last 30 days
  first and the rest later, so the first sync may see none of the days
  around the cutover. The sync line says when only the first 30 days have
  arrived, and a row held on a later sync reopens a closed boundary review,
  so it is answered rather than left out unseen.

### Sign verification (enforced)

- `bank_accounts.verified_at` (null until verified), with the statement
  period and the figures compared. Applies in every environment, so Sandbox
  accounts go through the same flow on dev before any real one.
- **Unverified rows do not count:** not splittable (the split save refuses,
  like a pending row), left out of Insights and the Expenses summary, and
  marked "awaiting verification" on /accounts and on the Expenses group.
- **The verification view** (per account): the owner enters the statement's
  period, its purchases + fees + interest, and its payments + credits. The
  app sums the fetched rows (inserted and skipped) by posted `date` over that
  period and compares both totals to the cent; it lists every negative row
  (payments, credits, refunds) and the five largest positive ones with their
  signs, for the owner to tick against the statement. Pass needs both totals
  equal, after any rows the owner marks as pending at statement close (each
  listed with its amount), and the owner's confirmation. Fail turns sync off
  for the account; the sign mapping is fixed in the provider, never
  downstream.

### Re-issued account ids (BANK-SYNC.md, blocking)

- **Adopt.** A re-issued account (same persistent id, or, where there is
  none, an account added in the same reload that marked another of the same
  type and mask unshared) is offered as "the same account under a new id".
  Adopting points the new Plaid account at the same ledger account with a
  cutover the day after the old account's last synced row; the old account
  stays, unshared, with its rows. No new Item.
- **Refusal.** Sync cannot be turned on for a candidate twin of an unshared
  account in the same login until it is adopted, or the owner says it is a
  different account.

## Go live (each step approved)

1. **Owner:** production `BANK_TOKEN_KEY` (in the password manager first),
   `PLAID_CLIENT_ID`, `PLAID_SECRET` (production) and `PLAID_ENV=production`
   on the production environment only; the production OAuth redirect URI in
   the Plaid dashboard. Never through an AI session.
2. **Migration 0027 and the ledger-account backfill** on production, with
   the mapping and counts shown first.
3. **First Item**, on the desktop (Link's popup; the OAuth redirect page has
   never run live): the link confirmation states the cost; choose accounts;
   map each onto its ledger account.
4. **First sync**, then the boundary review, then verification against a
   statement, per account. Only a verified account's rows count.
5. The next Item, from step 3.

## Failure paths

- The first sync of a long history runs past the 240 s fetch budget. Sync
  fetches an account's pages and then commits them, so an account that
  passes the budget saves nothing from that run and the next run starts
  from the same point; it cannot resume part-way (BANK-SYNC.md: named, not
  designed for). At these volumes it should not happen: two years is about
  1,600 Discover rows, 800 Chase, fewer Amex, a few pages each, seconds to
  fetch. Accounts sync one after another, each with its own cursor, so
  accounts that finished keep their progress. The result line says exactly
  this when it happens, instead of reading as a failure.
- An institution's OAuth flow fails in the popup: nothing is exchanged and
  no Item is created; the owner retries.
- Verification fails: sync off for that account, rows uncounted, the
  mapping fixed in code and the check rerun; no row is edited by hand.
- A wrong mapping onto a ledger account: before its first sync it can be
  changed with Change… on the account (the same dialog, which also corrects
  the cutover), and a ledger account the mistaken choice created, with no
  CSV history, is dropped; after, it is fixed in the app, and correcting it
  is a separate, approved step (it would remove synced rows; never CSV
  rows).

## As built, and what was seen

- **In a browser,** 2026-10-28, on dev with a Sandbox login: Set up offered
  only the synthetic Chase ledger account and a new one, defaulted the
  cutover to the day after its last CSV row and refused an earlier date;
  Sync now inserted only rows on or after it; the account then showed its
  ledger account and cutover, "awaiting verification", and the boundary
  review; the verification page compared to the cent and would not record a
  mismatch; Expenses named the group after the ledger account and left its
  rows out of the summary. The first run found the picker listing every
  ledger account the migration had created (63 on dev, loans included); the
  migration now creates them only for accounts that synced, and the picker
  offers only ledger accounts not in use.
- **Sandbox data that stops a sync:** Tartan Bank's dynamic test user sent
  an amount with five decimals (162.69058). Sync refuses any amount it
  cannot store exactly in mills, rather than rounding, so that account stops
  with a message; real banks send two decimals.
- **Dev rows now uncounted:** every Sandbox account on dev synced before
  verification existed, so their rows count again only once verified.
- **Not seen yet:** a held possible duplicate on real data, adopting a real
  re-issued account, and a real statement check. The database tests cover
  them with constructed rows.

## Tests

- Unit: cutover filtering by basis, the verification comparison (totals to
  the cent, exceptions, signs), the twin-candidate rule.
- Database: the ledger-account backfill on a copy of the import shapes;
  unverified rows refused for splits and absent from totals; adopt keeps
  every ledger row and cursor consistent; the twin refusal; skipped rows
  never counted.
- Sandbox on dev: a Sandbox login mapped onto a synthetic CSV ledger account
  (the seeded synthetic Chase import), cutover, boundary review, and
  verification with figures from the Sandbox data.
