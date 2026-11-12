// Expense-table filters: URL serialization and row predicates, pure and
// framework-free like lib/table-state.ts. The URL params are the single
// source of truth; every value at its default stays out of the URL.
import type { ParamPatch } from './table-state';

export const DATE_RANGES = ['all', '30d', '90d', 'custom'] as const;
export type DateRangeKey = (typeof DATE_RANGES)[number];

export const SPLIT_STATUSES = ['all', 'split', 'not-split', 'non-splittable'] as const;
export type SplitStatusKey = (typeof SPLIT_STATUSES)[number];

export const CATEGORY_SOURCES = ['all', 'rule', 'bank', 'manual', 'uncategorized'] as const;
export type CategorySourceKey = (typeof CATEGORY_SOURCES)[number];

export const RECEIPT_FILTERS = ['all', 'has', 'none'] as const;
export type ReceiptFilterKey = (typeof RECEIPT_FILTERS)[number];

// Rows bank sync flagged for the owner (BANK-SYNC.md): an amount changed
// under a split, or a row the bank removed that the owner had built on.
// flagged: changed or removed by the bank since it was split. raised: a row
// raised after it came in that the conversion would accept (lib/conversion.ts),
// the rows offering Move (PAID-ALONGSIDE.md); the band's "Raised rows" line
// opens it.
export const REVIEW_FILTERS = ['all', 'flagged', 'raised'] as const;
export type ReviewFilterKey = (typeof REVIEW_FILTERS)[number];

export function needsReview(row: {
  bankAmountBeforeCents?: number | null;
  removedByBankAt?: unknown;
}): boolean {
  return (row.bankAmountBeforeCents ?? null) !== null || (row.removedByBankAt ?? null) !== null;
}

// Sentinel inside ?cat= for rows with no category, so "Uncategorized" can
// sit in the category multi-select alongside real ids.
export const UNCATEGORIZED_FILTER = 'none';

export type ExpenseFilters = {
  q: string;
  range: DateRangeKey;
  // Custom range bounds (inclusive, YYYY-MM-DD); either side may be open.
  from: string | null;
  to: string | null;
  // Category ids, possibly including UNCATEGORIZED_FILTER; empty = all.
  categories: string[];
  split: SplitStatusKey;
  catSource: CategorySourceKey;
  receipt: ReceiptFilterKey;
  review: ReviewFilterKey;
  // A point-out rule's id: only the rows it points out (migration 0037).
  pointOut: string | null;
};

