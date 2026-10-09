import { describe, it, expect } from 'vitest';
import {
  monthLabel,
  groupByMonth,
  totalOutstanding,
  selectionTotal,
  setShares,
  sharesInRange,
  rangeBetween,
  groupState,
  fifoSelection,
  parseApplied,
  toAllocationPayload,
  checkAllocations,
} from './settle-selection';

// FIFO order: date ascending.
const shares = [
  { shareId: 'a', date: '2026-05-30', outstandingCents: 10_000 },
  { shareId: 'b', date: '2026-06-01', outstandingCents: 20_000 },
  { shareId: 'c', date: '2026-06-15', outstandingCents: 5_500 },
  { shareId: 'd', date: '2026-06-30', outstandingCents: 1_250 },
  { shareId: 'e', date: '2026-07-01', outstandingCents: 30_000 },
];

describe('monthLabel', () => {
  it('formats a YYYY-MM key', () => {
    expect(monthLabel('2026-06')).toBe('Jun 2026');
    expect(monthLabel('2025-12')).toBe('Dec 2025');
  });
});

describe('groupByMonth', () => {
  it('groups consecutive months oldest first with totals', () => {
    const groups = groupByMonth(shares);
    expect(groups.map((g) => [g.key, g.label, g.shares.length, g.totalCents])).toEqual([
      ['2026-05', 'May 2026', 1, 10_000],
      ['2026-06', 'Jun 2026', 3, 26_750],
      ['2026-07', 'Jul 2026', 1, 30_000],
    ]);
  });
  it('is empty for no shares', () => {
    expect(groupByMonth([])).toEqual([]);
  });
});

describe('selection building', () => {
  it('selects shares at full outstanding and totals them', () => {
    const sel = setShares({}, shares, true);
    expect(selectionTotal(sel)).toBe(totalOutstanding(shares));
    expect(sel.c).toBe(5_500);
  });
  it('deselects only the given shares', () => {
    const sel = setShares(setShares({}, shares, true), [shares[1], shares[2]], false);
    expect(Object.keys(sel)).toEqual(['a', 'd', 'e']);
  });
  it('resets a partial amount when re-selected', () => {
    const sel = setShares({ b: 100 }, [shares[1]], true);
    expect(sel.b).toBe(20_000);
  });
  it('does not mutate its input', () => {
    const before = { a: 1 };
    setShares(before, shares, true);
    expect(before).toEqual({ a: 1 });
  });
});

describe('sharesInRange', () => {
  it('is inclusive on both ends', () => {
    expect(sharesInRange(shares, '2026-06-01', '2026-06-30').map((s) => s.shareId)).toEqual([
      'b',
      'c',
      'd',
    ]);
  });
  it('treats an empty bound as open', () => {
    expect(sharesInRange(shares, '', '2026-06-01').map((s) => s.shareId)).toEqual(['a', 'b']);
    expect(sharesInRange(shares, '2026-06-30', '').map((s) => s.shareId)).toEqual(['d', 'e']);
    expect(sharesInRange(shares, '', '')).toHaveLength(5);
  });
});

describe('rangeBetween', () => {
  it('spans anchor to target in either direction', () => {
    expect(rangeBetween(shares, 'b', 'd').map((s) => s.shareId)).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(shares, 'd', 'b').map((s) => s.shareId)).toEqual(['b', 'c', 'd']);
  });
  it('is just the target without a usable anchor', () => {
    expect(rangeBetween(shares, null, 'c').map((s) => s.shareId)).toEqual(['c']);
    expect(rangeBetween(shares, 'gone', 'c').map((s) => s.shareId)).toEqual(['c']);
  });
  it('is empty for an unknown target', () => {
    expect(rangeBetween(shares, 'a', 'zz')).toEqual([]);
  });
});

describe('groupState', () => {
  const june = shares.slice(1, 4);
  it('reports none, some, and all', () => {
    expect(groupState({}, june)).toBe('none');
    expect(groupState({ c: 1 }, june)).toBe('some');
    expect(groupState({ b: 1, c: 5_500, d: 1_250 }, june)).toBe('all');
  });
});

describe('fifoSelection', () => {
  it('fills oldest first and leaves the tail partial', () => {
    expect(fifoSelection(32_000, shares)).toEqual({ a: 10_000, b: 20_000, c: 2_000 });
  });
  it('is empty for a zero or negative payment', () => {
    expect(fifoSelection(0, shares)).toEqual({});
    expect(fifoSelection(-5, shares)).toEqual({});
  });
});

describe('parseApplied', () => {
  it('parses dollars into minor units', () => {
    expect(parseApplied('12.5', 20_000)).toBe(12_500);
  });
  it('clamps to the outstanding amount and to zero', () => {
    expect(parseApplied('99', 20_000)).toBe(20_000);
    expect(parseApplied('-3', 20_000)).toBe(0);
  });
  it('is null for junk', () => {
    expect(parseApplied('abc', 20_000)).toBeNull();
  });
});

describe('toAllocationPayload', () => {
  it('emits FIFO order regardless of selection insertion order, dropping zeros', () => {
    expect(toAllocationPayload({ e: 30_000, a: 0, c: 100 }, shares)).toEqual([
      { shareId: 'c', amountCents: 100 },
      { shareId: 'e', amountCents: 30_000 },
    ]);
  });
});

describe('checkAllocations', () => {
  it('reports leftover credit on under-allocation', () => {
    expect(checkAllocations(10_000, [{ amountCents: 4_000 }])).toEqual({
      ok: true,
      allocatedCents: 4_000,
      creditCents: 6_000,
    });
  });
  it('accepts an exact match with zero credit', () => {
    expect(checkAllocations(4_000, [{ amountCents: 4_000 }])).toEqual({
      ok: true,
      allocatedCents: 4_000,
      creditCents: 0,
    });
  });
  it('blocks over-allocation by any amount', () => {
    expect(checkAllocations(4_000, [{ amountCents: 3_000 }, { amountCents: 1_001 }])).toEqual({
      ok: false,
      allocatedCents: 4_001,
      overByCents: 1,
    });
  });
});
