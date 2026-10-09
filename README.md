# expense-splitter

A personal app for splitting expenses. It ingests bank statement exports,
presents transactions in an editable table, splits any transaction with
other people, and tracks per-person balances and per-category spend.

Single-user in v1: the statements belong to one owner, so every shared
expense is money others owe the owner.

## Scope

In v1:

- Import from Chase, Discover, and Amex as CSV or OFX. No PDF parsing and
  no bank APIs.
- Transaction table with an editable category column.
- Split a transaction equally, by amount, by percent, or by line item
  (via receipt upload).
- Bidirectional per-person balances (what each person owes the owner and
  what the owner owes them, netted) and per-category spend summary.

Deferred to later phases: receipt line-item extraction with an LLM, Plaid
auto-refresh, and recurring-charge detection. Debt simplification (the
fewest transfers that settle everyone) is a suggestion on /people.

## Stack

- Next.js (App Router) with TypeScript, deployed to Vercel.
- Neon Postgres for data, via the Vercel integration. Receipt storage in
  phase 5 will use Vercel Blob (deferred until then).
- Drizzle ORM with explicit SQL migrations.
- Zod for validation, shared across forms, Server Actions, and importers.
- Tailwind with shadcn/ui components (generated into the repo).
- TanStack Table for the transaction table.
- Vitest for tests.

Money math and the split engine live in a framework-free `lib/` of pure,
unit-tested functions. That layer does not depend on Next.js, the database,
or any UI code.

Security posture for v1: single-user, so there is no row-level security or
per-user authorization. All data access goes through Server Actions using
the server-side `DATABASE_URL` connection; the connection string is never
exposed to the client.

## Domain rules

- Money is stored as signed integer minor units — thousandths of a dollar
  (mills), 1 dollar = 1000 units — so sub-cent amounts like 80.765 are exact;
  no floats anywhere. Spending is stored positive, refunds and credits
  negative. Each bank parser maps its export's sign convention onto this
  canonical form. (The unit was hundredths through phase 8; the `*_cents`
  names were kept when it widened to thousandths.)
- The split engine operates on the absolute value of a transaction amount.
- Split shares distribute the remainder deterministically: the first k people
  each receive one extra minor unit so shares sum to the total exactly.
- On item-level splits, tax and tip are divided equally among all
  participants, regardless of what each person ordered.
- Transactions are deduplicated on a `dedup_hash` over (source,
  account_label, date, amount_cents, description_raw). Fuzzy merchant
  matching is deferred until merchant normalization exists in phase 3.

## Data model

All monetary fields are signed integer minor units (thousandths of a dollar;
the `*_cents` column names predate the unit widening).

- **Person** — everyone in the split graph, including the owner. The owner
  is a Person with `is_owner` set (exactly one, enforced by a partial
  unique index). Persons are soft-deleted via `deleted_at` so shares never
  orphan.
- **Category** — flat list, no hierarchy in v1. Carries `is_splittable`
  (Rent and Income are seeded false); transactions inherit it, and
  uncategorized transactions count as splittable.
- **Transaction** — date, signed `amount_cents` (positive spending,
  negative credit), raw description, `merchant_normalized`, nullable
  category, `category_source` (manual, rule, or null), source (manual,
  chase, discover, amex), `dedup_hash`, optional `account_label`, a
  nullable `import_id` linking imported rows to their upload batch, and an
  optional free-text `note` (independent of dedup and balances).
- **Import** — one CSV upload batch: source, original filename (null for
  the synthetic backfill rows created when the table was introduced),
  upload timestamp, inserted row count. Soft-deleted; undoing an import
  soft-deletes its transactions with it.
- **CategorizationRule** — a `match_pattern` and `match_type` (substring or
  regex) that map a matching `merchant_normalized` to a category, with an
  integer `priority` (lower wins, ties by `created_at`).
- **Split** — carries the split method (equal, amount, percent, item),
  `tax_cents` / `tip_cents` (divided equally among participants on top of
  the method shares), and `payer_person_id` (who paid). An owner-paid split
  is at most one per transaction; absence means the expense is entirely the
  owner's. A split with `transaction_id` NULL is an **external split**: an
  expense someone else paid that the owner owes a share of, with its own
  `date` and `description` and the payer set to that non-owner person. The
  owner is never the payer of an external split.
- **Receipt** — at most one per transaction. A private Vercel Blob image
  plus values extracted by Gemini (merchant, date, subtotal, tax, tip,
  total) into typed columns, with the raw LLM response kept as jsonb for
  debugging. Extraction is a first draft the user reviews and edits.
