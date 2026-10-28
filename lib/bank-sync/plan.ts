// The sync planner: what one account's fetched changes mean for the ledger.
// Pure and framework-free like lib/import-dedup.ts; the commit
// (db/queries.ts commitAccountSync) locks and reads the stored rows, calls
// this, and writes what it returns.
//
// The rules (BANK-SYNC.md):
//   - Sync never changes a balance. It never writes splits, shares,
//     settlements or allocations, and never deletes a row the owner has built
//     on (a split, a receipt, a note, a manual category); it updates the row
//     and flags it instead.
//   - Pending rows are stored, and their posted row takes them over in place.
//   - A removed posted row and an identical added one in the same sync are
//     one transaction changing id.
//   - Anything unexpected stops the whole sync and applies nothing, leaving
//     the cursor where it was.
import { normalizeMerchant } from '../parsers/normalize';
import { categorize, ruleOutcome, type CategoryRule } from '../categorize';
import type { ProviderTransaction, RemovedTransaction } from './provider';

// A stored row of the account being synced, as the commit read it under lock.
export type StoredRow = {
  rowId: string;
  providerTransactionId: string;
  pending: boolean;
  amountCents: number;
  date: string;
  descriptionRaw: string;
  categoryId: string | null;
  categorySource: 'manual' | 'rule' | null;
  bankAmountBeforeCents: number | null;
  deleted: boolean;
  removedByBank: boolean;
  hasSplit: boolean;
  hasReceipt: boolean;
  hasNote: boolean;
};

export type PlannedInsert = {
  providerTransactionId: string;
  // When the purchase happened when the bank says, else the posted date.
  date: string;
  amountCents: number;
  descriptionRaw: string;
  merchantNormalized: string;
  categoryId: string | null;
  categorySource: 'rule' | null;
  pending: boolean;
  providerRaw: unknown;
};

// Columns to set on one stored row. A field left undefined is not written.
export type PlannedUpdate = {
  rowId: string;
  reason: 'takeover' | 'reidentify' | 'modify' | 'remove-flag' | 'remove-delete';
  set: {
    providerTransactionId?: string;
    date?: string;
    amountCents?: number;
    descriptionRaw?: string;
    merchantNormalized?: string;
    pending?: boolean;
    categoryId?: string | null;
    categorySource?: 'rule' | null;
    providerRaw?: unknown;
    bankAmountBeforeCents?: number | null;
    // 'now' stamps the commit's timestamp; null clears.
    removedByBankAt?: 'now' | null;
    deletedAt?: 'now' | null;
  };
};

export type SyncCounts = {
  inserted: number;
  insertedPending: number;
  takenOver: number;
  reidentified: number;
  updated: number;
  amountFlagged: number;
  removedDeleted: number;
  removedFlagged: number;
  ignored: number;
};

// "3 new (1 pending), 2 posted, 1 updated, 1 needs review". Zero counts are
// left out; nothing at all reads "no changes". Rows the cutover set aside
// (REAL-ACCOUNTS.md) are named too, so a first sync that inserts little
// says why.
export function describeCounts(c: SyncCounts & { beforeCutover?: number; held?: number }): string {
  const parts: string[] = [];
  if (c.inserted > 0) parts.push(`${c.inserted} new` + (c.insertedPending > 0 ? ` (${c.insertedPending} pending)` : ''));
  if (c.takenOver > 0) parts.push(`${c.takenOver} posted`);
  if (c.updated + c.reidentified > 0) parts.push(`${c.updated + c.reidentified} updated`);
  if (c.removedDeleted > 0) parts.push(`${c.removedDeleted} removed by the bank`);
  const review = c.amountFlagged + c.removedFlagged;
  if (review > 0) parts.push(`${review} need${review === 1 ? 's' : ''} review`);
  if (c.held) parts.push(`${c.held} held: may match a CSV row, see the boundary review`);
  if (c.beforeCutover) parts.push(`${c.beforeCutover} before the cutover, not added`);
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}

