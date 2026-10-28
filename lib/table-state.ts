// URL-persisted table view state. The URL search params are the single
// source of truth for sorting (and, in later slices, filters), so reload,
// back/forward, and shared links all reproduce the view. These are pure
// string <-> state functions with no Next.js dependency; the useTableState
// hook applies the patches to the real location.

export type SortDir = 'asc' | 'desc';

export type SortState = { sort: string; dir: SortDir };

export type SortSpec = {
  // Column ids allowed in ?sort=; anything else falls back to the default.
  columns: readonly string[];
  defaultSort: string;
  defaultDir: SortDir;
  // Direction a column starts in when first clicked. Unlisted columns start
  // 'asc'; dates and amounts read better starting 'desc'.
  firstDir?: Readonly<Record<string, SortDir>>;
};

// A patch is the set of params a state change touches: string sets the
// param, null deletes it (used to keep default values out of the URL).
export type ParamPatch = Record<string, string | null>;

export function readSort(params: URLSearchParams, spec: SortSpec): SortState {
  const sort = params.get('sort');
  const dir = params.get('dir');
  if (sort === null || !spec.columns.includes(sort)) {
    return { sort: spec.defaultSort, dir: spec.defaultDir };
  }
  return {
    sort,
    dir: dir === 'asc' || dir === 'desc' ? dir : (spec.firstDir?.[sort] ?? 'asc'),
  };
}

// Header-click behavior: same column reverses, a new column starts in its
// natural direction.
export function nextSort(current: SortState, column: string, spec: SortSpec): SortState {
  if (current.sort === column) {
    return { sort: column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { sort: column, dir: spec.firstDir?.[column] ?? 'asc' };
}

// The default sort is the URL-less state; only deviations are serialized.
export function sortPatch(state: SortState, spec: SortSpec): ParamPatch {
  const isDefault =
    state.sort === spec.defaultSort && state.dir === spec.defaultDir;
  return isDefault
    ? { sort: null, dir: null }
    : { sort: state.sort, dir: state.dir };
}

export function applyPatch(
  params: URLSearchParams,
  patch: ParamPatch,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

// Shared comparator for sortRows: numbers numerically, strings
// case-insensitively, null/undefined always last regardless of direction.
function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
}

// Stable sort (Array.prototype.sort is stable), so ties keep the caller's
// base ordering — e.g. same-date rows stay in insertion order.
export function sortRows<T>(
  rows: readonly T[],
  accessor: (row: T) => unknown,
  dir: SortDir,
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av == null || bv == null) return compareValues(av, bv);
    return sign * compareValues(av, bv);
  });
}
