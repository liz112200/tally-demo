import 'server-only';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { db } from './index';
import {
  bankAccounts,
  bankCategoryMap,
  ledgerAccounts,
  syncSkippedRows,
  bankConnections,
  categories,
  categorizationRules,
  imports,
  persons,
  receiptImages,
  receiptItemAssignments,
  receiptItems,
  receipts,
  settlementAllocations,
  settlements,
  shareLinks,
  splits,
  splitShares,
  transactions,
} from './schema';
import { dedupHash } from '@/lib/parsers/dedup';
import { normalizeMerchant } from '@/lib/parsers/normalize';
import { categorize, ruleOutcome, type CategoryRule } from '@/lib/categorize';
import { allocateFifo } from '@/lib/allocations';
import { planNetting, type Alloc } from '@/lib/netting';
import { formatUSD, toCents } from '@/lib/money';
import { planSync, referencedPendingIds, type StoredRow, type SyncCounts } from '@/lib/bank-sync/plan';
import { BOUNDARY_DAYS, MATCH_DAYS, splitAtCutover, type Cutover } from '@/lib/bank-sync/cutover';
import type { ProviderTransaction, RemovedTransaction } from '@/lib/bank-sync/provider';
import type { InsightRow } from '@/lib/insights';

type TransactionSource = (typeof transactions.source.enumValues)[number];
type CategorySource = (typeof transactions.categorySource.enumValues)[number];
type MatchType = (typeof categorizationRules.matchType.enumValues)[number];

export type RuleRow = {
  id: string;
  matchPattern: string;
  matchType: MatchType;
  categoryId: string;
  categoryName: string;
  priority: number;
  createdAt: Date;
};

// Rules with their category name, ordered the way the engine resolves them
// (priority ascending, then created_at ascending).
export async function getRules(): Promise<RuleRow[]> {
  return db
    .select({
      id: categorizationRules.id,
      matchPattern: categorizationRules.matchPattern,
      matchType: categorizationRules.matchType,
      categoryId: categorizationRules.categoryId,
      categoryName: categories.name,
      priority: categorizationRules.priority,
      createdAt: categorizationRules.createdAt,
    })
    .from(categorizationRules)
    .innerJoin(categories, eq(categorizationRules.categoryId, categories.id))
    .orderBy(categorizationRules.priority, categorizationRules.createdAt);
}

export type TransactionRow = {
  id: string;
  date: string;
  amountCents: number;
  descriptionRaw: string;
  categoryId: string | null;
  categoryName: string | null;
  source: string;
  categorySource: CategorySource | null;
  // The upload batch this row belongs to; null for manual entries.
  importId: string | null;
  // The linked account a synced row came from; null for CSV and manual rows.
  bankAccountId: string | null;
  // Free-text user annotation; null when none.
  note: string | null;
  // Resolved from the category (uncategorized counts as splittable), the
  // sign (refunds/credits are never splittable) and pending (never).
  isSplittable: boolean;
  // Resolved from the category (uncategorized counts): false for Transfers,
  // whose rows stay out of the view's spending and credit totals.
  countsAsSpending: boolean;
  // Bank-sync state (BANK-SYNC.md); false/null on CSV and manual rows.
  pending: boolean;
  // A synced row whose bank account is not yet verified against a statement
  // (REAL-ACCOUNTS.md): not splittable and in no total until it is. Always
  // false for CSV and manual rows.
  unverified: boolean;
  // The amount the split was built on, when the bank has since changed it.
  bankAmountBeforeCents: number | null;
  // Set when the bank removed a row the owner had built on.
  removedByBankAt: Date | null;
};

