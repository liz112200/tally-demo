// Import dedup decisions, pure and framework-free. The Server Action does
// the IO (hashing rows, querying existing hashes, inserting); these
// functions hold the branching those steps hang on, so the truth table is
// tested in isolation from the database.

// Why a row already exists: it collides with a live transaction, or with
// one that was soft-deleted (the dedup hash lingers past a soft delete).
// null = new.
export type DuplicateKind = 'active' | 'deleted';

// Classify one row against the existing-hash lookup. Absent = new; present
// carries whether the blocking row is soft-deleted.
export function classifyDuplicate(
  existing: { deleted: boolean } | undefined,
): DuplicateKind | null {
  if (!existing) return null;
  return existing.deleted ? 'deleted' : 'active';
}

// What the confirm loop does with a row: insert a new row normally, force
// an approved duplicate past the index (exempt), or skip an unapproved
// duplicate. A non-duplicate never consults the approval set.
export type RowPlan = 'insert' | 'force' | 'skip';

export function planImportRow(
  isDuplicate: boolean,
  approved: boolean,
): RowPlan {
  if (!isDuplicate) return 'insert';
  return approved ? 'force' : 'skip';
}
