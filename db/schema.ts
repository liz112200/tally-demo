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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Money: every `*_cents` column holds integer THOUSANDTHS of a dollar (mills),
// not cents ($89.40 is 89400), signed, never a float. The name is historical;
// see the Cents type in lib/money.ts.

export const transactionSource = pgEnum('transaction_source', [
  'manual',
  'chase',
  'discover',
  'amex',
  // Synced from a linked bank account (BANK-SYNC.md); the bank is known
  // through bank_account_id.
  'plaid',
]);

// How a categorization rule matches merchant_normalized. Both are
// case-insensitive at match time.
export const matchType = pgEnum('match_type', ['substring', 'regex']);

// Where a transaction's category came from. NULL means never categorized.
// 'bank' is the bank's own category for a synced row, through the owner's
// mapping (bank_category_map); it fills only uncategorized rows, and rules
// overwrite it. Rules only ever touch NULL, 'rule' or 'bank' rows, never
// 'manual'.
export const categorySource = pgEnum('category_source', ['manual', 'rule', 'bank']);

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
  // Whether rows in this category count as spending in Insights and the
  // Expenses summary. False for money moving between the owner's own
  // accounts (Transfers): a card payment from checking is not new spending,
  // the card purchases it pays for already were. Rent counts as spending but
  // is not splittable; nothing can be splittable without counting as
  // spending (CHECK below). Uncategorized rows count as spending.
  countsAsSpending: boolean('counts_as_spending').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  check(
    'categories_splittable_counts_as_spending',
    sql`${table.countsAsSpending} or not ${table.isSplittable}`,
  ),
]);

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

// An account as the owner knows it ("Discover it ••NNNN"), outliving any
// one data source (bank sync slice 7, REAL-ACCOUNTS.md). Its CSV history is
// the rows imported from `csvSource`/`csvAccountLabel`; a Plaid account maps
// onto it, and syncs only rows on or after `cutoverDate`, compared in
// `cutoverBasis` (the date the account's CSV parser records: posted for
// Chase checking, transaction date for Discover and Amex). The cutover is
// what keeps one purchase from arriving from both sources: an account syncs
// only once it is confirmed (`cutoverConfirmedAt`). A ledger account with no
// CSV history has no cutover and syncs its full history.
export const ledgerCutoverBasis = pgEnum('ledger_cutover_basis', ['posted', 'transaction']);