export async function getTransactions(): Promise<TransactionRow[]> {
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      descriptionRaw: transactions.descriptionRaw,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      source: transactions.source,
      categorySource: transactions.categorySource,
      importId: transactions.importId,
      bankAccountId: transactions.bankAccountId,
      note: transactions.note,
      categoryIsSplittable: categories.isSplittable,
      categoryCountsAsSpending: categories.countsAsSpending,
      pending: transactions.pending,
      bankAmountBeforeCents: transactions.bankAmountBeforeCents,
      removedByBankAt: transactions.removedByBankAt,
      unverified: sql<boolean>`(${transactions.bankAccountId} is not null and ${bankAccounts.verifiedAt} is null)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(bankAccounts, eq(bankAccounts.id, transactions.bankAccountId))
    .where(isNull(transactions.deletedAt))
    .orderBy(desc(transactions.date), desc(transactions.createdAt));
  return rows.map(({ categoryIsSplittable, categoryCountsAsSpending, ...row }) => ({
    ...row,
    isSplittable: !row.pending && !row.unverified && row.amountCents > 0 && (categoryIsSplittable ?? true),
    countsAsSpending: categoryCountsAsSpending ?? true,
  }));
}

export async function getCategories() {
  return db.select().from(categories).orderBy(categories.name);
}

// Create a category. Names are unique; onConflictDoNothing turns a repeat
// into a no-op so the caller can report "already exists" instead of a 500.
// `created` is false when the name was taken.
export async function insertCategory(input: {
  name: string;
  isSplittable: boolean;
  countsAsSpending: boolean;
}): Promise<{ created: boolean }> {
  const rows = await db
    .insert(categories)
    .values({
      name: input.name,
      isSplittable: input.isSplittable,
      countsAsSpending: input.countsAsSpending,
    })
    .onConflictDoNothing({ target: categories.name })
    .returning({ id: categories.id });
  return { created: rows.length > 0 };
}

export async function insertRule(input: {
  matchPattern: string;
  matchType: MatchType;
  categoryId: string;
  priority: number;
}): Promise<void> {
  await db.insert(categorizationRules).values(input);
}

export async function updateRuleById(
  id: string,
  input: {
    matchPattern: string;
    matchType: MatchType;
    categoryId: string;
    priority: number;
  },
): Promise<void> {
  await db
    .update(categorizationRules)
    .set(input)
    .where(eq(categorizationRules.id, id));
}

export async function deleteRuleById(id: string): Promise<{ matchPattern: string } | null> {
  const [row] = await db
    .delete(categorizationRules)
    .where(eq(categorizationRules.id, id))
    .returning({ matchPattern: categorizationRules.matchPattern });
  return row ?? null;
}

// Re-run the rule set against existing transactions. Only rows that are
// uncategorized (category_source NULL) or previously rule-set ('rule') are
// touched; 'manual' rows are never overwritten. A row that matches is set to
// the winning category with source 'rule'; a previously-'rule' row that no
// longer matches any rule is cleared. Returns counts for the caller to report.
// Re-run every rule over the rows rules may touch (uncategorized, 'rule' and
// 'bank' rows; manual rows are the owner's). A synced row no rule matches
// takes the owner's category for the bank's own (bank_category_map), as
// 'bank'. One transaction: the candidate rows are locked first (FOR UPDATE,
// by id) and only then is it read whether each has a split, so a split saved
// meanwhile is seen, and ruleOutcome (lib/categorize.ts) never moves a split
// row into a category that is not splittable. Returns how many rows a rule
// matched, how many took the bank's category, how many matched neither, and
// how many manual rows were left alone.
export async function applyRulesToExisting(): Promise<{
  matched: number;
  bank: number;
  unmatched: number;
  skippedManual: number;
}> {
  const rules = await getRules();
  const engineRules: CategoryRule[] = rules.map((r) => ({
    categoryId: r.categoryId,
    matchPattern: r.matchPattern,
    matchType: r.matchType,
    priority: r.priority,
    createdAt: r.createdAt,
  }));

  return db.transaction(async (tx) => {
    const eligible = and(
      isNull(transactions.deletedAt),
      or(isNull(transactions.categorySource), inArray(transactions.categorySource, ['rule', 'bank'])),
    );
    await tx.execute(sql`select id from ${transactions} where ${eligible} order by id for update`);
    const candidates = await tx
      .select({
        id: transactions.id,
        merchantNormalized: transactions.merchantNormalized,
        categoryId: transactions.categoryId,
        categorySource: transactions.categorySource,
        hasSplit: rowHasSplit(),
        bankCategory: sql<string | null>`${transactions.providerRaw}->'personal_finance_category'->>'primary'`,
      })
      .from(transactions)
      .where(eligible);
    const bankMap = await bankCategoryMapOf(tx);
    const nonSplittable = new Set(
      (await tx.select({ id: categories.id }).from(categories).where(eq(categories.isSplittable, false))).map(
        (c) => c.id,
      ),
    );
    const [{ value: skippedManual }] = await tx
      .select({ value: count() })
      .from(transactions)
      .where(and(isNull(transactions.deletedAt), eq(transactions.categorySource, 'manual')));

    let matched = 0;
    let bank = 0;
    let unmatched = 0;
    for (const row of candidates) {
      const categoryId = categorize(row.merchantNormalized, engineRules);
      const fallback = row.bankCategory ? (bankMap.get(row.bankCategory) ?? null) : null;
      if (categoryId) matched += 1;
      else if (fallback) bank += 1;
      else unmatched += 1;
      const next = ruleOutcome(row, categoryId, (id) => !nonSplittable.has(id), fallback);
      if (next) await tx.update(transactions).set(next).where(eq(transactions.id, row.id));
    }
    return { matched, bank, unmatched, skippedManual };
  });
}

// The owner's category for each of the bank's own (bank_category_map).
export async function bankCategoryMapOf(conn: Pick<Tx, 'select'> = db): Promise<Map<string, string>> {
  const rows = await conn
    .select({ plaidCategory: bankCategoryMap.plaidCategory, categoryId: bankCategoryMap.categoryId })
    .from(bankCategoryMap);
  return new Map(rows.map((r) => [r.plaidCategory, r.categoryId]));
}

// Shared insert path for both manual entry and import. Computes the dedup_hash
// and relies on the partial unique index to drop duplicates: onConflictDoNothing
// makes a re-inserted row a no-op instead of an error. Returns whether a row was
// actually written so callers (e.g. import confirm) can count inserted vs
// skipped. `source` defaults to 'manual' and `accountLabel` to null.
export async function insertTransaction(input: {
  date: string;
  amountCents: number;
  descriptionRaw: string;
  categoryId: string | null;
  source?: TransactionSource;
  accountLabel?: string | null;
  categorySource?: CategorySource | null;
  importId?: string | null;
  // Optional free-text note (manual entry only; imports never set one).
  note?: string | null;
  // Force a row past the dedup index (user approved a collision in the
  // import preview). The row keeps its canonical hash but sets
  // dedup_exempt, so it is not in the unique index and always inserts.
  dedupExempt?: boolean;
}): Promise<{ inserted: boolean }> {
  const source: TransactionSource = input.source ?? 'manual';
  const accountLabel = input.accountLabel ?? null;
  const hash = dedupHash({
    source,
    accountLabel,
    date: input.date,
    amountCents: input.amountCents,
    descriptionRaw: input.descriptionRaw,
  });

  const rows = await db
    .insert(transactions)
    .values({
      date: input.date,
      amountCents: input.amountCents,
      descriptionRaw: input.descriptionRaw,
      categoryId: input.categoryId,
      source,
      accountLabel,
      dedupHash: hash,
      dedupExempt: input.dedupExempt ?? false,
      merchantNormalized: normalizeMerchant(input.descriptionRaw),
      // A category given without a source is the owner's choice (manual
      // entry); imports always pass 'rule' explicitly. Never NULL with a
      // category: that would read as uncategorized and let a rule overwrite
      // it (CHECK transactions_category_has_source).
      categorySource: input.categoryId ? (input.categorySource ?? 'manual') : null,
      importId: input.importId ?? null,
      note: input.note ?? null,
    })
    // The arbiter is the partial unique index, whose predicate now excludes
    // exempt rows — so a forced (exempt) insert never conflicts and always
    // lands, while a normal insert still no-ops on a live collision.
    .onConflictDoNothing({
      target: transactions.dedupHash,
      where: sql`${transactions.dedupHash} is not null and ${transactions.dedupExempt} = false`,
    })
    .returning({ id: transactions.id });

  return { inserted: rows.length > 0 };
}

// Whether an incoming row is a duplicate: for each hash that already exists
// as an index-blocking (non-exempt) row, report if that existing row is
// soft-deleted. A hash absent from the result is new. Only non-exempt rows
// can block a normal insert, so exempt rows (past intentional duplicates)
// are ignored — a hash that only matches exempt rows imports as new.
export async function lookupDedupStatus(
  hashes: string[],
): Promise<Record<string, { deleted: boolean }>> {
  if (hashes.length === 0) return {};
  const rows = await db
    .select({ dedupHash: transactions.dedupHash, deletedAt: transactions.deletedAt })
    .from(transactions)
    .where(
      and(
        inArray(transactions.dedupHash, hashes),
        eq(transactions.dedupExempt, false),
      ),
    );
  const status: Record<string, { deleted: boolean }> = {};
  for (const row of rows) {
    // inArray never matches NULL, so synced rows (which carry no hash) are
    // never returned; the check only narrows the type.
    if (row.dedupHash === null) continue;
    // At most one non-exempt row per hash (the unique index guarantees it).
    status[row.dedupHash] = { deleted: row.deletedAt !== null };
  }
  return status;
}

export type PersonRow = {
  id: string;
  name: string;
  isOwner: boolean;
  createdAt: Date;
};

// Active (non-deleted) persons in created_at ascending order. This ordering
// is load-bearing: the split engine hands remainder cents to the first k
// participants, so participant order must be stable across sessions.
export async function getPersons(): Promise<PersonRow[]> {
  return db
    .select({
      id: persons.id,
      name: persons.name,
      isOwner: persons.isOwner,
      createdAt: persons.createdAt,
    })
    .from(persons)
    .where(isNull(persons.deletedAt))
    .orderBy(asc(persons.createdAt));
}

export async function insertPerson(name: string): Promise<void> {
  await db.insert(persons).values({ name });
}

export async function renamePersonById(id: string, name: string): Promise<void> {
  await db.update(persons).set({ name }).where(eq(persons.id, id));
}

// Soft delete only, and never the owner. Shares and settlements keep their
// person_id; the person just stops appearing in pickers.
export async function softDeletePersonById(id: string): Promise<{ name: string } | null> {
  // The owner is never deleted, and a person already deleted keeps the
  // time they were deleted. Null when nothing matched.
  const [row] = await db
    .update(persons)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(persons.id, id), eq(persons.isOwner, false), isNull(persons.deletedAt)))
    .returning({ name: persons.name });
  return row ?? null;
}

type SplitMethodType = (typeof splits.method.enumValues)[number];

// Whether the `transactions` row of the enclosing select has a split, or a
// receipt. Written as literal, fully qualified SQL on purpose: in a select's
// field list Drizzle renders column references unqualified, so the obvious
// `${splits.transactionId} = ${transactions.id}` becomes
// "transaction_id" = "id", which resolves both sides to `splits` and is never
// true (found by the database tests).
const rowHasSplit = () =>
  sql<boolean>`exists (select 1 from "splits" s where s."transaction_id" = "transactions"."id")`;
const rowHasReceipt = () =>
  sql<boolean>`exists (select 1 from "receipts" r where r."transaction_id" = "transactions"."id")`;

// The transaction handle drizzle hands to a db.transaction callback; helpers
// that must run inside an existing transaction take this.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// For each newly created debt share, consume the counterparty's existing
// same-direction unallocated settlement credit (a prior overpayment), oldest
// settlement first, writing settlement_allocations (fork 5). Runs inside the
// caller's transaction so share creation and credit consumption commit
// together. An in-memory running total prevents two shares for the same
// person double-spending one credit.
async function consumeCreditForShares(
  tx: Tx,
  shares: {
    shareId: string;
    counterpartyId: string;
    direction: 'incoming' | 'outgoing';
    amountCents: number;
  }[],
): Promise<void> {
  const rowsToInsert: {
    settlementId: string;
    splitShareId: string;
    amountCents: number;
  }[] = [];
  // Cache credit lists per (person, direction) so multiple shares in one call
  // draw from the same decremented pool.
  const creditCache = new Map<string, { settlementId: string; unallocatedCents: number }[]>();
  for (const share of shares) {
    const key = `${share.counterpartyId}|${share.direction}`;
    let credits = creditCache.get(key);
    if (!credits) {
      const creditRows = (await tx.execute(sql`
        SELECT s.id, s.amount_cents - COALESCE(eff.total, 0) AS unallocated
        FROM settlements s
        LEFT JOIN (
          SELECT sa.settlement_id, SUM(sa.amount_cents) AS total
          FROM settlement_allocations sa
          JOIN split_shares ss ON ss.id = sa.split_share_id
          JOIN splits sp ON sp.id = ss.split_id
          LEFT JOIN transactions t ON t.id = sp.transaction_id
          WHERE (sp.transaction_id IS NULL OR t.deleted_at IS NULL)
          GROUP BY sa.settlement_id
        ) eff ON eff.settlement_id = s.id
        WHERE s.person_id = ${share.counterpartyId}
          AND s.direction = ${share.direction}
          AND s.amount_cents - COALESCE(eff.total, 0) > 0
        ORDER BY s.date ASC, s.created_at ASC
      `)) as unknown as Array<Record<string, unknown>>;
      credits = creditRows.map((r) => ({
        settlementId: r.id as string,
        unallocatedCents: Number(r.unallocated),
      }));
      creditCache.set(key, credits);
    }
    let remaining = share.amountCents;
    for (const credit of credits) {
      if (remaining <= 0) break;
      if (credit.unallocatedCents <= 0) continue;
      const take = Math.min(remaining, credit.unallocatedCents);
      rowsToInsert.push({
        settlementId: credit.settlementId,
        splitShareId: share.shareId,
        amountCents: take,
      });
      credit.unallocatedCents -= take;
      remaining -= take;
    }
  }
  if (rowsToInsert.length > 0) {
    await tx.insert(settlementAllocations).values(rowsToInsert);
  }
}

// Log an external expense: someone else paid, and the owner owes `amountCents`
// of it. One split (transaction_id NULL, payer = that person, with its own
// date/description) and one owner share. Any outgoing credit the owner already
// holds toward this person (a prepayment) auto-applies to the new share.
export async function insertExternalExpense(input: {
  payerPersonId: string;
  ownerId: string;
  amountCents: number;
  date: string;
  description: string;
}): Promise<{ shareId: string }> {
  return db.transaction(async (tx) => {
    const [split] = await tx
      .insert(splits)
      .values({
        transactionId: null,
        payerPersonId: input.payerPersonId,
        method: 'equal',
        taxCents: 0,
        tipCents: 0,
        date: input.date,
        description: input.description,
      })
      .returning({ id: splits.id });
    const [share] = await tx
      .insert(splitShares)
      .values({
        splitId: split.id,
        personId: input.ownerId,
        amountCents: input.amountCents,
        inputAmountCents: null,
        inputPercent: null,
      })
      .returning({ id: splitShares.id });
    await consumeCreditForShares(tx, [
      {
        shareId: share.id,
        counterpartyId: input.payerPersonId,
        direction: 'outgoing',
        amountCents: input.amountCents,
      },
    ]);
    return { shareId: share.id };
  });
}

// Hard-delete an external split (its share and any allocations against it
// cascade). Guarded to transaction-less splits so a bank split can never be
// removed through this path — those are soft-deleted via their transaction.
export async function deleteExternalSplit(splitId: string): Promise<boolean> {
  const deleted = await db
    .delete(splits)
    .where(and(eq(splits.id, splitId), isNull(splits.transactionId)))
    .returning({ id: splits.id });
  return deleted.length > 0;
}

export type SplitShareView = {
  personId: string;
  personName: string;
  personDeleted: boolean;
  amountCents: number;
  // Settlement allocations against this share, so the Expenses split panel can
  // show per-participant status (paid / partial / outstanding).
  allocatedCents: number;
  inputAmountCents: number | null;
  inputPercent: number | null;
};

export type SplitView = {
  transactionId: string;
  method: SplitMethodType;
  taxCents: number;
  tipCents: number;
  createdAt: Date;
  shares: SplitShareView[];
};

// All owner-paid (transaction-backed) splits with their shares and
// share-holder names (including soft-deleted persons, whose names the UI
// masks). External splits (transaction_id IS NULL) are deliberately excluded:
// they belong to /people only (fork 3), and this map is keyed by transaction
// id for the /expenses view. Shares stay in person created_at order,
// mirroring the engine's participant order.
export async function getSplits(): Promise<SplitView[]> {
  const rows = await db
    .select({
      transactionId: splits.transactionId,
      method: splits.method,
      taxCents: splits.taxCents,
      tipCents: splits.tipCents,
      createdAt: splits.createdAt,
      personId: splitShares.personId,
      personName: persons.name,
      personDeletedAt: persons.deletedAt,
      amountCents: splitShares.amountCents,
      allocatedCents: sql<number>`COALESCE((SELECT SUM(amount_cents) FROM settlement_allocations WHERE split_share_id = ${splitShares.id}), 0)`,
      inputAmountCents: splitShares.inputAmountCents,
      inputPercent: splitShares.inputPercent,
    })
    .from(splits)
    .innerJoin(splitShares, eq(splitShares.splitId, splits.id))
    .innerJoin(persons, eq(splitShares.personId, persons.id))
    .where(isNotNull(splits.transactionId))
    .orderBy(asc(splits.createdAt), asc(persons.createdAt));

  const byTransaction = new Map<string, SplitView>();
  for (const row of rows) {
    // transaction_id is non-null here (filtered above); assert for the type.
    const transactionId = row.transactionId as string;
    let view = byTransaction.get(transactionId);
    if (!view) {
      view = {
        transactionId,
        method: row.method,
        taxCents: row.taxCents,
        tipCents: row.tipCents,
        createdAt: row.createdAt,
        shares: [],
      };
      byTransaction.set(transactionId, view);
    }
    view.shares.push({
      personId: row.personId,
      personName: row.personName,
      personDeleted: row.personDeletedAt !== null,
      amountCents: row.amountCents,
      allocatedCents: Number(row.allocatedCents),
      inputAmountCents: row.inputAmountCents,
      inputPercent: row.inputPercent,
    });
  }
  return [...byTransaction.values()];
}

export async function getTransactionForSplit(id: string): Promise<{
  id: string;
  amountCents: number;
  pending: boolean;
  isSplittable: boolean;
} | null> {
  const rows = await db
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      pending: transactions.pending,
      categoryIsSplittable: categories.isSplittable,
      unverified: sql<boolean>`(${transactions.bankAccountId} is not null and ${bankAccounts.verifiedAt} is null)`,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(bankAccounts, eq(bankAccounts.id, transactions.bankAccountId))
    .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)));
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    amountCents: row.amountCents,
    pending: row.pending,
    isSplittable: !row.pending && !row.unverified && row.amountCents > 0 && (row.categoryIsSplittable ?? true),
  };
}

export type SplitSaveResult = { ok: true } | { error: string };

// The check a split save makes under the row lock, inside its transaction:
// the row is live, posted, still splittable, and (for a method split) still
// has the amount the shares were computed from. A sync that changed the row
// first is seen here and the save refuses; a sync that comes after waits on
// this lock, then sees the split and flags the row (commitAccountSync). Read
// with FOR UPDATE OF the transaction only, so the category row is not locked.
async function lockRowForSplit(
  tx: Tx,
  transactionId: string,
  expectedAmountCents: number | null,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select t.amount_cents, t.pending, t.deleted_at is not null as deleted, c.is_splittable,
      (t.bank_account_id is not null and b.verified_at is null) as unverified
    from ${transactions} t
    left join ${categories} c on c.id = t.category_id
    left join bank_accounts b on b.id = t.bank_account_id
    where t.id = ${transactionId}
    for update of t`)) as unknown as {
    amount_cents: string | number;
    pending: boolean;
    deleted: boolean;
    is_splittable: boolean | null;
    unverified: boolean;
  }[];
  const row = rows[0];
  if (!row || row.deleted) return 'Transaction not found';
  if (row.pending) return 'Pending transactions can be split once they post.';
  if (row.unverified) return 'This bank account is not verified against a statement yet; its rows can be split once it is.';
  const amount = Number(row.amount_cents);
  if (amount <= 0 || row.is_splittable === false) return 'This transaction is not splittable';
  if (expectedAmountCents !== null && amount !== expectedAmountCents) {
    return 'The bank changed this transaction while the split was open. Reopen it and save again.';
  }
  return null;
}

// Editing a split is a full overwrite (locked in CLAUDE.md): drop the old
// split (shares cascade) and insert the new one atomically. Owner-paid splits
// carry payer_person_id = the owner id (passed in; the column is NOT NULL with
// no SQL default, so every insert names the payer explicitly).
//
// The row is locked and re-checked first (lockRowForSplit): `amountCents` is
// the amount the shares were computed from, and a row that no longer has it
// is refused rather than given shares that do not sum to it. Saving clears
// the bank's amount-changed flag: the split is now built on the new amount.
export async function replaceSplit(input: {
  transactionId: string;
  amountCents: number;
  payerPersonId: string;
  method: SplitMethodType;
  taxCents: number;
  tipCents: number;
  shares: {
    personId: string;
    amountCents: number;
    inputAmountCents: number | null;
    inputPercent: number | null;
  }[];
}): Promise<SplitSaveResult> {
  return db.transaction(async (tx) => {
    const refused = await lockRowForSplit(tx, input.transactionId, input.amountCents);
    if (refused) return { error: refused };
    await tx
      .update(transactions)
      .set({ bankAmountBeforeCents: null })
      .where(eq(transactions.id, input.transactionId));
    await tx.delete(splits).where(eq(splits.transactionId, input.transactionId));
    const [split] = await tx
      .insert(splits)
      .values({
        transactionId: input.transactionId,
        payerPersonId: input.payerPersonId,
        method: input.method,
        taxCents: input.taxCents,
        tipCents: input.tipCents,
      })
      .returning({ id: splits.id });
    const inserted = await tx
      .insert(splitShares)
      .values(
        input.shares.map((s) => ({
          splitId: split.id,
          personId: s.personId,
          amountCents: s.amountCents,
          inputAmountCents: s.inputAmountCents,
          inputPercent: s.inputPercent,
        })),
      )
      .returning({ id: splitShares.id, personId: splitShares.personId });
    // Owner-paid split: non-owner shares are incoming debts. Auto-apply any
    // incoming credit each such person is carrying (fork 5). The overwrite
    // already dropped old shares (and their allocations cascaded away), so
    // this re-derives allocations from scratch.
    const byPerson = new Map(input.shares.map((s) => [s.personId, s]));
    await consumeCreditForShares(
      tx,
      inserted
        .filter((s) => s.personId !== input.payerPersonId)
        .map((s) => ({
          shareId: s.id,
          counterpartyId: s.personId,
          direction: 'incoming' as const,
          amountCents: byPerson.get(s.personId)!.amountCents,
        })),
    );
    return { ok: true } as const;
  });
}

