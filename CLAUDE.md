# CLAUDE.md

Guidance for working in this repository. Read alongside README.md, which
holds the project scope, stack, data model, and build order.

## Working style

Build incrementally from scratch. Do not scaffold the whole app or import
a working template.

For each phase, propose the smallest useful slice, wait for approval, then
implement one piece at a time. The goal is that every layer is understood,
not inherited. Stop for approval between slices rather than running ahead.

Do not skip phases or build ahead into a later phase's entities. Phase 1
creates only Transaction and Category; other tables arrive with their
phases.

## Invariants

These are decided. Do not reintroduce the alternatives.

- Money is signed integer minor units; no floats in storage, computation, or
  intermediate values. A minor unit is one THOUSANDTH of a dollar (mills):
  1 dollar = 1000 units, so sub-cent amounts like 80.765 are exactly
  representable. This widened from hundredths (cents) after phase 8; the
  branded `Cents` type and every `*_cents` field/column keep the historical
  name but now hold thousandths, and `MINOR_UNITS_PER_DOLLAR`/`MONEY_DECIMALS`
  in lib/money.ts are the single source of the scale. `parseDollars` accepts
  up to three decimals; `formatCents` shows the third only for sub-cent
  amounts (trailing zero trims back to the familiar two). The unit change was
  a one-time data rescale (db/rescale-to-mills.ts, marker-guarded, ×10 on
  every money column, dedup_hash recomputed) — column types never changed, so
  there is no Drizzle migration for it. Sign convention (locked in phase 2):
  spending is stored as positive, refunds and credits as negative. Manual
  entry already produces this (the user types a positive number for a
  purchase); each bank parser owns the raw-to-canonical sign mapping for its
  export format, verified against real fixtures rather than assumed.
- The split engine takes the absolute value of the transaction amount.
  Negative transactions (refunds, credits) are not splittable and are
  filtered from the split editor.
- Remainder cents are distributed deterministically: the first k people
  each get one extra cent so shares sum to the total exactly. Participant
  order is person `created_at` ascending.
- Tax and tip are split equally among all participants regardless of
  method (for item-level splits, independent of what each ordered). The
  engine divides `abs(amount) - tax - tip` by the chosen method and adds
  the equal tax/tip share on top; shares always sum to `abs(amount)`
  exactly — except item splits, below.
- Item splits (`method='item'`) derive shares from receipt line items:
  each item divides equally among its assignees, unassigned items belong
  to the owner, and the receipt's tax + tip divide equally among all
  participants (anyone holding at least one item, including the owner).
  Shares sum to the receipt total (items + tax + tip), which a tolerated
  total mismatch (warned above max(5%, $2), never blocking) may leave
  different from `abs(amount)` — the one sanctioned relaxation of the
  sum invariant. Shares are computed on save and stored explicitly;
  the balance view (/people) never re-derives them.
- Percent inputs are whole integers summing to 100, so percent share math
  never touches floats.
- Transactions dedupe on a `dedup_hash`: sha256 over
  (source, account_label, date, amount_cents, description_raw), enforced by
  a partial unique index (`where dedup_hash is not null and dedup_exempt =
  false`). The hash records what the import saw and is
  never recomputed: inline edits to date, amount, or description (phase 7)
  trust the user post-hoc and leave the hash as imported, so the original
  bank row still dedupes on re-import. The derived `merchant_normalized`
  IS recomputed on edit, so rules keep matching what the row now says. The earlier "(amount, date, fuzzy merchant)"
  phrasing was a phase-1 sketch; an exact hash cannot fuzzy-match, and
  merchant normalization does not exist until phase 3, so phase 2 hashes
  `description_raw` exactly. Upgrading the hash to a normalized merchant is
  deferred to phase 3 (see PHASE3.md).
- Dedup is a default, not a wall: the import preview classifies each row
  as new, a duplicate of a live row, or a duplicate of a soft-deleted row
  (the hash lingers after a soft delete), and offers an opt-in "include
  anyway" per duplicate. An approved duplicate is inserted with
  `dedup_exempt = true` — it keeps its canonical hash but is excluded from
  the unique index, so it coexists with the row it duplicates (a genuine
  repeat purchase, or re-adding data whose original was deleted). The hash
  is therefore never salted; only `dedup_exempt` bends. Exempt rows are
  ignored when detecting future duplicates, so a hash that matches only
  exempt rows imports as new. Unapproved duplicates skip exactly as before.
- The owner is modeled as a Person with `is_owner`. Their own share is
  never owed, and the owner never appears as a debtor: on /people (which
  absorbed /balances in phase 6) the owner is a pinned summary row, not a
  balance row. Exactly one owner row exists, enforced by a partial unique
  index.
