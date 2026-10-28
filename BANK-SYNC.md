# Bank sync (phase 10)

Linked bank accounts replace CSV upload as the main ingestion path. CSV
import stays as a fallback and as the record of everything before each
account's cutover. Decided 2026-10-19; this file is the spec. Deferrals
surfaced while building go to PHASE11.md, as before.

## Decisions

- **Provider: Plaid, Trial plan.** Free; 10 production Items for the life of
  the account (an Item is one bank login, possibly several accounts); Chase,
  Amex and most OAuth institutions available without registration. Removing
  an Item does not return its slot, and upgrading off the Trial is one-way.
  The budget is a hard invariant in CLAUDE.md, not a convention.
- **Behind our own interface.** `BankProvider` (lib/bank-sync/provider.ts)
  is the only thing the sync engine knows. Plaid is one implementation; the
  demo's synthetic provider is the second, so every demo row goes through
  the real sync code. Methods are added per slice as needed, never ahead.
- **Plain `fetch`, no Plaid server SDK.** A thin typed client for the
  endpoints we call, responses validated by Zod. The SDK's axios layer parses
  JSON into floats before we can see it, and we need the raw numeric text
  (below). Plaid Link in the browser uses `react-plaid-link`.
- **Amounts never become floats.** Responses are parsed with a
  `JSON.parse` reviver that reads `context.source`, so `amount` reaches us
  as the literal decimal text and converts to mills by integer parsing (at
  most three decimals, otherwise the sync halts). Verified on Node 24.22
  locally (2026-10-19) and inside a Vercel function on Node 24.21 (throwaway
  project, 2026-10-22, deleted afterwards): every number came back as its
  source text. If a runtime ever lacks `context.source`, parsing throws; it
  never falls back to floats.
- **Sign.** Plaid's `amount` is positive for money leaving the account, which
  matches the canonical sign (spending positive). Verified against Sandbox
  fixtures in slice 2 (purchase, refund, card payment), not assumed.
- **Currency.** A row whose `iso_currency_code` is not USD, or that carries
  `unofficial_currency_code`, halts that connection's sync with a visible
  error. It is never dropped silently and never converted.
- **Identity.** A synced row is identified by `(bank_account_id,
  provider_transaction_id)`, unique. It carries no `dedup_hash`: provider
  rows are mutable, and a content hash of mutable data is wrong the first
  time Plaid modifies one. `dedup_hash` becomes nullable with a CHECK that
  every row has exactly one identity (hash for CSV/manual, provider id for
  synced). The partial unique index on the hash is unchanged.
- **Source.** `transaction_source` gains `plaid`: source records how a row
  arrived. The bank is known through the row's account.
- **Accounts are opt-in.** A login returns every account at the institution
  (the Sandbox one returns 14, mortgage and 401k included). Each
  `bank_accounts` row carries `sync_enabled`, off by default; only depository
  and credit accounts can be enabled. Nothing syncs until the owner chooses.
  CSV import was selective because the owner chose which file to export;
  linking is not, so selection moves here.
- **Cursors are per account.** Plaid's `/transactions/sync` accepts an
  `account_id` with its own cursor. A per-Item cursor would advance past rows
  of disabled accounts, so enabling one later could never recover its
  history. With per-account cursors a disabled account is never fetched,
  enabling it starts its full history, and disabling it keeps its rows and
  cursor so it can resume. `sync_cursor`, `last_synced_at` and
  `last_sync_error` live on `bank_accounts`.
- **Description and rules.** Requests set `include_original_description`;
  `description_raw` is Plaid's `original_description` (the bank string the
  existing rules were tuned on), falling back to `name`. `merchant_normalized`
  and rules run exactly as for CSV. Plaid's own category is stored in the raw
  payload and not used in this phase.
- **Date.** `transactions.date` is `authorized_date ?? date`: when the
  purchase happened, which is what a split is remembered by and what the
  Discover and Amex parsers already use. (The Chase checking parser uses
  Posting Date; that history is not rewritten.)
- **Pending rows are never splittable.** Tips land after authorization, so a
  pending restaurant charge is wrong in exactly the case most often split.
  Pending rows are visible, read-only for splitting and receipts (the
  server-side `isSplittable` gate gains `pending = false`), and can carry a
  note or a category. They are provisional, so they are left out of Insights
  and of the Expenses summary totals (which count them separately); the
  posted row is the one that counts.
- **Sync never changes a balance.** It never writes `splits`,
  `split_shares`, `settlements` or `settlement_allocations`, and never
  deletes a row the owner has built on (a split, a receipt, a note or a
  manual category). Where the bank's change touches such a row, sync updates
  the row and sets a flag; anything that moves money between people happens
  only when the owner resolves the flag, after seeing the effect per person.
  Split safety therefore bites on posted rows only: a split row the bank
  modifies, a split row the bank removes (or removes and re-adds under a new
  id), and a split saved while a sync changes the same row.
- **Posted takes over pending in place.** A posted row whose
  `pending_transaction_id` matches a stored pending row of the same account
  updates that row: new provider id, amount, date, description,
  `pending = false`. Notes, manual categories and the row id survive. Since
  pending rows cannot be split, no split ever sees this drift. Plaid does not
  guarantee the posted row and the pending row's removal arrive together, so
  a pending row the bank already removed is revived by its takeover; a
  pending row the owner deleted takes the new id and stays deleted. If the
  posted id is already stored, there is no takeover and a still-live pending
  row is removed as the bank's.