// Removing a split returns the transaction to "entirely the owner's". Its
// allocations cascade away, returning those payments to credit; the bank's
// amount-changed flag goes with the split it was about.
export async function deleteSplitByTransactionId(
  transactionId: string,
): Promise<{ freedAllocations: number } | null> {
  // Null when the row has no split. The split's shares go with it, and so do
  // the allocations against them (cascade): those payments become credit.
  return db.transaction(async (tx) => {
    const [freed] = (await tx.execute(sql`
      select count(*)::int as n from "settlement_allocations" a
      join "split_shares" sh on sh."id" = a."split_share_id"
      join "splits" s on s."id" = sh."split_id"
      where s."transaction_id" = ${transactionId}`)) as unknown as { n: number }[];
    const deleted = await tx
      .delete(splits)
      .where(eq(splits.transactionId, transactionId))
      .returning({ id: splits.id });
    if (deleted.length === 0) return null;
    await tx
      .update(transactions)
      .set({ bankAmountBeforeCents: null })
      .where(eq(transactions.id, transactionId));
    return { freedAllocations: Number(freed?.n ?? 0) };
  });
}

// Persist an item split: the derived split + shares (full overwrite, same
// as replaceSplit) and the item→person assignments they were derived from,
// atomically — stored shares and stored assignments must never disagree.
export async function replaceItemSplit(input: {
  transactionId: string;
  payerPersonId: string;
  receiptId: string;
  taxCents: number;
  tipCents: number;
  shares: { personId: string; amountCents: number }[];
  assignments: { receiptItemId: string; personId: string }[];
}): Promise<SplitSaveResult> {
  return db.transaction(async (tx) => {
    // Item shares sum to the receipt, not the amount, so only liveness and
    // splittability are checked; a receipt-vs-amount mismatch is shown on
    // the receipt as before.
    const refused = await lockRowForSplit(tx, input.transactionId, null);
    if (refused) return { error: refused };
    await tx
      .update(transactions)
      .set({ bankAmountBeforeCents: null })
      .where(eq(transactions.id, input.transactionId));
    await tx.delete(splits).where(eq(splits.transactionId, input.transactionId));
    const [split] = await tx
      .insert(splits)
      .values({
        transactionId: input.transactionId,
        payerPersonId: input.payerPersonId,
        method: 'item',
        taxCents: input.taxCents,
        tipCents: input.tipCents,
      })
      .returning({ id: splits.id });
    const inserted = await tx
      .insert(splitShares)
      .values(
        input.shares.map((s) => ({
          splitId: split.id,
          personId: s.personId,
          amountCents: s.amountCents,
          inputAmountCents: null,
          inputPercent: null,
        })),
      )
      .returning({ id: splitShares.id, personId: splitShares.personId });
    // Non-owner shares are incoming debts; auto-apply carried incoming credit
    // (fork 5), same as replaceSplit.
    const byPerson = new Map(input.shares.map((s) => [s.personId, s]));
    await consumeCreditForShares(
      tx,
      inserted
        .filter((s) => s.personId !== input.payerPersonId)
        .map((s) => ({
          shareId: s.id,
          counterpartyId: s.personId,
          direction: 'incoming' as const,
          amountCents: byPerson.get(s.personId)!.amountCents,
        })),
    );
    const itemIds = tx
      .select({ id: receiptItems.id })
      .from(receiptItems)
      .where(eq(receiptItems.receiptId, input.receiptId));
    await tx
      .delete(receiptItemAssignments)
      .where(inArray(receiptItemAssignments.receiptItemId, itemIds));
    if (input.assignments.length > 0) {
      await tx.insert(receiptItemAssignments).values(input.assignments);
    }
    return { ok: true } as const;
  });
}

// Every person including soft-deleted ones, for balance views where deleted
// people must still surface while money is outstanding.
export async function getAllPersons(): Promise<(PersonRow & { deleted: boolean })[]> {
  const rows = await db
    .select({
      id: persons.id,
      name: persons.name,
      isOwner: persons.isOwner,
      deletedAt: persons.deletedAt,
      createdAt: persons.createdAt,
    })
    .from(persons)
    .orderBy(asc(persons.createdAt));
  return rows.map(({ deletedAt, ...row }) => ({
    ...row,
    deleted: deletedAt !== null,
  }));
}

// Every debt share in both directions, the foundation for balances, per-share
// status, and the /people history. A debt share is either an owner-paid
// split's non-owner share (incoming: that person owes the owner) or an
// external split's owner share (outgoing: the owner owes that person); an
// owner's own share on an owner-paid split is their own spending, not a debt,
// and is excluded. `allocatedCents` sums the settlement allocations against
// the share. Shares of a soft-deleted transaction are excluded entirely (the
// deleted_at filter is the cascade). Rows are FIFO-ordered by effective date
// (transaction date for owner-paid, split.created_at date for external, per
// fork 6), then created_at, then id — the order the allocation engine relies
// on.
export type DebtShareRow = {
  shareId: string;
  splitId: string;
  // The non-owner counterparty of the debt, regardless of direction.
  counterpartyId: string;
  counterpartyName: string;
  counterpartyDeleted: boolean;
  direction: 'incoming' | 'outgoing';
  amountCents: number;
  allocatedCents: number;
  // Null for external splits (no backing bank transaction).
  transactionId: string | null;
  // Display date and label: the transaction's for owner-paid splits, the
  // stored external-split fields otherwise.
  date: string;
  description: string;
  // FIFO tiebreak after effectiveDate; effectiveDate is what the engine sorts
  // by (already applied in the ORDER BY here).
  createdAt: Date;
  effectiveDate: string;
  // Display/detail fields for /people. All null for external splits, which
  // have no backing transaction to read a category, total, or note from.
  categoryName: string | null;
  // The whole transaction's amount, so the detail popup can frame this
  // person's share against what was actually spent.
  transactionAmountCents: number | null;
  note: string | null;
  // Friendlier label for the same row: the normalized merchant, which drops
  // the phone numbers and "APPLE PAY ENDING IN ..." tails the raw descriptor
  // carries. Used when the list is shared with the person who owes it; the
  // on-screen rows keep description_raw so /people matches the Expenses table.
  merchantLabel: string;
  // How the split was divided, and over how many people (the owner included).
  method: SplitMethodType;
  participantCount: number;
};

export async function getDebtShares(): Promise<DebtShareRow[]> {
  const rows = (await db.execute(sql`
    SELECT
      ss.id AS share_id,
      sp.id AS split_id,
      (CASE WHEN sp.payer_person_id = o.id THEN ss.person_id ELSE sp.payer_person_id END) AS counterparty_id,
      cp.name AS counterparty_name,
      (cp.deleted_at IS NOT NULL) AS counterparty_deleted,
      (CASE WHEN sp.payer_person_id = o.id THEN 'incoming' ELSE 'outgoing' END) AS direction,
      ss.amount_cents AS amount_cents,
      COALESCE(al.total, 0) AS allocated_cents,
      sp.transaction_id AS transaction_id,
      COALESCE(t.date, sp.date)::text AS date,
      COALESCE(t.description_raw, sp.description, '') AS description,
      COALESCE(t.created_at, sp.created_at) AS created_at,
      (CASE WHEN sp.transaction_id IS NOT NULL THEN t.date::text ELSE to_char(sp.created_at, 'YYYY-MM-DD') END) AS effective_date,
      c.name AS category_name,
      t.amount_cents AS transaction_amount_cents,
      t.note AS note,
      COALESCE(NULLIF(t.merchant_normalized, ''), sp.description, t.description_raw, '') AS merchant_label,
      sp.method AS method,
      (SELECT COUNT(*) FROM split_shares s2 WHERE s2.split_id = sp.id) AS participant_count
    FROM split_shares ss
    JOIN splits sp ON sp.id = ss.split_id
    JOIN persons o ON o.is_owner = true
    JOIN persons cp ON cp.id = (CASE WHEN sp.payer_person_id = o.id THEN ss.person_id ELSE sp.payer_person_id END)
    LEFT JOIN transactions t ON t.id = sp.transaction_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN (
      SELECT split_share_id, SUM(amount_cents) AS total
      FROM settlement_allocations
      GROUP BY split_share_id
    ) al ON al.split_share_id = ss.id
    WHERE (sp.transaction_id IS NULL OR t.deleted_at IS NULL)
      AND (
        (sp.payer_person_id = o.id AND ss.person_id <> o.id)
        OR (sp.payer_person_id <> o.id AND ss.person_id = o.id)
      )
    ORDER BY effective_date ASC, created_at ASC, share_id ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    shareId: r.share_id as string,
    splitId: r.split_id as string,
    counterpartyId: r.counterparty_id as string,
    counterpartyName: r.counterparty_name as string,
    counterpartyDeleted: r.counterparty_deleted as boolean,
    direction: r.direction as 'incoming' | 'outgoing',
    amountCents: Number(r.amount_cents),
    allocatedCents: Number(r.allocated_cents),
    transactionId: (r.transaction_id as string | null) ?? null,
    date: r.date as string,
    description: r.description as string,
    createdAt: new Date(r.created_at as string),
    effectiveDate: r.effective_date as string,
    categoryName: (r.category_name as string | null) ?? null,
    transactionAmountCents:
      r.transaction_amount_cents === null || r.transaction_amount_cents === undefined
        ? null
        : Number(r.transaction_amount_cents),
    note: (r.note as string | null) ?? null,
    merchantLabel: r.merchant_label as string,
    method: r.method as SplitMethodType,
    participantCount: Number(r.participant_count),
  }));
}

export type SettlementRow = {
  id: string;
  personId: string;
  amountCents: number;
  direction: 'incoming' | 'outgoing';
  date: string;
  note: string | null;
  createdAt: Date;
  // Shared by the rows of one netted payment (cash + offset pair); null for
  // a settlement recorded on its own.
  groupId: string | null;
  isOffset: boolean;
  // amount minus allocations against still-live shares. Allocations on
  // soft-deleted transactions are excluded, so their amount returns to this
  // pool (fork 7). Non-negative.
  unallocatedCents: number;
};

export async function getSettlements(): Promise<SettlementRow[]> {
  const rows = (await db.execute(sql`
    SELECT
      s.id,
      s.person_id,
      s.amount_cents,
      s.direction,
      s.date,
      s.note,
      s.created_at,
      s.group_id,
      s.is_offset,
      s.amount_cents - COALESCE(eff.total, 0) AS unallocated_cents
    FROM settlements s
    LEFT JOIN (
      SELECT sa.settlement_id, SUM(sa.amount_cents) AS total
      FROM settlement_allocations sa
      JOIN split_shares ss ON ss.id = sa.split_share_id
      JOIN splits sp ON sp.id = ss.split_id
      LEFT JOIN transactions t ON t.id = sp.transaction_id
      WHERE (sp.transaction_id IS NULL OR t.deleted_at IS NULL)
      GROUP BY sa.settlement_id
    ) eff ON eff.settlement_id = s.id
    ORDER BY s.date DESC, s.created_at DESC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    personId: r.person_id as string,
    amountCents: Number(r.amount_cents),
    direction: r.direction as 'incoming' | 'outgoing',
    date: r.date as string,
    note: (r.note as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    groupId: (r.group_id as string | null) ?? null,
    isOffset: Boolean(r.is_offset),
    unallocatedCents: Number(r.unallocated_cents),
  }));
}

// Outstanding shares for a person in one direction, FIFO-ordered (effective
// date, then created_at, then id — the same order getDebtShares uses), with
// each share's still-outstanding amount. Soft-deleted transactions are
// excluded. This is what a settlement allocates against.
async function outstandingSharesFor(
  tx: Tx,
  personId: string,
  direction: 'incoming' | 'outgoing',
): Promise<{ shareId: string; outstandingCents: number }[]> {
  const directionFilter =
    direction === 'incoming'
      ? sql`sp.payer_person_id = o.id AND ss.person_id = ${personId}`
      : sql`sp.payer_person_id = ${personId} AND ss.person_id = o.id`;
  const rows = (await tx.execute(sql`
    SELECT ss.id AS share_id, ss.amount_cents - COALESCE(al.total, 0) AS outstanding
    FROM split_shares ss
    JOIN splits sp ON sp.id = ss.split_id
    JOIN persons o ON o.is_owner = true
    LEFT JOIN transactions t ON t.id = sp.transaction_id
    LEFT JOIN (
      SELECT split_share_id, SUM(amount_cents) AS total
      FROM settlement_allocations GROUP BY split_share_id
    ) al ON al.split_share_id = ss.id
    WHERE (sp.transaction_id IS NULL OR t.deleted_at IS NULL)
      AND (${directionFilter})
      AND ss.amount_cents - COALESCE(al.total, 0) > 0
    ORDER BY
      (CASE WHEN sp.transaction_id IS NOT NULL THEN t.date::text ELSE to_char(sp.created_at, 'YYYY-MM-DD') END) ASC,
      COALESCE(t.created_at, sp.created_at) ASC,
      ss.id ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    shareId: r.share_id as string,
    outstandingCents: Number(r.outstanding),
  }));
}

// Record a settlement and allocate it to specific shares in its direction.
// Default is FIFO across outstanding shares (allocateFifo); advanced mode
// passes explicit per-share amounts, each clamped to that share's outstanding
// balance. Whatever is not placed stays as unallocated credit on the
// settlement, to be consumed by the next same-direction share.
// Per-settlement allocation detail for the settlement-expansion UI: which
// shares each settlement paid down and by how much, with the share's date and
// description. Allocations against soft-deleted transactions are excluded (so
// the displayed allocations agree with the settlement's effective unallocated
// amount). Ordered by the share's effective date.
export type SettlementAllocationDetailRow = {
  settlementId: string;
  splitShareId: string;
  amountCents: number;
  shareDate: string;
  shareDescription: string;
};

export async function getSettlementAllocationDetails(): Promise<
  SettlementAllocationDetailRow[]
> {
  const rows = (await db.execute(sql`
    SELECT
      sa.settlement_id,
      sa.split_share_id,
      sa.amount_cents,
      COALESCE(t.date, sp.date)::text AS share_date,
      COALESCE(t.description_raw, sp.description, '') AS share_description
    FROM settlement_allocations sa
    JOIN split_shares ss ON ss.id = sa.split_share_id
    JOIN splits sp ON sp.id = ss.split_id
    LEFT JOIN transactions t ON t.id = sp.transaction_id
    WHERE (sp.transaction_id IS NULL OR t.deleted_at IS NULL)
    ORDER BY COALESCE(t.date, sp.date) ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    settlementId: r.settlement_id as string,
    splitShareId: r.split_share_id as string,
    amountCents: Number(r.amount_cents),
    shareDate: r.share_date as string,
    shareDescription: r.share_description as string,
  }));
}

