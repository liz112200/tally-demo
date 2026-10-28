import { describe, it, expect } from 'vitest';
import {
  shareStatus,
  settlementUnallocated,
  allocateFifo,
  consumeCredit,
} from './allocations';

describe('shareStatus', () => {
  it('is outstanding when nothing is allocated', () => {
    expect(shareStatus({ amountCents: 10000, allocatedCents: 0 })).toEqual({
      status: 'outstanding',
      outstandingCents: 10000,
    });
  });
  it('is partial when some but not all is allocated', () => {
    expect(shareStatus({ amountCents: 10000, allocatedCents: 4000 })).toEqual({
      status: 'partial',
      outstandingCents: 6000,
    });
  });
  it('is settled at an exact match', () => {
    expect(shareStatus({ amountCents: 10000, allocatedCents: 10000 })).toEqual({
      status: 'settled',
      outstandingCents: 0,
    });
  });
  it('is settled with zero outstanding when over-allocated', () => {
    expect(shareStatus({ amountCents: 10000, allocatedCents: 15000 })).toEqual({
      status: 'settled',
      outstandingCents: 0,
    });
  });
});

describe('settlementUnallocated', () => {
  it('is the full amount with no allocations', () => {
    expect(settlementUnallocated(50000, [])).toBe(50000);
  });
  it('subtracts every allocation', () => {
    expect(
      settlementUnallocated(50000, [{ amountCents: 20000 }, { amountCents: 15000 }]),
    ).toBe(15000);
  });
  it('is zero, never negative, when fully consumed', () => {
    expect(settlementUnallocated(50000, [{ amountCents: 50000 }])).toBe(0);
  });
});

describe('allocateFifo', () => {
  const shares = [
    { shareId: 'a', outstandingCents: 10000 },
    { shareId: 'b', outstandingCents: 20000 },
    { shareId: 'c', outstandingCents: 5000 },
  ];

  it('allocates nothing and keeps the whole amount with no shares', () => {
    expect(allocateFifo(50000, [])).toEqual({ allocations: [], unallocatedCents: 50000 });
  });

  it('fills shares in order until the settlement runs out (under-payment)', () => {
    // $15 covers a ($10) fully and b partially ($5).
    expect(allocateFifo(15000, shares)).toEqual({
      allocations: [
        { splitShareId: 'a', amountCents: 10000 },
        { splitShareId: 'b', amountCents: 5000 },
      ],
      unallocatedCents: 0,
    });
  });

  it('closes a share exactly at its boundary', () => {
    expect(allocateFifo(10000, shares)).toEqual({
      allocations: [{ splitShareId: 'a', amountCents: 10000 }],
      unallocatedCents: 0,
    });
  });

  it('matches the full outstanding total exactly', () => {
    expect(allocateFifo(35000, shares)).toEqual({
      allocations: [
        { splitShareId: 'a', amountCents: 10000 },
        { splitShareId: 'b', amountCents: 20000 },
        { splitShareId: 'c', amountCents: 5000 },
      ],
      unallocatedCents: 0,
    });
  });

  it('leaves the surplus unallocated on over-payment', () => {
    expect(allocateFifo(40000, shares)).toEqual({
      allocations: [
        { splitShareId: 'a', amountCents: 10000 },
        { splitShareId: 'b', amountCents: 20000 },
        { splitShareId: 'c', amountCents: 5000 },
      ],
      unallocatedCents: 5000,
    });
  });

  it('skips already-settled shares without emitting zero allocations', () => {
    const withSettled = [
      { shareId: 'a', outstandingCents: 0 },
      { shareId: 'b', outstandingCents: 7000 },
    ];
    expect(allocateFifo(10000, withSettled)).toEqual({
      allocations: [{ splitShareId: 'b', amountCents: 7000 }],
      unallocatedCents: 3000,
    });
  });
});

describe('consumeCredit', () => {
  it('allocates nothing when there is no credit', () => {
    expect(consumeCredit({ shareId: 's', outstandingCents: 8000 }, [])).toEqual({
      allocations: [],
      shareRemainingCents: 8000,
    });
  });

  it('consumes a single credit partially, leaving the share outstanding', () => {
    // $5 credit against an $8 share -> $3 still outstanding, credit exhausted.
    expect(
      consumeCredit({ shareId: 's', outstandingCents: 8000 }, [
        { settlementId: 'x', unallocatedCents: 5000 },
      ]),
    ).toEqual({
      allocations: [{ settlementId: 'x', splitShareId: 's', amountCents: 5000 }],
      shareRemainingCents: 3000,
    });
  });

  it('walks multiple credits FIFO until the share is covered', () => {
    expect(
      consumeCredit({ shareId: 's', outstandingCents: 8000 }, [
        { settlementId: 'x', unallocatedCents: 5000 },
        { settlementId: 'y', unallocatedCents: 6000 },
      ]),
    ).toEqual({
      allocations: [
        { settlementId: 'x', splitShareId: 's', amountCents: 5000 },
        { settlementId: 'y', splitShareId: 's', amountCents: 3000 },
      ],
      shareRemainingCents: 0,
    });
  });

  it('leaves leftover credit unused once the share is settled', () => {
    const result = consumeCredit({ shareId: 's', outstandingCents: 4000 }, [
      { settlementId: 'x', unallocatedCents: 5000 },
    ]);
    expect(result).toEqual({
      allocations: [{ settlementId: 'x', splitShareId: 's', amountCents: 4000 }],
      shareRemainingCents: 0,
    });
  });

  it('skips empty credit sources', () => {
    expect(
      consumeCredit({ shareId: 's', outstandingCents: 3000 }, [
        { settlementId: 'x', unallocatedCents: 0 },
        { settlementId: 'y', unallocatedCents: 3000 },
      ]),
    ).toEqual({
      allocations: [{ settlementId: 'y', splitShareId: 's', amountCents: 3000 }],
      shareRemainingCents: 0,
    });
  });
});