- **Modified posted rows.** Amount, date and description are applied;
  `merchant_normalized` is recomputed; rules re-run when the description
  changed, unless the category is `manual`. If the
  amount changed and a split exists, the stored shares are kept, never
  rescaled, and `bank_amount_before_cents` records the amount the split was
  built on (the first one, if the bank changes it again; cleared if the
  amount returns to it). Re-saving or removing the split, or dismissing the
  flag, clears it. Until then shares may not sum to `abs(amount)` — a second
  sanctioned, transient relaxation of the sum invariant, visible on the row.
  A stored posted row reported as pending again stops the sync: Plaid does
  not do that, so it means a bug or a provider change.
- **Removed rows.** A removed pending row (a hold that never posted) is
  soft-deleted. A removed posted row the owner has not built on is
  soft-deleted too: a charge the bank says does not exist should not keep
  counting as spending. A removed posted row the owner has built on is never
  deleted by sync: `removed_by_bank_at` flags it and it stays live. Sync's
  soft-deletes set `removed_by_bank_at` as well, which is how a takeover
  tells the bank's removal from the owner's.
- **Remove and re-add.** Within one sync, a removed posted row and an added
  posted row in the same account with equal amount, date and description,
  exactly one on each side, are one transaction changing id: the stored row
  takes the new id in place, keeping everything built on it. With more than
  one candidate on either side nothing is paired. A wrong pairing is
  harmless: the two rows are identical and the ledger ends with one either
  way.
- **Resolving a flag.** Dismiss changes nothing. "Move split to" re-points
  the split and receipt (`transaction_id`) onto the re-added row, so shares
  and settlement allocations are untouched, carries the note and a manual
  category over where the re-added row has none, and deletes the old row as
  the owner; candidates are live posted rows in the same account with the
  same amount, dated within 7 days, with no split or receipt. Re-saving the split is the ordinary full overwrite: the
  old allocations drop, the freed amount becomes each person's credit, and
  the new shares consume it at once (oldest credit first, so attribution may
  move between payments; per-person totals do not). Removing the split or
  deleting the row makes its allocations ineffective, returning them to
  credit, as for any deleted row.
- **A split row stays splittable.** No rule, retroactive apply or manual
  edit moves a row with a split into a category that is not splittable
  (Transfers, Rent, Income): the split would keep counting in balances on a
  row the app says cannot be split. A rule leaves such a row as it is; a
  manual edit is refused with a message to remove the split first.
- **Synced rows are the bank's.** Date, amount and description of a synced
  row cannot be edited (refused in the Server Action); its note and category
  can. A user edit and a bank modification can therefore never disagree.
- **Split saves check the row under a lock.** Saving a split locks the
  transaction row (`FOR UPDATE`) and refuses unless it is live, posted, and
  still has the amount the shares were computed from. Sync locks every row
  it may change (ordered by id) before it reads whether they have a split,
  receipt or note, and reads that in a separate statement, so it sees a
  split committed while it waited. Whichever commits first, the other sees
  it: a split saved first gets the flag; a save after the sync refuses.
- **Rows outside our window.** `added`, `modified` and `removed` entries for
  rows before the account's cutover, or for ids we never ingested, are
  ignored.
- **Sync is fetch-then-commit, per account.** For each enabled account, all
  pages are fetched first (restarting from the saved cursor on
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, at most three times). Then
  one database transaction takes `pg_try_advisory_xact_lock` on the
  connection (the Item), checks that the account's stored cursor still equals
  the one the fetch started from, applies every row, and writes the new
  cursor. No network call happens inside the transaction. A concurrent run
  either fails the lock or fails the cursor check and becomes a no-op; a
  crash before commit leaves the old cursor, and the next run re-fetches.
  Transaction-scoped locks are required: Neon's pooled endpoint does not keep
  session locks.
- **It fits one function call.** Hobby's function limit is 300 s, both the
  default and the maximum (Pro: 800 s; Vercel docs, 2026-08-24); the sync
  runs with `maxDuration = 300`. Extrapolated from the CSV ledger (Discover
  about 65 rows a month, Chase about 32), two years across three accounts is
  about 2,500 rows: five pages of 500, a few MB, well under a minute. The
  failure mode is named rather than designed for: under fetch-then-commit an
  account too large to fetch in one call could never make progress, because
  each attempt restarts from the same cursor. So each fetch is timed and
  logged, and one that passes a budget stops with an error instead of a
  silent timeout. Committing page by page becomes safe only once slice 3
  applies `modified` and `removed`; it is not needed at these volumes.
- **The planner is pure.** `planSync(existing, pages, cutover)` in
  lib/bank-sync/ returns the inserts, takeovers, updates, flags and
  soft-deletes; the action only does IO. Tested in isolation like
  lib/import-dedup.ts.
