// Upload batches as the account's Imports section names them, pure and
// framework-free. Expenses no longer groups rows by upload (the accounts
// board, 2026-11-05): it reads by month, and uploads are managed on each
// account's page.

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
  // The ledger account the batch belongs to (its account's Imports section).
  ledgerAccountId?: string | null;
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

// An undone import, as an account's Imports section lists it. Undo is a soft
// delete, so the batch and its rows are still in the database: restoring is
// the recovery path, not re-importing (which would insert dedup-exempt
// copies carrying none of the original splits).
export type UndoneImport = ImportGroupMeta & {
  // Date the batch was undone (YYYY-MM-DD).
  deletedOn: string;
  // Rows a restore would bring back: those the undo itself deleted, not ones
  // already deleted individually beforehand.
  restorableCount: number;
};

// Header label: the display name, then the raw filename, then a placeholder.
export function importGroupLabel(imp: ImportGroupMeta): string {
  return imp.displayName ?? imp.filename ?? 'Untitled import';
}

