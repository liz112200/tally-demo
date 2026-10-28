// Settlement allocation engine. Pure functions over integer cents, no
// dependency on Next.js, Drizzle, or the database. A settlement is FIFO-
// allocated to the outstanding shares it pays down, in its direction, for one
// person; whatever cannot be placed carries forward as unallocated credit and
// is later consumed by the next same-direction share for that person.
//
// The caller is responsible for pre-filtering and ordering: shares must
// already be the matching direction and counterparty, in FIFO order
// (effective date, then created_at, then id — see getDebtShares). These
// functions never re-sort; they only greedily fill.
import { type Cents, toCents } from './money';

export type ShareStatus = 'outstanding' | 'partial' | 'settled';

// A share's status and remaining amount from what has been allocated to it.
// settled: fully (or over-) covered. partial: some but not all. outstanding:
// nothing allocated yet.
export function shareStatus(share: {
  amountCents: number;
  allocatedCents: number;
}): { status: ShareStatus; outstandingCents: Cents } {
  const outstanding = Math.max(0, share.amountCents - share.allocatedCents);
  let status: ShareStatus;
  if (share.allocatedCents <= 0) status = 'outstanding';
  else if (outstanding <= 0) status = 'settled';
  else status = 'partial';
  return { status, outstandingCents: toCents(outstanding) };
}

// A settlement's unallocated remainder: its amount minus everything allocated
// out of it. Never negative (allocations can never exceed the settlement).
export function settlementUnallocated(
  amountCents: number,
  allocations: readonly { amountCents: number }[],
): Cents {
  const used = allocations.reduce((acc, a) => acc + a.amountCents, 0);
  return toCents(Math.max(0, amountCents - used));
}

// A share with its still-outstanding amount, ready to receive allocation.
export type AllocatableShare = {
  shareId: string;
  outstandingCents: number;
};

export type ShareAllocation = { splitShareId: string; amountCents: Cents };

// FIFO-allocate a single settlement across outstanding shares. Walks the
// pre-ordered shares, filling each up to its outstanding amount until the
// settlement is exhausted; the leftover is unallocated credit. Shares with no
// outstanding balance are skipped without producing a zero allocation.
export function allocateFifo(
  settlementAmountCents: number,
  shares: readonly AllocatableShare[],
): { allocations: ShareAllocation[]; unallocatedCents: Cents } {
  let remaining = Math.max(0, settlementAmountCents);
  const allocations: ShareAllocation[] = [];
  for (const share of shares) {
    if (remaining <= 0) break;
    const outstanding = Math.max(0, share.outstandingCents);
    if (outstanding <= 0) continue;
    const take = Math.min(remaining, outstanding);
    allocations.push({ splitShareId: share.shareId, amountCents: toCents(take) });
    remaining -= take;
  }
  return { allocations, unallocatedCents: toCents(remaining) };
}

// An existing settlement carrying unallocated credit, ready to be consumed.
export type CreditSource = {
  settlementId: string;
  unallocatedCents: number;
};

export type CreditAllocation = {
  settlementId: string;
  splitShareId: string;
  amountCents: Cents;
};

// The dual of allocateFifo: when a new share is created, consume existing
// same-direction credit for that person to pay it down, FIFO across the
// credit sources (pre-ordered by the caller, oldest settlement first). Returns
// the allocations to write and how much of the share is still outstanding.
export function consumeCredit(
  share: { shareId: string; outstandingCents: number },
  credits: readonly CreditSource[],
): { allocations: CreditAllocation[]; shareRemainingCents: Cents } {
  let remaining = Math.max(0, share.outstandingCents);
  const allocations: CreditAllocation[] = [];
  for (const credit of credits) {
    if (remaining <= 0) break;
    const available = Math.max(0, credit.unallocatedCents);
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    allocations.push({
      settlementId: credit.settlementId,
      splitShareId: share.shareId,
      amountCents: toCents(take),
    });
    remaining -= take;
  }
  return { allocations, shareRemainingCents: toCents(remaining) };
}
