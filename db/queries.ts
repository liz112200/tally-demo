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
import { categorize, type CategoryRule } from '@/lib/categorize';
import { allocateFifo } from '@/lib/allocations';
import { planNetting, type Alloc } from '@/lib/netting';
import { formatUSD, toCents } from '@/lib/money';
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
  // Free-text user annotation; null when none.
  note: string | null;
  // Resolved from the category (uncategorized counts as splittable) and the
  // sign: refunds/credits are never splittable.
  isSplittable: boolean;
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
      note: transactions.note,
      categoryIsSplittable: categories.isSplittable,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(isNull(transactions.deletedAt))
    .orderBy(desc(transactions.date), desc(transactions.createdAt));
  return rows.map(({ categoryIsSplittable, ...row }) => ({
    ...row,
    isSplittable: row.amountCents > 0 && (categoryIsSplittable ?? true),
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
}): Promise<{ created: boolean }> {
  const rows = await db
    .insert(categories)
    .values({ name: input.name, isSplittable: input.isSplittable })
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

export async function deleteRuleById(id: string): Promise<void> {
  await db.delete(categorizationRules).where(eq(categorizationRules.id, id));
}

// Re-run the rule set against existing transactions. Only rows that are
// uncategorized (category_source NULL) or previously rule-set ('rule') are
// touched; 'manual' rows are never overwritten. A row that matches is set to
// the winning category with source 'rule'; a previously-'rule' row that no
// longer matches any rule is cleared. Returns counts for the caller to report.
export async function applyRulesToExisting(): Promise<{
  matched: number;
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

  const candidates = await db
    .select({
      id: transactions.id,
      merchantNormalized: transactions.merchantNormalized,
      categoryId: transactions.categoryId,
      categorySource: transactions.categorySource,
    })
    .from(transactions)
    .where(
      and(
        isNull(transactions.deletedAt),
        or(isNull(transactions.categorySource), eq(transactions.categorySource, 'rule')),
      ),
    );

  const [{ value: skippedManual }] = await db
    .select({ value: count() })
    .from(transactions)
    .where(
      and(isNull(transactions.deletedAt), eq(transactions.categorySource, 'manual')),
    );

  let matched = 0;
  let unmatched = 0;
  for (const row of candidates) {
    const categoryId = categorize(row.merchantNormalized, engineRules);
    if (categoryId) {
      if (row.categoryId !== categoryId || row.categorySource !== 'rule') {
        await db
          .update(transactions)
          .set({ categoryId, categorySource: 'rule' })
          .where(eq(transactions.id, row.id));
      }
      matched += 1;
    } else {
      // Clear a stale rule categorization; NULL rows stay NULL (no-op).
      if (row.categoryId !== null || row.categorySource !== null) {
        await db
          .update(transactions)
          .set({ categoryId: null, categorySource: null })
          .where(and(eq(transactions.id, row.id), eq(transactions.categorySource, 'rule')));
      }
      unmatched += 1;
    }
  }

  return { matched, unmatched, skippedManual };
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
      categorySource: input.categoryId ? (input.categorySource ?? null) : null,
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
export async function softDeletePersonById(id: string): Promise<void> {
  await db
    .update(persons)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(persons.id, id), eq(persons.isOwner, false)));
}

type SplitMethodType = (typeof splits.method.enumValues)[number];

// The transaction handle drizzle hands to a db.transaction callback; helpers
// that must run inside an existing transaction take this.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
export async function deleteExternalSplit(splitId: string): Promise<void> {
  await db
    .delete(splits)
    .where(and(eq(splits.id, splitId), isNull(splits.transactionId)));
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
  isSplittable: boolean;
} | null> {
  const rows = await db
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      categoryIsSplittable: categories.isSplittable,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)));
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    amountCents: row.amountCents,
    isSplittable: row.amountCents > 0 && (row.categoryIsSplittable ?? true),
  };
}

// Editing a split is a full overwrite (locked in CLAUDE.md): drop the old
// split (shares cascade) and insert the new one atomically. Owner-paid splits
// carry payer_person_id = the owner id (passed in; the column is NOT NULL with
// no SQL default, so every insert names the payer explicitly).
export async function replaceSplit(input: {
  transactionId: string;
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
}): Promise<void> {
  await db.transaction(async (tx) => {
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
  });
}