export async function insertSettlementWithAllocations(input: {
  personId: string;
  amountCents: number;
  direction: 'incoming' | 'outgoing';
  date: string;
  note: string | null;
  manualAllocations?: { shareId: string; amountCents: number }[];
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [settlement] = await tx
      .insert(settlements)
      .values({
        personId: input.personId,
        amountCents: input.amountCents,
        direction: input.direction,
        date: input.date,
        note: input.note,
      })
      .returning({ id: settlements.id });

    const shares = await outstandingSharesFor(tx, input.personId, input.direction);

    let allocations: { splitShareId: string; amountCents: number }[];
    if (input.manualAllocations && input.manualAllocations.length > 0) {
      const outstandingById = new Map(shares.map((s) => [s.shareId, s.outstandingCents]));
      // createSettlement already rejects a request that sums past the
      // payment; the budget here only absorbs per-share clamping races.
      let budget = input.amountCents;
      allocations = [];
      for (const a of input.manualAllocations) {
        if (budget <= 0) break;
        const cap = outstandingById.get(a.shareId) ?? 0;
        const take = Math.min(a.amountCents, cap, budget);
        if (take > 0) {
          allocations.push({ splitShareId: a.shareId, amountCents: take });
          budget -= take;
        }
      }
    } else {
      allocations = allocateFifo(input.amountCents, shares).allocations.map((a) => ({
        splitShareId: a.splitShareId,
        amountCents: a.amountCents,
      }));
    }

    if (allocations.length > 0) {
      await tx.insert(settlementAllocations).values(
        allocations.map((a) => ({
          settlementId: settlement.id,
          splitShareId: a.splitShareId,
          amountCents: a.amountCents,
        })),
      );
    }
  });
}

// Settlements cascade-delete their allocations (returning that amount to the
// shares' outstanding balances), so a hard delete is safe: balances recompute
// without this payment.
// A settlement that belongs to a netted group (cash + offset pair) takes the
// rest of its group with it: half an offset would leave the balance lopsided.
export async function deleteSettlementById(
  id: string,
): Promise<{ amountCents: number; isOffset: boolean }[]> {
  // The whole netting group goes with any one of its rows. Empty when
  // nothing matched.
  const rows = (await db.execute(sql`
    DELETE FROM settlements
    WHERE id = ${id}
       OR group_id = (SELECT group_id FROM settlements WHERE id = ${id} AND group_id IS NOT NULL)
    RETURNING amount_cents, is_offset
  `)) as unknown as { amount_cents: string | number; is_offset: boolean }[];
  return rows.map((r) => ({ amountCents: Number(r.amount_cents), isOffset: r.is_offset }));
}

// A refused settlement write: rolls the transaction back and carries the
// message the form shows.
export class SettlementWriteError extends Error {}

// Record one payment as a netted group, optionally replacing an existing
// settlement (and its group) in the same transaction — that is how a
// settlement is edited. Requested allocations are per share and per
// direction; each must fit the share's outstanding amount as it stands after
// the replaced rows are gone (no clamping: an offset's halves must stay
// equal), else the write is refused. planNetting decides the cash and offset
// split, and refuses typed cash below the net (the over-allocation block).
export async function recordSettlementGroup(input: {
  personId: string;
  date: string;
  note: string | null;
  incoming: Alloc[];
  outgoing: Alloc[];
  pinnedCashCents: number | null;
  fallbackDirection: 'incoming' | 'outgoing';
  replaceId: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.replaceId) {
      const removed = (await tx.execute(sql`
        DELETE FROM settlements
        WHERE person_id = ${input.personId}
          AND (id = ${input.replaceId}
               OR group_id = (SELECT group_id FROM settlements
                              WHERE id = ${input.replaceId} AND group_id IS NOT NULL))
        RETURNING id
      `)) as unknown as unknown[];
      if (removed.length === 0) {
        throw new SettlementWriteError('That settlement no longer exists — reload the page');
      }
    }

    // Validate against live outstanding and put each side in FIFO order.
    const ordered = async (direction: 'incoming' | 'outgoing', requested: Alloc[]) => {
      const live = await outstandingSharesFor(tx, input.personId, direction);
      const rank = new Map(live.map((s, i) => [s.shareId, i]));
      const cap = new Map(live.map((s) => [s.shareId, s.outstandingCents]));
      const seen = new Set<string>();
      for (const a of requested) {
        const max = cap.get(a.shareId);
        if (max === undefined || a.amountCents > max || seen.has(a.shareId)) {
          throw new SettlementWriteError(
            'Some shares changed since you opened this — close it and try again',
          );
        }
        seen.add(a.shareId);
      }
      return requested
        .filter((a) => a.amountCents > 0)
        .sort((x, y) => rank.get(x.shareId)! - rank.get(y.shareId)!);
    };
    const incoming = await ordered('incoming', input.incoming);
    const outgoing = await ordered('outgoing', input.outgoing);

    const result = planNetting(incoming, outgoing, input.pinnedCashCents, input.fallbackDirection);
    if (!result.ok) {
      throw new SettlementWriteError(
        result.reason === 'empty'
          ? 'Pick at least one share'
          : `The payment is ${formatUSD(toCents(result.overByCents))} short of the net — raise it or untick shares`,
      );
    }
    const { cash, offset } = result.plan;
    const groupId = offset ? crypto.randomUUID() : null;

    const insert = async (
      direction: 'incoming' | 'outgoing',
      amountCents: number,
      isOffset: boolean,
      allocations: Alloc[],
    ) => {
      const [row] = await tx
        .insert(settlements)
        .values({
          personId: input.personId,
          amountCents,
          direction,
          date: input.date,
          note: input.note,
          groupId,
          isOffset,
        })
        .returning({ id: settlements.id });
      if (allocations.length > 0) {
        await tx.insert(settlementAllocations).values(
          allocations.map((a) => ({
            settlementId: row.id,
            splitShareId: a.shareId,
            amountCents: a.amountCents,
          })),
        );
      }
    };

    if (cash) await insert(cash.direction, cash.amountCents, false, cash.allocations);
    if (offset) {
      await insert('incoming', offset.amountCents, true, offset.incoming);
      await insert('outgoing', offset.amountCents, true, offset.outgoing);
    }
  });
}

// Permanently remove a soft-deleted person once nothing active depends on
// them. Only ever called for a person with no active shares (the UI gates
// it), but their share/assignment rows on already-deleted transactions and
// their settlements still hold the person_id foreign keys, so all of them
// go in one transaction before the person row itself. Never removes the
// owner. This is a true hard delete — there is no undo.
export async function hardDeletePersonById(
  id: string,
): Promise<{ name: string; settlements: number } | null> {
  // Only a person already soft-deleted, never the owner. Null when nothing
  // matched; the whole erase rolls back with it.
  return db.transaction(async (tx) => {
    const [person] = await tx
      .select({ name: persons.name })
      .from(persons)
      .where(and(eq(persons.id, id), eq(persons.isOwner, false), isNotNull(persons.deletedAt)))
      .for('update');
    if (!person) return null;
    const erased = await tx
      .delete(settlements)
      .where(eq(settlements.personId, id))
      .returning({ id: settlements.id });
    await tx.delete(splitShares).where(eq(splitShares.personId, id));
    await tx
      .delete(receiptItemAssignments)
      .where(eq(receiptItemAssignments.personId, id));
    await tx.delete(persons).where(eq(persons.id, id));
    return { name: person.name, settlements: erased.length };
  });
}

// ---- Receipts (phase 5) ----

export type ReceiptItemView = {
  id: string;
  position: number;
  description: string;
  quantity: number;
  amountCents: number;
  // Person ids assigned to this item; empty means the owner's.
  assignedPersonIds: string[];
};

export type ReceiptView = {
  id: string;
  transactionId: string;
  // Every image of the receipt, in upload order (position). Always at least
  // one; display iterates all, presigning each for viewing.
  blobUrls: string[];
  merchant: string;
  date: string | null;
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  mismatchNote: string | null;
  // True when the stored receipt came from a successful extraction (raw
  // response present); false for manual-entry receipts.
  extracted: boolean;
  items: ReceiptItemView[];
};

function toReceiptView(
  receipt: typeof receipts.$inferSelect,
  images: (typeof receiptImages.$inferSelect)[],
  items: (typeof receiptItems.$inferSelect)[],
  assignments: { receiptItemId: string; personId: string }[],
): ReceiptView {
  const byItem = new Map<string, string[]>();
  for (const a of assignments) {
    const list = byItem.get(a.receiptItemId) ?? [];
    list.push(a.personId);
    byItem.set(a.receiptItemId, list);
  }
  // Ordered image URLs; fall back to the denormalized primary if a receipt
  // somehow has no image rows (pre-backfill safety).
  const blobUrls =
    images.length > 0
      ? [...images].sort((a, b) => a.position - b.position).map((i) => i.blobUrl)
      : [receipt.blobUrl];
  return {
    id: receipt.id,
    transactionId: receipt.transactionId,
    blobUrls,
    merchant: receipt.merchantExtracted,
    date: receipt.dateExtracted,
    subtotalCents: receipt.subtotalCents,
    taxCents: receipt.taxCents,
    tipCents: receipt.tipCents,
    totalCents: receipt.totalCents,
    mismatchNote: receipt.mismatchNote,
    extracted: receipt.rawLlmResponse !== null,
    items: items
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        id: i.id,
        position: i.position,
        description: i.description,
        quantity: i.quantity,
        amountCents: i.amountCents,
        assignedPersonIds: byItem.get(i.id) ?? [],
      })),
  };
}

export async function getReceiptByTransactionId(
  transactionId: string,
): Promise<ReceiptView | null> {
  const receiptRows = await db
    .select()
    .from(receipts)
    .where(eq(receipts.transactionId, transactionId));
  if (receiptRows.length === 0) return null;
  const receipt = receiptRows[0];
  const images = await db
    .select()
    .from(receiptImages)
    .where(eq(receiptImages.receiptId, receipt.id));
  const items = await db
    .select()
    .from(receiptItems)
    .where(eq(receiptItems.receiptId, receipt.id));
  const assignments =
    items.length === 0
      ? []
      : await db
          .select({
            receiptItemId: receiptItemAssignments.receiptItemId,
            personId: receiptItemAssignments.personId,
          })
          .from(receiptItemAssignments)
          .innerJoin(
            receiptItems,
            eq(receiptItemAssignments.receiptItemId, receiptItems.id),
          )
          .where(eq(receiptItems.receiptId, receipt.id));
  return toReceiptView(receipt, images, items, assignments);
}

// All receipts keyed by transaction for the table (icon + dialog data
// without an N+1 per row).
export async function getReceipts(): Promise<ReceiptView[]> {
  const receiptRows = await db.select().from(receipts);
  if (receiptRows.length === 0) return [];
  const allImages = await db.select().from(receiptImages);
  const items = await db.select().from(receiptItems);
  const assignments = await db
    .select({
      receiptItemId: receiptItemAssignments.receiptItemId,
      personId: receiptItemAssignments.personId,
    })
    .from(receiptItemAssignments);
  const imagesByReceipt = new Map<string, (typeof receiptImages.$inferSelect)[]>();
  for (const img of allImages) {
    const list = imagesByReceipt.get(img.receiptId) ?? [];
    list.push(img);
    imagesByReceipt.set(img.receiptId, list);
  }
  const itemsByReceipt = new Map<string, (typeof receiptItems.$inferSelect)[]>();
  for (const item of items) {
    const list = itemsByReceipt.get(item.receiptId) ?? [];
    list.push(item);
    itemsByReceipt.set(item.receiptId, list);
  }
  return receiptRows.map((r) =>
    toReceiptView(
      r,
      imagesByReceipt.get(r.id) ?? [],
      itemsByReceipt.get(r.id) ?? [],
      assignments,
    ),
  );
}