export const DEFAULT_FILTERS: ExpenseFilters = {
  q: '',
  range: 'all',
  from: null,
  to: null,
  categories: [],
  split: 'all',
  catSource: 'all',
  receipt: 'all',
  review: 'all',
  pointOut: null,
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pick<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function readFilters(params: URLSearchParams): ExpenseFilters {
  const range = pick(params.get('range'), DATE_RANGES, 'all');
  const from = params.get('from');
  const to = params.get('to');
  const cat = params.get('cat');
  return {
    q: params.get('q') ?? '',
    range,
    from: range === 'custom' && from !== null && DATE_PATTERN.test(from) ? from : null,
    to: range === 'custom' && to !== null && DATE_PATTERN.test(to) ? to : null,
    categories: cat ? cat.split(',').filter((id) => id.length > 0) : [],
    split: pick(params.get('split'), SPLIT_STATUSES, 'all'),
    catSource: pick(params.get('catsrc'), CATEGORY_SOURCES, 'all'),
    receipt: pick(params.get('rcpt'), RECEIPT_FILTERS, 'all'),
    review: pick(params.get('review'), REVIEW_FILTERS, 'all'),
    pointOut: params.get('point'),
  };
}

// Always patches every filter key, so switching e.g. range custom -> 30d
// also clears the stale from/to params.
export function filterPatch(filters: ExpenseFilters): ParamPatch {
  return {
    q: filters.q === '' ? null : filters.q,
    range: filters.range === 'all' ? null : filters.range,
    from: filters.range === 'custom' && filters.from ? filters.from : null,
    to: filters.range === 'custom' && filters.to ? filters.to : null,
    cat: filters.categories.length > 0 ? filters.categories.join(',') : null,
    split: filters.split === 'all' ? null : filters.split,
    catsrc: filters.catSource === 'all' ? null : filters.catSource,
    rcpt: filters.receipt === 'all' ? null : filters.receipt,
    review: filters.review === 'all' ? null : filters.review,
    point: filters.pointOut,
  };
}

export function hasActiveFilters(filters: ExpenseFilters): boolean {
  return Object.values(filterPatch(filters)).some((v) => v !== null);
}

// A filter the Needs you band opens (lib/needs-you.ts): Bank changes, Raised
// rows, a point-out rule. The band counts every live row, so its view must
// show every row it counts.
export function asksBandQuestion(filters: ExpenseFilters): boolean {
  return filters.review !== 'all' || filters.pointOut !== null;
}

// Hiding an import takes its rows out of browsing, never out of a question
// the band is still asking (2026-11-11: the band counted 20 Zelle rows and 4
// raised rows that its own links could not show, because all of them were in
// hidden imports). Under a band question the matching rows of hidden imports
// are shown and said; otherwise they are left out and said, with a count of
// the rows that match, not of every row the imports hold.
// The line above a view whose rows include some in hidden imports. Under a
// band question they are shown and said; worded for how many of the view
// they are (2026-11-12: "1 of these rows" read oddly when the view held one).
export function hiddenImportText(hidden: { rows: number; imports: number; shown: boolean }, viewRows: number): string | null {
  if (hidden.rows === 0) return null;
  const where = hidden.imports === 1 ? 'a hidden import' : `${hidden.imports} hidden imports`;
  if (!hidden.shown) {
    // Browsing: the summary above the table counts the rows shown, so these
    // are neither listed nor counted there.
    return `${hidden.rows} ${hidden.rows === 1 ? 'row' : 'rows'} not shown or counted here: ${hidden.rows === 1 ? 'it is' : 'they are'} in ${where}.`;
  }
  const stays = hidden.imports === 1 ? 'The import stays hidden.' : 'The imports stay hidden.';
  const subject =
    hidden.rows === viewRows
      ? hidden.rows === 1
        ? 'This row is'
        : `All ${hidden.rows} rows are`
      : hidden.rows === 1
        ? '1 of these rows is'
        : `${hidden.rows} of these rows are`;
  return `${subject} in ${where}, shown here because the band asks about ${hidden.rows === 1 ? 'it' : 'them'}. ${stays}`;
}

export function withHiddenImports<T extends { importId: string | null }>(
  matched: readonly T[],
  filters: ExpenseFilters,
  isHidden: (importId: string) => boolean,
): { rows: T[]; hidden: { rows: number; imports: number; shown: boolean } } {
  const inHidden = matched.filter((r) => r.importId !== null && isHidden(r.importId));
  const shown = asksBandQuestion(filters);
  return {
    rows: shown ? [...matched] : matched.filter((r) => !(r.importId !== null && isHidden(r.importId))),
    hidden: { rows: inHidden.length, imports: new Set(inHidden.map((r) => r.importId)).size, shown },
  };
}

// ---- Account tabs ----
// The segmented control above the table picks an account with its own URL
// param (?tab=<ledger account id>), separate from the filter bar: switching
// tabs keeps the filters, and Clear keeps the tab.

// Expenses tabs (STATEMENT-CYCLES.md, the period view): All, one per ledger
// account (every row of that account, CSV and synced, with the manual
// purchases paid alongside its rows), and Manual. They replaced tabs per CSV
// source plus Linked, which split each card in two at its cutover.
export type ExpenseTab = { kind: 'all' } | { kind: 'manual' } | { kind: 'ledger'; id: string };
export type LedgerTabMeta = { id: string; label: string; csvSource: string | null };

const ALL: ExpenseTab = { kind: 'all' };

// From the URL: `tab` is all, manual or a ledger account id. A link from
// before carries `source`: a CSV source opens its ledger account, Linked
// (`plaid`) opens All, manual opens Manual.
export function readTab(params: URLSearchParams, ledgers: readonly LedgerTabMeta[]): ExpenseTab {
  const tab = params.get('tab');
  if (tab === 'manual') return { kind: 'manual' };
  if (tab && ledgers.some((l) => l.id === tab)) return { kind: 'ledger', id: tab };
  const source = params.get('source');
  if (source === 'manual') return { kind: 'manual' };
  const bySource = source ? ledgers.find((l) => l.csvSource === source) : undefined;
  return bySource ? { kind: 'ledger', id: bySource.id } : ALL;
}

export function tabPatch(tab: ExpenseTab): ParamPatch {
  return { tab: tab.kind === 'all' ? null : tab.kind === 'manual' ? 'manual' : tab.id, source: null };
}

export const sameTab = (a: ExpenseTab, b: ExpenseTab) =>
  a.kind === b.kind && (a.kind !== 'ledger' || (b.kind === 'ledger' && a.id === b.id));

type TabRow = { id: string; source: string; ledgerAccountId: string | null; alongsideOfId: string | null };

// A ledger tab holds the account's rows and the manual purchases paid
// alongside them; Manual every manual entry.
export function filterByTab<T extends TabRow>(rows: readonly T[], tab: ExpenseTab): T[] {
  if (tab.kind === 'all') return [...rows];
  if (tab.kind === 'manual') return rows.filter((r) => r.source === 'manual');
  const inLedger = new Set(rows.filter((r) => r.ledgerAccountId === tab.id).map((r) => r.id));
  return rows.filter((r) => inLedger.has(r.id) || (r.alongsideOfId !== null && inLedger.has(r.alongsideOfId)));
}

// All, then each ledger account holding a row (in the order given), then
// Manual when there are manual entries.
export function availableTabs(rows: readonly TabRow[], ledgers: readonly LedgerTabMeta[]): ExpenseTab[] {
  const used = new Set(rows.map((r) => r.ledgerAccountId));
  return [
    ALL,
    ...ledgers.filter((l) => used.has(l.id)).map((l): ExpenseTab => ({ kind: 'ledger', id: l.id })),
    ...(rows.some((r) => r.source === 'manual') ? [{ kind: 'manual' } as ExpenseTab] : []),
  ];
}

// Inclusive lower bound for "last N days": today counts as day one, so
// N=30 keeps dates within the previous 29 days plus today.
export function rangeCutoff(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

// The row fields filtering needs; TransactionRow satisfies this shape.
export type FilterableTransaction = {
  id: string;
  date: string;
  descriptionRaw: string;
  categoryId: string | null;
  categorySource: 'manual' | 'rule' | 'bank' | null;
  amountCents: number;
  isSplittable: boolean;
  bankAmountBeforeCents?: number | null;
  removedByBankAt?: unknown;
};

export type FilterContext = {
  today: string;
  hasSplit: (transactionId: string) => boolean;
  hasReceipt: (transactionId: string) => boolean;
  // A raised row the conversion would accept (the server's check).
  convertible?: (transactionId: string) => boolean;
  // A row the chosen point-out rule points out (the server's match).
  pointedOut?: (transactionId: string) => boolean;
};

export function applyExpenseFilters<T extends FilterableTransaction>(
  rows: readonly T[],
  filters: ExpenseFilters,
  ctx: FilterContext,
): T[] {
  const q = filters.q.trim().toLowerCase();
  const lowerBound =
    filters.range === '30d'
      ? rangeCutoff(ctx.today, 30)
      : filters.range === '90d'
        ? rangeCutoff(ctx.today, 90)
        : filters.range === 'custom'
          ? filters.from
          : null;
  const upperBound = filters.range === 'custom' ? filters.to : null;
  const categorySet = new Set(filters.categories);

  return rows.filter((row) => {
    if (q !== '' && !row.descriptionRaw.toLowerCase().includes(q)) return false;
    if (lowerBound !== null && row.date < lowerBound) return false;
    if (upperBound !== null && row.date > upperBound) return false;
    if (categorySet.size > 0) {
      const key = row.categoryId ?? UNCATEGORIZED_FILTER;
      if (!categorySet.has(key)) return false;
    }
    if (filters.split === 'split' && !ctx.hasSplit(row.id)) return false;
    if (filters.split === 'not-split' && (ctx.hasSplit(row.id) || !row.isSplittable)) {
      return false;
    }
    if (filters.split === 'non-splittable' && row.isSplittable) return false;
    if (filters.catSource === 'rule' && row.categorySource !== 'rule') return false;
    if (filters.catSource === 'bank' && row.categorySource !== 'bank') return false;
    if (filters.catSource === 'manual' && row.categorySource !== 'manual') return false;
    if (filters.catSource === 'uncategorized' && row.categoryId !== null) return false;
    if (filters.receipt === 'has' && !ctx.hasReceipt(row.id)) return false;
    if (filters.receipt === 'none' && ctx.hasReceipt(row.id)) return false;
    if (filters.review === 'flagged' && !needsReview(row)) return false;
    if (filters.review === 'raised' && !ctx.convertible?.(row.id)) return false;
    if (filters.pointOut !== null && !ctx.pointedOut?.(row.id)) return false;
    return true;
  });
}

// Summary strip figures for the current view. Spending is the positive
// side, credits the negative (kept negative for display); net is their sum.
// Rows in a category that does not count as spending (Transfers) are left out
// of all three and counted separately, so a card payment is neither spending
// nor a credit.
export type ViewSummary = {
  count: number;
  spendingCents: number;
  creditsCents: number;
  netCents: number;
  transferCount: number;
  // Pending synced rows: provisional, so counted here and left out of the
  // totals (their posted row is the one that counts).
  pendingCount: number;
  // Synced rows of a bank account not yet verified against a statement
  // (REAL-ACCOUNTS.md): counted here, left out of the totals until verified.
  unverifiedCount: number;
  // Rows bank sync flagged for review; they count in the totals as usual.
  reviewCount: number;
};

export function summarizeView(
  rows: readonly {
    amountCents: number;
    countsAsSpending?: boolean;
    pending?: boolean;
    unverified?: boolean;
    bankAmountBeforeCents?: number | null;
    removedByBankAt?: unknown;
  }[],
): ViewSummary {
  let spending = 0;
  let credits = 0;
  let transferCount = 0;
  let pendingCount = 0;
  let unverifiedCount = 0;
  let reviewCount = 0;
  for (const row of rows) {
    if (needsReview(row)) reviewCount += 1;
    if (row.pending) pendingCount += 1;
    else if (row.unverified) unverifiedCount += 1;
    else if (row.countsAsSpending === false) transferCount += 1;
    else if (row.amountCents >= 0) spending += row.amountCents;
    else credits += row.amountCents;
  }
  return {
    count: rows.length,
    spendingCents: spending,
    creditsCents: credits,
    netCents: spending + credits,
    transferCount,
    pendingCount,
    unverifiedCount,
    reviewCount,
  };
}