// Removing a split returns the transaction to "entirely the owner's".
export async function deleteSplitByTransactionId(
  transactionId: string,
): Promise<void> {
  await db.delete(splits).where(eq(splits.transactionId, transactionId));
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
}): Promise<void> {
  await db.transaction(async (tx) => {
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
export async function deleteSettlementById(id: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM settlements
    WHERE id = ${id}
       OR group_id = (SELECT group_id FROM settlements WHERE id = ${id} AND group_id IS NOT NULL)
  `);
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
export async function hardDeletePersonById(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(settlements).where(eq(settlements.personId, id));
    await tx.delete(splitShares).where(eq(splitShares.personId, id));
    await tx
      .delete(receiptItemAssignments)
      .where(eq(receiptItemAssignments.personId, id));
    await tx
      .delete(persons)
      .where(and(eq(persons.id, id), eq(persons.isOwner, false)));
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
): Promise<{ blobUrls: string[] } | null> {
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
  await db.transaction(async (tx) => {
    // receipt_images cascade with the receipt row.
    await tx.delete(receipts).where(eq(receipts.transactionId, transactionId));
    await tx
      .delete(splits)
      .where(
        and(eq(splits.transactionId, transactionId), eq(splits.method, 'item')),
      );
  });
  return { blobUrls };
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
      merchantNormalized: transactions.merchantNormalized,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(isNull(transactions.deletedAt));
  return rows.map((row) => ({
    ...row,
    categoryIsSplittable: row.categoryIsSplittable ?? true,
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
): Promise<void> {
  await db.update(imports).set({ hidden }).where(eq(imports.id, id));
}

// Unhide every hidden import at once ("Show all" in the strip).
export async function showAllImports(): Promise<void> {
  await db.update(imports).set({ hidden: false }).where(eq(imports.hidden, true));
}

export async function insertImport(input: {
  source: TransactionSource;
  filename: string;
  displayName: string;
  rowCount: number;
}): Promise<{ importId: string }> {
  const [row] = await db
    .insert(imports)
    .values(input)
    .returning({ id: imports.id });
  return { importId: row.id };
}

export async function updateImportRowCount(
  importId: string,
  rowCount: number,
): Promise<void> {
  await db.update(imports).set({ rowCount }).where(eq(imports.id, importId));
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
export async function softDeleteImportById(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(imports)
      .set({ deletedAt: sql`now()` })
      .where(eq(imports.id, id));
    await tx
      .update(transactions)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(transactions.importId, id), isNull(transactions.deletedAt)));
  });
}

// Soft delete. The dedup_hash stays occupied (a re-import will not
// resurrect the row) and splits/shares/receipts stay untouched; read paths
// filter them out instead.
export async function softDeleteTransactionById(id: string): Promise<void> {
  await db
    .update(transactions)
    .set({ deletedAt: sql`now()` })
    .where(eq(transactions.id, id));
}

// User edit of an existing row's core fields (phase 7). The dedup_hash is
// NOT recomputed — it recorded what the import saw, and edits are trusted
// post-hoc — but the derived merchant_normalized is, so categorization
// rules keep matching what the row now says.
export async function updateTransactionDetailsById(
  id: string,
  input: { date: string; amountCents: number; descriptionRaw: string },
): Promise<void> {
  await db
    .update(transactions)
    .set({
      date: input.date,
      amountCents: input.amountCents,
      descriptionRaw: input.descriptionRaw,
      merchantNormalized: normalizeMerchant(input.descriptionRaw),
    })
    .where(eq(transactions.id, id));
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
export async function softDeleteTransactionsByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(transactions)
    .set({ deletedAt: sql`now()` })
    .where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt)));
}

// Bulk form of updateTransactionCategory, same manual-override semantics:
// every selected row gets category_source 'manual' (or NULL when clearing),
// so a later rule apply never re-clobbers them.
export async function bulkUpdateTransactionCategory(
  ids: string[],
  categoryId: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(transactions)
    .set({ categoryId, categorySource: categoryId ? 'manual' : null })
    .where(inArray(transactions.id, ids));
}

// Inline category edit is always a manual override: it sets category_source to
// 'manual' when a category is chosen, or back to NULL when cleared (making the
// row eligible for rules again).
export async function updateTransactionCategory(
  id: string,
  categoryId: string | null,
): Promise<void> {
  await db
    .update(transactions)
    .set({ categoryId, categorySource: categoryId ? 'manual' : null })
    .where(eq(transactions.id, id));
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
// number of rows a restore would revive. `restorableCount` matches rows on
// deleted_at rather than counting every row in the batch: softDeleteImportById
// only stamps rows that were still live, so a row deleted before the undo has
// an earlier timestamp and must stay deleted.
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
      restorableCount: sql<number>`(
        SELECT COUNT(*) FROM ${transactions} t
        WHERE t.import_id = ${imports.id} AND t.deleted_at = ${imports.deletedAt}
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
export async function restoreImportById(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [imp] = await tx
      .select({ deletedAt: imports.deletedAt })
      .from(imports)
      .where(eq(imports.id, id));
    if (!imp?.deletedAt) return;
    await tx
      .update(transactions)
      .set({ deletedAt: null })
      .where(
        and(eq(transactions.importId, id), eq(transactions.deletedAt, imp.deletedAt)),
      );
    // hidden is cleared alongside: restoring a batch that was hidden before
    // it was undone would otherwise bring the rows back invisibly, making the
    // Restore button look like it did nothing.
    await tx
      .update(imports)
      .set({ deletedAt: null, hidden: false })
      .where(eq(imports.id, id));
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