- Persons are soft-deleted (`deleted_at`); hard deletes would orphan
  shares. Deleted persons keep their history but are hidden from
  new-split and settlement UI.
- Transactions are soft-deleted too (`deleted_at`, phase 6). Their splits,
  shares, and receipts stay in the database unchanged, but every read
  path — including balance derivation — filters them, so deleting a split
  transaction removes its effect on balances. The dedup hash stays
  occupied (re-imports cannot resurrect a deleted row). Restore and hard
  delete (with blob cleanup) are deferred.
- Imports group CSV uploads (phase 7): each confirm creates one `imports`
  row and attaches the inserted transactions via `transactions.import_id`;
  manual entries stay NULL. `row_count` counts rows actually inserted
  (dedup skips excluded), and a confirm where every row was a skip leaves
  no import row behind. Backfilled imports (one synthetic row per source,
  created by migration 0008 for pre-phase-7 rows) are identified by
  `filename IS NULL` — real uploads always carry a filename. "Undo import"
  soft-deletes the import row and every transaction in it; the deleted_at
  filter on read paths is the cascade. It is reversible: `restoreImport`
  clears `deleted_at` on the batch and on exactly the rows whose `deleted_at`
  equals the import's — both were stamped by one `now()` inside a single
  transaction, and Postgres `now()` is the transaction timestamp, so a row
  deleted individually before the undo keeps an earlier stamp and stays
  deleted. Splits, shares, and receipts were never touched, so balances come
  back unchanged; `hidden` is cleared so restored rows are actually visible.
  Restore, not re-import, is the recovery path: re-importing the same file
  inserts `dedup_exempt` copies carrying none of the original splits, notes,
  or manual categories, and the preview's 100-row cap means a larger batch
  cannot be fully re-approved anyway.
- A transaction has at most one Split. No Split means it is entirely the
  owner's. Editing a split is a full overwrite: delete the old shares,
  insert new ones — no diffing.
- Balances are bidirectional (batch B). A split carries
  `payer_person_id`; an owner-paid split's non-owner shares are debts owed
  TO the owner (incoming), while an external split (transaction_id NULL,
  payer = a non-owner, its own date/description, a single owner share) is a
  debt the owner owes THEM (outgoing). Per person X: `they_owe_me` = the
  outstanding of X's incoming shares, `i_owe_them` = the outstanding of X's
  outgoing shares, `net = they_owe_me - i_owe_them` (positive => X owes the
  owner). A share's outstanding is `amount_cents` minus its settlement
  allocations, floored at 0. The owner may never be the payer of an
  external split (that is just an owner-paid split); this is enforced in the
  Zod/Server-Action layer, not a CHECK — a CHECK cannot reference the owner
  id portably (a hardcoded uuid inverts on any freshly-seeded DB).
- External splits (manual "expenses you paid") live only on /people, never
  on /expenses, which stays the bank + owner-paid ledger. `getSplits` is
  scoped to transaction-backed splits.
- Settlements carry a `direction` (`incoming` = they paid me, the default
  and the backfill value for pre-batch-B rows; `outgoing` = I paid them),
  locked at creation. A settlement is a positive amount FIFO-allocated to
  the outstanding shares in its direction via `settlement_allocations`
  (settlement, split_share, amount, composite PK). FIFO orders by effective
  date — transaction date for owner-paid shares, split.created_at for
  external — then created_at, then id. Advanced mode overrides FIFO with
  explicit per-share amounts, each clamped to the share's outstanding,
  chosen in the share-picker dialog (`settle-allocator.tsx`; selection logic
  in `lib/settle-selection.ts`). Over-allocation — requested amounts summing
  past the payment (for a netted payment, typed cash below the net) — is a
  hard block: the picker disables Record, and `createSettlement` /
  `recordSettlementGroup` reject it, never trimming silently.
  Under-allocation is allowed and the remainder becomes credit. The inline
  form's "Full balance" only fills the amount field; it sends no
  allocations, so that path stays plain FIFO. The
  per-person share sort on /people (date / category / amount) is display only:
  the settlement form reads the unsorted array, so reordering the list on
  screen cannot perturb allocation order.
- A settlement's unallocated remainder is credit: it carries forward and
  auto-applies to the next same-direction share created for that person
  (share creation in insertExternalExpense/replaceSplit/replaceItemSplit
  consumes matching-direction credit oldest-first). Overpayment therefore
  shows as $0 net plus standalone credit, not a negative balance.
