// Grouping of expense rows by upload batch, pure and framework-free like
// lib/expense-filters.ts. Groups derive from the imports list — a batch
// whose rows are all filtered out still renders as an empty group — while
// row order inside a group follows the caller's current sort.
import type { SourceTab } from './expense-filters';

export type ImportGroupMeta = {
  id: string;
  source: string;
  // Original upload filename; null identifies a synthetic backfill import.
  filename: string | null;
  // Standardized (or user-renamed) display label; null falls back to
  // filename, then to "Untitled import".
  displayName: string | null;
  // Upload date as YYYY-MM-DD (callers format the timestamp server-side).
  importedAt: string;
  rowCount: number;
  backfilled: boolean;
  // Hidden from the Expenses list (persisted on the imports row). Hidden
  // batches drop their header and rows from the view; the strip unhides them.
  hidden: boolean;
};

const SOURCE_LABELS: Record<string, string> = {
  chase: 'Chase',
  discover: 'Discover',
  amex: 'Amex',
  plaid: 'Linked',
  manual: 'Manual',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

// "YYYY-MM-DD" -> "MM/DD".
function monthDay(date: string): string {
  const [, m, d] = date.split('-');
  return `${m}/${d}`;
}

// Auto-generated name for a fresh import: "Discover 06/12 – 07/09".
export function defaultImportName(source: string, from: string, to: string): string {
  return `${sourceLabel(source)} ${monthDay(from)} – ${monthDay(to)}`;
}

// Auto-generated name for a synthetic backfill import: "Chase (backfilled)".
export function backfilledImportName(source: string): string {
  return `${sourceLabel(source)} (backfilled)`;
}

export type GroupableRow = {
  id: string;
  date: string;
  importId: string | null;
  // The linked account a synced row came from (BANK-SYNC.md); absent or null
  // for CSV and manual rows.
  bankAccountId?: string | null;
};

// A linked account as a group: synced rows group by the account they came
// from, the way CSV rows group by upload batch. No undo, rename, or hide:
// those belong to uploads, not accounts.
export type AccountGroupMeta = {
  id: string;
  // "Institution · Account ••mask".
  label: string;
  // ISO timestamp of the last completed sync; null if never synced.
  lastSyncedAt: string | null;
  // Why the account is not syncing (lib/bank-sync/accounts-view.ts), or null.
  notSyncing?: { text: string; needsOwner: boolean } | null;
};

const ACCOUNT_KEY_PREFIX = 'account:';

// The key 'ungrouped' collects manual rows (and, defensively, rows whose
// import is missing from the list); import groups key by import id.
export const UNGROUPED_KEY = 'ungrouped';

export type RowGroup<T> = {
  key: string;
  // At most one of imp and account is set; neither = manual entries.
  imp: ImportGroupMeta | null;
  account: AccountGroupMeta | null;
  // Visible rows in the caller's sort order; empty when filters hide all.
  rows: T[];
  // min/max transaction date across the whole batch, unfiltered, so the
  // header reads as the statement period even while filters narrow rows.
  batchDates: { from: string; to: string } | null;
  // Non-deleted rows in the batch, unfiltered — the N of "Undo import".
  batchSize: number;
};

// Returns null when the view should render flat: the Manual tab (manual
// entries are never grouped) or a view with neither imports nor linked
// accounts. Synced rows group by account (the Linked tab shows only those);
// CSV rows group by upload batch.
export function groupRowsByImport<T extends GroupableRow>(input: {
  // Every non-deleted row, unfiltered (batch stats).
  all: readonly T[];
  // Filtered + sorted rows for display.
  visible: readonly T[];
  // Non-deleted imports, newest upload first (group order).
  imports: readonly ImportGroupMeta[];
  // Linked accounts, in display order.
  accounts?: readonly AccountGroupMeta[];
  tab: SourceTab;
}): RowGroup<T>[] | null {
  if (input.tab === 'manual') return null;
  const tabImports =
    input.tab === 'all'
      ? input.imports
      : input.imports.filter((imp) => imp.source === input.tab);
  const tabAccounts =
    input.tab === 'all' || input.tab === 'plaid' ? (input.accounts ?? []) : [];
  if (tabImports.length === 0 && tabAccounts.length === 0) return null;

  const knownImports = new Set(tabImports.map((imp) => imp.id));
  const knownAccounts = new Set(tabAccounts.map((acc) => acc.id));
  const keyFor = (row: T) => {
    if (row.bankAccountId && knownAccounts.has(row.bankAccountId)) {
      return ACCOUNT_KEY_PREFIX + row.bankAccountId;
    }
    if (row.importId !== null && knownImports.has(row.importId)) return row.importId;
    return UNGROUPED_KEY;
  };

  const visibleByKey = new Map<string, T[]>();
  for (const row of input.visible) {
    const key = keyFor(row);
    const list = visibleByKey.get(key) ?? [];
    list.push(row);
    visibleByKey.set(key, list);
  }

  // Date span and size per group, from the unfiltered rows.
  const batchByKey = new Map<string, { from: string; to: string; size: number }>();
  for (const row of input.all) {
    const key = keyFor(row);
    if (key === UNGROUPED_KEY) continue;
    const batch = batchByKey.get(key);
    if (!batch) {
      batchByKey.set(key, { from: row.date, to: row.date, size: 1 });
    } else {
      if (row.date < batch.from) batch.from = row.date;
      if (row.date > batch.to) batch.to = row.date;
      batch.size += 1;
    }
  }
  const stats = (key: string) => {
    const batch = batchByKey.get(key);
    return {
      batchDates: batch ? { from: batch.from, to: batch.to } : null,
      batchSize: batch?.size ?? 0,
    };
  };

  const groups: RowGroup<T>[] = [];
  const ungrouped = visibleByKey.get(UNGROUPED_KEY) ?? [];
  const ungroupedGroup: RowGroup<T> = {
    key: UNGROUPED_KEY,
    imp: null,
    account: null,
    rows: ungrouped,
    batchDates: null,
    batchSize: ungrouped.length,
  };
  // Manual entries lead the All tab; on a bank or Linked tab the bucket only
  // exists defensively (such rows always belong to an import or account), so
  // it trails.
  if (input.tab === 'all' && ungrouped.length > 0) groups.push(ungroupedGroup);
  for (const account of tabAccounts) {
    const key = ACCOUNT_KEY_PREFIX + account.id;
    groups.push({ key, imp: null, account, rows: visibleByKey.get(key) ?? [], ...stats(key) });
  }
  for (const imp of tabImports) {
    groups.push({ key: imp.id, imp, account: null, rows: visibleByKey.get(imp.id) ?? [], ...stats(imp.id) });
  }
  if (input.tab !== 'all' && ungrouped.length > 0) groups.push(ungroupedGroup);
  return groups;
}

// Header label: the uploaded filename, or the synthetic backfill name.
// Header label: the display name, then the raw filename, then a placeholder.
export function importGroupLabel(imp: ImportGroupMeta): string {
  return imp.displayName ?? imp.filename ?? 'Untitled import';
}

