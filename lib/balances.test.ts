import { describe, it, expect } from 'vitest';
import { toCents } from './money';
import {
  computeBalances,
  computeBidirectionalBalances,
  shareOutstanding,
  type DebtShare,
  type Direction,
} from './balances';

const debt = (
  counterpartyId: string,
  direction: Direction,
  amount: number,
  allocated = 0,
): DebtShare => ({
  shareId: `${counterpartyId}-${direction}-${amount}-${allocated}`,
  counterpartyId,
  direction,
  amountCents: toCents(amount),
  allocatedCents: toCents(allocated),
});

const share = (personId: string, n: number) => ({
  personId,
  amountCents: toCents(n),
});

describe('computeBalances', () => {
  it('sums shares per person with no settlements', () => {
    const result = computeBalances(
      [share('alex', 11950), share('sam', 11940), share('alex', 10000)],
      [],
    );
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 21950, settledCents: 0, balanceCents: 21950 },
      { personId: 'sam', sharesCents: 11940, settledCents: 0, balanceCents: 11940 },
    ]);
  });

  it('subtracts settlements from shares', () => {
    const result = computeBalances(
      [share('alex', 21950)],
      [share('alex', 10000), share('alex', 1950)],
    );
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 21950, settledCents: 11950, balanceCents: 10000 },
    ]);
  });

  it('settles to exactly zero', () => {
    const result = computeBalances([share('alex', 21950)], [share('alex', 21950)]);
    expect(result[0].balanceCents).toBe(0);
  });

  it('goes negative on overpayment', () => {
    const result = computeBalances([share('alex', 10000)], [share('alex', 15000)]);
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 10000, settledCents: 15000, balanceCents: -5000 },
    ]);
  });

  it('includes a person with settlements but no shares', () => {
    const result = computeBalances([], [share('sam', 5000)]);
    expect(result).toEqual([
      { personId: 'sam', sharesCents: 0, settledCents: 5000, balanceCents: -5000 },
    ]);
  });

  it('returns an empty list for no activity', () => {
    expect(computeBalances([], [])).toEqual([]);
  });

  it('keeps people independent across many splits and settlements', () => {
    const result = computeBalances(
      [share('alex', 11950), share('sam', 11950), share('kai', 11940), share('sam', 22950)],
      [share('sam', 34900), share('kai', 1940)],
    );
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 11950, settledCents: 0, balanceCents: 11950 },
      { personId: 'sam', sharesCents: 34900, settledCents: 34900, balanceCents: 0 },
      { personId: 'kai', sharesCents: 11940, settledCents: 1940, balanceCents: 10000 },
    ]);
  });
});

describe('shareOutstanding', () => {
  it('is amount minus allocated', () => {
    expect(shareOutstanding({ amountCents: 10000, allocatedCents: 3000 })).toBe(7000);
  });
  it('never goes negative when over-allocated', () => {
    expect(shareOutstanding({ amountCents: 10000, allocatedCents: 12000 })).toBe(0);
  });
  it('is the full amount when unallocated', () => {
    expect(shareOutstanding({ amountCents: 10000, allocatedCents: 0 })).toBe(10000);
  });
});

describe('computeBidirectionalBalances', () => {
  it('sums incoming shares as they-owe-me with no allocations', () => {
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 11950),
      debt('alex', 'incoming', 10000),
      debt('sam', 'incoming', 5000),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 21950, iOweThemCents: 0, netCents: 21950 },
      { personId: 'sam', theyOweMeCents: 5000, iOweThemCents: 0, netCents: 5000 },
    ]);
  });

  it('nets incoming against outgoing for the same person', () => {
    // Alex owes me $30 (incoming) and I owe Alex $20 (outgoing) => net +$10.
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 30000),
      debt('alex', 'outgoing', 20000),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 30000, iOweThemCents: 20000, netCents: 10000 },
    ]);
  });

  it('produces a negative net when the owner owes more than they are owed', () => {
    const result = computeBidirectionalBalances([
      debt('sam', 'incoming', 5000),
      debt('sam', 'outgoing', 20000),
    ]);
    expect(result).toEqual([
      { personId: 'sam', theyOweMeCents: 5000, iOweThemCents: 20000, netCents: -15000 },
    ]);
  });

  it('subtracts allocations from each share before summing', () => {
    // $30 incoming with $30 allocated is fully settled; $20 incoming with $5
    // allocated leaves $15 outstanding.
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 30000, 30000),
      debt('alex', 'incoming', 20000, 5000),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 15000, iOweThemCents: 0, netCents: 15000 },
    ]);
  });

  it('treats an over-allocated (credit) share as $0, never negative', () => {
    // $60 incoming shares, $100 worth allocated (a $40 overpayment); the
    // surplus lives on the settlement as credit, not as a negative balance.
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 60000, 100000),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 0, iOweThemCents: 0, netCents: 0 },
    ]);
  });

  it('returns an empty list for no debt shares', () => {
    expect(computeBidirectionalBalances([])).toEqual([]);
  });
});