- Netting (migration 0018): when debts run both ways, one payment settles
  the difference and the overlap is cancelled by an offset pair — an
  incoming and an outgoing settlement of equal amount, `is_offset = true`,
  moving no money. The cash row (net direction) and the pair share a
  `group_id`; a CHECK requires every offset to have one. Balances need no
  special case: each half is an ordinary settlement in its direction, and
  the pair cancels in the net. `planNetting` (lib/netting.ts) splits the
  selection: the smaller side goes wholly to the offset; on the larger side
  the cash covers the oldest selected amounts and the offset the rest. A
  group is the unit of display, deletion, and editing. Editing replaces the
  group in one transaction (`recordSettlementGroup` with `replaceId`):
  the old rows are deleted first, so their allocations count as outstanding
  again, and every requested allocation must fit the share's live
  outstanding exactly — refused, not clamped, because clamping one half
  would unbalance the pair. The inline form offers "Settle up" (picker with
  both sides ticked) instead of "Full balance" for people owed both ways,
  since a one-sided full fill clears their side and leaves the owner's open.
- Allocations against a soft-deleted transaction's shares are ineffective:
  read paths (balances, share status, settlement unallocated) exclude them,
  so the amount returns to the settlement's credit pool. Hard-deleting a
  settlement or an external split cascades its allocation rows.
- The pure allocation logic (share status, FIFO, credit consumption) lives
  in `lib/allocations.ts`, tested in isolation; the migration 0013 FIFO
  backfill mirrors it as interval-intersection SQL.
- Categories carry `is_splittable` (Rent and Income seed false).
  Transactions inherit it; uncategorized transactions count as
  splittable.
- Categorization rules match against `merchant_normalized` (a canonical
  merchant string derived from the raw description on insert),
  case-insensitively, as either a substring or a regex per `match_type`.
  Lower `priority` wins; ties break by `created_at` ascending.
- `category_source` is `manual`, `rule`, or NULL (never categorized). Rules
  only ever set or clear NULL and `rule` rows; they never overwrite a
  `manual` category. A user's inline edit sets `manual` (or clears to NULL).
- Debt simplification (`lib/debt-simplify.ts`) is greedy, not optimal:
  exact-amount pairs first, then largest debtor to largest creditor, ties by
  input order. It guarantees at most (nonzero people - 1) transfers; the true
  minimum is NP-hard (zero-sum partitioning) and is not attempted. Inputs must
  sum to exactly zero. Because every debt here has the owner on one side, the
  graph is a star, and simplification only beats per-person settling when the
  owner is near even or amounts line up — the /people card says so, and says
  that transfers between two non-owners cannot be recorded (settlements always
  involve the owner). It is a suggestion; nothing is recorded from it.

## Architecture

- Money math and the split engine are pure functions in `lib/`, with no
  dependency on Next.js, Drizzle, the database, or UI code. Test them in
  isolation with Vitest.
- Data access goes through Server Actions, server-side only, using the
  `DATABASE_URL` connection. The connection string must never reach the
  client.
- Mutations run only in Server Actions and refresh data with
  `revalidatePath`. Do not use `router.refresh()` or `router.push()` for
  data refresh, and no client-side optimistic state in v1.
- File uploads that feed a Server Action hold the selected `File` in client
  state and dispatch the action with a manually built `FormData`, rather
  than relying on the form's own submission. React 19 resets an
  uncontrolled `<form>` after a form action runs, which would drop the file
  between a preview submit and a later confirm submit. This is the standard
  file-upload pattern here; see `app/_components/import-form.tsx`.
- No row-level security or per-user authorization in v1. Do not add it or
  design around it; v1 is single-user and all access is server-side. The one
  exception is `/s/<token>`, below, which is deliberately unauthenticated.
- Share links (`share_links`) publish both sides of one person's balance at an
  unguessable token, so a list too long for a text message can be sent as a
  short teaser plus a URL. They are snapshots, not views: the rendered lines
  are copied into the row, so a link handed out today can never expose
  expenses added tomorrow, and a person later renamed or deleted still reads
  as they were sent. The payload is denormalized display text carrying no ids,
  so a token reveals that one list and nothing else. Tokens are 96 random bits
  (16 base64url chars), never derived from a person or split id. The page is
  `noindex`, and SiteHeader renders nothing under `/s/` — the reader is not
  the owner and has no app to navigate. Snapshots are served in production by
  a SECOND Vercel project built from `share/`, with deployment protection off,
  while the app keeps protection on: a share link must open for someone with
  no Vercel account, and the ledger must not. That project declares only the
  `share_links` table and has no route but `/s/[token]` and a dead end at `/`,
  so it cannot serve ledger data even if misconfigured, and trimming a link
  back to its domain reveals nothing. It imports `lib/money.ts` from the app
  rather than copying it (the scale has already widened once), owns no
  migrations, and is addressed by `NEXT_PUBLIC_SHARE_BASE_URL` on the app —
  unset, links fall back to the app's own origin, which is local dev. `revoked_at` is read as "gone" already,
  so a revoke affordance needs no migration. A list of 8 items or fewer is
  sent whole and publishes no row at all. A snapshot carries BOTH directions
  and states the net: a message listing only what someone owes, while omitting
  what they are owed back, overstates the debt (it read $1,250.675 where the
  net was $967.77). Hence one Share button per person, not per direction,
  and one sort shared by both lists so the message matches the screen.
