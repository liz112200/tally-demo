import { describe, expect, it } from 'vitest';
import {
  addMonths,
  categoryBreakdown,
  isMonthKey,
  monthLabel,
  monthlySpending,
  spendingDelta,
  spendingTrend,
  topMerchants,
  type InsightRow,
} from './insights';

function row(overrides: Partial<InsightRow>): InsightRow {
  return {
    date: '2026-07-10',
    amountCents: 1000,
    categoryId: 'cat-dining',
    categoryName: 'Dining',
    categoryIsSplittable: true,
    countsAsSpending: true,
    merchantNormalized: 'MERCHANT',
    ...overrides,
  };
}

describe('addMonths', () => {
  it('steps forward and back across year boundaries', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(addMonths('2026-07', -6)).toBe('2026-01');
  });
});

describe('isMonthKey', () => {
  it('accepts YYYY-MM and rejects everything else', () => {
    expect(isMonthKey('2026-07')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-07-01')).toBe(false);
    expect(isMonthKey('garbage')).toBe(false);
  });
});

describe('monthLabel', () => {
  it('spells the month out', () => {
    expect(monthLabel('2026-07')).toBe('July 2026');
  });
});

describe('monthlySpending', () => {
  it('sums positive amounts only, by calendar month boundaries', () => {
    const rows = [
      // First and last day of July belong to July.
      row({ date: '2026-07-01', amountCents: 100 }),
      row({ date: '2026-07-31', amountCents: 200 }),
      // Adjacent-month edges stay out.
      row({ date: '2026-06-30', amountCents: 400 }),
      row({ date: '2026-08-01', amountCents: 800 }),
      // Credits/refunds/income (negative) never subtract.
      row({ date: '2026-07-15', amountCents: -5000 }),
    ];
    expect(monthlySpending(rows, '2026-07')).toBe(300);
  });
});

describe('spendingDelta', () => {
  it('compares against the previous calendar month', () => {
    const rows = [
      row({ date: '2026-07-10', amountCents: 900 }),
      row({ date: '2026-06-10', amountCents: 600 }),
    ];
    expect(spendingDelta(rows, '2026-07')).toEqual({
      currentCents: 900,
      previousCents: 600,
      deltaCents: 300,
    });
  });
});

describe('categoryBreakdown', () => {
  const rows = [
    row({ amountCents: 500, categoryName: 'Dining', categoryId: 'c1' }),
    row({ amountCents: 300, categoryName: 'Dining', categoryId: 'c1' }),
    row({ amountCents: 600, categoryName: 'Groceries', categoryId: 'c2' }),
    // Non-splittable (Rent) is excluded from the breakdown.
    row({
      amountCents: 90000,
      categoryName: 'Rent',
      categoryId: 'c3',
      categoryIsSplittable: false,
    }),
    // Uncategorized spending gets its own trailing line.
    row({ amountCents: 250, categoryId: null, categoryName: null }),
    // Credits never appear.
    row({ amountCents: -400, categoryName: 'Groceries', categoryId: 'c2' }),
    // Other months stay out.
    row({ date: '2026-06-01', amountCents: 999 }),
  ];

  it('sorts splittable categories desc and appends Uncategorized', () => {
    expect(categoryBreakdown(rows, '2026-07')).toEqual([
      { name: 'Dining', totalCents: 800 },
      { name: 'Groceries', totalCents: 600 },
      { name: null, totalCents: 250 },
    ]);
  });

  it('omits the Uncategorized line when everything is tagged', () => {
    const tagged = rows.filter((r) => r.categoryId !== null);
    expect(
      categoryBreakdown(tagged, '2026-07').some((s) => s.name === null),
    ).toBe(false);
  });

  it('but rent still counts toward the month total', () => {
    expect(monthlySpending(rows, '2026-07')).toBe(500 + 300 + 600 + 90000 + 250);
  });
});

describe('topMerchants', () => {
  it('ranks by positive spend within the month, capped', () => {
    const rows = [
      row({ merchantNormalized: 'A', amountCents: 100 }),
      row({ merchantNormalized: 'B', amountCents: 300 }),
      row({ merchantNormalized: 'B', amountCents: 100 }),
      row({ merchantNormalized: 'C', amountCents: 200 }),
      row({ merchantNormalized: 'D', amountCents: -900 }),
      row({ merchantNormalized: 'E', amountCents: 50, date: '2026-06-01' }),
    ];
    expect(topMerchants(rows, '2026-07', 2)).toEqual([
      { merchant: 'B', totalCents: 400 },
      { merchant: 'C', totalCents: 200 },
    ]);
  });
});

describe('spendingTrend', () => {
  it('renders in-window empty months as 0 but trims months before the data', () => {
    const rows = [
      row({ date: '2026-05-10', amountCents: 100 }),
      // June has no rows; July does.
      row({ date: '2026-07-10', amountCents: 300 }),
    ];
    expect(spendingTrend(rows, '2026-07', 6)).toEqual([
      { month: '2026-05', totalCents: 100 },
      { month: '2026-06', totalCents: 0 },
      { month: '2026-07', totalCents: 300 },
    ]);
  });

  it('returns nothing when there are no rows at all', () => {
    expect(spendingTrend([], '2026-07', 6)).toEqual([]);
  });
});

describe('transfers (categories that do not count as spending)', () => {
  // A card payment from checking, filed under Transfers: the card purchases
  // it pays for were already spending.
  const payment = row({
    amountCents: 2_589_350,
    categoryId: 'cat-transfers',
    categoryName: 'Transfers',
    categoryIsSplittable: false,
    countsAsSpending: false,
    merchantNormalized: 'DISCOVER E-PAYMENT 8694',
  });
  const purchase = row({ amountCents: 12_340 });
  const rent = row({ amountCents: 1_500_000, categoryId: 'cat-rent', categoryName: 'Rent', categoryIsSplittable: false });

  it('are left out of monthly spending, while Rent still counts', () => {
    expect(monthlySpending([payment, purchase, rent], '2026-07')).toBe(12_340 + 1_500_000);
  });

  it('drop the total by exactly their amount', () => {
    const asSpending = { ...payment, countsAsSpending: true };
    expect(
      monthlySpending([asSpending, purchase], '2026-07') - monthlySpending([payment, purchase], '2026-07'),
    ).toBe(2_589_350);
  });

  it('never appear among top merchants or in the category breakdown', () => {
    expect(topMerchants([payment, purchase], '2026-07').map((m) => m.merchant)).toEqual(['MERCHANT']);
    expect(categoryBreakdown([payment, purchase], '2026-07').map((s) => s.name)).toEqual(['Dining']);
  });

  it('are left out of the trend', () => {
    expect(spendingTrend([payment, purchase], '2026-07', 1)).toEqual([{ month: '2026-07', totalCents: 12_340 }]);
  });
});

