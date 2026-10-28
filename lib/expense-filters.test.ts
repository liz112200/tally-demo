import { describe, expect, it } from 'vitest';
import { applyPatch } from './table-state';
import {
  DEFAULT_FILTERS,
  UNCATEGORIZED_FILTER,
  applyExpenseFilters,
  availableSourceTabs,
  filterBySource,
  filterPatch,
  hasActiveFilters,
  rangeCutoff,
  readFilters,
  readSourceTab,
  sourceTabPatch,
  summarizeView,
  type ExpenseFilters,
  type FilterableTransaction,
} from './expense-filters';

const TODAY = '2026-07-17';

function tx(overrides: Partial<FilterableTransaction>): FilterableTransaction {
  return {
    id: 'tx-1',
    date: '2026-07-01',
    descriptionRaw: 'COFFEE SHOP',
    categoryId: null,
    categorySource: null,
    amountCents: 1000,
    isSplittable: true,
    ...overrides,
  };
}

const ctx = (splitIds: string[] = [], receiptIds: string[] = []) => ({
  today: TODAY,
  hasSplit: (id: string) => splitIds.includes(id),
  hasReceipt: (id: string) => receiptIds.includes(id),
});

describe('readFilters / filterPatch round-trip', () => {
  it('defaults produce an empty URL', () => {
    const params = applyPatch(new URLSearchParams(), filterPatch(DEFAULT_FILTERS));
    expect(params.toString()).toBe('');
    expect(readFilters(params)).toEqual(DEFAULT_FILTERS);
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
  });

  it('round-trips every non-default field', () => {
    const filters: ExpenseFilters = {
      q: 'uber',
      range: 'custom',
      from: '2026-01-01',
      to: '2026-06-30',
      categories: ['cat-a', UNCATEGORIZED_FILTER],
      split: 'not-split',
      catSource: 'rule',
      receipt: 'has',
      review: 'flagged',
    };
    const params = applyPatch(new URLSearchParams(), filterPatch(filters));
    expect(readFilters(params)).toEqual(filters);
    expect(hasActiveFilters(filters)).toBe(true);
  });

  it('clears stale custom bounds when the range changes', () => {
    const custom = applyPatch(
      new URLSearchParams(),
      filterPatch({ ...DEFAULT_FILTERS, range: 'custom', from: '2026-01-01' }),
    );
    const thirty = applyPatch(
      custom,
      filterPatch({ ...DEFAULT_FILTERS, range: '30d' }),
    );
    expect(thirty.get('from')).toBeNull();
    expect(readFilters(thirty).range).toBe('30d');
  });

  it('ignores malformed values', () => {
    const params = new URLSearchParams(
      'range=yesterday&split=maybe&catsrc=vibes&rcpt=lots&from=junk&review=soon',
    );
    expect(readFilters(params)).toEqual(DEFAULT_FILTERS);
  });

  it('ignores from/to outside a custom range', () => {
    const params = new URLSearchParams('range=30d&from=2026-01-01&to=2026-02-01');
    const filters = readFilters(params);
    expect(filters.from).toBeNull();
    expect(filters.to).toBeNull();
  });
});

describe('rangeCutoff', () => {
  it('counts today as day one', () => {
    expect(rangeCutoff('2026-07-17', 30)).toBe('2026-06-18');
    expect(rangeCutoff('2026-07-17', 90)).toBe('2026-04-19');
  });

  it('crosses month and year boundaries', () => {
    expect(rangeCutoff('2026-01-15', 30)).toBe('2025-12-17');
  });
});

