// Aggregations for the /insights dashboard, pure and framework-free.
// Months are calendar months keyed 'YYYY-MM', derived from transaction.date
// strings (already YYYY-MM-DD), so no timezone math ever happens here.
//
// "Spending" is the sum of positive amounts only — the same definition the
// expenses summary strip uses. Credits, refunds, and income rows (negative
// by the sign convention) never subtract from it, which also keeps Income
// out of every figure without special-casing the category.

export type InsightRow = {
  date: string;
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
  // Resolved from the category; uncategorized rows count as splittable.
  categoryIsSplittable: boolean;
  // Resolved from the category; uncategorized rows count as spending. False
  // for Transfers: a card payment from checking is not new spending.
  countsAsSpending: boolean;
  merchantNormalized: string;
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const mon = (total % 12 + 12) % 12;
  return `${String(year).padStart(4, '0')}-${String(mon + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// Short form for chart ticks: 'Jul'.
export function monthShortLabel(month: string): string {
  return MONTH_NAMES[Number(month.split('-')[1]) - 1].slice(0, 3);
}

function inMonth(row: InsightRow, month: string): boolean {
  return monthOf(row.date) === month;
}

export function monthlySpending(rows: readonly InsightRow[], month: string): number {
  let total = 0;
  for (const row of rows) {
    if (row.amountCents > 0 && row.countsAsSpending && inMonth(row, month)) total += row.amountCents;
  }
  return total;
}

// The headline pair: this month vs the previous calendar month.
export function spendingDelta(
  rows: readonly InsightRow[],
  month: string,
): { currentCents: number; previousCents: number; deltaCents: number } {
  const currentCents = monthlySpending(rows, month);
  const previousCents = monthlySpending(rows, addMonths(month, -1));
  return { currentCents, previousCents, deltaCents: currentCents - previousCents };
}

export type CategorySlice = {
  // null = the "Uncategorized" line.
  name: string | null;
  totalCents: number;
};

// Splittable spending by category for one month, largest first, with one
// trailing "Uncategorized" line so untagged spend stays visible.
// Non-splittable categories (Rent, Income) are excluded here but still
// count toward monthlySpending — that asymmetry is the point: the
// breakdown answers "what did my shareable spending go to".
export function categoryBreakdown(
  rows: readonly InsightRow[],
  month: string,
): CategorySlice[] {
  const byName = new Map<string, number>();
  let uncategorized = 0;
  for (const row of rows) {
    if (row.amountCents <= 0 || !row.countsAsSpending || !inMonth(row, month)) continue;
    if (row.categoryId === null) {
      uncategorized += row.amountCents;
    } else if (row.categoryIsSplittable && row.categoryName !== null) {
      byName.set(row.categoryName, (byName.get(row.categoryName) ?? 0) + row.amountCents);
    }
  }
  const slices: CategorySlice[] = [...byName.entries()]
    .map(([name, totalCents]) => ({ name, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents || a.name!.localeCompare(b.name!));
  if (uncategorized > 0) slices.push({ name: null, totalCents: uncategorized });
  return slices;
}

export type MerchantTotal = { merchant: string; totalCents: number };

export function topMerchants(
  rows: readonly InsightRow[],
  month: string,
  limit = 5,
): MerchantTotal[] {
  const byMerchant = new Map<string, number>();
  for (const row of rows) {
    if (row.amountCents <= 0 || !row.countsAsSpending || !inMonth(row, month)) continue;
    byMerchant.set(
      row.merchantNormalized,
      (byMerchant.get(row.merchantNormalized) ?? 0) + row.amountCents,
    );
  }
  return [...byMerchant.entries()]
    .map(([merchant, totalCents]) => ({ merchant, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents || a.merchant.localeCompare(b.merchant))
    .slice(0, limit);
}

export type TrendPoint = { month: string; totalCents: number };

// The trailing `count` calendar months ending at `endMonth`. Months inside
// the window with no rows render as 0, but leading months from before the
// data began are trimmed (fork 10): a ledger three months old shows three
// points, not six.
export function spendingTrend(
  rows: readonly InsightRow[],
  endMonth: string,
  count = 6,
): TrendPoint[] {
  const firstMonth = rows.reduce<string | null>(
    (acc, row) => (acc === null || monthOf(row.date) < acc ? monthOf(row.date) : acc),
    null,
  );
  const points: TrendPoint[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const month = addMonths(endMonth, -i);
    if (firstMonth === null || month < firstMonth) continue;
    points.push({ month, totalCents: monthlySpending(rows, month) });
  }
  return points;
}