// A receipt is created once per upload, extraction succeeding or not; a
// failed extraction stores an empty draft the user fills in manually.
export async function insertReceiptWithItems(input: {
  transactionId: string;
  // One or more image URLs, in upload order; blobUrls[0] is the primary
  // (mirrored into receipts.blob_url).
  blobUrls: string[];
  merchant: string;
  date: string | null;
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  rawLlmResponse: unknown | null;
  items: { description: string; quantity: number; amountCents: number }[];
}): Promise<{ receiptId: string }> {
  return db.transaction(async (tx) => {
    const [receipt] = await tx
      .insert(receipts)
      .values({
        transactionId: input.transactionId,
        blobUrl: input.blobUrls[0],
        merchantExtracted: input.merchant,
        dateExtracted: input.date,
        subtotalCents: input.subtotalCents,
        taxCents: input.taxCents,
        tipCents: input.tipCents,
        totalCents: input.totalCents,
        rawLlmResponse: input.rawLlmResponse ?? null,
      })
      .returning({ id: receipts.id });
    await tx.insert(receiptImages).values(
      input.blobUrls.map((blobUrl, position) => ({
        receiptId: receipt.id,
        blobUrl,
        position,
      })),
    );
    if (input.items.length > 0) {
      await tx.insert(receiptItems).values(
        input.items.map((item, index) => ({
          receiptId: receipt.id,
          position: index,
          description: item.description,
          quantity: item.quantity,
          amountCents: item.amountCents,
        })),
      );
    }
    return { receiptId: receipt.id };
  });
}

// Review-step save: overwrite the receipt's editable fields and replace its
// items wholesale (same full-overwrite policy as splits; item assignments
// cascade away with the old items).
export async function updateReceiptWithItems(input: {
  receiptId: string;
  merchant: string;
  date: string | null;
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  mismatchNote: string | null;
  items: { description: string; quantity: number; amountCents: number }[];
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(receipts)
      .set({
        merchantExtracted: input.merchant,
        dateExtracted: input.date,
        subtotalCents: input.subtotalCents,
        taxCents: input.taxCents,
        tipCents: input.tipCents,
        totalCents: input.totalCents,
        mismatchNote: input.mismatchNote,
      })
      .where(eq(receipts.id, input.receiptId));
    await tx.delete(receiptItems).where(eq(receiptItems.receiptId, input.receiptId));
    if (input.items.length > 0) {
      await tx.insert(receiptItems).values(
        input.items.map((item, index) => ({
          receiptId: input.receiptId,
          position: index,
          description: item.description,
          quantity: item.quantity,
          amountCents: item.amountCents,
        })),
      );
    }
  });
}

// Removing a receipt also removes an item split derived from it — stored
// shares would otherwise claim provenance from data that no longer exists.
// Method splits (equal/amount/percent) are left alone. Returns every image
// URL so the caller can delete the stored blobs.
export async function deleteReceiptByTransactionId(
  transactionId: string,
): Promise<{ blobUrls: string[]; itemSplitRemoved: boolean } | null> {
  const rows = await db
    .select({ id: receipts.id, blobUrl: receipts.blobUrl })
    .from(receipts)
    .where(eq(receipts.transactionId, transactionId));
  if (rows.length === 0) return null;
  const imageRows = await db
    .select({ blobUrl: receiptImages.blobUrl })
    .from(receiptImages)
    .where(eq(receiptImages.receiptId, rows[0].id));
  const blobUrls =
    imageRows.length > 0 ? imageRows.map((i) => i.blobUrl) : [rows[0].blobUrl];
  return db.transaction(async (tx) => {
    // receipt_images cascade with the receipt row.
    const deleted = await tx
      .delete(receipts)
      .where(eq(receipts.transactionId, transactionId))
      .returning({ id: receipts.id });
    // Removed by another request between the read above and here.
    if (deleted.length === 0) return null;
    const splitDeleted = await tx
      .delete(splits)
      .where(
        and(eq(splits.transactionId, transactionId), eq(splits.method, 'item')),
      )
      .returning({ id: splits.id });
    return { blobUrls, itemSplitRemoved: splitDeleted.length > 0 };
  });
}

// ---- Insights (phase 7) ----

// Every non-deleted transaction in the shape lib/insights.ts aggregates.
// The dashboard is server-rendered, so raw rows never reach the client —
// only the computed aggregates do.
export async function getInsightRows(): Promise<InsightRow[]> {
  const rows = await db
    .select({
      date: transactions.date,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryIsSplittable: categories.isSplittable,
      countsAsSpending: categories.countsAsSpending,
      merchantNormalized: transactions.merchantNormalized,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(bankAccounts, eq(bankAccounts.id, transactions.bankAccountId))
    // Pending rows are provisional: their posted row is the one that counts.
    // A synced row counts once its bank account is verified against a
    // statement (REAL-ACCOUNTS.md); CSV and manual rows always count.
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.pending, false),
        sql`(${transactions.bankAccountId} is null or ${bankAccounts.verifiedAt} is not null)`,
      ),
    );
  return rows.map((row) => ({
    ...row,
    categoryIsSplittable: row.categoryIsSplittable ?? true,
    // Uncategorized rows count as spending.
    countsAsSpending: row.countsAsSpending ?? true,
  }));
}

// ---- Imports (phase 7) ----

export type ImportRow = {
  id: string;
  source: TransactionSource;
  filename: string | null;
  displayName: string | null;
  importedAt: Date;
  rowCount: number;
  // Synthetic migration-time import for pre-phase-7 rows (filename IS NULL).
  backfilled: boolean;
  // Hidden from the Expenses list (persisted; the strip below the table
  // unhides). Hidden imports are still returned here so the strip can list
  // them — the table filters their rows out client-side.
  hidden: boolean;
};

// Non-deleted imports, newest upload first (the group order on /). Hidden
// imports are included (annotated) so the unhide strip can surface them.
export async function getImports(): Promise<ImportRow[]> {
  const rows = await db
    .select({
      id: imports.id,
      source: imports.source,
      filename: imports.filename,
      displayName: imports.displayName,
      importedAt: imports.importedAt,
      rowCount: imports.rowCount,
      hidden: imports.hidden,
    })
    .from(imports)
    .where(isNull(imports.deletedAt))
    .orderBy(desc(imports.importedAt));
  return rows.map((row) => ({ ...row, backfilled: row.filename === null }));
}

// Hide or unhide a single import batch. Purely a view preference (no effect
// on balances, dedup, or the rows themselves).
export async function setImportHiddenById(
  id: string,
  hidden: boolean,
): Promise<boolean> {
  const updated = await db.update(imports).set({ hidden }).where(eq(imports.id, id)).returning({ id: imports.id });
  return updated.length > 0;
}

// Unhide every hidden import at once ("Show all" in the strip).
export async function showAllImports(): Promise<number> {
  const shown = await db
    .update(imports)
    .set({ hidden: false })
    .where(eq(imports.hidden, true))
    .returning({ id: imports.id });
  return shown.length;
}

export async function insertImport(input: {
  source: TransactionSource;
  filename: string;
  displayName: string;
  rowCount: number;
  ledgerAccountId?: string | null;
}): Promise<{ importId: string }> {
  const [row] = await db
    .insert(imports)
    .values(input)
    .returning({ id: imports.id });
  return { importId: row.id };
}

// A confirm that skipped rows: the batch's count and generated name cover
// only the rows actually imported.
export async function updateImportAfterSkips(
  importId: string,
  rowCount: number,
  displayName: string,
): Promise<void> {
  await db.update(imports).set({ rowCount, displayName }).where(eq(imports.id, importId));
}

// User rename of an import's display label.
export async function updateImportDisplayName(
  importId: string,
  displayName: string,
): Promise<void> {
  await db
    .update(imports)
    .set({ displayName })
    .where(eq(imports.id, importId));
}

// An import whose rows were all dedup skips never happened: hard delete is
// safe because nothing references it.
export async function deleteEmptyImport(importId: string): Promise<void> {
  await db.delete(imports).where(eq(imports.id, importId));
}

// Undo import: soft-delete the batch and every transaction in it, in one
// transaction. Rows already individually deleted keep their original
// deleted_at. Splits/shares/receipts stay untouched — the deleted_at filter
// on every read path (including balance derivation) is the cascade.
export async function softDeleteImportById(id: string): Promise<{ rows: number } | null> {
  // Null when the import does not exist or is already undone: a second Undo
  // changes nothing. The rows it deletes are marked deleted_by_undo, which is
  // what Restore brings back; a row deleted on its own before stays deleted.
  return db.transaction(async (tx) => {
    const undone = await tx
      .update(imports)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(imports.id, id), isNull(imports.deletedAt)))
      .returning({ id: imports.id });
    if (undone.length === 0) return null;
    const rows = await tx
      .update(transactions)
      .set({ deletedAt: sql`now()`, deletedByUndo: true })
      .where(and(eq(transactions.importId, id), isNull(transactions.deletedAt)))
      .returning({ id: transactions.id });
    return { rows: rows.length };
  });
}

// Soft delete. The dedup_hash stays occupied (a re-import will not
// resurrect the row) and splits/shares/receipts stay untouched; read paths
// filter them out instead.
// The owner's delete. removed_by_bank_at is cleared because it marks sync as
// the deleter: left set, a later takeover or re-delivery would revive a row
// the owner deleted (BANK-SYNC.md).
export async function softDeleteTransactionById(id: string): Promise<boolean> {
  // A row already deleted keeps its deletion as it was.
  const deleted = await db
    .update(transactions)
    .set({ deletedAt: sql`now()`, removedByBankAt: null })
    .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
    .returning({ id: transactions.id });
  return deleted.length > 0;
}

// User edit of an existing row's core fields (phase 7). The dedup_hash is
// NOT recomputed — it recorded what the import saw, and edits are trusted
// post-hoc — but the derived merchant_normalized is, so categorization
// rules keep matching what the row now says. Synced rows are the bank's
// (BANK-SYNC.md): the WHERE excludes them, so a stale page or a forged
// request cannot edit one. Returns whether a row was updated.
export async function updateTransactionDetailsById(
  id: string,
  input: { date: string; amountCents: number; descriptionRaw: string },
): Promise<boolean> {
  const rows = await db
    .update(transactions)
    .set({
      date: input.date,
      amountCents: input.amountCents,
      descriptionRaw: input.descriptionRaw,
      merchantNormalized: normalizeMerchant(input.descriptionRaw),
    })
    .where(and(eq(transactions.id, id), isNull(transactions.providerTransactionId)))
    .returning({ id: transactions.id });
  return rows.length > 0;
}

// Set or clear a transaction's free-text note. null clears it. Notes are
// independent of dedup and balances, so this touches nothing else.
export async function updateTransactionNoteById(
  id: string,
  note: string | null,
): Promise<void> {
  await db.update(transactions).set({ note }).where(eq(transactions.id, id));
}

// Bulk soft delete; rows already deleted keep their original deleted_at.
export async function softDeleteTransactionsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await db
    .update(transactions)
    .set({ deletedAt: sql`now()`, removedByBankAt: null })
    .where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt)))
    .returning({ id: transactions.id });
  return deleted.length;
}

export type CategoryChangeResult = { ok: true } | { error: string };

// A manual category change, refused when it would move a row with a split
// into a category that is not splittable (CLAUDE.md): the split would keep
// counting in balances on a row the app says cannot be split. The rows are
// locked first and their splits read after, so a split saved meanwhile is
// seen. Applying a category marks the rows 'manual' (rules never overwrite
// them); clearing sets them back to NULL, re-opening them to rules.
async function setManualCategory(ids: string[], categoryId: string | null): Promise<CategoryChangeResult> {
  if (ids.length === 0) return { ok: true };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${transactions} where ${inArray(transactions.id, ids)} order by id for update`);
    if (categoryId !== null) {
      const [category] = await tx
        .select({ name: categories.name, isSplittable: categories.isSplittable })
        .from(categories)
        .where(eq(categories.id, categoryId));
      if (!category) return { error: 'That category no longer exists.' };
      if (!category.isSplittable) {
        const [{ value: splitRows }] = await tx
          .select({ value: count() })
          .from(splits)
          .where(inArray(splits.transactionId, ids));
        if (splitRows > 0) {
          return {
            error:
              ids.length === 1
                ? `${category.name} can't hold a split. Remove the split first.`
                : `${splitRows} of the selected rows have a split, and ${category.name} can't hold one. Remove those splits first.`,
          };
        }
      }
    }
    await tx
      .update(transactions)
      .set({ categoryId, categorySource: categoryId ? 'manual' : null })
      .where(inArray(transactions.id, ids));
    return { ok: true } as const;
  });
}

// Inline category edit: a manual override (see setManualCategory).
export async function updateTransactionCategory(
  id: string,
  categoryId: string | null,
): Promise<CategoryChangeResult> {
  return setManualCategory([id], categoryId);
}

// Bulk form, same semantics; refused as a whole if any selected row would
// break the rule, so a selection is never half-applied.
export async function bulkUpdateTransactionCategory(
  ids: string[],
  categoryId: string | null,
): Promise<CategoryChangeResult> {
  return setManualCategory(ids, categoryId);
}

// ---- Undone imports (restore) ----

export type DeletedImportRow = ImportRow & {
  // When the batch was undone (YYYY-MM-DD, formatted server-side).
  deletedAt: Date;
  // Transactions a restore would actually bring back: those soft-deleted by
  // the undo itself, not ones already deleted individually beforehand.
  restorableCount: number;
};