describe('applyExpenseFilters', () => {
  it('matches search case-insensitively against the description', () => {
    const rows = [
      tx({ id: 'a', descriptionRaw: 'UBER TRIP' }),
      tx({ id: 'b', descriptionRaw: 'Coffee' }),
    ];
    const out = applyExpenseFilters(rows, { ...DEFAULT_FILTERS, q: 'uber' }, ctx());
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  it('applies 30d / 90d windows relative to today', () => {
    const rows = [
      tx({ id: 'recent', date: '2026-07-10' }),
      tx({ id: 'spring', date: '2026-05-01' }),
      tx({ id: 'old', date: '2026-01-01' }),
    ];
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, range: '30d' }, ctx()).map((r) => r.id),
    ).toEqual(['recent']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, range: '90d' }, ctx()).map((r) => r.id),
    ).toEqual(['recent', 'spring']);
  });

  it('applies custom bounds inclusively, either side open', () => {
    const rows = [
      tx({ id: 'a', date: '2026-03-01' }),
      tx({ id: 'b', date: '2026-04-01' }),
    ];
    expect(
      applyExpenseFilters(
        rows,
        { ...DEFAULT_FILTERS, range: 'custom', from: '2026-04-01', to: null },
        ctx(),
      ).map((r) => r.id),
    ).toEqual(['b']);
    expect(
      applyExpenseFilters(
        rows,
        { ...DEFAULT_FILTERS, range: 'custom', from: null, to: '2026-03-01' },
        ctx(),
      ).map((r) => r.id),
    ).toEqual(['a']);
  });

  it('filters by category ids including the uncategorized sentinel', () => {
    const rows = [
      tx({ id: 'a', categoryId: 'groceries' }),
      tx({ id: 'b', categoryId: 'dining' }),
      tx({ id: 'c', categoryId: null }),
    ];
    expect(
      applyExpenseFilters(
        rows,
        { ...DEFAULT_FILTERS, categories: ['groceries', UNCATEGORIZED_FILTER] },
        ctx(),
      ).map((r) => r.id),
    ).toEqual(['a', 'c']);
  });

  it('filters by split status', () => {
    const rows = [
      tx({ id: 'split' }),
      tx({ id: 'plain' }),
      tx({ id: 'credit', amountCents: -500, isSplittable: false }),
    ];
    const c = ctx(['split']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, split: 'split' }, c).map((r) => r.id),
    ).toEqual(['split']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, split: 'not-split' }, c).map((r) => r.id),
    ).toEqual(['plain']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, split: 'non-splittable' }, c).map(
        (r) => r.id,
      ),
    ).toEqual(['credit']);
  });

  it('filters by category source', () => {
    const rows = [
      tx({ id: 'rule', categoryId: 'x', categorySource: 'rule' }),
      tx({ id: 'manual', categoryId: 'x', categorySource: 'manual' }),
      tx({ id: 'never', categoryId: null, categorySource: null }),
    ];
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, catSource: 'rule' }, ctx()).map(
        (r) => r.id,
      ),
    ).toEqual(['rule']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, catSource: 'manual' }, ctx()).map(
        (r) => r.id,
      ),
    ).toEqual(['manual']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, catSource: 'uncategorized' }, ctx()).map(
        (r) => r.id,
      ),
    ).toEqual(['never']);
  });

  it('filters by receipt presence', () => {
    const rows = [tx({ id: 'with' }), tx({ id: 'without' })];
    const c = ctx([], ['with']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, receipt: 'has' }, c).map((r) => r.id),
    ).toEqual(['with']);
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, receipt: 'none' }, c).map((r) => r.id),
    ).toEqual(['without']);
  });

  it('composes all predicates', () => {
    const rows = [
      tx({ id: 'hit', descriptionRaw: 'UBER', date: '2026-07-10', categoryId: 'transport' }),
      tx({ id: 'wrong-cat', descriptionRaw: 'UBER', date: '2026-07-10', categoryId: 'dining' }),
      tx({ id: 'too-old', descriptionRaw: 'UBER', date: '2026-01-01', categoryId: 'transport' }),
    ];
    const out = applyExpenseFilters(
      rows,
      { ...DEFAULT_FILTERS, q: 'uber', range: '30d', categories: ['transport'] },
      ctx(),
    );
    expect(out.map((r) => r.id)).toEqual(['hit']);
  });
});

