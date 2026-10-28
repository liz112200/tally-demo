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
export const REVIEW_FILTERS = ['all', 'flagged'] as const;
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
  };
}

export function hasActiveFilters(filters: ExpenseFilters): boolean {
  return Object.values(filterPatch(filters)).some((v) => v !== null);
}

// ---- Per-account source tabs ----
// The segmented control above the table is a source filter with its own
// URL param (?source=chase), separate from the filter bar: switching tabs
// keeps the filters, and Clear keeps the tab.

export const SOURCE_TABS = ['all', 'chase', 'discover', 'amex', 'plaid', 'manual'] as const;
export type SourceTab = (typeof SOURCE_TABS)[number];

export function readSourceTab(params: URLSearchParams): SourceTab {
  return pick(params.get('source'), SOURCE_TABS, 'all');
}

export function sourceTabPatch(tab: SourceTab): ParamPatch {
  return { source: tab === 'all' ? null : tab };
}

export function filterBySource<T extends { source: string }>(
  rows: readonly T[],
  tab: SourceTab,
): T[] {
  return tab === 'all' ? [...rows] : rows.filter((row) => row.source === tab);
}

// Tabs render only for sources that actually have rows; 'all' is always
// present, and tab order is fixed rather than data-ordered.
export function availableSourceTabs(
  rows: readonly { source: string }[],
): SourceTab[] {
  const present = new Set(rows.map((row) => row.source));
  return SOURCE_TABS.filter((tab) => tab === 'all' || present.has(tab));
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
