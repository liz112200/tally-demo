import { describe, expect, it } from 'vitest';
import { groupByPeriod, statementComparison, type PeriodRow, type PeriodStatement } from './statement-periods';

// Invented dates and amounts throughout.
let n = 0;
const row = (date: string, amountCents: number, over: Partial<PeriodRow> = {}): PeriodRow => ({
  id: `r${++n}`,
  date,
  postedDate: date,
  amountCents,
  source: 'plaid',
  pending: false,
  unverified: false,
  alongsideOfId: null,
  ...over,
});
const statement = (closingDate: string, over: Partial<PeriodStatement> = {}): PeriodStatement => ({
  closingDate,
  periodStart: null,
  nextClosingDate: null,
  startsNewCycle: false,
  chargesCents: null,
  creditsCents: null,
  ...over,
});
const group = (rows: PeriodRow[], statements: PeriodStatement[], purchaseDatedCsv = false) =>
  groupByPeriod({ all: rows, visible: rows, statements, purchaseDatedCsv });

describe('groupByPeriod', () => {
  const statements = [statement('2026-09-06', { periodStart: '2026-08-07' }), statement('2026-10-06')];

  it('places rows in their statement periods, newest first, and loses none', () => {
    const rows = [
      row('2026-08-01', 1_000), // before the earliest recorded period
      row('2026-08-20', 2_000),
      row('2026-09-06', 3_000), // the closing day itself
      row('2026-09-07', 4_000),
      row('2026-10-20', 5_000), // the current cycle
    ];
    const groups = group(rows, statements);
    expect(groups.map((g) => [g.kind, g.from, g.to, g.rows.map((r) => r.amountCents)])).toEqual([
      ['current', '2026-10-07', null, [5_000]],
      ['statement', '2026-09-07', '2026-10-06', [4_000]],
      ['statement', '2026-08-07', '2026-09-06', [2_000, 3_000]],
      ['before', null, '2026-08-06', [1_000]],
    ]);
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(rows.length);
  });

  it('counts a synced row by its posting date, and says when its purchase date shows outside', () => {
    const late = row('2026-10-06', 2_500, { postedDate: '2026-10-07' });
    const [current, october] = group([late], statements);
    expect(current.rows).toEqual([late]);
    expect(current.postedOutsideRows).toBe(1);
    expect(october.count).toBe(0);
  });

  it('places a purchase paid alongside with its card row, outside the total', () => {
    const charge = row('2026-09-20', 6_000);
    const cash = row('2026-09-30', 1_500, { source: 'manual', alongsideOfId: charge.id, postedDate: '2026-10-30' });
    const [, october] = group([charge, cash], statements);
    expect(october.rows).toEqual([charge, cash]);
    expect(october).toMatchObject({ count: 2, chargesCents: 6_000, alongsideCount: 1 });
  });

  it('keeps pending rows out of the totals and unverified ones in, counted and marked', () => {
    const [current] = group([row('2026-10-20', 1_000, { pending: true }), row('2026-10-21', 2_000, { unverified: true }), row('2026-10-22', -500)], statements);
    expect(current).toMatchObject({ count: 3, chargesCents: 2_000, creditsCents: 500, pendingCount: 1, unverifiedCount: 1 });
  });

  it('gives undated stretches their own groups instead of inventing a boundary', () => {
    // The earliest statement has no recorded start; a later one starts after a gap.
    const gappy = [statement('2026-06-06'), statement('2026-09-06', { periodStart: '2026-08-07' })];
    const groups = group([row('2026-05-01', 1_000), row('2026-07-15', 2_000), row('2026-08-10', 3_000)], gappy);
    expect(groups.map((g) => [g.kind, g.from, g.to, g.count])).toEqual([
      ['current', '2026-09-07', null, 0],
      ['statement', '2026-08-07', '2026-09-06', 1],
      ['gap', '2026-06-07', '2026-08-06', 1],
      ['before', null, '2026-06-06', 1],
    ]);
  });

  it('marks periods holding CSV rows dated by purchase', () => {
    const [, october] = group([row('2026-09-20', 1_000, { source: 'amex' })], statements, true);
    expect(october.purchaseDatedCsvRows).toBe(1);
    expect(group([row('2026-09-20', 1_000, { source: 'chase' })], statements, false)[1].purchaseDatedCsvRows).toBe(0);
  });

  it('with no statement recorded, holds every row in one group', () => {
    const groups = group([row('2026-10-01', 1_000), row('2026-10-02', 2_000)], []);
    expect(groups.map((g) => [g.kind, g.from, g.count])).toEqual([['current', null, 2]]);
  });
});

describe('statementComparison', () => {
  it('states each side of a difference, and nothing without recorded totals', () => {
    const recorded = [statement('2026-10-06', { periodStart: '2026-09-07', chargesCents: 10_000, creditsCents: 2_000 })];
    const [, october] = groupByPeriod({ all: [row('2026-09-20', 9_000), row('2026-09-21', -2_000)], visible: [], statements: recorded, purchaseDatedCsv: false });
    expect(statementComparison(october)).toEqual({ chargesDiff: -1_000, creditsDiff: 0 });
    // Recorded without totals: nothing to compare. (A first statement with no
    // recorded start has no period at all; its rows sit in the group before.)
    const [, bare] = groupByPeriod({ all: [], visible: [], statements: [statement('2026-10-06', { periodStart: '2026-09-07' })], purchaseDatedCsv: false });
    expect(bare.kind).toBe('statement');
    expect(statementComparison(bare)).toBeNull();
    expect(groupByPeriod({ all: [], visible: [], statements: [statement('2026-10-06')], purchaseDatedCsv: false }).map((g) => g.kind)).toEqual(['current']);
  });
});
