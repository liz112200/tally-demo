import { describe, it, expect } from 'vitest';
import {
  shareStatus,
  settlementUnallocated,
  allocateFifo,
  consumeCredit,
} from './allocations';

describe('shareStatus', () => {
  it('is outstanding when nothing is allocated', () => {
    expect(shareStatus({ amountCents: 1000, allocatedCents: 0 })).toEqual({
      status: 'outstanding',
      outstandingCents: 1000,
    });
  });
  it('is partial when some but not all is allocated', () => {
    expect(shareStatus({ amountCents: 1000, allocatedCents: 400 })).toEqual({
      status: 'partial',
      outstandingCents: 600,
    });
  });
  it('is settled at an exact match', () => {
    expect(shareStatus({ amountCents: 1000, allocatedCents: 1000 })).toEqual({
      status: 'settled',
      outstandingCents: 0,
    });
  });
  it('is settled with zero outstanding when over-allocated', () => {
    expect(shareStatus({ amountCents: 1000, allocatedCents: 1500 })).toEqual({
      status: 'settled',
      outstandingCents: 0,
    });
  });
});

describe('settlementUnallocated', () => {
  it('is the full amount with no allocations', () => {
    expect(settlementUnallocated(5000, [])).toBe(5000);
  });
  it('subtracts every allocation', () => {
    expect(
      settlementUnallocated(5000, [{ amountCents: 2000 }, { amountCents: 1500 }]),
    ).toBe(1500);
  });
  it('is zero, never negative, when fully consumed', () => {
    expect(settlementUnallocated(5000, [{ amountCents: 5000 }])).toBe(0);
  });
});

describe('allocateFifo', () => {
  const shares = [
    { shareId: 'a', outstandingCents: 1000 },
    { shareId: 'b', outstandingCents: 2000 },
    { shareId: 'c', outstandingCents: 500 },
  ];

  it('allocates nothing and keeps the whole amount with no shares', () => {
    expect(allocateFifo(5000, [])).toEqual({ allocations: [], unallocatedCents: 5000 });
  });

  it('fills shares in order until the settlement runs out (under-payment)', () => {
    // $15 covers a ($10) fully and b partially ($5).
    expect(allocateFifo(1500, shares)).toEqual({
      allocations: [
        { splitShareId: 'a', amountCents: 1000 },
        { splitShareId: 'b', amountCents: 500 },
      ],
      unallocatedCents: 0,
    });
  });

  it('closes a share exactly at its boundary', () => {
    expect(allocateFifo(1000, shares)).toEqual({
      allocations: [{ splitShareId: 'a', amountCents: 1000 }],
      unallocatedCents: 0,
    });
  });

  it('matches the full outstanding total exactly', () => {
    expect(allocateFifo(3500, shares)).toEqual({
      allocations: [
        { splitShareId: 'a', amountCents: 1000 },
        { splitShareId: 'b', amountCents: 2000 },
        { splitShareId: 'c', amountCents: 500 },
      ],
      unallocatedCents: 0,
    });
  });

  it('leaves the surplus unallocated on over-payment', () => {
    expect(allocateFifo(4000, shares)).toEqual({
      allocations: [
        { splitShareId: 'a', amountCents: 1000 },
        { splitShareId: 'b', amountCents: 2000 },
        { splitShareId: 'c', amountCents: 500 },
      ],
      unallocatedCents: 500,
    });
  });

  it('skips already-settled shares without emitting zero allocations', () => {
    const withSettled = [
      { shareId: 'a', outstandingCents: 0 },
      { shareId: 'b', outstandingCents: 700 },
    ];
    expect(allocateFifo(1000, withSettled)).toEqual({
      allocations: [{ splitShareId: 'b', amountCents: 700 }],
      unallocatedCents: 300,
    });
  });
});

describe('consumeCredit', () => {
  it('allocates nothing when there is no credit', () => {
    expect(consumeCredit({ shareId: 's', outstandingCents: 800 }, [])).toEqual({
      allocations: [],
      shareRemainingCents: 800,
    });
  });

  it('consumes a single credit partially, leaving the share outstanding', () => {
    // $5 credit against an $8 share -> $3 still outstanding, credit exhausted.
    expect(
      consumeCredit({ shareId: 's', outstandingCents: 800 }, [
        { settlementId: 'x', unallocatedCents: 500 },
      ]),
    ).toEqual({
      allocations: [{ settlementId: 'x', splitShareId: 's', amountCents: 500 }],
      shareRemainingCents: 300,
    });
  });

  it('walks multiple credits FIFO until the share is covered', () => {
    expect(
      consumeCredit({ shareId: 's', outstandingCents: 800 }, [
        { settlementId: 'x', unallocatedCents: 500 },
        { settlementId: 'y', unallocatedCents: 600 },
      ]),
    ).toEqual({
      allocations: [
        { settlementId: 'x', splitShareId: 's', amountCents: 500 },
        { settlementId: 'y', splitShareId: 's', amountCents: 300 },
      ],
      shareRemainingCents: 0,
    });
  });

  it('leaves leftover credit unused once the share is settled', () => {
    const result = consumeCredit({ shareId: 's', outstandingCents: 400 }, [
      { settlementId: 'x', unallocatedCents: 500 },
    ]);
    expect(result).toEqual({
      allocations: [{ settlementId: 'x', splitShareId: 's', amountCents: 400 }],
      shareRemainingCents: 0,
    });
  });

  it('skips empty credit sources', () => {
    expect(
      consumeCredit({ shareId: 's', outstandingCents: 300 }, [
        { settlementId: 'x', unallocatedCents: 0 },
        { settlementId: 'y', unallocatedCents: 300 },
      ]),
    ).toEqual({
      allocations: [{ settlementId: 'y', splitShareId: 's', amountCents: 300 }],
      shareRemainingCents: 0,
    });
  });
});
