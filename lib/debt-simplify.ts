// Debt simplification. Pure over integer minor units; no database or UI
// dependency. Given everyone's net position in a group, produce a short list
// of direct transfers that brings every balance to zero.
//
// Sign convention: netCents > 0 means the person owes the group (a debtor),
// netCents < 0 means the group owes them (a creditor). The inputs must sum to
// exactly zero — money is integer minor units, so there is no rounding slack
// to tolerate, and a nonzero sum is a caller bug.
//
// ALGORITHM — greedy, not optimal. The true minimum number of transfers is
// (nonzero people) minus (the largest number of disjoint zero-sum groups the
// balances can be partitioned into), and finding that partition is NP-hard
// (it generalizes subset-sum). Instead:
//   1. Pair any debtor and creditor whose amounts match exactly — one
//      transfer clears both, the cheapest possible win.
//   2. Repeatedly match the largest remaining debtor with the largest
//      remaining creditor for the smaller of the two amounts.
// Every transfer clears at least one person and the last clears two, so the
// result never exceeds (nonzero people - 1) transfers. It can miss a
// partition into zero-sum groups of three or more (e.g. +1 +2 -3 alongside
// +4 +5 -9), where an exhaustive search would save a transfer per group.
// Group sizes here are a handful of people, where that gap is rarely more
// than one transfer; the greedy pass is predictable and easy to explain.
//
// DETERMINISM: ties (equal amounts) break by input order, so the same input
// always yields the same transfers.
import { type Cents, toCents } from './money';

export type NetBalance = { personId: string; netCents: Cents };

export type Transfer = {
  fromPersonId: string;
  toPersonId: string;
  amountCents: Cents;
};

type Party = { personId: string; amount: number; order: number };

export function simplifyDebts(balances: readonly NetBalance[]): Transfer[] {
  const seen = new Set<string>();
  let sum = 0;
  for (const b of balances) {
    if (seen.has(b.personId)) {
      throw new Error(`Duplicate person in balances: ${b.personId}`);
    }
    seen.add(b.personId);
    toCents(b.netCents); // re-assert the integer invariant
    sum += b.netCents;
  }
  if (sum !== 0) {
    throw new Error(`Balances must sum to zero, received: ${sum}`);
  }

  // Magnitudes on both sides, so "larger" means the same thing for each.
  const debtors: Party[] = [];
  const creditors: Party[] = [];
  balances.forEach((b, order) => {
    if (b.netCents > 0) debtors.push({ personId: b.personId, amount: b.netCents, order });
    else if (b.netCents < 0) creditors.push({ personId: b.personId, amount: -b.netCents, order });
  });

  const transfers: Transfer[] = [];
  const pay = (from: Party, to: Party, amount: number) => {
    transfers.push({
      fromPersonId: from.personId,
      toPersonId: to.personId,
      amountCents: toCents(amount),
    });
    from.amount -= amount;
    to.amount -= amount;
  };

  // Pass 1: exact matches, in debtor input order, each to the earliest
  // creditor carrying the same amount.
  for (const d of debtors) {
    const c = creditors.find((c) => c.amount > 0 && c.amount === d.amount);
    if (c) pay(d, c, d.amount);
  }

  // Pass 2: largest debtor to largest creditor until everyone is clear.
  const byLargest = (a: Party, b: Party) => b.amount - a.amount || a.order - b.order;
  for (;;) {
    const d = debtors.filter((p) => p.amount > 0).sort(byLargest)[0];
    const c = creditors.filter((p) => p.amount > 0).sort(byLargest)[0];
    if (!d || !c) break;
    pay(d, c, Math.min(d.amount, c.amount));
  }

  return transfers;
}