// Soft-deleted (undone) imports, most recently undone first, each with the
// number of rows a restore would revive: the rows its Undo deleted
// (deleted_by_undo), not every row in the batch, since a row deleted on its
// own before the undo stays deleted.
export async function getDeletedImports(): Promise<DeletedImportRow[]> {
  const rows = await db
    .select({
      id: imports.id,
      source: imports.source,
      filename: imports.filename,
      displayName: imports.displayName,
      importedAt: imports.importedAt,
      rowCount: imports.rowCount,
      hidden: imports.hidden,
      deletedAt: imports.deletedAt,
      // Literal, fully qualified SQL: see rowHasSplit. Written with
      // ${imports.id}, Drizzle rendered a bare "id" that the subquery read as
      // t.id, so the count was always 0.
      restorableCount: sql<number>`(
        SELECT COUNT(*) FROM "transactions" t
        WHERE t."import_id" = "imports"."id" AND t."deleted_by_undo"
      )`,
    })
    .from(imports)
    .where(isNotNull(imports.deletedAt))
    .orderBy(desc(imports.deletedAt));
  return rows.map((row) => ({
    ...row,
    deletedAt: row.deletedAt as Date,
    restorableCount: Number(row.restorableCount),
    backfilled: row.filename === null,
  }));
}

// Restore an undone import: clear deleted_at on the batch and on exactly the
// transactions the undo deleted. Both updates in softDeleteImportById ran
// inside one transaction using now(), which in Postgres is the transaction
// timestamp and therefore identical across both statements — so matching a
// row's deleted_at against the import's identifies the undo's own rows and
// leaves individually-deleted rows deleted. Splits, shares, receipts and
// notes were never touched, so balances come back exactly as they were.
export async function restoreImportById(id: string): Promise<{ rows: number } | null> {
  // Null when the import is not undone. Brings back exactly the rows its Undo
  // deleted (deleted_by_undo, migration 0025), not rows deleted on their own.
  return db.transaction(async (tx) => {
    const restored = await tx
      .update(imports)
      // hidden is cleared alongside: restoring a batch that was hidden before
      // it was undone would otherwise bring the rows back invisibly, making
      // the Restore button look like it did nothing.
      .set({ deletedAt: null, hidden: false })
      .where(and(eq(imports.id, id), isNotNull(imports.deletedAt)))
      .returning({ id: imports.id });
    if (restored.length === 0) return null;
    const rows = await tx
      .update(transactions)
      .set({ deletedAt: null, deletedByUndo: false })
      .where(and(eq(transactions.importId, id), eq(transactions.deletedByUndo, true)))
      .returning({ id: transactions.id });
    return { rows: rows.length };
  });
}

// ---- Share links ----

export type ShareSnapshotLine = {
  date: string;
  description: string;
  outstandingCents: number;
  category: string | null;
};

export type ShareLinkView = {
  token: string;
  personName: string;
  groupedByCategory: boolean;
  createdAt: Date;
  // What the person owes the owner.
  owedCents: number;
  owed: ShareSnapshotLine[];
  // What the owner owes the person.
  owingCents: number;
  owing: ShareSnapshotLine[];
  // owedCents - owingCents; positive means the person owes the owner.
  netCents: number;
};

// 16 base64url characters from 96 random bits. Short enough not to dominate
// a text message, far too large to enumerate. crypto.randomUUID would be
// longer and, being a v4 uuid, would read as an internal id.
function generateShareToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString(
    'base64url',
  );
}

// Publish a snapshot and return its token. The total is summed here rather
// than taken from the caller so the figure on the page always matches the
// lines beside it.
export async function insertShareLink(input: {
  personName: string;
  groupedByCategory: boolean;
  owed: ShareSnapshotLine[];
  owing: ShareSnapshotLine[];
}): Promise<{ token: string }> {
  const token = generateShareToken();
  const sum = (ls: ShareSnapshotLine[]) =>
    ls.reduce((acc, l) => acc + l.outstandingCents, 0);
  await db.insert(shareLinks).values({
    token,
    personName: input.personName,
    // Vestigial: a snapshot now carries both sides. Written as the dominant
    // direction so the column keeps a sane value for pre-0017 readers.
    direction: sum(input.owed) >= sum(input.owing) ? 'they-owe-me' : 'i-owe-them',
    groupedByCategory: input.groupedByCategory,
    totalCents: sum(input.owed),
    lines: input.owed,
    owingCents: sum(input.owing),
    owingLines: input.owing,
  });
  return { token };
}

// The public read path. A revoked link reads as missing, so the page can
// treat null as "not found" without a second case.
export async function getShareLinkByToken(
  token: string,
): Promise<ShareLinkView | null> {
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt)));
  if (!row) return null;
  return {
    token: row.token,
    personName: row.personName,
    groupedByCategory: row.groupedByCategory,
    createdAt: row.createdAt,
    owedCents: row.totalCents,
    owed: row.lines as ShareSnapshotLine[],
    owingCents: row.owingCents,
    owing: row.owingLines as ShareSnapshotLine[],
    netCents: row.totalCents - row.owingCents,
  };
}

// ---- Bank connections (BANK-SYNC.md) ----

export type BankAccountRow = {
  id: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  syncEnabled: boolean;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  unsharedAt: Date | null;
  // Live (not deleted) rows synced from this account.
  rowCount: number;
};

// Only these account types can be synced into the expense ledger; mirrors
// the bank_accounts_sync_expense_types CHECK.
export const SYNCABLE_ACCOUNT_TYPES = ['depository', 'credit'] as const;

// A connection as the UI sees it. Deliberately has no token field: the sealed
// access token is read only by getSealedAccessToken, never by a list query.
export type BankConnectionRow = {
  id: string;
  provider: string;
  institutionId: string | null;
  institutionName: string | null;
  createdAt: Date;
  status: 'active' | 'paused' | 'removed';
  removedAt: Date | null;
  itemErrorCode: string | null;
  consentExpiresAt: Date | null;
  healthCheckedAt: Date | null;
  accounts: BankAccountRow[];
};

export async function getBankConnections(): Promise<BankConnectionRow[]> {
  const connections = await db
    .select({
      id: bankConnections.id,
      provider: bankConnections.provider,
      institutionId: bankConnections.institutionId,
      institutionName: bankConnections.institutionName,
      createdAt: bankConnections.createdAt,
      status: bankConnections.status,
      removedAt: bankConnections.removedAt,
      itemErrorCode: bankConnections.itemErrorCode,
      consentExpiresAt: bankConnections.consentExpiresAt,
      healthCheckedAt: bankConnections.healthCheckedAt,
    })
    .from(bankConnections)
    .orderBy(asc(bankConnections.createdAt));
  if (connections.length === 0) return [];

  const accounts = await db
    .select({
      id: bankAccounts.id,
      connectionId: bankAccounts.connectionId,
      name: bankAccounts.name,
      officialName: bankAccounts.officialName,
      mask: bankAccounts.mask,
      type: bankAccounts.type,
      subtype: bankAccounts.subtype,
      syncEnabled: bankAccounts.syncEnabled,
      lastSyncedAt: bankAccounts.lastSyncedAt,
      lastSyncError: bankAccounts.lastSyncError,
      unsharedAt: bankAccounts.unsharedAt,
      // Written out qualified: in a single-table select Drizzle renders
      // column references unqualified, which inside this subquery would
      // resolve to "transactions" and compare a column with itself.
      rowCount: sql<number>`(select count(*)::int from "transactions" t
        where t."bank_account_id" = "bank_accounts"."id" and t."deleted_at" is null)`,
    })
    .from(bankAccounts)
    .where(inArray(bankAccounts.connectionId, connections.map((c) => c.id)))
    .orderBy(asc(bankAccounts.type), asc(bankAccounts.name));

  return connections.map((c) => ({
    ...c,
    accounts: accounts
      .filter((a) => a.connectionId === c.id)
      .map(({ connectionId: _, ...a }) => a),
  }));
}

// Record a newly exchanged Item. Idempotent on (provider, item id): a repeat
// returns the existing row instead of failing, so a retried completion never
// loses the token of an Item that already exists at the provider.
export async function insertBankConnection(input: {
  provider: 'plaid';
  providerItemId: string;
  accessTokenSealed: string;
}): Promise<{ id: string; created: boolean }> {
  const [inserted] = await db
    .insert(bankConnections)
    .values(input)
    .onConflictDoNothing({
      target: [bankConnections.provider, bankConnections.providerItemId],
    })
    .returning({ id: bankConnections.id });
  if (inserted) return { id: inserted.id, created: true };

  const [existing] = await db
    .select({ id: bankConnections.id })
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.provider, input.provider),
        eq(bankConnections.providerItemId, input.providerItemId),
      ),
    );
  return { id: existing.id, created: false };
}

// Every login ever linked, removed ones included, for the duplicate guard
// and the Item budget (lib/bank-sync/link-guard.ts).
export async function getLinkedLogins(): Promise<
  {
    institutionId: string | null;
    institutionName: string | null;
    createdAt: Date;
    status: 'active' | 'paused' | 'removed';
    itemErrorCode: string | null;
  }[]
> {
  return db
    .select({
      institutionId: bankConnections.institutionId,
      institutionName: bankConnections.institutionName,
      createdAt: bankConnections.createdAt,
      status: bankConnections.status,
      itemErrorCode: bankConnections.itemErrorCode,
    })
    .from(bankConnections)
    .orderBy(asc(bankConnections.createdAt));
}

// A connection's stored health and status, without its token.
export async function getConnectionHealth(connectionId: string): Promise<{
  status: 'active' | 'paused' | 'removed';
  institutionName: string | null;
  itemErrorCode: string | null;
} | null> {
  const [row] = await db
    .select({
      status: bankConnections.status,
      institutionName: bankConnections.institutionName,
      itemErrorCode: bankConnections.itemErrorCode,
    })
    .from(bankConnections)
    .where(eq(bankConnections.id, connectionId));
  return row ?? null;
}

// The sealed token of a connection that still has one. A removed
// connection's token is erased, so it reads as not found.
export async function getSealedAccessToken(
  connectionId: string,
): Promise<{ providerItemId: string; accessTokenSealed: string } | null> {
  const [row] = await db
    .select({
      providerItemId: bankConnections.providerItemId,
      accessTokenSealed: bankConnections.accessTokenSealed,
    })
    .from(bankConnections)
    .where(eq(bankConnections.id, connectionId));
  if (!row || row.accessTokenSealed === null) return null;
  return { providerItemId: row.providerItemId, accessTokenSealed: row.accessTokenSealed };
}

// Store the institution and accounts the provider reported, in one
// transaction, under the connection's lock. New accounts are added (sync
// off); recorded ones are left as they are, except that an account the
// provider no longer returns is marked unshared with its sync turned off,
// and one that returns is unmarked (sync stays off until the owner turns it
// on). Its rows stay either way.
//
// A returned account that looks like a recorded one under a new id (a
// re-issued account id: the same persistent id, or, where the institution
// gives none, the same type and mask as an account this reload marks
// unshared) is added marked `replaces_account_id`. It cannot sync until the
// owner adopts it, joining the old account's ledger account after its last
// synced row, or says it is a different account (db/ledger.ts): syncing it
// as new would add its history again beside the rows already stored. An
// empty list is not read as "nothing is shared any more".
export async function saveConnectionAccounts(input: {
  connectionId: string;
  institutionId: string | null;
  institutionName: string | null;
  accounts: {
    providerAccountId: string;
    persistentAccountId: string | null;
    name: string;
    officialName: string | null;
    mask: string | null;
    type: string;
    subtype: string | null;
  }[];
}): Promise<{ ok: true; added: number; unshared: number; reshared: number; reissued: number }> {
  return db.transaction(async (tx) => {
    await lockConnection(tx, input.connectionId);
    const recorded = await tx
      .select({
        id: bankAccounts.id,
        providerAccountId: bankAccounts.providerAccountId,
        persistentAccountId: bankAccounts.persistentAccountId,
        unsharedAt: bankAccounts.unsharedAt,
        name: bankAccounts.name,
        mask: bankAccounts.mask,
        type: bankAccounts.type,
      })
      .from(bankAccounts)
      .where(eq(bankAccounts.connectionId, input.connectionId));
    const byProviderId = new Map(recorded.map((a) => [a.providerAccountId, a]));
    const returned = new Set(input.accounts.map((a) => a.providerAccountId));
    const goingAway = input.accounts.length === 0 ? [] : recorded.filter((r) => !returned.has(r.providerAccountId));
    // The recorded account a new one replaces, if it looks like one.
    const replaces = (a: (typeof input.accounts)[number]): string | null => {
      const byPersistent = a.persistentAccountId === null ? undefined : recorded.find((r) => r.persistentAccountId === a.persistentAccountId);
      if (byPersistent) return byPersistent.id;
      if (a.persistentAccountId !== null || a.mask === null) return null;
      const twins = goingAway.filter((r) => r.type === a.type && r.mask === a.mask);
      return twins.length === 1 ? twins[0].id : null;
    };

    await tx
      .update(bankConnections)
      .set({ institutionId: input.institutionId, institutionName: input.institutionName })
      .where(eq(bankConnections.id, input.connectionId));
    const fresh = input.accounts.filter((a) => !byProviderId.has(a.providerAccountId));
    if (fresh.length > 0) {
      await tx
        .insert(bankAccounts)
        .values(fresh.map((a) => ({ ...a, connectionId: input.connectionId, replacesAccountId: replaces(a) })));
    }
    const gone = input.accounts.length === 0 ? [] : recorded.filter((a) => !returned.has(a.providerAccountId) && a.unsharedAt === null);
    const back = recorded.filter((a) => returned.has(a.providerAccountId) && a.unsharedAt !== null);
    if (gone.length > 0) {
      await tx
        .update(bankAccounts)
        .set({ unsharedAt: sql`now()`, syncEnabled: false })
        .where(inArray(bankAccounts.id, gone.map((a) => a.id)));
    }
    if (back.length > 0) {
      await tx.update(bankAccounts).set({ unsharedAt: null }).where(inArray(bankAccounts.id, back.map((a) => a.id)));
    }
    return {
      ok: true,
      added: fresh.length,
      unshared: gone.length,
      reshared: back.length,
      reissued: fresh.filter((a) => replaces(a) !== null).length,
    };
  });
}

