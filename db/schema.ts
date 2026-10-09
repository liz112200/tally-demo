import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  date,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const transactionSource = pgEnum('transaction_source', [
  'manual',
  'chase',
  'discover',
  'amex',
]);

// How a categorization rule matches merchant_normalized. Both are
// case-insensitive at match time.
export const matchType = pgEnum('match_type', ['substring', 'regex']);

// Where a transaction's category came from. NULL means never categorized;
// rules only ever touch NULL or 'rule' rows, never 'manual'.
export const categorySource = pgEnum('category_source', ['manual', 'rule']);

// How a split divides a transaction. 'item' derives shares from receipt
// line-item assignments instead of a direct method input.
export const splitMethod = pgEnum('split_method', [
  'equal',
  'amount',
  'percent',
  'item',
]);

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  color: text('color'),
  // Transactions inherit this: rows in a non-splittable category (Rent,
  // Income) are hidden from the split editor. Uncategorized rows count as
  // splittable.
  isSplittable: boolean('is_splittable').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // The owner is a Person too; their share of a split is their own portion
    // of the expense, never a debt. Exactly one owner row exists (partial
    // unique index below).
    isOwner: boolean('is_owner').notNull().default(false),
    // Soft delete: hard-deleting would orphan split_shares. Deleted persons
    // keep their history (rendered as deleted) but are hidden from new-split
    // and settlement UI.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('persons_single_owner')
      .on(table.isOwner)
      .where(sql`${table.isOwner} = true`),
  ],
);