// The owner's mapping from the bank's own categories (Plaid's personal
// finance category, primary level, e.g. FOOD_AND_DRINK) to theirs. Small and
// editable on /rules. A mapped category must count as spending: a transfer
// to a person is TRANSFER_OUT to Plaid, and mapping it to Transfers would
// take real spending out of every total (enforced where the mapping is set).
export const bankCategoryMap = pgTable('bank_category_map', {
  plaidCategory: text('plaid_category').primaryKey(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    csvSource: transactionSource('csv_source'),
    csvAccountLabel: text('csv_account_label'),
    cutoverBasis: ledgerCutoverBasis('cutover_basis').notNull().default('transaction'),
    cutoverDate: date('cutover_date', { mode: 'string' }),
    cutoverConfirmedAt: timestamp('cutover_confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One ledger account per CSV source and label.
    uniqueIndex('ledger_accounts_csv_unique')
      .on(table.csvSource, sql`coalesce(${table.csvAccountLabel}, '')`)
      .where(sql`${table.csvSource} is not null`),
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
  // The ledger account this batch's rows belong to (slice 7); set on confirm
  // from the batch's source and label, and by the one-time backfill for
  // batches imported before.
  ledgerAccountId: uuid('ledger_account_id').references(() => ledgerAccounts.id),
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
    // Every CSV and manual row carries one; the unique index below enforces
    // dedup. The hash is always the canonical value (never salted): a row the
    // user chose to import despite a collision keeps its real hash and is
    // exempted from the index via dedup_exempt instead. Synced rows carry
    // none: provider rows are mutable, so they are identified by the
    // provider's id instead (transactions_one_identity below).
    dedupHash: text('dedup_hash'),
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
    // Synced rows only: the linked account the row came from, the provider's
    // id for it (unique per account), and the provider's object as received,
    // numbers as their source text (debugging; later slices read its dates
    // and category).
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'restrict',
    }),
    providerTransactionId: text('provider_transaction_id'),
    providerRaw: jsonb('provider_raw'),
    // Synced rows only (CHECK below), all three set by sync (BANK-SYNC.md).
    // A pending row is provisional: never splittable, no receipt, left out of
    // spending totals; its posted row takes it over in place.
    pending: boolean('pending').notNull().default(false),
    // Set when the bank changes the amount of a row that has a split: the
    // amount the split was built on (the first, if it changes again). The
    // shares are kept as they were, so until the owner re-saves or removes
    // the split, or dismisses this, they may not sum to the amount.
    bankAmountBeforeCents: bigint('bank_amount_before_cents', { mode: 'number' }),
    // When the bank removed the row. On a live row it is a flag: the owner
    // had built on it (split, receipt, note, manual category), so sync kept
    // it. On a soft-deleted row it marks sync, not the owner, as the deleter,
    // so a later takeover by the posted row may revive it.
    removedByBankAt: timestamp('removed_by_bank_at', { withTimezone: true }),
    // Free-text user annotation, independent of the bank description. NULL
    // means no note. Never touched by import or dedup (not part of the
    // hash); purely for the owner's own reference.
    note: text('note'),
    // A manual row the owner paid off-card alongside another transaction
    // (PAID-ALONGSIDE.md): cash for gas on a trip next to its car rental.
    // Context only, never read for an amount; manual rows only (CHECK).
    alongsideTransactionId: uuid('alongside_transaction_id').references((): AnyPgColumn => transactions.id, {
      onDelete: 'set null',
    }),
    // Soft delete. Splits, shares, and receipts referencing a deleted
    // transaction stay in the database unchanged, but every read path —
    // including balance derivation via share history — filters them out.
    // The dedup_hash row survives, so a re-import cannot resurrect a
    // deleted row. Restore/hard-delete UI is deferred.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Deleted by undoing its import, not on its own: Restore brings back
    // exactly these rows. Recorded rather than inferred from a deleted_at
    // shared with the import, which went wrong twice (microseconds lost
    // through a JS Date; a second Undo re-stamping the import).
    deletedByUndo: boolean('deleted_by_undo').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transactions_dedup_hash_unique')
      .on(table.dedupHash)
      .where(sql`${table.dedupHash} is not null and ${table.dedupExempt} = false`),
    uniqueIndex('transactions_provider_unique')
      .on(table.bankAccountId, table.providerTransactionId)
      .where(sql`${table.providerTransactionId} is not null`),
    // A category always records where it came from: a rule or the owner.
    // A NULL source reads as "never categorized", which a rule may overwrite,
    // so a category without a source would be an owner's choice left
    // unprotected (migration 0022 backfilled the rows that predated
    // category_source).
    check(
      'transactions_category_has_source',
      sql`${table.categoryId} is null or ${table.categorySource} is not null`,
    ),
    check(
      'transactions_alongside_is_manual',
      sql`${table.alongsideTransactionId} is null or ${table.source} = 'manual'`,
    ),
    // Exactly one identity: a content hash (CSV and manual rows) or a
    // provider id with its account (synced rows), never both or neither.
    check(
      'transactions_one_identity',
      sql`(${table.dedupHash} is not null and ${table.providerTransactionId} is null and ${table.bankAccountId} is null)
        or (${table.dedupHash} is null and ${table.providerTransactionId} is not null and ${table.bankAccountId} is not null)`,
    ),
    check(
      'transactions_undo_marks_deleted_import_rows',
      sql`not ${table.deletedByUndo} or (${table.deletedAt} is not null and ${table.importId} is not null)`,
    ),
    check(
      'transactions_bank_state_synced_only',
      sql`${table.providerTransactionId} is not null
        or (not ${table.pending} and ${table.bankAmountBeforeCents} is null and ${table.removedByBankAt} is null)`,
    ),
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

// Which bank-data provider a connection belongs to (BANK-SYNC.md). The demo's
// synthetic provider joins this enum in its own slice.
export const bankProvider = pgEnum('bank_provider', ['plaid']);

// Whether a connection syncs (BANK-SYNC.md, slice 4). `paused` stops syncing
// and keeps the token, reversibly; `removed` is a deliberate disconnect:
// Plaid's access ended with /item/remove and the token is erased, so it can
// never become active again (CHECK below).
export const bankConnectionStatus = pgEnum('bank_connection_status', [
  'active',
  'paused',
  'removed',
]);

// One linked bank login: a Plaid Item, which may hold several accounts.
// Never hard-deleted: on Plaid's Trial plan an Item's slot is spent for good
// once created, and removing it does not return the slot, so these rows are
// also the ledger of the Item budget (CLAUDE.md). A trigger in migration 0019
// refuses DELETE outright; removal only changes the status.
export const bankConnections = pgTable(
  'bank_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: bankProvider('provider').notNull(),
    // Plaid's item_id. Also the associated data the access token is sealed
    // with, so a sealed token copied onto another row will not open.
    providerItemId: text('provider_item_id').notNull(),
    institutionId: text('institution_id'),
    institutionName: text('institution_name'),
    // The access token, sealed with BANK_TOKEN_KEY (lib/token-crypto.ts).
    // Never stored or sent anywhere in the clear. NULL exactly when removed.
    accessTokenSealed: text('access_token_sealed'),
    status: bankConnectionStatus('status').notNull().default('active'),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    // The Item's health as the provider last reported it: its error code
    // (NULL = no error; lib/bank-sync/item-health.ts says what each means to
    // the owner), when its consent ends if the institution sets one, and when
    // this was last read.
    itemErrorCode: text('item_error_code'),
    consentExpiresAt: timestamp('consent_expires_at', { withTimezone: true }),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('bank_connections_provider_item_unique').on(
      table.provider,
      table.providerItemId,
    ),
    check(
      'bank_connections_removed_state',
      sql`(${table.status} = 'removed') = (${table.accessTokenSealed} is null)
        and (${table.status} = 'removed') = (${table.removedAt} is not null)`,
    ),
  ],
);

// An account under a connection, as the provider reported it at link time.
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Restrict: an account outlives nothing it belongs to, and connections
    // are never deleted anyway.
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => bankConnections.id, { onDelete: 'restrict' }),
    providerAccountId: text('provider_account_id').notNull(),
    // Stable across re-links at institutions that tokenize account numbers
    // (Chase, PNC, US Bank), where provider_account_id can change.
    persistentAccountId: text('persistent_account_id'),
    name: text('name').notNull(),
    officialName: text('official_name'),
    // Last 2-4 characters of the account number; not unique within a login.
    mask: text('mask'),
    type: text('type').notNull(),
    subtype: text('subtype'),
    // Opt-in: a login returns every account at the institution (mortgages and
    // retirement accounts included), and nothing syncs until the owner picks.
    // Only depository and credit accounts can be enabled (CHECK below).
    syncEnabled: boolean('sync_enabled').notNull().default(false),
    // Per-account sync state. Plaid keeps one cursor per account when a sync
    // is filtered to it, so a disabled account is never fetched and enabling
    // it later still starts from its full history. NULL cursor = never synced.
    syncCursor: text('sync_cursor'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    // Set when the provider stops returning the account (de-selected in
    // Link's account selection, or closed); cleared if it comes back. Its
    // rows stay in the ledger. An unshared account cannot sync (CHECK).
    unsharedAt: timestamp('unshared_at', { withTimezone: true }),
    // The ledger account this Plaid account syncs into (slice 7). Required
    // to sync (CHECK below); fixed once the account has synced.
    ledgerAccountId: uuid('ledger_account_id').references(() => ledgerAccounts.id),
    // Sign verification against a statement (REAL-ACCOUNTS.md): until set,
    // the account's synced rows do not count (not splittable, not in any
    // total). `verification` keeps the statement period and the figures
    // compared.
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verification: jsonb('verification'),
    // The one-time boundary review after the first sync, once dismissed.
    boundaryReviewedAt: timestamp('boundary_reviewed_at', { withTimezone: true }),
    // Set on an account that looks like a recorded one under a new id (a
    // re-issued account id, REAL-ACCOUNTS.md): the same persistent id, or the
    // same type and mask as an account the same reload marked unshared. It
    // cannot sync until the owner adopts it (it joins that account's ledger
    // account after its last synced row) or says it is a different account.
    replacesAccountId: uuid('replaces_account_id').references((): AnyPgColumn => bankAccounts.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One syncing Plaid account per ledger account: two would deliver the
    // same purchases twice.
    uniqueIndex('bank_accounts_one_syncing_per_ledger')
      .on(table.ledgerAccountId)
      .where(sql`${table.syncEnabled}`),
    check('bank_accounts_sync_needs_ledger', sql`not ${table.syncEnabled} or ${table.ledgerAccountId} is not null`),
    uniqueIndex('bank_accounts_connection_account_unique').on(
      table.connectionId,
      table.providerAccountId,
    ),
    check(
      'bank_accounts_sync_expense_types',
      sql`not ${table.syncEnabled} or ${table.type} in ('depository', 'credit')`,
    ),
    check(
      'bank_accounts_sync_shared_only',
      sql`not ${table.syncEnabled} or ${table.unsharedAt} is null`,
    ),
  ],
);