// Opt an account in or out of syncing. The CHECKs refuse enabling anything
// but a depository or credit account, and an unshared account; the caller
// turns that into a message. Enabling an account of a removed login is
// refused here, under the connection's lock, because no CHECK can see the
// connection: removal turned every account off, and turning one back on would
// show a login that can never sync as syncing. Turning sync off is always
// allowed.
export async function setAccountSyncEnabled(
  accountId: string,
  enabled: boolean,
): Promise<'ok' | 'not_found' | 'unshared' | 'removed' | 'needs_ledger' | 'reissued'> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ connectionId: bankAccounts.connectionId })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, accountId));
    if (!account) return 'not_found';
    await lockConnection(tx, account.connectionId);
    const [state] = await tx
      .select({
        status: bankConnections.status,
        unsharedAt: bankAccounts.unsharedAt,
        ledgerAccountId: bankAccounts.ledgerAccountId,
        replacesAccountId: bankAccounts.replacesAccountId,
      })
      .from(bankAccounts)
      .innerJoin(bankConnections, eq(bankConnections.id, bankAccounts.connectionId))
      .where(eq(bankAccounts.id, accountId));
    if (enabled && state.status === 'removed') return 'removed';
    if (enabled && state.unsharedAt !== null) return 'unshared';
    // Turning sync on the first time goes through mapAccountToLedger
    // (db/ledger.ts), which confirms the cutover.
    if (enabled && state.replacesAccountId !== null) return 'reissued';
    if (enabled && state.ledgerAccountId === null) return 'needs_ledger';
    await tx.update(bankAccounts).set({ syncEnabled: enabled }).where(eq(bankAccounts.id, accountId));
    return 'ok';
  });
}

export type SyncTarget = {
  connectionId: string;
  providerItemId: string;
  accessTokenSealed: string;
  // A paused connection is returned so the caller can say so; it is not
  // synced (and commitAccountSync re-checks under the lock).
  status: 'active' | 'paused';
  institutionName: string | null;
  accounts: { id: string; providerAccountId: string; syncCursor: string | null; label: string }[];
};

// What a sync of one connection needs: its sealed token and its enabled
// accounts with their cursors. Null when the connection does not exist or
// was removed (its token is erased).
export async function getSyncTarget(connectionId: string): Promise<SyncTarget | null> {
  const [connection] = await db
    .select({
      providerItemId: bankConnections.providerItemId,
      accessTokenSealed: bankConnections.accessTokenSealed,
      status: bankConnections.status,
      institutionName: bankConnections.institutionName,
    })
    .from(bankConnections)
    .where(eq(bankConnections.id, connectionId));
  if (!connection || connection.accessTokenSealed === null || connection.status === 'removed') return null;
  const { accessTokenSealed, status } = connection;
  const accounts = await db
    .select({
      id: bankAccounts.id,
      providerAccountId: bankAccounts.providerAccountId,
      syncCursor: bankAccounts.syncCursor,
      name: bankAccounts.name,
      mask: bankAccounts.mask,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.connectionId, connectionId), eq(bankAccounts.syncEnabled, true)))
    .orderBy(asc(bankAccounts.name));
  return {
    connectionId,
    providerItemId: connection.providerItemId,
    accessTokenSealed,
    status,
    institutionName: connection.institutionName,
    accounts: accounts.map(({ name, mask, ...a }) => ({
      ...a,
      label: mask ? `${name} ••${mask}` : name,
    })),
  };
}

export type AccountSyncOutcome =
  | { kind: 'applied'; counts: SyncCounts & { beforeCutover: number; held: number } }
  | { kind: 'stopped'; reason: string }
  | { kind: 'busy' }
  | { kind: 'stale' }
  // The connection was paused or removed after the fetch began.
  | { kind: 'inactive'; status: 'paused' | 'removed' };

// Rows per statement: well inside Postgres's 65,535 bind-parameter limit at
// ~12 parameters a row.
const SYNC_INSERT_CHUNK = 1000;

// This account's stored rows for the given provider ids, soft-deleted rows
// included, with what the owner has built on each. Read AFTER the rows are
// locked, in its own statement, so a split committed while the lock was
// awaited is seen (READ COMMITTED takes a fresh snapshot per statement).
async function readStoredRows(tx: Tx, accountId: string, ids: string[]): Promise<StoredRow[]> {
  const out: StoredRow[] = [];
  for (let i = 0; i < ids.length; i += SYNC_INSERT_CHUNK) {
    const rows = await tx
      .select({
        rowId: transactions.id,
        providerTransactionId: transactions.providerTransactionId,
        pending: transactions.pending,
        amountCents: transactions.amountCents,
        date: transactions.date,
        descriptionRaw: transactions.descriptionRaw,
        categoryId: transactions.categoryId,
        categorySource: transactions.categorySource,
        bankAmountBeforeCents: transactions.bankAmountBeforeCents,
        deleted: sql<boolean>`${transactions.deletedAt} is not null`,
        removedByBank: sql<boolean>`${transactions.removedByBankAt} is not null`,
        hasSplit: rowHasSplit(),
        hasReceipt: rowHasReceipt(),
        hasNote: sql<boolean>`${transactions.note} is not null`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.bankAccountId, accountId),
          inArray(transactions.providerTransactionId, ids.slice(i, i + SYNC_INSERT_CHUNK)),
        ),
      );
    for (const r of rows) out.push({ ...r, providerTransactionId: r.providerTransactionId as string });
  }
  return out;
}

// Apply one account's fetched changes and advance its cursor, atomically.
// Called after the fetch, so no network call happens inside the transaction.
//   - The connection (Plaid Item) lock is transaction-scoped: Neon's pooled
//     endpoint does not keep session-level advisory locks. Busy means another
//     sync of this Item holds it; nothing is applied.
//   - The connection's status is read under the lock: pausing and removal
//     take the same lock, so a connection paused or removed while the fetch
//     ran applies nothing.
//   - The cursor check makes a fetch that started from an outdated cursor a
//     no-op: another sync committed first, and its rows are already in.
//   - Every stored row the fetch may touch is locked (FOR UPDATE, by id)
//     before its split/receipt/note state is read, so a split save on the same
//     row either commits first and is seen (the row gets flagged) or waits and
//     then refuses because the row changed (replaceSplit's own check).
//   - The planner decides; a stop applies nothing and leaves the cursor.
// Nothing here writes splits, shares, settlements or allocations.
export async function commitAccountSync(input: {
  connectionId: string;
  accountId: string;
  providerAccountId: string;
  startCursor: string | null;
  nextCursor: string;
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: RemovedTransaction[];
  rules: CategoryRule[];
}): Promise<AccountSyncOutcome> {
  return db.transaction(async (tx) => {
    const lockRows = (await tx.execute(sql`
      select pg_try_advisory_xact_lock(hashtextextended(${input.connectionId}, 0)) as locked`)) as unknown as {
      locked: boolean;
    }[];
    if (!lockRows[0]?.locked) return { kind: 'busy' } as const;

    const [connection] = await tx
      .select({ status: bankConnections.status })
      .from(bankConnections)
      .where(eq(bankConnections.id, input.connectionId));
    if (!connection) return { kind: 'stale' } as const;
    if (connection.status !== 'active') return { kind: 'inactive', status: connection.status } as const;

    const [account] = await tx
      .select({
        syncCursor: bankAccounts.syncCursor,
        ledgerAccountId: bankAccounts.ledgerAccountId,
        csvSource: ledgerAccounts.csvSource,
        cutoverDate: ledgerAccounts.cutoverDate,
        cutoverBasis: ledgerAccounts.cutoverBasis,
        cutoverConfirmedAt: ledgerAccounts.cutoverConfirmedAt,
      })
      .from(bankAccounts)
      .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, bankAccounts.ledgerAccountId))
      .where(eq(bankAccounts.id, input.accountId));
    if (!account || account.syncCursor !== input.startCursor) return { kind: 'stale' } as const;
    // The cutover is what keeps a purchase from arriving from both the CSV and
    // the bank (REAL-ACCOUNTS.md); without a confirmed one nothing is applied.
    if (!account.ledgerAccountId || account.cutoverConfirmedAt === null) {
      return { kind: 'stopped', reason: 'This account has no confirmed ledger account and cutover yet; nothing was added.' } as const;
    }
    const cutover: Cutover | null =
      account.cutoverDate !== null ? { date: account.cutoverDate, basis: account.cutoverBasis! } : null;

    const fetchedIds = [...input.added, ...input.modified, ...input.removed].map((t) => t.providerTransactionId);
    const setAsideIds = new Set<string>();
    for (let i = 0; i < fetchedIds.length; i += SYNC_INSERT_CHUNK) {
      const rows = await tx
        .select({ id: syncSkippedRows.providerTransactionId })
        .from(syncSkippedRows)
        .where(
          and(
            eq(syncSkippedRows.bankAccountId, input.accountId),
            inArray(syncSkippedRows.providerTransactionId, fetchedIds.slice(i, i + SYNC_INSERT_CHUNK)),
          ),
        );
      for (const r of rows) setAsideIds.add(r.id);
    }
    // The ledger account's CSV rows around the cutover, for the possible-
    // duplicate check (amount or merchant); only its imports' live rows.
    const csvRows =
      cutover === null
        ? []
        : await tx
            .select({ date: transactions.date, amountCents: transactions.amountCents, description: transactions.descriptionRaw })
            .from(transactions)
            .innerJoin(imports, eq(imports.id, transactions.importId))
            .where(
              and(
                eq(imports.ledgerAccountId, account.ledgerAccountId),
                isNull(transactions.deletedAt),
                sql`${transactions.date} >= ${cutover.date}::date - ${MATCH_DAYS + 1}::int`,
                sql`${transactions.date} < ${cutover.date}::date + ${BOUNDARY_DAYS + MATCH_DAYS}::int`,
              ),
            );
    const split = splitAtCutover({
      cutover,
      added: input.added,
      modified: input.modified,
      removed: input.removed,
      setAsideIds,
      csvRows,
    });

    const pendingIds = referencedPendingIds(split.added);
    const ids = [
      ...new Set([
        ...[...split.added, ...split.modified, ...split.removed].map((t) => t.providerTransactionId),
        ...pendingIds,
      ]),
    ];
    for (let i = 0; i < ids.length; i += SYNC_INSERT_CHUNK) {
      await tx.execute(sql`
        select id from ${transactions}
        where ${transactions.bankAccountId} = ${input.accountId}
          and ${inArray(transactions.providerTransactionId, ids.slice(i, i + SYNC_INSERT_CHUNK))}
        order by id
        for update`);
    }
    const stored = await readStoredRows(tx, input.accountId, ids);

    const storedElsewhere = new Set<string>();
    if (pendingIds.length > 0) {
      const rows = await tx
        .select({ id: transactions.providerTransactionId })
        .from(transactions)
        .where(
          and(
            sql`${transactions.bankAccountId} <> ${input.accountId}`,
            inArray(transactions.providerTransactionId, pendingIds),
          ),
        );
      for (const r of rows) if (r.id) storedElsewhere.add(r.id);
    }
    const nonSplittable = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.isSplittable, false));

    const plan = planSync({
      providerAccountId: input.providerAccountId,
      added: split.added,
      modified: split.modified,
      removed: split.removed,
      stored: new Map(stored.map((r) => [r.providerTransactionId, r])),
      storedElsewhere,
      rules: input.rules,
      nonSplittableCategoryIds: new Set(nonSplittable.map((c) => c.id)),
      bankCategories: await bankCategoryMapOf(tx),
    });
    if (plan.kind === 'stop') return { kind: 'stopped', reason: plan.reason } as const;

    for (const update of plan.updates) {
      const { removedByBankAt, deletedAt, ...fields } = update.set;
      await tx
        .update(transactions)
        .set({
          ...fields,
          ...(removedByBankAt !== undefined ? { removedByBankAt: removedByBankAt === 'now' ? sql`now()` : null } : {}),
          ...(deletedAt !== undefined ? { deletedAt: deletedAt === 'now' ? sql`now()` : null } : {}),
        })
        .where(eq(transactions.id, update.rowId));
    }

    for (let i = 0; i < plan.inserts.length; i += SYNC_INSERT_CHUNK) {
      await tx
        .insert(transactions)
        .values(
          plan.inserts.slice(i, i + SYNC_INSERT_CHUNK).map((p) => ({
            date: p.date,
            amountCents: p.amountCents,
            descriptionRaw: p.descriptionRaw,
            merchantNormalized: p.merchantNormalized,
            categoryId: p.categoryId,
            categorySource: p.categorySource,
            pending: p.pending,
            source: 'plaid' as const,
            bankAccountId: input.accountId,
            providerTransactionId: p.providerTransactionId,
            providerRaw: p.providerRaw,
          })),
        );
    }

    // Rows set aside: recorded, never inserted. A row already set aside keeps
    // its reason and the owner's answer; its fields follow the bank's.
    for (const { row: t, reason } of split.setAside) {
      const values = {
        date: t.authorizedDate ?? t.date,
        postedDate: t.date,
        amountCents: t.amountCents,
        descriptionRaw: t.descriptionRaw,
        pending: t.pending,
        providerRaw: t.raw,
      };
      await tx
        .insert(syncSkippedRows)
        .values({ bankAccountId: input.accountId, providerTransactionId: t.providerTransactionId, reason, ...values })
        .onConflictDoUpdate({ target: [syncSkippedRows.bankAccountId, syncSkippedRows.providerTransactionId], set: values });
    }
    if (split.setAsideRemoved.length > 0) {
      await tx
        .update(syncSkippedRows)
        .set({ removedAt: sql`now()` })
        .where(
          and(
            eq(syncSkippedRows.bankAccountId, input.accountId),
            inArray(syncSkippedRows.providerTransactionId, split.setAsideRemoved),
          ),
        );
    }

    const newlySetAside = split.setAside.filter((s) => !setAsideIds.has(s.row.providerTransactionId));
    const held = newlySetAside.filter((s) => s.reason === 'possible_duplicate').length;
    await tx
      .update(bankAccounts)
      .set({
        syncCursor: input.nextCursor,
        lastSyncedAt: new Date(),
        lastSyncError: null,
        // A row held after the review was closed (Plaid sends the older
        // history on a later sync) reopens it, so it is answered, not lost.
        ...(held > 0 ? { boundaryReviewedAt: null } : {}),
      })
      .where(eq(bankAccounts.id, input.accountId));

    return {
      kind: 'applied',
      counts: {
        ...plan.counts,
        beforeCutover: newlySetAside.filter((s) => s.reason === 'before_cutover').length,
        held,
      },
    } as const;
  });
}