- **ReceiptItem** — one per line item, ordered by `position`, holding the
  line's description, display quantity, and `amount_cents` total.
- **ReceiptItemAssignment** — many-to-many item/person junction. An item
  splits equally among its assignees; unassigned items are the owner's.
  Saving assignments produces a `method='item'` split whose shares are
  stored explicitly.
- **SplitShare** — one per participant per split. Holds the resolved owed
  `amount_cents` plus the raw input for percent and amount methods
  (percents are whole integers).
- **Settlement** — a positive payment between a person and the owner:
  person, `amount_cents`, `direction` (`incoming` = they paid me,
  `outgoing` = I paid them, locked at creation), date, optional note. A
  settlement is FIFO-allocated to the outstanding shares in its direction.
- **SettlementAllocation** — junction (settlement, split_share,
  `amount_cents`, composite PK) recording how much of a settlement pays
  down a specific share. A share's status (outstanding / partial / settled)
  derives from the sum of its allocations; a settlement's unallocated
  remainder carries forward as credit and auto-applies to the next
  same-direction share for that person.

Balances are bidirectional. Per person X: `they_owe_me` = the outstanding
(amount minus allocations) of X's shares on owner-paid splits; `i_owe_them`
= the outstanding of the owner's shares on X's external splits; and `net =
they_owe_me - i_owe_them` (positive means X owes the owner). Unallocated
credit is tracked on the settlement, not as a negative balance.

## Build order

1. Data model, manual transaction entry, and table view. No AI.
2. CSV import per bank (OFX/QFX deferred to phase 3).
3. Rules-based categorization from merchant strings.
4. Split engine and balance computation.
5. Receipt upload and LLM line-item extraction.
6. Summary dashboard.
7. Later: Plaid, recurring-charge detection.

## Demo

A public demo runs as a separate Vercel project on synthetic data, with its
own database and Blob store; it never holds production credentials, and a
build guard refuses to start it if it does. Data is generated
deterministically, relative to the current date, and resets daily. Receipt
extraction is simulated there. Provisioning and guard details are in
DEMO.md.

## Phase 1

Phase 1 covers the data model, manual entry, and the table view, with no
AI and no splitting. It creates only the Transaction and Category tables;
the remaining entities arrive with their phases.

It is built in five slices, one at a time:

1. Project skeleton plus `lib/money.ts` (cents type, dollar parsing, cents
   formatting) with Vitest tests. No database.
2. Drizzle schema for Transaction and Category, the first migration, the
   Neon connection, and a small category seed.
3. Read path: list transactions and render them in the table, no editing.
4. Write path: a manual add-transaction form validated with Zod, storing
   dollars entered as cents.
5. Editable category column that updates via a Server Action.

## Phase 3

Phase 3 adds rules-based categorization from merchant strings. Rules are
`(match_pattern, match_type, category, priority)` rows; they match against a
`merchant_normalized` string computed from each transaction's raw
description. A `category_source` column (manual, rule, or null) keeps rules
from ever overwriting a user's manual category. LLM fallback for unmatched
merchants is deferred to a later phase.

## Phase 5

Phase 5 adds receipts: attach a JPG/PNG receipt image (max 10MB) to a
transaction, store it as a private Vercel Blob, extract line items with
Gemini (`gemini-3.5-flash`, structured JSON output validated by Zod),
review and correct the draft, assign items to people, and save an
item-level split. Extraction failures fall back to manual item entry —
the LLM is never a dead end. Free-tier Gemini may train on prompts;
acceptable for personal receipts in v1, revisit before any multi-user
mode.

## Phase 4

Phase 4 adds people, splits, and settlements: the Person, Split,
SplitShare, and Settlement tables, a pure split engine in `lib/split.ts`
(equal, by-amount, by-percent, with deterministic remainder distribution
and equal tax/tip division), per-person balances on /balances (merged
into /people in phase 6), and settlement recording. Item-level splits
arrive with receipts in phase 5.

It is built in six slices:

1. Schema: the rules table, `merchant_normalized`, and `category_source`,
   plus the Income and Rent categories and a seed rule set.
2. Normalization and the match engine as pure, unit-tested functions.
3. Rules applied automatically during CSV import, surfaced in the preview.
4. A `/rules` page to list, add, edit, and delete rules.
5. A retroactive apply that runs the rules against existing transactions.
6. Inline category edits mark a row `manual`, with a table indicator
   distinguishing rule-applied from manual categories.