export const splits = pgTable('splits', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Transaction:Split is 1:0-or-1 for owner-paid splits; no Split row on a
  // transaction means that expense is entirely the owner's. NULL here marks
  // an "external split": an expense someone else paid that the owner owes a
  // share of, with no backing bank transaction (payer_person_id names who
  // paid). unique() still forbids two splits on the same transaction; NULLs
  // do not collide in a Postgres unique index, so external splits coexist.
  transactionId: uuid('transaction_id')
    .unique()
    .references(() => transactions.id, { onDelete: 'cascade' }),
  // Who paid the expense. Defaults (at the application layer) to the owner
  // Person: an owner-paid split's non-owner shares are debts owed TO the
  // owner. An external split sets this to the non-owner who paid, and its
  // single owner share is a debt the owner owes THEM. The owner may never be
  // the payer of a transaction_id-less external split (that is just a normal
  // owner-paid split) — enforced by the Zod schema and the query layer, not a
  // CHECK, because a CHECK cannot reference the owner's id portably.
  payerPersonId: uuid('payer_person_id')
    .notNull()
    .references(() => persons.id),
  // External-split-only: an expense with no backing transaction still needs a
  // date and a label to show on /people and to order FIFO by. Both stay NULL
  // for owner-paid splits, whose date/description come from the transaction.
  date: date('date', { mode: 'string' }),
  description: text('description'),
  method: splitMethod('method').notNull(),
  // Tax and tip are carved out of the transaction total, divided equally
  // among all participants regardless of method, and added back onto each
  // person's method share.
  taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
  tipCents: bigint('tip_cents', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const splitShares = pgTable('split_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  splitId: uuid('split_id')
    .notNull()
    .references(() => splits.id, { onDelete: 'cascade' }),
  personId: uuid('person_id')
    .notNull()
    .references(() => persons.id),
  // The resolved owed amount computed by the split engine; shares of a split
  // always sum to abs(transaction.amount_cents) exactly.
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  // Raw inputs preserved for editing: the entered dollar amount for
  // method='amount', the entered whole-number percent for method='percent'.
  // Percents are integers so share math never touches floats.
  inputAmountCents: bigint('input_amount_cents', { mode: 'number' }),
  inputPercent: integer('input_percent'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Receipt : Transaction is 1:0-or-1; a receipt must belong to a transaction
// (orphan receipts are deferred). Extracted values live in typed columns —
// the LLM output is a first draft the user reviews and edits — while the
// raw model response is kept as jsonb for debugging. All *_cents columns
// default 0 so a failed extraction can persist an empty receipt for the
// manual-entry path.
export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id')
    .notNull()
    .unique()
    .references(() => transactions.id, { onDelete: 'cascade' }),
  // The primary (first) image's private blob URL, kept denormalized here so
  // this column stays NOT NULL. The full ordered set of images — a receipt
  // can now be several photos/screenshots of one order — lives in
  // receipt_images; display and deletion iterate that.
  blobUrl: text('blob_url').notNull(),
  merchantExtracted: text('merchant_extracted').notNull().default(''),
  dateExtracted: date('date_extracted', { mode: 'string' }),
  subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
  taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
  tipCents: bigint('tip_cents', { mode: 'number' }).notNull().default(0),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
  // Optional user note recorded when saving despite a receipt-total vs
  // transaction-amount mismatch (e.g. "tip added after printing").
  mismatchNote: text('mismatch_note'),
  rawLlmResponse: jsonb('raw_llm_response'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A receipt's images, one row per uploaded photo/screenshot, in upload
// order. Every receipt has at least one (position 0, mirrored in
// receipts.blob_url). Multi-page receipts and multi-screenshot app orders
// add more. Cascade-deleted with the receipt; blobs are swept separately.
export const receiptImages = pgTable('receipt_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  receiptId: uuid('receipt_id')
    .notNull()
    .references(() => receipts.id, { onDelete: 'cascade' }),
  blobUrl: text('blob_url').notNull(),
  position: integer('position').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const receiptItems = pgTable('receipt_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  receiptId: uuid('receipt_id')
    .notNull()
    .references(() => receipts.id, { onDelete: 'cascade' }),
  // Stable display order matching the paper receipt.
  position: integer('position').notNull(),
  description: text('description').notNull(),
  // Display-only context (e.g. "2" or a weight like 0.62); money math only
  // ever reads amount_cents, the line total, so the float invariant holds.
  quantity: real('quantity').notNull().default(1),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Item : Person is many-to-many; an item split equally among its assignees.
// Items with no assignment row count as the owner's.
export const receiptItemAssignments = pgTable(
  'receipt_item_assignments',
  {
    receiptItemId: uuid('receipt_item_id')
      .notNull()
      .references(() => receiptItems.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
  },
  (table) => [primaryKey({ columns: [table.receiptItemId, table.personId] })],
);

// A settlement's direction, locked at creation (never edited). 'incoming' is
// a payment the person made to the owner (they paid me), reducing what they
// owe; 'outgoing' is a payment the owner made to the person (I paid them),
// reducing what the owner owes them. Existing rows backfill to 'incoming'.
export const settlementDirection = pgEnum('settlement_direction', [
  'incoming',
  'outgoing',
]);

export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    // Always positive: the magnitude of a payment. Which way it moves money is
    // carried by `direction`, and it is FIFO-allocated to specific shares in
    // that direction via settlement_allocations.
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    direction: settlementDirection('direction').notNull().default('incoming'),
    date: date('date', { mode: 'string' }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Settlements recorded together as one netted payment share a group:
    // the cash actually paid (net direction) plus an offset pair. NULL for a
    // settlement recorded on its own. A group is deleted and edited as a unit.
    groupId: uuid('group_id'),
    // An offset half moves no money. It is paired with an opposite-direction
    // offset of the same amount in its group, and the two cancel debts both
    // ways; balances treat each half as an ordinary settlement.
    isOffset: boolean('is_offset').notNull().default(false),
  },
  (table) => [
    index('settlements_group_id_idx').on(table.groupId),
    check(
      'settlements_offset_has_group',
      sql`NOT ${table.isOffset} OR ${table.groupId} IS NOT NULL`,
    ),
  ],
);

// FIFO allocation of a settlement to the specific shares it pays down.
// amount_cents is the portion of the settlement applied to that share; a
// share's status (outstanding/partial/settled) derives from the sum of its
// allocations, and a settlement's unallocated remainder (amount minus its
// allocations) carries forward as credit to the next share in the same
// direction with the same person. Cascade both ways: hard-deleting a
// settlement drops its allocations; deleting a share (external-split delete)
// drops allocations against it, returning that amount to the settlement's
// unallocated pool. Soft-deleted transactions do not delete allocation rows —
// read paths ignore allocations whose share's transaction is soft-deleted.
export const settlementAllocations = pgTable(
  'settlement_allocations',
  {
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id, { onDelete: 'cascade' }),
    splitShareId: uuid('split_share_id')
      .notNull()
      .references(() => splitShares.id, { onDelete: 'cascade' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.settlementId, table.splitShareId] }),
  ],
);

// One row per CSV upload batch. filename is the original upload name; NULL
// identifies the synthetic "Backfilled <source>" imports created by
// migration 0008 for pre-phase-7 rows (real uploads always carry a name).
// row_count is the number of transactions actually inserted (dedup skips
// excluded). Soft-deleted like transactions: "undo import" sets deleted_at
// here and on every transaction in the batch.
export const imports = pgTable('imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: transactionSource('source').notNull(),
  filename: text('filename'),
  // Standardized display label shown on the group header, generated on
  // confirm as "<Source> <MM/DD> – <MM/DD>" (or "<Source> (backfilled)").
  // The raw filename stays in `filename`; the user can rename this freely.
  // NULL falls back to filename, then to "Untitled import".
  displayName: text('display_name'),
  importedAt: timestamp('imported_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  rowCount: integer('row_count').notNull(),
  // Whether this batch is hidden from the Expenses list (its header and rows
  // drop out of the view; the hidden strip below the table unhides it).
  // Persisted here rather than in the URL so hiding survives reloads and
  // deployments and keeps the URL clean. Distinct from deletedAt (undo
  // import) and from client-side collapse (which keeps the header).
  hidden: boolean('hidden').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: date('date', { mode: 'string' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    descriptionRaw: text('description_raw').notNull(),
    categoryId: uuid('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    source: transactionSource('source').notNull().default('manual'),
    // The CSV upload batch this row arrived in; NULL for manual entries.
    // Pre-phase-7 imported rows were attached to synthetic backfill imports
    // by migration 0008.
    importId: uuid('import_id').references(() => imports.id),
    // Which card/account the row came from, when the export exposes it. Often
    // null for phase-2 CSVs (Chase/Discover rarely carry it); kept so the dedup
    // key can distinguish two cards at the same bank once it is populated.
    accountLabel: text('account_label'),
    // sha256 over (source, account_label, date, amount_cents, description_raw).
    // Every row carries one; the unique index below enforces dedup. The hash
    // is always the canonical value (never salted): a row the user chose to
    // import despite a collision keeps its real hash and is exempted from the
    // index via dedup_exempt instead.
    dedupHash: text('dedup_hash').notNull(),
    // Set when the user deliberately imported a row that collided with an
    // existing dedup_hash (a legitimate repeat purchase, or re-adding data
    // whose original was soft-deleted). Exempt rows are excluded from the
    // unique index, so they coexist with the row they duplicate while still
    // carrying their true hash. Normal rows are false and dedup as before.
    dedupExempt: boolean('dedup_exempt').notNull().default(false),
    // Canonical merchant string that categorization rules match against
    // (upper-cased, whitespace-collapsed, phone/date/city-state stripped).
    // Computed from description_raw on insert; every row carries one.
    merchantNormalized: text('merchant_normalized').notNull(),
    // Provenance of category_id. NULL = never categorized (rules may apply);
    // 'rule' = set by a categorization rule (rules may re-apply); 'manual' =
    // set by the user (rules never overwrite).
    categorySource: categorySource('category_source'),
    // Free-text user annotation, independent of the bank description. NULL
    // means no note. Never touched by import or dedup (not part of the
    // hash); purely for the owner's own reference.
    note: text('note'),
    // Soft delete. Splits, shares, and receipts referencing a deleted
    // transaction stay in the database unchanged, but every read path —
    // including balance derivation via share history — filters them out.
    // The dedup_hash row survives, so a re-import cannot resurrect a
    // deleted row. Restore/hard-delete UI is deferred.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transactions_dedup_hash_unique')
      .on(table.dedupHash)
      .where(sql`${table.dedupHash} is not null and ${table.dedupExempt} = false`),
  ],
);

export const categorizationRules = pgTable(
  'categorization_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchPattern: text('match_pattern').notNull(),
    matchType: matchType('match_type').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    // Lower priority wins; ties break by created_at ascending.
    priority: integer('priority').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A given pattern+type is one rule; editing changes its category/priority.
    uniqueIndex('categorization_rules_pattern_type_unique').on(
      table.matchPattern,
      table.matchType,
    ),
  ],
);

// A snapshot of one person's outstanding list, published at a short
// unguessable token so it can be sent in a text message that would
// otherwise be far too long. Deliberately a snapshot rather than a live
// view: the page shows what was actually sent, and a link handed out today
// can never expose expenses added tomorrow.
//
// This is the app's only unauthenticated read surface. It carries no ids
// that address anything else — the payload is denormalized display text —
// so possessing a token reveals that one list and nothing more.
export const shareLinks = pgTable('share_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  // URL path segment. Random, not derived from any row id, so links cannot
  // be enumerated or guessed from a person id.
  token: text('token').notNull().unique(),
  // Names are copied, not referenced: the person may later be renamed or
  // soft-deleted, and the snapshot should still read as it was sent.
  personName: text('person_name').notNull(),
  // 'they-owe-me' or 'i-owe-them', matching the summary builder.
  direction: text('direction').notNull(),
  // What the person owes the owner, and the lines behind it.
  totalCents: integer('total_cents').notNull(),
  // The rendered lines: [{ date, description, outstandingCents, category }].
  lines: jsonb('lines').notNull(),
  // The other direction: what the owner owes them. A snapshot covers both
  // sides, because a balance the recipient can act on is the net, not one
  // column of it. Defaulted so the columns are additive over existing rows.
  owingCents: integer('owing_cents').notNull().default(0),
  owingLines: jsonb('owing_lines').notNull().default([]),
  // Whether the snapshot was grouped by category when it was shared.
  groupedByCategory: boolean('grouped_by_category').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Reserved for a revoke affordance; read paths already treat a non-null
  // value as gone, so revocation can ship without a migration.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