// The Item's health as the provider reported it. `consentExpiresAt`
// undefined leaves the stored expiry alone (an error read from a failed
// request says nothing about consent); the institution is refreshed when
// reported. A removed connection is left as it was.
export async function recordItemHealth(
  connectionId: string,
  health: {
    errorCode: string | null;
    consentExpiresAt?: string | null;
    institutionId?: string | null;
    institutionName?: string | null;
  },
): Promise<void> {
  await db
    .update(bankConnections)
    .set({
      itemErrorCode: health.errorCode,
      healthCheckedAt: sql`now()`,
      ...(health.consentExpiresAt !== undefined
        ? { consentExpiresAt: health.consentExpiresAt === null ? null : new Date(health.consentExpiresAt) }
        : {}),
      ...(health.institutionId ? { institutionId: health.institutionId } : {}),
      ...(health.institutionName ? { institutionName: health.institutionName } : {}),
    })
    .where(and(eq(bankConnections.id, connectionId), sql`${bankConnections.status} <> 'removed'`));
}

// Take the connection's lock, waiting for a commit that holds it: pausing
// and removal queue behind a sync's commit rather than racing it.
export async function lockConnection(tx: Tx, connectionId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))`);
}

export type ConnectionChange = { ok: true } | { error: string };

// Pause or resume syncing. Nothing else changes: the token, accounts, cursors
// and rows stay, and resuming continues from the stored cursors.
export async function setConnectionPaused(connectionId: string, paused: boolean): Promise<ConnectionChange> {
  return db.transaction(async (tx) => {
    await lockConnection(tx, connectionId);
    const [row] = await tx
      .select({ status: bankConnections.status })
      .from(bankConnections)
      .where(eq(bankConnections.id, connectionId));
    if (!row) return { error: 'Connection not found.' };
    if (row.status === 'removed') return { error: 'This login was removed; it cannot sync again.' };
    await tx
      .update(bankConnections)
      .set({ status: paused ? 'paused' : 'active' })
      .where(eq(bankConnections.id, connectionId));
    return { ok: true };
  });
}

// The database half of a removal, after the provider has ended its access:
// erase the token, turn off every account's sync, and delete the login's
// pending rows, which never counted and whose posted version can no longer
// arrive. Posted rows, splits, receipts, settlements and flags stay. Running
// it again on a removed connection changes nothing.
export async function markConnectionRemoved(
  connectionId: string,
): Promise<{ ok: true; pendingDeleted: number; alreadyRemoved: boolean } | { error: string }> {
  return db.transaction(async (tx) => {
    await lockConnection(tx, connectionId);
    const [row] = await tx
      .select({ status: bankConnections.status })
      .from(bankConnections)
      .where(eq(bankConnections.id, connectionId));
    if (!row) return { error: 'Connection not found.' };
    if (row.status === 'removed') return { ok: true, pendingDeleted: 0, alreadyRemoved: true };
    await tx
      .update(bankConnections)
      .set({ status: 'removed', accessTokenSealed: null, removedAt: sql`now()` })
      .where(eq(bankConnections.id, connectionId));
    await tx.update(bankAccounts).set({ syncEnabled: false }).where(eq(bankAccounts.connectionId, connectionId));
    const deleted = (await tx.execute(sql`
      update "transactions" t set "deleted_at" = now()
      where t."pending" and t."deleted_at" is null
        and t."bank_account_id" in (select a."id" from "bank_accounts" a where a."connection_id" = ${connectionId})
      returning t."id"`)) as unknown as { id: string }[];
    return { ok: true, pendingDeleted: deleted.length, alreadyRemoved: false };
  });
}

// Record why an account's sync did not complete. The cursor is untouched.
export async function recordAccountSyncError(accountId: string, message: string): Promise<void> {
  await db
    .update(bankAccounts)
    .set({ lastSyncError: message.slice(0, 500) })
    .where(eq(bankAccounts.id, accountId));
}

export type LinkedAccountGroupRow = {
  id: string;
  institutionName: string | null;
  name: string;
  mask: string | null;
  lastSyncedAt: Date | null;
  unsharedAt: Date | null;
  status: 'active' | 'paused' | 'removed';
  itemErrorCode: string | null;
  // Slice 7: the ledger account it syncs into, and whether its rows count.
  ledgerName: string | null;
  verifiedAt: Date | null;
};

// Accounts that appear in Expenses as Linked groups: every account holding
// synced rows, plus enabled accounts that have none yet.
export async function getLinkedAccountGroups(): Promise<LinkedAccountGroupRow[]> {
  return db
    .select({
      id: bankAccounts.id,
      institutionName: bankConnections.institutionName,
      name: bankAccounts.name,
      mask: bankAccounts.mask,
      lastSyncedAt: bankAccounts.lastSyncedAt,
      unsharedAt: bankAccounts.unsharedAt,
      status: bankConnections.status,
      itemErrorCode: bankConnections.itemErrorCode,
      ledgerName: ledgerAccounts.displayName,
      verifiedAt: bankAccounts.verifiedAt,
    })
    .from(bankAccounts)
    .innerJoin(bankConnections, eq(bankConnections.id, bankAccounts.connectionId))
    .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, bankAccounts.ledgerAccountId))
    .where(
      or(
        eq(bankAccounts.syncEnabled, true),
        sql`exists (select 1 from ${transactions} where ${transactions.bankAccountId} = ${bankAccounts.id})`,
      ),
    )
    .orderBy(asc(bankConnections.institutionName), asc(bankAccounts.name));
}


// ---- Bank flags (BANK-SYNC.md, slice 3) ----

// Dismiss a flag sync set: the owner has looked and keeps the row as it is.
// Changes nothing else (no share, no allocation). Idempotent: a flag already
// cleared, or a deleted row, is a no-op.
export async function clearBankFlag(id: string, flag: 'amount' | 'removed'): Promise<void> {
  await db
    .update(transactions)
    .set(flag === 'amount' ? { bankAmountBeforeCents: null } : { removedByBankAt: null })
    .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)));
}

// How far apart a removed row and its re-added replacement may be dated.
export const REPLACEMENT_WINDOW_DAYS = 7;

export type ReplacementCandidate = {
  id: string;
  date: string;
  descriptionRaw: string;
  amountCents: number;
};

// For each flagged-removed row, the rows its split could move to: live and
// posted, same account, same amount, dated within the window, with no split,
// no receipt and no removal flag of their own.
export async function getReplacementCandidates(
  fromIds: string[],
): Promise<Map<string, ReplacementCandidate[]>> {
  const out = new Map<string, ReplacementCandidate[]>();
  if (fromIds.length === 0) return out;
  const rows = (await db.execute(sql`
    select f.id as from_id, t.id, t.date::text as date, t.description_raw, t.amount_cents
    from ${transactions} f
    join ${transactions} t
      on t.bank_account_id = f.bank_account_id
     and t.amount_cents = f.amount_cents
     and t.id <> f.id
    where ${inArray(sql`f.id`, fromIds)}
      and t.deleted_at is null
      and not t.pending
      and t.removed_by_bank_at is null
      and abs(t.date - f.date) <= ${REPLACEMENT_WINDOW_DAYS}
      and not exists (select 1 from ${splits} s where s.transaction_id = t.id)
      and not exists (select 1 from ${receipts} r where r.transaction_id = t.id)
    order by abs(t.date - f.date), t.date`)) as unknown as {
    from_id: string;
    id: string;
    date: string;
    description_raw: string;
    amount_cents: string | number;
  }[];
  for (const r of rows) {
    const list = out.get(r.from_id) ?? [];
    list.push({ id: r.id, date: r.date, descriptionRaw: r.description_raw, amountCents: Number(r.amount_cents) });
    out.set(r.from_id, list);
  }
  return out;
}

export type MoveResult = { ok: true } | { error: string };

// Resolve a removed-by-bank row whose purchase came back under a new id that
// sync could not pair: re-point its split and receipt (transaction_id) onto
// the replacement, carry its note and manual category over where the
// replacement has none, and delete it as the owner. Shares and settlement
// allocations reference the split, not the row, so every payment stays
// exactly where it was. Both rows are locked (by id) before anything is
// checked; any condition that no longer holds refuses with a message.
export async function moveBuiltOnToReplacement(fromId: string, toId: string): Promise<MoveResult> {
  if (fromId === toId) return { error: 'Choose a different transaction.' };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${transactions} where ${inArray(transactions.id, [fromId, toId])} order by id for update`);
    const rows = await tx
      .select({
        id: transactions.id,
        bankAccountId: transactions.bankAccountId,
        amountCents: transactions.amountCents,
        date: transactions.date,
        pending: transactions.pending,
        deleted: sql<boolean>`${transactions.deletedAt} is not null`,
        removedByBank: sql<boolean>`${transactions.removedByBankAt} is not null`,
        note: transactions.note,
        categoryId: transactions.categoryId,
        categorySource: transactions.categorySource,
        hasSplit: rowHasSplit(),
        hasReceipt: rowHasReceipt(),
      })
      .from(transactions)
      .where(inArray(transactions.id, [fromId, toId]));
    const from = rows.find((r) => r.id === fromId);
    const to = rows.find((r) => r.id === toId);
    if (!from || from.deleted || !from.removedByBank) {
      return { error: 'This row is no longer flagged as removed by the bank.' };
    }
    if (!to || to.deleted) return { error: 'That transaction no longer exists.' };
    const days = Math.abs(Date.parse(to.date) - Date.parse(from.date)) / 86_400_000;
    const unfit =
      to.pending ? 'it is still pending'
      : to.bankAccountId !== from.bankAccountId ? 'it is in a different account'
      : to.amountCents !== from.amountCents ? 'its amount differs'
      : days > REPLACEMENT_WINDOW_DAYS ? `it is more than ${REPLACEMENT_WINDOW_DAYS} days away`
      : to.hasSplit ? 'it already has a split'
      : to.hasReceipt ? 'it already has a receipt'
      : to.removedByBank ? 'the bank removed it too'
      : null;
    if (unfit) return { error: `That transaction can't take this split: ${unfit}.` };

    const takeCategory = from.categorySource === 'manual' && to.categorySource !== 'manual';
    const categoryId = takeCategory ? from.categoryId : to.categoryId;
    if (from.hasSplit && categoryId) {
      const [category] = await tx
        .select({ name: categories.name, isSplittable: categories.isSplittable })
        .from(categories)
        .where(eq(categories.id, categoryId));
      if (category && !category.isSplittable) {
        return { error: `That transaction is categorized ${category.name}, which can't hold a split.` };
      }
    }

    await tx.update(splits).set({ transactionId: toId }).where(eq(splits.transactionId, fromId));
    await tx.update(receipts).set({ transactionId: toId }).where(eq(receipts.transactionId, fromId));
    await tx
      .update(transactions)
      .set({
        ...(to.note === null && from.note !== null ? { note: from.note } : {}),
        ...(takeCategory ? { categoryId: from.categoryId, categorySource: 'manual' as const } : {}),
      })
      .where(eq(transactions.id, toId));
    await tx
      .update(transactions)
      .set({ deletedAt: sql`now()`, removedByBankAt: null })
      .where(eq(transactions.id, fromId));
    return { ok: true } as const;
  });
}