- The public demo is a THIRD Vercel project, `tally-demo`, built from this
  repository with `DEMO_MODE=1`, deployment protection off, and its own empty
  Neon database and Blob store; see DEMO.md. Its safety is structural, not
  RLS: it never holds production credentials. Two layers enforce that.
  `lib/deploy-guard.ts` (offline, in `next.config.ts` at build and at module
  scope in `db/index.ts` before any connection) fails a demo deployment —
  `DEMO_MODE=1`, or a production URL naming tally-demo even with the flag
  missing — whose database endpoint or Blob store fingerprint is listed in
  `lib/production-fingerprints.ts` (sha256 of the ids, never credentials), or
  that holds a Gemini key. `db/demo-guard.ts` (network, at build and inside
  every reset) requires positive markers: the database comment `tally-demo`
  and a marker object in the Blob store. Only `npm run demo:mark` writes
  them, and it refuses a store holding any data, so production can never
  acquire them. The marker is a database comment because Neon's owner role
  may not `ALTER DATABASE ... SET` a custom parameter.
- Demo data is synthetic and deterministic: `lib/demo/seed.ts` builds the
  ledger for a (seed, day) through the real parsers, normalizer, rules, dedup
  hash, split engine, FIFO allocator, and netting planner, so it can only
  contain what the app itself would produce. Dates are relative to the reset
  day. The reset (`db/demo-reset.ts`) uploads new receipt images, truncates
  and rewrites every table in one transaction after rechecking the database
  marker, then deletes the previous images. It runs daily from Vercel Cron
  (declared in `vercel.ts` only for demo deployments; the route 404s
  elsewhere), from the banner's Reset button, and from `npm run demo:reset`.
  Demo scripts read `.env.demo` only; `npm run db:migrate` must never be used
  for the demo, because `drizzle.config.ts` reads `.env.local`.
- In demo mode receipt extraction is simulated (`lib/demo/canned-receipt.ts`):
  any image yields a sample dinner receipt sized to the transaction, so the
  review and assignment steps run as normal without a Gemini request. The
  sample statement (`/api/demo/sample-statement`) is rebuilt from the seed
  for the day the ledger was built (recovered from the owner row), so its
  overlap with the last seeded import always dedupes.
- Zod schemas are the single source of truth for validation and are shared
  by forms, Server Actions, and importers.
- Drizzle migrations are explicit SQL. Schema changes ship as migrations,
  not as implicit sync.
- shadcn/ui components are generated into the repo and owned here; edit
  them directly rather than wrapping around an external dependency.

## Dependencies

- TypeScript is pinned to `^6`. Do not `npm update` it back to 7: the
  TypeScript 7 native Go port omits `lib/typescript.js`, which Next.js 16's
  `next build` uses to detect TypeScript, so a v7 install fails the Vercel
  build with "trying to use TypeScript but do not have the required
  package(s) installed" (vercel/next.js#95633). Revisit once Next.js ships
  detection for the v7 layout.
- Receipt extraction uses `gemini-3.5-flash` (lib/receipt/extract.ts) on a
  free-tier key. The real free-tier limit is 20 generate_content requests
  per day (observed live via `generate_content_free_tier_requests,
  limit: 20` — not the higher figures public docs suggest), plus a
  per-minute cap that 429s back-to-back calls. Each receipt upload burns
  1–4 requests depending on retries (2s/4s/8s ladder on 429/503/timeout).
  Budget live extraction tests accordingly; do not iterate speculatively
  against the real API.

## Git conventions

- Commit messages are the owner's: imperative mood, no AI attribution
  anywhere in the git record.
- Do not add a `Co-Authored-By: Claude` trailer to any commit.
- Do not add a "Generated with Claude Code" line to PR descriptions.
- `.claude/settings.json` sets `includeCoAuthoredBy: false` to enforce the
  no-co-author rule structurally. Do not remove it.

## Documentation tone

Keep README.md and CLAUDE.md concise and factual. Match technical
documentation tone: no badges, no emoji, no marketing language, no
feature-list framing. State decisions and constraints plainly.