- **Database tests.** What the planner cannot show — rollback, lock order,
  races between a sync and a split save, balances unchanged across a sync —
  is tested against a real Postgres: `npm run test:db` starts Postgres 17
  (Neon's major version) behind PgBouncer in transaction mode, as Neon's
  pooled endpoint runs, from docker-compose.test.yml, applies the migrations
  to the empty database and runs db/**/*.dbtest.ts. The suite refuses any
  database without the `tally-test` comment it writes itself. CI runs the
  same containers on every push. Neon branches were rejected for this: a key
  that can branch inside the production project can read production data.
  What Sandbox can and cannot produce, tested 2026-10-25 and 2026-10-26
  with `user_transactions_dynamic`, and what the tests therefore stand on:
  - *Pending to posted:* real. Posted rows taking over pending ones were
    seen 49 times across four refresh rounds, and a recorded sequence
    (tests/fixtures/plaid/sandbox-dynamic.json) replays them unaltered.
  - *A `modified` posted row that changes only its date:* real, and the
    harmless case. When the first sync lands before Plaid has every
    authorized date, a later round re-sends those rows as `modified` with
    `authorized_date` filled in. In one live run on dev it moved 48 rows'
    date by a day; that run was not recorded. The recorded sequence
    (tests/fixtures/plaid/sandbox-modified.json) is a `modified` entry for a
    split, settled row whose filled-in date equals its posted date, so
    nothing the ledger stores changes; the test shows that writes nothing
    and moves no balance. No amount moves and no flag is set in either.
    The recorded entry is therefore a no-op: nothing in the suite replays
    Plaid changing a value the ledger stores. The run that moved 48 dates
    was real, on dev, and is not recorded.
  - *A changed amount, or a removed posted row:* never produced by Sandbox,
    and these are the two that threaten a split. Custom users are fixed at
    Item creation and `/sandbox/transactions/create` only adds. Their tests
    take a real recorded row and rewrite it into `modified` (new amount) or
    `removed`, replayed through the real Plaid client: Plaid's choice to
    send it, and its shape for these cases, are the test's assumption, not
    something observed. The first real occurrence will be on a real account;
    what makes that safe is structural (sync only updates and flags), not
    that this path has been seen against Plaid.
  - *How far the first probe reached:* it synced only after Plaid reported
    the history complete, then refreshed four times, and saw no `modified`
    entry at all. That was definitive about that procedure, not about
    Sandbox: the date-only modification above appears only when the first
    sync comes earlier. A negative result from one way of driving Sandbox
    says nothing about another.
- **Staleness is visible.** Each account stores `last_synced_at` and
  `last_sync_error` (the connection stores Plaid's Item status, slice 4);
  /accounts and the Expenses group headers show "last synced" per account
  and any error.
- **Scheduling.** A daily Vercel Cron (Hobby: once a day, up to 59 minutes
  of jitter) plus "Sync now". Webhooks are deferred: the app sits behind
  Vercel Authentication, so Plaid's calls would need the protection-bypass
  secret embedded in a URL stored at Plaid, and Plaid refreshes only one to
  four times a day anyway.
- **Ledger accounts, not institutions.** A physical account outlives its
  institution's identity: a Discover card now served by Capital One has CSV
  history labelled Discover and synced rows labelled Capital One. So slice 7
  adds `ledger_accounts`, the account as the owner knows it (a display name),
  and both data sources point at one: CSV import batches
  (`imports.ledger_account_id`) and Plaid accounts
  (`bank_accounts.ledger_account_id`). Expenses grouping and the cutover key
  on the ledger account; institution id and name are descriptive metadata on
  the Plaid account, refreshed on every sync and never used as a key. A
  replacement Item after an institution migration maps its new Plaid account
  onto the existing ledger account. Worked example below.
- **Cutover, no reconciliation.** Each ledger account has a `cutover_date`:
  the day after its last CSV row (or, for a replacement Item, the day after
  the old Plaid account's last synced row). Synced rows before it are
  ignored; CSV history and its splits, receipts and settlements are
  untouched. The comparison uses the date basis of the account's CSV parser
  (posted for Chase checking, transaction date for Discover and Amex), stored
  as `cutover_basis` on the ledger account. Boundary hazard: a purchase on
  the last CSV day that was still pending when the CSV was exported is in
  neither source. The first sync of each account therefore lists rows from
  the seven days before cutover that it skipped, as a one-time review list
  (read-only, not reconciliation).
- **Access tokens are encrypted at rest.** AES-256-GCM via node:crypto, key
  from `BANK_TOKEN_KEY` (32 random bytes, base64), the Plaid `item_id` as
  associated data so a token cannot be swapped between rows. Stored as
  `v1:<iv>:<tag>:<ciphertext>`; the version prefix allows key rotation.
  A database leak (backup, branch, misconfigured demo) holds no usable
  tokens.
- **Connections are never hard-deleted.** The rows double as the ledger of
  Items spent; /accounts shows "Items used N of 10" in production. A
  connection is `active`, `paused` or `removed` (slice 4, below). Removal is
  a deliberate disconnect, never a repair; a new Item is legitimate only
  when an institution migration retires the old one.

## Item health (slice 4)

- **Status.** Migration 0024 gives `bank_connections` a `status` (`active`,
  `paused`, `removed`). A CHECK ties `removed` to `removed_at` being set and
  the token being erased (`access_token_sealed` is nullable for that alone).
  `bank_accounts.unshared_at` marks an account the bank stopped sharing, and
  a CHECK keeps such an account from syncing. Turning sync on for an account
  of a removed login is refused in the query, under the connection's lock,
  since no CHECK can see the connection.
- **Health is read on every sync.** Each sync starts with one `/item/get`
  and stores the error code, consent expiry and check time
  (`item_error_code`, `consent_expires_at`, `health_checked_at`). A login in
  error is not fetched at all. A login-wide error that arrives during a sync
  (an Item or institution error the classifier knows) is recorded on the
  connection and stops the remaining accounts; any other error stays with its
  account. If the health cannot be read (a timeout, an outage at Plaid), the
  stored health is left as it was.
- **The classifier** (lib/bank-sync/item-health.ts) sorts codes into
  healthy, reconnect, fix at the bank, bank unavailable, gone and unknown.
  Reconnect is offered for every kind but gone. Plaid's own advice for
  several codes is to link the account again, which spends an Item; a test
  fails if the sentence for any repairable code says so. Why a login cannot
  sync is said once, on the login; a sync result names the accounts in one
  line. Every action on a login reports into one result slot on its card,
  the latest replacing the one before, so a result outlives the button that
  produced it and an old one cannot contradict a later repair.
- **Reconnect and Choose shared accounts** are Link's update mode on the
  same Item: nothing is exchanged and no Item is created. When Link
  finishes, the action re-reads the login's health, reloads its accounts and,
  if healthy, syncs, and one message says what each step did. The reload adds
  new accounts with sync off, marks an account no longer shared (sync off,
  rows kept), unmarks one shared again, reads an empty list as no change,
  and refuses a re-issued account id (below).
- **OAuth.** `PLAID_REDIRECT_URI` is checked at startup (https, or plain
  http for localhost in Sandbox only; no fragment) and must match the
  dashboard entry character for character. Desktop Link uses a popup. Where
  it cannot, the bank returns to /accounts/oauth, which reopens Link with the
  link token remembered in session storage and the URL it arrived at, and
  finishes the same flow. The browser never holds an access token.
- **Linking a login twice is refused.** Before the exchange, the
  institution Link reports is compared with every login not removed, and a
  match is not exchanged, as Plaid advises. If the logins cannot be read,
  nothing is exchanged. Plaid does not document whether an unexchanged
  public token spends a Trial slot. A login Plaid no longer recognises still
  blocks: the refusal says to remove it first, then link. In Sandbox, where
  Items are free and dev holds several logins at one institution, the
  refusal can be overridden. The button renders only when the page's Plaid
  environment is Sandbox and the refusal is overridable, and the action
  checks the environment again. A database test calls it with production
  settings and a forged override and is refused.
- **The same account under two logins** (same institution, name and mask,
  syncable accounts only) is one line per login, expandable per account.
  Syncing under both counts every transaction twice, so it is amber with the
  fix; linked under both but syncing under one is information.
- **The Item budget** shows "Items used N of 10" in production, removed
  logins included. It is a lower bound (an Item whose exchange never
  completed is not recorded), so the page names Plaid's dashboard as the
  authority. The link confirmation states the cost; with none left, linking
  is not offered.
- **Pause** stops syncing and changes nothing at Plaid; Resume continues
  from the stored cursors. **Removal** asks for the institution's name,
  compared again on the server. Plaid's half runs first; a code saying the
  Item is already gone counts as removed. Then, under the connection's lock,
  the token is erased, every account's sync turned off and its pending rows
  soft-deleted; posted rows, splits and settlements stay. If the database
  half fails after Plaid's succeeded, the message says Plaid's access has
  ended and that removing again finishes it at no cost. The slot is not
  returned. Pause, removal, account reloads and sync toggles take the
  connection's lock and wait; a sync commit tries it and reports a busy
  login instead of waiting.
- **Rendered per request.** /accounts judges consent expiry against the
  current time, so it is not prerendered. Every other page is, and is
  refreshed by `revalidatePath`; /people is also per request since its
  settlement forms default to today.
- **What was observed, and what was not.** On dev, against Sandbox, on
  2026-10-27:
  - *A login needing reconnection:* real. `/sandbox/item/reset_login` on a
    First Platypus Item, with `/item/get` before and after, is recorded
    (tests/fixtures/plaid/sandbox-item-health.json). The replay harness
    answers `/item/get` from those bytes, and a test syncs on the
    post-reset response through the real client: it reads
    `ITEM_LOGIN_REQUIRED` and fetches nothing.
  - *Reconnect, end to end:* real, in the browser. Sync now on the reset
    login gave one line and the amber callout; Reconnect with `user_good`
    restored it, and the follow-on sync ran. Its message did not show: it
    lived in the callout's button, which success unmounted, while Sync now's
    earlier "Nothing synced" stayed. Fixed by one result slot per login on
    the card; the fix has not yet been seen in the browser.
  - *A new OAuth link:* real (Platypus OAuth Bank, 14 accounts). Linking
    it a second time was refused before the exchange, and the Sandbox
    override then linked it. Both links stayed in Link's popup, the second
    under iPhone emulation in Chrome DevTools: the browser's history shows
    only Plaid's own pages (the institution's OAuth login page and a
    "Redirecting…" page on cdn.plaid.com) and no visit to /accounts/oauth.
    Why is not established; the likely reason is that emulation changes the
    viewport and user agent but not the browser, which can still open a
    popup.
  - *Removing an Item twice:* real and recorded
    (tests/fixtures/plaid/sandbox-item-remove.json). The first
    `/item/remove` succeeds; the second, on the same Item, returns
    `400 ITEM_ERROR/ITEM_NOT_FOUND`, which Plaid does not document for this
    case. The classifier counts it as gone, so a removal retried after its
    database half failed finishes; the retry test replays these bytes
    through the real client. The app's own removal then ran on dev and
    finished the same way.
  - *Not observed:* the OAuth redirect page, which nothing has exercised
    live (it needs a browser where Link cannot open a popup, such as a
    mobile web view), Choose shared accounts, consent
    expiry (Sandbox Items report none), any Item error but
    `ITEM_LOGIN_REQUIRED`, whether an unexchanged public token spends a
    Trial slot, and what Plaid returns when an account's old id is asked for
    after a re-issue. Their handling rests on Plaid's documentation and on
    tests with made-up responses.

## Bank categories

Plaid gives each synced row its own category (personal finance category,
primary level, e.g. FOOD_AND_DRINK). The owner maps the few that matter to
their categories on /rules (`bank_category_map`, migration 0028; it starts
as approved on 2026-10-28: food and drink to Dining, general merchandise to
Shopping, transportation to Transport, travel to Travel, entertainment to
Entertainment). A synced row that no rule matches takes the mapped category
with source `bank`, shown on the row as the bank's, so a wrong guess is seen
rather than inherited. Rules come first and overwrite it; it never
overwrites a manual or rule category; a row with a split never moves into a
category that is not splittable. Only categories that count as spending can
be mapped: Plaid files a Zelle to a person as TRANSFER_OUT, and mapping that
to Transfers would remove real spending from the totals. Changing the
mapping changes no row; "Apply to existing" does, and reports how many rows
took the bank's category. The normalizer also strips Plaid's "APLPAY "
prefix, so a merchant reads the same from the bank and from a CSV (0028
recomputes it on the rows that had it).

## Environments and guards

`.env.local` currently points at the production database and Blob store
(its fingerprints match lib/production-fingerprints.ts) — it is what
`drizzle.config.ts` migrates. Sandbox development against it would write
fake bank rows into the real ledger. So:

- Local development gets its own database and Blob store. The database is a
  Neon branch of production named `dev` with every financial table truncated
  (SQL below), keeping categories, persons and rules as reference data. The
  Blob store is a new private store, `tally-dev`. Under `next dev`, Next.js
  loads `.env.development.local` ahead of `.env.local`: a key it sets wins, a
  key it sets to an empty value blocks `.env.local`'s value, and a key it
  omits falls through from `.env.local` (verified against @next/env 16.2.10).
  So that file must name every store credential explicitly. The Plaid keys
  move out of `.env.local`.
- `@vercel/blob` (2.6.1) prefers OIDC — `VERCEL_OIDC_TOKEN` with
  `BLOB_STORE_ID` — over `BLOB_READ_WRITE_TOKEN` whenever no explicit token is
  passed, and the receipt action passes none. Production sets `BLOB_STORE_ID`.
  Overriding the token alone is therefore not enough: dev blanks both OIDC
  keys, and the guard fingerprints `BLOB_STORE_ID` as well as the token.
- `drizzle.config.ts` reads `DRIZZLE_ENV_FILE` (default `.env.local`) so
  `npm run db:migrate:dev` can target the branch.
- `lib/deploy-guard.ts` gains five rules, unit-tested:
  1. Under `next dev` (`NODE_ENV=development`), the production database
     fingerprint, the production Blob token fingerprint and the production
     `BLOB_STORE_ID` fingerprint are all refused. Local development never
     touches a production store; a mistake in the env file fails at startup
     rather than writing. (This ends running `next dev` against production,
     deliberately.) The demo rules gain the `BLOB_STORE_ID` check too.
  2. A demo deployment may hold no `PLAID_*` variable and no
     `BANK_TOKEN_KEY` (the synthetic provider needs neither).
  3. `PLAID_ENV=sandbox` is refused when the database fingerprint is
     production's: Sandbox rows never reach the real ledger.
  4. `PLAID_ENV=production` is refused unless the database is production's
     and `VERCEL_ENV=production`: real Items are only ever created by the
     production deployment, never from a laptop or a preview.
  5. The production Plaid secret is recognized by value: its sha256 is listed
     in lib/production-fingerprints.ts (a 120-bit random secret, so the hash
     is safe to publish), and it is refused anywhere but the production
     deployment, whatever `PLAID_ENV` says. Added after the production secret
     was found in `.env.local` labeled sandbox (2026-10-19); the entry is
     replaced on every rotation.
     The list holds only the current secret, so the guard does not refuse a
     superseded or exposed one: it was never listed. What closes an exposed
     secret is deleting it in the Plaid dashboard. Rotating there creates a
     New secret beside the Old one, and the Old one is still accepted until
     it is deleted: the secret exposed on 2026-10-19 stayed live beside its
     replacement until it was deleted on 2026-10-27.
- Preview deployments get no Plaid variables and cannot sync.
- Test fixtures are synthetic or Sandbox-recorded, never real responses.
  The public snapshot's denylist scan is a backstop, not the control.
- `.gitignore` ignores `.env*` (verified 2026-10-19 with `git check-ignore`
  for `.env.local`, `.env.demo`, `.env.development.local`,
  `.env.production.local`); the only `.env` file ever committed is
  `.env.example`, without values. The snapshot build copies tracked files
  only.

## Deployment protection

Verified 2026-10-19 via the Vercel API:

- The app project's protection scope was `all_except_custom_domains`
  (Standard Protection), which by definition leaves production domains
  public. The app's former `*.vercel.app` production domain was one, so it
  served the ledger without authentication. The demo and share projects use
  the same scope, intentionally.
- The project's domain list is now empty, the domain returns
  `DEPLOYMENT_NOT_FOUND`, no other project in the team claims it, and no
  `vercel.json`/`vercel.ts` in the repository's history ever declared an
  alias.
- Why it came back: each production deployment re-assigns every domain in
  the project's Settings > Domains list (`autoAssignCustomDomains` is on).
  The last two production deployments (2026-10-11) both carried that
  domain, so it was still in that list then. The likeliest
  cause is that the first removal took the alias off a deployment rather than
  the domain off the project, and the next push re-attached it. Hobby has no
  audit log, so the first removal cannot be confirmed.
- Required setting: scope **All Deployments** (`deploymentType: "all"`),
  available on Hobby without an add-on. Under it a production domain, however
  it gets added, is behind Vercel Authentication. Applied 2026-10-19; the
  app's generated production URLs now redirect to Vercel SSO, while the demo
  and share projects stay public as intended. Nothing in the app needed
  changing first: no code reads `VERCEL_URL` or `VERCEL_BRANCH_URL`, client
  fetches are relative, share links use `NEXT_PUBLIC_SHARE_BASE_URL` (set in
  production, pointing at the share project), there are no OG images, and no
  Blob client uploads with completion callbacks (the one place `@vercel/blob`
  reads `VERCEL_URL`).
- Cron under All Deployments: tested on a throwaway project
  (`cron-protection-probe`) set to `all`. An anonymous request to its
  production domain got a 302 to Vercel SSO, while both a manually triggered
  cron run (20:11 UTC) and the scheduled `0 21 * * *` run reached the
  function (user agent `vercel-cron/1.0`, status 200; the scheduled run
  landed at 21:27:25, inside Hobby's hour of jitter). Vercel's own cron
  calls pass deployment protection. The cron route still checks
  `CRON_SECRET`. The probe project was deleted afterwards.

## Build order

Each step is one vertical slice, proposed in detail and approved before it
is built. Steps 1–5 are Sandbox-only. Order after slice 4 (2026-10-27):
the action-results slice (ACTION-RESULTS.md), then 6 and 7, so the owner's
own banks sync first; then 8, since the demo is what visitors open; then 5,
since a sync the owner can trigger by hand need not be automated yet.

1. **Link a Sandbox Item and list its accounts.** Dev database split, guard
   rules, token encryption, `bank_connections` and `bank_accounts`, /accounts.
   No transactions.
2. **Sync now, posted rows only.** Per-account opt-in and cursors,
   transaction columns, the `AccessToken` wrapper, exact-amount parsing, the
   pure planner, fetch-then-commit with lock and cursor check, sign fixtures,
   Linked rows grouped per Plaid account in Expenses. Pending rows filtered;
   any `modified` or `removed` entry for an ingested row halts the sync
   loudly instead of being skipped.

Between slices 2 and 3, outside the numbering: **Transfers.** Not bank sync,
but wrong today: the CSV ledger counts card payments from Chase checking
(about $5,876 so far) as spending on top of the card purchases they pay for,
and offers them for splitting. Categories gain whether they count as
spending; a Transfers category excluded from spending and splits, rules for
the payment patterns, applied retroactively. It covers both shapes the data
already shows: checking to card across institutions in the CSV history
(`DISCOVER E-PAYMENT`, `AMERICAN EXPRESS ACH PMT`), and one linked account
paying another at the same institution in synced data (Sandbox: Plaid Saving
`CREDIT CARD 3333 PAYMENT`, +$25 monthly, which Plaid itself tags
`LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`). Kept small.

3. **Full lifecycle.** Pending rows (read-only), takeover in place,
   modified and removed handling with the flags, remove-and-re-add pairing,
   flag resolution on the Expenses table, synced rows read-only, the split
   save lock, no category change (rule or manual) moving a split row into a
   non-splittable category, and the database test suite in CI.
4. **Item health.** Item status and consent expiry from Plaid, update-mode
   relink, OAuth redirect handling (Sandbox OAuth institutions), the Items
   budget display, connection status with pause and deliberate removal, and
   a warning when two connections hold the same account (same institution,
   name and mask): that is the same login linked twice, the budget mistake,
   and it should be visible rather than look like two accounts.
5. **Scheduled sync.** Daily cron over all connections, each isolated so one
   broken Item does not stop the others.
6. **Authentication.** Built (AUTH.md): passkeys, the session checked by
   every page and action, Vercel protection kept on All Deployments as a
   second layer, owner only, no RLS (still deferred). The cron path is
   exempt from the session and checks `CRON_SECRET` instead. Still open: a
   check that the protection scope is still All Deployments, as a local
   pre-deploy script run with the owner's token, never in CI (AUTH.md).
7. **Ledger accounts, cutover and real accounts.** Build half done
   (REAL-ACCOUNTS.md); real Items go live one at a time. `ledger_accounts` with
   `cutover_date` and `cutover_basis`, mapping of CSV import batches and Plaid
   accounts onto them, grouping by ledger account, the boundary review list,
   then the production Plaid secret and the first real Items (below).
8. **Synthetic provider for the demo.** The demo seed builds its bank rows
   through `BankProvider` and the real planner, replacing the CSV path for
   those sources.

## Real accounts (slice 7)

Three Items: Chase, Capital One and Amex. Within each, only the accounts in
use are enabled. The Capital One login holds two cards, the migrated Discover
it and a Venture X, so one Item returns both: Discover it is enabled, and the
Venture X is the owner's choice at link time. Per-account opt-in exists for
exactly this.

**The Discover card goes through Capital One.** Settled 2026-10-25: the card
is listed in the owner's Capital One login with its balance, payments and a
virtual card (check 1 below), and its last four digits match the
`DISCOVER E-PAYMENT` rows in the Chase history. Discover is not linked. The
reasoning, kept for the next institution migration: Plaid lists Discover
(`ins_33`) and Capital One (`ins_128026`) as separate OAuth institutions
(institution search, 2026-10-22). Discover cards began moving to Capital One
on 2026-07-27, in waves into 2027, and a migrated card's Discover link is
reported to disconnect and need relinking through Capital One. Linking
Discover for an already migrated card would spend an Item on a login that no
longer serves it; linking it before migration would spend a second Item when
the migration retires the first. So before slice 7, settle which applies:

1. Sign in at capitalone.com or the Capital One app. Definitive: the card is
   listed in that login with its last four digits, recent transactions and a
   statement. Capital One's login is what a Capital One Item sees.
2. Sign in at discover.com. Consistent with migration: it says the card is
   now managed at Capital One, or sends you there.
3. The latest statement: the issuer, the payment address and the
   customer-service number name Capital One rather than Discover.
4. The notice: Capital One or Discover wrote to each cardholder with the
   date of the move; it names the date to expect from (1).

Only (1) is definitive. The last check costs nothing: during Link, Capital
One's consent screen shows which accounts will be shared before any Item
exists. If the card is not listed, leave Link there and no Item is spent. If
the screen offers account selection, share only the card.

**Worked example for the ledger-account design.** The same physical card,
"Discover it ••NNNN":

- Before cutover: CSV rows with `source = 'discover'`, from Discover-format
  exports (`Trans. Date` basis), in import batches labelled Discover. The last
  CSV row sets the cutover.
- After cutover: synced rows with `source = 'plaid'`, from a Plaid account
  under the Capital One Item, institution name Capital One.
- The ledger account "Discover it ••NNNN" owns both: the Discover import
  batches map onto it, and so does the Capital One Plaid account. Its cutover
  basis is transaction date, from the Discover parser; synced rows use
  `authorized_date ?? date`, the same basis.
- The same Capital One Item also returns the Venture X. If enabled, it gets
  its own ledger account "Venture X ••NNNN" with no CSV history, so its
  cutover is the start of its synced history and nothing is skipped. If not
  enabled, it is never fetched (per-account cursors), and enabling it later
  starts its full history with no new Item. One Item, two ledger accounts.
- Expenses shows one group for the card across the cutover. Nothing keys on
  "Discover" or "Capital One"; both are labels.
- If the institution changes again, a new Item's Plaid account maps onto the
  same ledger account, with its cutover after the old account's last synced
  row.

Slice 7 is built and tested against this case.

### Re-issued account ids (blocking, slice 7)

A synced row's identity is its account and Plaid's transaction id; it
carries no `dedup_hash`. An account that comes back under a new
`account_id` would therefore, once synced, deliver its whole history again
beside the rows already stored. Plaid documents an `account_id` changing
when it cannot reconcile an account with the institution's data (a renamed
account is its example), and under a new access token. It does not say
whether update mode does it. `persistent_account_id`, which stays the same
across ids, is populated only at institutions that tokenize account numbers
(Chase, PNC, US Bank; in Sandbox, the TAN institutions and Platypus OAuth
Bank `ins_127287`).

What slice 4 does:

- **With a persistent id (Chase).** The account reload after Reconnect or
  Choose shared accounts refuses as a whole and changes nothing. The login
  itself is reconnected. The owner is told once, in the Reconnect result:
  "Reconnected, but its accounts were not reloaded. The bank re-issued the
  id of Chase Checking ••NNNN. Nothing was changed: syncing it under the new
  id would add its history again beside the rows already stored. Its rows
  stay; the app has no repair for this yet." No retry is offered, because
  retrying gets the same answer. The account keeps its old id and its sync
  setting, so later syncs ask Plaid for an id it no longer reports. Not
  observed: what Plaid returns for that, and so whether the failure stays on
  that account (the expected case: other accounts keep syncing) or is read as
  a login-wide error that stops them.
- **Without one (Capital One, Amex).** Not detected. The reload sees a new
  account, added with sync off, and an old one no longer shared, marked and
  turned off. Its rows stay. Turning sync on for the new account would sync
  its history again. Nothing on /accounts says the two are one account.

So until slice 7, the account is stuck: its rows stay, and nothing in the
app repairs it. Linking the bank again is not the way out. In production
the duplicate-login guard refuses it. Even if it went through, a new Item
issues new ids for every account at that login, which is the same problem on
all of them, and it spends an Item.

The repair is slice 7's ledger accounts. A re-issued id is the same case as
an institution migration: a new Plaid account maps onto the existing ledger
account, with its cutover after the old account's last synced row. History
from the new id dated before the cutover is skipped, and the boundary
review list covers the edge days. That repair uses no new Item, because the
login is the same one. Slice 7 therefore includes, before any real Item is
linked:

1. An "adopt" flow for a re-issued account. With a persistent id, the
   refusal becomes this prompt. Without one, a candidate is an account added
   in the same reload that marked another of the same type and mask
   unshared; the owner confirms the pair.
2. A refusal to turn sync on for an account that is a candidate twin of an
   unshared account in the same login, until it is adopted or the owner says
   it is a different account.
3. Database tests for both paths, through the real reload.

### Sign verification (blocking, slice 7)

A wrong sign on card rows would look plausible and would not be caught by
eye, and Sandbox cannot rule it out: Plaid documents a positive amount as
money leaving the account (the canonical sign), Sandbox confirms it for
checking (purchases positive, a refund negative), but its card data has no
negative rows at all and posts the card payment as positive (recorded
2026-10-22, tests/fixtures/plaid/sandbox-sync.json). So every real account
is verified against a statement before its rows count, and the app enforces
that, rather than a reminder.

**Enforced in code.** `bank_accounts.verified_at` starts NULL in production.
An unverified account syncs, but its rows are not splittable and are left out
of Insights totals, and /accounts shows the account as awaiting verification.
Passing the check records `verified_at` together with the statement period
and the figures compared; failing it disables syncing for that account.

**Procedure, per account.**

1. *Statement:* the most recent closed statement for that account, downloaded
   from the issuer (PDF). The first sync fetches the account's full history,
   so the statement period is available even if it lies before the cutover:
   the verification view is built from the fetched rows for that period,
   whether or not they are inserted.
2. *Which date:* statements group transactions by posting date, so the
   comparison uses Plaid's `date` (posted), not the ledger's
   `authorized_date ?? date`.
3. *Rows compared:* every payment, credit and refund on the statement (each
   must be negative in the fetched rows, at the statement amount), and the
   five largest purchases (each positive, at the statement amount). For
   checking: the five largest debits (positive) and every deposit (negative).
4. *Totals compared:* for the statement period, the sum of positive fetched
   rows must equal the statement's purchases plus fees plus interest, and the
   sum of negative rows must equal minus its payments plus credits, to the
   cent. Rows that legitimately differ (a charge pending at statement close,
   posted in the next period) are listed one by one; an unexplained
   difference fails the check.
5. *Pass:* every compared row matches in amount and sign, and both totals
   match after the listed exceptions. Anything else is a fail.
6. *On fail:* syncing for the account stays disabled and its rows stay
   uncounted. The sign mapping is fixed in the provider, as the CSV parsers'
   were, never patched downstream, and the check is run again.

## Required from you

Before slice 1:

1. **Dev database.** Neon console > the production project > Branches >
   Create branch: parent the production branch, name `dev`, data as of now.
   Copy its pooled connection string (Connect > Pooled).
2. **Dev Blob store.** Vercel dashboard > Storage > Create > Blob: name
   `tally-dev`, private, connected to no project. Copy its read-write token
   (the store's `.env.local` tab).
3. **Token key.** Generate the dev `BANK_TOKEN_KEY`:

   ```sh
   openssl rand -base64 32
   ```

4. **`.env.development.local`**, complete. Then delete the three `PLAID_*`
   lines from `.env.local`.

   ```sh
   # Local development only. Overrides .env.local under `next dev`; a key
   # left out here falls through from .env.local, which is production.

   # Dev Neon branch (pooled), financial tables truncated.
   DATABASE_URL=<dev branch pooled connection string>

   # Dev Blob store, not production's.
   BLOB_READ_WRITE_TOKEN=<tally-dev read-write token>
   # Blank on purpose: @vercel/blob prefers OIDC over the token, and these
   # must not fall through to a production store.
   VERCEL_OIDC_TOKEN=
   BLOB_STORE_ID=

   # Plaid Sandbox.
   PLAID_CLIENT_ID=<from .env.local>
   PLAID_SECRET=<sandbox secret, from .env.local>
   PLAID_ENV=sandbox

   # Dev token encryption key; never the production one.
   BANK_TOKEN_KEY=<output of step 3>
   ```

   `GEMINI_API_KEY` deliberately falls through: it is not a store, and dev
   shares the free tier's 20 requests a day.

5. **Check before touching data.** Both hashes printed must differ from
   lib/production-fingerprints.ts:

   ```sh
   npm run guard:fingerprint -- .env.development.local
   ```

6. **Truncate the branch.** Run against the dev branch only, with
   `psql "<dev branch connection string>" -v ON_ERROR_STOP=1 -f <file>` or in
   the Neon SQL editor with the `dev` branch selected:

   ```sql
   BEGIN;
   -- Every table holding financial data. No CASCADE on purpose: if any table
   -- outside this list still references one of these, TRUNCATE fails rather
   -- than silently emptying it. imports carries statement names and date
   -- spans; share_links carries person names, descriptions and amounts as
   -- display text.
   TRUNCATE TABLE
     settlement_allocations,
     settlements,
     receipt_item_assignments,
     receipt_items,
     receipt_images,
     receipts,
     split_shares,
     splits,
     transactions,
     imports,
     share_links;

   SELECT 'transactions' AS t, count(*) FROM transactions
   UNION ALL SELECT 'splits', count(*) FROM splits
   UNION ALL SELECT 'settlements', count(*) FROM settlements
   UNION ALL SELECT 'receipts', count(*) FROM receipts
   UNION ALL SELECT 'imports', count(*) FROM imports
   UNION ALL SELECT 'share_links', count(*) FROM share_links
   UNION ALL SELECT 'categories (kept)', count(*) FROM categories
   UNION ALL SELECT 'persons (kept)', count(*) FROM persons
   UNION ALL SELECT 'categorization_rules (kept)', count(*) FROM categorization_rules;
   COMMIT;
   ```

   The truncated rows stay in the branch's point-in-time history until its
   restore window passes. That history is reachable only from the Neon
   console, not with the connection string.

7. **Protection.** Done 2026-10-19 (All Deployments).

Before slice 5:

8. Production `CRON_SECRET`:
   `openssl rand -base64 32 | vercel env add CRON_SECRET production`.

Before slice 7 (never earlier, never locally):

9. A separate production token key, stored first in your password manager:
   `openssl rand -base64 32`, then
   `vercel env add BANK_TOKEN_KEY production --sensitive`. Losing it makes
   every stored access token unreadable and forces a relink of every Item,
   which spends the Item budget.
10. The Plaid production secret from the Plaid dashboard (Developers > Keys),
   as `PLAID_SECRET`, plus `PLAID_CLIENT_ID` and `PLAID_ENV=production`, on
   the production environment only.
11. In the Plaid dashboard, the allowed OAuth redirect URI for the production
   app URL (`https://<app domain>/accounts/oauth`); slice 4 registers the
   localhost one for Sandbox. The same URL, character for character, as
   `PLAID_REDIRECT_URI` on the production environment: the app sends a
   redirect URI to Plaid only when that variable is set, so the dashboard
   entry alone does nothing. Missed when production first got its Plaid
   variables (2026-10-28) and set before the first Item; every OAuth link
   seen so far ran with it set.
12. For slice 6: `AUTH_BOOTSTRAP_TOKEN` (`openssl rand -base64 24`) in the
   production environment, set before the deploy that turns sign-in on,
   since without it no first passkey can be made. Done 2026-10-27, with the
   project's .vercel.app production domain restored (now behind sign-in).