// ---- Authentication (bank sync slice 6, AUTH.md) ----

// A person who can sign in. One today, the owner; a second user later is
// another row (invitations, AUTH.md), with nothing here changing. `personId`
// links a user to the ledger's person for them: the owner user to the owner
// person, so "who is signed in" and "whose balances these are" are one join.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  personId: uuid('person_id').references(() => persons.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // A disabled user's sessions are refused; set by hand until there is UI.
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

// A passkey. `id` is the WebAuthn credential id (base64url); the public key
// verifies each sign-in, and the counter, when an authenticator keeps one,
// must only grow. Bound to the relying party (the production hostname): a
// passkey made on one hostname cannot sign in on another.
export const passkeyCredentials = pgTable(
  'passkey_credentials',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>(),
    deviceLabel: text('device_label').notNull(),
    // Whether the passkey can be backed up (multiDevice) and is: what made
    // it, not where it can be used. The AAGUID names the passkey provider
    // that made it (iCloud Keychain, Google Password Manager…) when the
    // provider reports one; all zeros when it does not.
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    aaguid: text('aaguid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [index('passkey_credentials_user_idx').on(table.userId)],
);

// A signed-in browser. The cookie holds a random token; only its sha256 is
// stored, so a database leak opens no session. Expiry slides with use and is
// judged by Postgres's clock. Revoking (sign out, or from another device)
// keeps the row as a record.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

// A WebAuthn challenge awaiting its answer: single use (consumed by
// deleting it) and short-lived. `purpose` says which ceremony it belongs to,
// and `userId` the user a registration adds a passkey to (null for the
// bootstrap registration and for sign-in, where the passkey names the user).
export const authPurpose = pgEnum('auth_purpose', ['bootstrap', 'add_device', 'sign_in']);

export const authChallenges = pgTable('auth_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  challenge: text('challenge').notNull(),
  purpose: authPurpose('purpose').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// Synced rows that were not inserted (slice 7), never counted: those dated
// before their ledger account's cutover (`before_cutover`), and those in the
// first days after it that match a CSV row of the same account by amount and
// date (`possible_duplicate`), held until the owner says whether they are
// the same purchase (`resolution`). Kept for the sign verification (a
// statement period can lie before the cutover) and the boundary review.
export const syncSkippedRows = pgTable(
  'sync_skipped_rows',
  {
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id),
    providerTransactionId: text('provider_transaction_id').notNull(),
    // The ledger date (authorized ?? posted) and the posted date statements
    // group by.
    date: date('date', { mode: 'string' }).notNull(),
    postedDate: date('posted_date', { mode: 'string' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    descriptionRaw: text('description_raw').notNull(),
    pending: boolean('pending').notNull(),
    reason: text('reason').$type<'before_cutover' | 'possible_duplicate'>().notNull(),
    // For a held possible duplicate: the owner's answer. 'released' rows were
    // inserted as transactions; 'same' rows stay out.
    resolution: text('resolution').$type<'same' | 'released'>(),
    providerRaw: jsonb('provider_raw').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.bankAccountId, table.providerTransactionId] }),
    check('sync_skipped_rows_reason', sql`${table.reason} in ('before_cutover', 'possible_duplicate')`),
    check(
      'sync_skipped_rows_resolution',
      sql`${table.resolution} is null or (${table.reason} = 'possible_duplicate' and ${table.resolution} in ('same', 'released'))`,
    ),
  ],
);