describe('source tabs', () => {
  it('round-trips through the URL and keeps "all" out of it', () => {
    expect(
      applyPatch(new URLSearchParams('source=chase'), sourceTabPatch('all')).toString(),
    ).toBe('');
    const params = applyPatch(new URLSearchParams(), sourceTabPatch('discover'));
    expect(readSourceTab(params)).toBe('discover');
  });

  it('rejects unknown sources', () => {
    expect(readSourceTab(new URLSearchParams('source=venmo'))).toBe('all');
  });

  it('filters rows by source', () => {
    const rows = [
      { id: 'a', source: 'chase' },
      { id: 'b', source: 'discover' },
    ];
    expect(filterBySource(rows, 'chase').map((r) => r.id)).toEqual(['a']);
    expect(filterBySource(rows, 'all').map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterBySource(rows, 'amex')).toEqual([]);
  });

  it('offers tabs only for sources present in the data', () => {
    expect(
      availableSourceTabs([{ source: 'chase' }, { source: 'amex' }]),
    ).toEqual(['all', 'chase', 'amex']);
    expect(availableSourceTabs([])).toEqual(['all']);
  });
});

describe('summarizeView', () => {
  it('splits spending from credits and nets them', () => {
    const summary = summarizeView([
      { amountCents: 1000 },
      { amountCents: 2500 },
      { amountCents: -400 },
    ]);
    expect(summary).toEqual({
      count: 3,
      spendingCents: 3500,
      creditsCents: -400,
      netCents: 3100,
      transferCount: 0,
      pendingCount: 0, unverifiedCount: 0,
      reviewCount: 0,
    });
  });

  it('handles an empty view', () => {
    expect(summarizeView([])).toEqual({
      count: 0,
      spendingCents: 0,
      creditsCents: 0,
      netCents: 0,
      transferCount: 0,
      pendingCount: 0, unverifiedCount: 0,
      reviewCount: 0,
    });
  });
});

describe('summarizeView with transfers', () => {
  it('leaves transfer rows out of spending, credits and net, and counts them', () => {
    expect(
      summarizeView([
        { amountCents: 25_000, countsAsSpending: false },
        { amountCents: -25_000, countsAsSpending: false },
        { amountCents: 4_330, countsAsSpending: true },
        { amountCents: -500_000 },
      ]),
    ).toEqual({ count: 4, spendingCents: 4_330, creditsCents: -500_000, netCents: -495_670, transferCount: 2, pendingCount: 0, unverifiedCount: 0, reviewCount: 0 });
  });
});


describe('summarizeView with pending rows', () => {
  it('counts pending rows and leaves them out of every total, transfers included', () => {
    expect(
      summarizeView([
        { amountCents: 4_330, pending: true },
        { amountCents: -1_000, pending: true },
        { amountCents: 25_000, countsAsSpending: false, pending: true },
        { amountCents: 2_000 },
      ]),
    ).toEqual({ count: 4, spendingCents: 2_000, creditsCents: 0, netCents: 2_000, transferCount: 0, pendingCount: 3, unverifiedCount: 0, reviewCount: 0 });
  });
});

describe('rows that need review', () => {
  it('are the flagged ones: amount changed under a split, or removed by the bank', () => {
    const rows = [
      tx({ id: 'plain' }),
      tx({ id: 'amount', bankAmountBeforeCents: 9_000 }),
      tx({ id: 'removed', removedByBankAt: new Date('2026-10-20') }),
    ];
    expect(
      applyExpenseFilters(rows, { ...DEFAULT_FILTERS, review: 'flagged' }, ctx()).map((r) => r.id),
    ).toEqual(['amount', 'removed']);
    expect(summarizeView(rows).reviewCount).toBe(2);
  });
});

describe('summarizeView with unverified synced rows', () => {
  it('counts them and leaves them out of every total; CSV and manual rows count as always', () => {
    const summary = summarizeView([
      { amountCents: 10_000 },
      { amountCents: 25_000, unverified: true },
      { amountCents: -5_000, unverified: true },
    ]);
    expect(summary).toMatchObject({ spendingCents: 10_000, creditsCents: 0, netCents: 10_000, unverifiedCount: 2, count: 3 });
  });
});

