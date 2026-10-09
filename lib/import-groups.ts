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
};

// The key 'ungrouped' collects manual rows (and, defensively, rows whose
// import is missing from the list); import groups key by import id.
export const UNGROUPED_KEY = 'ungrouped';

export type RowGroup<T> = {
  key: string;
  imp: ImportGroupMeta | null;
  // Visible rows in the caller's sort order; empty when filters hide all.
  rows: T[];
  // min/max transaction date across the whole batch, unfiltered, so the
  // header reads as the statement period even while filters narrow rows.
  batchDates: { from: string; to: string } | null;
  // Non-deleted rows in the batch, unfiltered — the N of "Undo import".
  batchSize: number;
};

// Returns null when the view should render flat: the Manual tab (manual
// entries are never import-grouped) or a view with no imports at all.
export function groupRowsByImport<T extends GroupableRow>(input: {
  // Every non-deleted row, unfiltered (batch stats).
  all: readonly T[];
  // Filtered + sorted rows for display.
  visible: readonly T[];
  // Non-deleted imports, newest upload first (group order).
  imports: readonly ImportGroupMeta[];
  tab: SourceTab;
}): RowGroup<T>[] | null {
  if (input.tab === 'manual') return null;
  const tabImports =
    input.tab === 'all'
      ? input.imports
      : input.imports.filter((imp) => imp.source === input.tab);
  if (tabImports.length === 0) return null;

  const knownIds = new Set(tabImports.map((imp) => imp.id));
  const keyFor = (row: T) =>
    row.importId !== null && knownIds.has(row.importId)
      ? row.importId
      : UNGROUPED_KEY;

  const visibleByKey = new Map<string, T[]>();
  for (const row of input.visible) {
    const key = keyFor(row);
    const list = visibleByKey.get(key) ?? [];
    list.push(row);
    visibleByKey.set(key, list);
  }

  const batchByImport = new Map<string, { from: string; to: string; size: number }>();
  for (const row of input.all) {
    if (row.importId === null || !knownIds.has(row.importId)) continue;
    const batch = batchByImport.get(row.importId);
    if (!batch) {
      batchByImport.set(row.importId, { from: row.date, to: row.date, size: 1 });
    } else {
      if (row.date < batch.from) batch.from = row.date;
      if (row.date > batch.to) batch.to = row.date;
      batch.size += 1;
    }
  }

  const groups: RowGroup<T>[] = [];
  const ungrouped = visibleByKey.get(UNGROUPED_KEY) ?? [];
  // Manual entries lead the All tab; on a bank tab the bucket only exists
  // defensively (a bank row always belongs to an import), so it trails.
  if (input.tab === 'all' && ungrouped.length > 0) {
    groups.push({
      key: UNGROUPED_KEY,
      imp: null,
      rows: ungrouped,
      batchDates: null,
      batchSize: ungrouped.length,
    });
  }
  for (const imp of tabImports) {
    const batch = batchByImport.get(imp.id);
    groups.push({
      key: imp.id,
      imp,
      rows: visibleByKey.get(imp.id) ?? [],
      batchDates: batch ? { from: batch.from, to: batch.to } : null,
      batchSize: batch?.size ?? 0,
    });
  }
  if (input.tab !== 'all' && ungrouped.length > 0) {
    groups.push({
      key: UNGROUPED_KEY,
      imp: null,
      rows: ungrouped,
      batchDates: null,
      batchSize: ungrouped.length,
    });
  }
  return groups;
}

// Header label: the uploaded filename, or the synthetic backfill name.
// Header label: the display name, then the raw filename, then a placeholder.
export function importGroupLabel(imp: ImportGroupMeta): string {
  return imp.displayName ?? imp.filename ?? 'Untitled import';
}

