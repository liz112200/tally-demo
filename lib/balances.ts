// Balance derivation. Pure over integer cents, no database dependency: the
// caller fetches share and settlement rows and this reduces them to
// per-person totals.
//
// balance = SUM(shares.amount_cents) - SUM(settlements.amount_cents).
// Positive means the person owes the owner; negative means an overpayment
// (still valid — it carries forward as credit). The owner's own shares are
// their own portion of expenses, not debts; callers exclude the owner
// before display, not here.
import { type Cents, toCents } from './money';

export type ShareEntry = { personId: string; amountCents: Cents };
export type SettlementEntry = { personId: string; amountCents: Cents };

export type PersonBalance = {
  personId: string;
  sharesCents: Cents;
  settledCents: Cents;
  balanceCents: Cents;
};

// Every person appearing in either list gets a row, keyed and returned in
// first-appearance order (shares first, then settlements) so output is
// deterministic for a deterministically-ordered input.
export function computeBalances(
  shares: readonly ShareEntry[],
  settlements: readonly SettlementEntry[],
): PersonBalance[] {
  const totals = new Map<string, { shares: number; settled: number }>();
  const entry = (personId: string) => {
    let t = totals.get(personId);
    if (!t) {
      t = { shares: 0, settled: 0 };
      totals.set(personId, t);
    }
    return t;
  };

  for (const s of shares) entry(s.personId).shares += s.amountCents;
  for (const s of settlements) entry(s.personId).settled += s.amountCents;

  return [...totals.entries()].map(([personId, t]) => ({
    personId,
    sharesCents: toCents(t.shares),
    settledCents: toCents(t.settled),
    balanceCents: toCents(t.shares - t.settled),
  }));
}

// ---- Bidirectional model (batch B) ----
//
// The ledger is now two-directional. A debt share is either:
//   incoming — an owner-paid split's non-owner share; that person owes the
//              owner.
//   outgoing — an external split's owner share; the owner owes that person.
// Each share is paid down by FIFO settlement allocations in its direction;
// the outstanding portion is amount minus what has been allocated to it.
//
// Per person X:
//   they_owe_me = SUM(outstanding of X's incoming shares)
//   i_owe_them  = SUM(outstanding of X's outgoing shares)
//   net         = they_owe_me - i_owe_them   (positive => X owes the owner)
// Unallocated settlement credit is tracked separately (it carries forward to
// the next same-direction share), so it never appears here as a negative
// balance — an overpayment shows as $0 net plus standalone credit.

export type Direction = 'incoming' | 'outgoing';

export type DebtShare = {
  shareId: string;
  // The non-owner counterparty of this debt, regardless of direction.
  counterpartyId: string;
  direction: Direction;
  amountCents: Cents;
  // Sum of settlement allocations against this share (already excludes
  // allocations on soft-deleted transactions upstream).
  allocatedCents: Cents;
};

export type BidirectionalBalance = {
  personId: string;
  theyOweMeCents: Cents;
  iOweThemCents: Cents;
  netCents: Cents;
};

// A share's outstanding portion never goes negative: an over-allocated share
// is simply settled, and the surplus lives on the settlement as credit.
export function shareOutstanding(share: {
  amountCents: number;
  allocatedCents: number;
}): Cents {
  return toCents(Math.max(0, share.amountCents - share.allocatedCents));
}

// Reduce debt shares to per-person bidirectional balances. Every counterparty
// appearing in the input gets a row, in first-appearance order.
export function computeBidirectionalBalances(
  shares: readonly DebtShare[],
): BidirectionalBalance[] {
  const totals = new Map<string, { owed: number; owe: number }>();
  const entry = (personId: string) => {
    let t = totals.get(personId);
    if (!t) {
      t = { owed: 0, owe: 0 };
      totals.set(personId, t);
    }
    return t;
  };
  for (const s of shares) {
    const outstanding = shareOutstanding(s);
    if (s.direction === 'incoming') entry(s.counterpartyId).owed += outstanding;
    else entry(s.counterpartyId).owe += outstanding;
  }
  return [...totals.entries()].map(([personId, t]) => ({
    personId,
    theyOweMeCents: toCents(t.owed),
    iOweThemCents: toCents(t.owe),
    netCents: toCents(t.owed - t.owe),
  }));
}
