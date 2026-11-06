import { describe, expect, it } from 'vitest';
import { groupByMonth } from './month-groups';

// Invented dates.
describe('groupByMonth', () => {
  it('groups runs of one month in the order given, naming the year only when it is not this one', () => {
    const rows = [{ date: '2026-08-03' }, { date: '2026-08-01' }, { date: '2026-07-30' }, { date: '2025-12-31' }];
    expect(groupByMonth(rows, '2026-08-20').map((g) => [g.key, g.label, g.rows.length])).toEqual([
      ['2026-08', 'August', 2],
      ['2026-07', 'July', 1],
      ['2025-12', 'December 2025', 1],
    ]);
  });

  it('follows an ascending sort as well', () => {
    expect(groupByMonth([{ date: '2026-06-30' }, { date: '2026-07-01' }], '2026-08-20').map((g) => g.label)).toEqual(['June', 'July']);
  });
});
