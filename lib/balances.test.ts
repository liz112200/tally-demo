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
      [share('alex', 1195), share('sam', 1194), share('alex', 1000)],
      [],
    );
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 2195, settledCents: 0, balanceCents: 2195 },
      { personId: 'sam', sharesCents: 1194, settledCents: 0, balanceCents: 1194 },
    ]);
  });

  it('subtracts settlements from shares', () => {
    const result = computeBalances(
      [share('alex', 2195)],
      [share('alex', 1000), share('alex', 195)],
    );
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 2195, settledCents: 1195, balanceCents: 1000 },
    ]);
  });

  it('settles to exactly zero', () => {
    const result = computeBalances([share('alex', 2195)], [share('alex', 2195)]);
    expect(result[0].balanceCents).toBe(0);
  });

  it('goes negative on overpayment', () => {
    const result = computeBalances([share('alex', 1000)], [share('alex', 1500)]);
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 1000, settledCents: 1500, balanceCents: -500 },
    ]);
  });

  it('includes a person with settlements but no shares', () => {
    const result = computeBalances([], [share('sam', 500)]);
    expect(result).toEqual([
      { personId: 'sam', sharesCents: 0, settledCents: 500, balanceCents: -500 },
    ]);
  });

  it('returns an empty list for no activity', () => {
    expect(computeBalances([], [])).toEqual([]);
  });

  it('keeps people independent across many splits and settlements', () => {
    const result = computeBalances(
      [share('alex', 1195), share('sam', 1195), share('kai', 1194), share('sam', 2295)],
      [share('sam', 3490), share('kai', 194)],
    );
    expect(result).toEqual([
      { personId: 'alex', sharesCents: 1195, settledCents: 0, balanceCents: 1195 },
      { personId: 'sam', sharesCents: 3490, settledCents: 3490, balanceCents: 0 },
      { personId: 'kai', sharesCents: 1194, settledCents: 194, balanceCents: 1000 },
    ]);
  });
});

describe('shareOutstanding', () => {
  it('is amount minus allocated', () => {
    expect(shareOutstanding({ amountCents: 1000, allocatedCents: 300 })).toBe(700);
  });
  it('never goes negative when over-allocated', () => {
    expect(shareOutstanding({ amountCents: 1000, allocatedCents: 1200 })).toBe(0);
  });
  it('is the full amount when unallocated', () => {
    expect(shareOutstanding({ amountCents: 1000, allocatedCents: 0 })).toBe(1000);
  });
});

describe('computeBidirectionalBalances', () => {
  it('sums incoming shares as they-owe-me with no allocations', () => {
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 1195),
      debt('alex', 'incoming', 1000),
      debt('sam', 'incoming', 500),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 2195, iOweThemCents: 0, netCents: 2195 },
      { personId: 'sam', theyOweMeCents: 500, iOweThemCents: 0, netCents: 500 },
    ]);
  });

  it('nets incoming against outgoing for the same person', () => {
    // Alex owes me $30 (incoming) and I owe Alex $20 (outgoing) => net +$10.
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 3000),
      debt('alex', 'outgoing', 2000),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 3000, iOweThemCents: 2000, netCents: 1000 },
    ]);
  });

  it('produces a negative net when the owner owes more than they are owed', () => {
    const result = computeBidirectionalBalances([
      debt('sam', 'incoming', 500),
      debt('sam', 'outgoing', 2000),
    ]);
    expect(result).toEqual([
      { personId: 'sam', theyOweMeCents: 500, iOweThemCents: 2000, netCents: -1500 },
    ]);
  });

  it('subtracts allocations from each share before summing', () => {
    // $30 incoming with $30 allocated is fully settled; $20 incoming with $5
    // allocated leaves $15 outstanding.
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 3000, 3000),
      debt('alex', 'incoming', 2000, 500),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 1500, iOweThemCents: 0, netCents: 1500 },
    ]);
  });

  it('treats an over-allocated (credit) share as $0, never negative', () => {
    // $60 incoming shares, $100 worth allocated (a $40 overpayment); the
    // surplus lives on the settlement as credit, not as a negative balance.
    const result = computeBidirectionalBalances([
      debt('alex', 'incoming', 6000, 10000),
    ]);
    expect(result).toEqual([
      { personId: 'alex', theyOweMeCents: 0, iOweThemCents: 0, netCents: 0 },
    ]);
  });

  it('returns an empty list for no debt shares', () => {
    expect(computeBidirectionalBalances([])).toEqual([]);
  });
});