export type SyncPlan =
  | { kind: 'apply'; inserts: PlannedInsert[]; updates: PlannedUpdate[]; counts: SyncCounts }
  | { kind: 'stop'; reason: string };

export function planSync(input: {
  // The account being synced, as the provider identifies it.
  providerAccountId: string;
  added: readonly ProviderTransaction[];
  modified: readonly ProviderTransaction[];
  removed: readonly RemovedTransaction[];
  // This account's stored rows for every id the fetch mentions and every
  // pending id a posted row points at, soft-deleted rows included.
  stored: ReadonlyMap<string, StoredRow>;
  // Of those same ids, the ones stored under a different account.
  storedElsewhere: ReadonlySet<string>;
  rules: readonly CategoryRule[];
  // Categories that may not hold a split (is_splittable = false).
  nonSplittableCategoryIds: ReadonlySet<string>;
}): SyncPlan {
  const { providerAccountId, stored } = input;
  const isSplittable = (id: string) => !input.nonSplittableCategoryIds.has(id);

  const all = [...input.added, ...input.modified, ...input.removed];
  const foreign = all.find((t) => t.providerAccountId !== providerAccountId);
  if (foreign) {
    return {
      kind: 'stop',
      reason: `The provider returned a row for another account (${foreign.providerTransactionId}).`,
    };
  }
  for (const t of [...input.added, ...input.modified]) {
    if (t.unofficialCurrencyCode !== null || t.isoCurrencyCode !== 'USD') {
      return {
        kind: 'stop',
        reason: `Transaction ${t.providerTransactionId} is not in USD (${t.isoCurrencyCode ?? t.unofficialCurrencyCode ?? 'unknown currency'}); amounts are never converted.`,
      };
    }
    if (t.descriptionRaw.trim() === '') {
      return { kind: 'stop', reason: `Transaction ${t.providerTransactionId} has no description.` };
    }
  }

  // One final state per id. A removal outranks anything else for the same id
  // in the same fetch, and a modification outranks the add it amends.
  const removedIds = new Set(input.removed.map((r) => r.providerTransactionId));
  const finals = new Map<string, { txn: ProviderTransaction; fromAdded: boolean }>();
  for (const t of input.added) {
    if (!removedIds.has(t.providerTransactionId)) finals.set(t.providerTransactionId, { txn: t, fromAdded: true });
  }
  for (const t of input.modified) {
    if (removedIds.has(t.providerTransactionId)) continue;
    const prior = finals.get(t.providerTransactionId);
    finals.set(t.providerTransactionId, { txn: t, fromAdded: prior?.fromAdded ?? false });
  }

  // A stored posted row reported as pending again is not something Plaid
  // does; guessing what it means could rewrite a split row.
  for (const { txn } of finals.values()) {
    const row = stored.get(txn.providerTransactionId);
    if (row && !row.pending && txn.pending) {
      return {
        kind: 'stop',
        reason: `The bank reported posted transaction ${txn.providerTransactionId} as pending again.`,
      };
    }
  }

  const inserts: PlannedInsert[] = [];
  const updates: PlannedUpdate[] = [];
  const counts: SyncCounts = {
    inserted: 0,
    insertedPending: 0,
    takenOver: 0,
    reidentified: 0,
    updated: 0,
    amountFlagged: 0,
    removedDeleted: 0,
    removedFlagged: 0,
    ignored: 0,
  };
  // Stored rows already given a new identity (takeover or re-add), whose own
  // removal in this fetch must not also apply.
  const consumed = new Set<string>();
  // New ids already placed onto a stored row, so they are not inserted.
  const placed = new Set<string>();

  const builtOn = (row: StoredRow) =>
    row.hasSplit || row.hasReceipt || row.hasNote || row.categorySource === 'manual';

  // The category after a description change, through the shared rule.
  const recategorize = (row: StoredRow, merchantNormalized: string) =>
    ruleOutcome(row, categorize(merchantNormalized, [...input.rules]), isSplittable);

  // The fields of a stored row that a provider row overwrites, and what
  // follows from them (rules, the amount flag). Undefined when nothing
  // changes.
  function applyFields(row: StoredRow, txn: ProviderTransaction): PlannedUpdate['set'] {
    const set: PlannedUpdate['set'] = {};
    const date = txn.authorizedDate ?? txn.date;
    if (date !== row.date) set.date = date;
    if (txn.descriptionRaw !== row.descriptionRaw) {
      set.descriptionRaw = txn.descriptionRaw;
      set.merchantNormalized = normalizeMerchant(txn.descriptionRaw);
      const category = recategorize(row, set.merchantNormalized);
      if (category) Object.assign(set, category);
    }
    if (txn.pending !== row.pending) set.pending = txn.pending;
    if (txn.amountCents !== row.amountCents) {
      set.amountCents = txn.amountCents;
      // A deleted row's split counts nowhere, so it needs no flag.
      if (row.hasSplit && !row.deleted) {
        // The amount the split was built on: the first one, kept across
        // further changes, and cleared when the bank returns to it.
        const basis = row.bankAmountBeforeCents ?? row.amountCents;
        const next = txn.amountCents === basis ? null : basis;
        if (next !== row.bankAmountBeforeCents) set.bankAmountBeforeCents = next;
      }
    }
    return set;
  }

  // 1. Posted rows taking over their pending row.
  const pendingClaimed = new Set<string>();
  for (const { txn, fromAdded } of finals.values()) {
    if (!fromAdded || txn.pending || txn.pendingTransactionId === null) continue;
    if (stored.has(txn.providerTransactionId)) {
      // The posted row is already stored on its own. No takeover; a pending
      // row still live beside it is the bank's to remove.
      const pendingRow = stored.get(txn.pendingTransactionId);
      if (pendingRow && pendingRow.pending && !pendingRow.deleted && !consumed.has(pendingRow.providerTransactionId)) {
        consumed.add(pendingRow.providerTransactionId);
        updates.push({ rowId: pendingRow.rowId, reason: 'remove-delete', set: { removedByBankAt: 'now', deletedAt: 'now' } });
        counts.removedDeleted += 1;
      }
      continue;
    }
    const pendingRow = stored.get(txn.pendingTransactionId);
    if (!pendingRow) {
      if (input.storedElsewhere.has(txn.pendingTransactionId)) {
        return {
          kind: 'stop',
          reason: `Posted transaction ${txn.providerTransactionId} points at a pending row of another account.`,
        };
      }
      continue; // never stored: inserted below as a new row
    }
    if (!pendingRow.pending || pendingClaimed.has(pendingRow.providerTransactionId)) continue;
    pendingClaimed.add(pendingRow.providerTransactionId);
    consumed.add(pendingRow.providerTransactionId);
    placed.add(txn.providerTransactionId);
    const set: PlannedUpdate['set'] = {
      providerTransactionId: txn.providerTransactionId,
      providerRaw: txn.raw,
      ...applyFields(pendingRow, txn),
    };
    // Revive a pending row the bank removed; one the owner deleted stays so.
    if (pendingRow.deleted && pendingRow.removedByBank) {
      set.deletedAt = null;
      set.removedByBankAt = null;
    }
    updates.push({ rowId: pendingRow.rowId, reason: 'takeover', set });
    counts.takenOver += 1;
  }

  // 2. A posted row removed and an identical one added: the same purchase
  //    under a new id. Paired only when exactly one of each matches.
  const pairKey = (amount: number, date: string, description: string) => `${amount}|${date}|${description}`;
  const removedPosted = new Map<string, StoredRow[]>();
  for (const id of removedIds) {
    const row = stored.get(id);
    if (!row || row.pending || row.deleted || consumed.has(id)) continue;
    const key = pairKey(row.amountCents, row.date, row.descriptionRaw);
    removedPosted.set(key, [...(removedPosted.get(key) ?? []), row]);
  }
  const addedPosted = new Map<string, ProviderTransaction[]>();
  for (const { txn, fromAdded } of finals.values()) {
    if (!fromAdded || txn.pending || stored.has(txn.providerTransactionId) || placed.has(txn.providerTransactionId)) continue;
    const key = pairKey(txn.amountCents, txn.authorizedDate ?? txn.date, txn.descriptionRaw);
    addedPosted.set(key, [...(addedPosted.get(key) ?? []), txn]);
  }
  for (const [key, rows] of removedPosted) {
    const txns = addedPosted.get(key);
    if (rows.length !== 1 || txns?.length !== 1) continue;
    const [row] = rows;
    const [txn] = txns;
    consumed.add(row.providerTransactionId);
    placed.add(txn.providerTransactionId);
    updates.push({
      rowId: row.rowId,
      reason: 'reidentify',
      set: { providerTransactionId: txn.providerTransactionId, providerRaw: txn.raw, ...applyFields(row, txn) },
    });
    counts.reidentified += 1;
  }

  // 3. Changes to stored rows.
  for (const { txn, fromAdded } of finals.values()) {
    const row = stored.get(txn.providerTransactionId);
    if (!row) {
      if (!fromAdded) counts.ignored += 1; // a change to a row never stored
      continue;
    }
    if (consumed.has(row.providerTransactionId)) continue;
    const set = applyFields(row, txn);
    // The bank re-delivering a row it had removed: it exists again.
    if (row.deleted && row.removedByBank) {
      set.deletedAt = null;
      set.removedByBankAt = null;
    }
    if (Object.keys(set).length === 0) continue; // re-delivered unchanged
    set.providerRaw = txn.raw;
    updates.push({ rowId: row.rowId, reason: 'modify', set });
    counts.updated += 1;
    if (set.bankAmountBeforeCents !== undefined && set.bankAmountBeforeCents !== null) counts.amountFlagged += 1;
  }

  // 4. Removals.
  for (const id of removedIds) {
    const row = stored.get(id);
    if (!row) {
      counts.ignored += 1;
      continue;
    }
    if (consumed.has(id) || row.deleted) continue;
    if (row.pending || !builtOn(row)) {
      updates.push({ rowId: row.rowId, reason: 'remove-delete', set: { removedByBankAt: 'now', deletedAt: 'now' } });
      counts.removedDeleted += 1;
    } else if (!row.removedByBank) {
      updates.push({ rowId: row.rowId, reason: 'remove-flag', set: { removedByBankAt: 'now' } });
      counts.removedFlagged += 1;
    }
  }

  // 5. New rows.
  for (const { txn, fromAdded } of finals.values()) {
    if (!fromAdded || stored.has(txn.providerTransactionId) || placed.has(txn.providerTransactionId)) continue;
    const merchantNormalized = normalizeMerchant(txn.descriptionRaw);
    const categoryId = categorize(merchantNormalized, [...input.rules]);
    inserts.push({
      providerTransactionId: txn.providerTransactionId,
      date: txn.authorizedDate ?? txn.date,
      amountCents: txn.amountCents,
      descriptionRaw: txn.descriptionRaw,
      merchantNormalized,
      categoryId,
      categorySource: categoryId ? 'rule' : null,
      pending: txn.pending,
      providerRaw: txn.raw,
    });
    counts.inserted += 1;
    if (txn.pending) counts.insertedPending += 1;
  }

  return { kind: 'apply', inserts, updates, counts };
}

// Every pending id the fetch's posted rows point at: the commit must read
// those rows too.
export function referencedPendingIds(added: readonly ProviderTransaction[]): string[] {
  return [
    ...new Set(
      added.filter((t) => !t.pending && t.pendingTransactionId !== null).map((t) => t.pendingTransactionId as string),
    ),
  ];
}
