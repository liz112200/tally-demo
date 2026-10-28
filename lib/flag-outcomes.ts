// What each way of resolving a bank flag (BANK-SYNC.md) does to each person's
// money, computed with the real split engine so the flag panel can name the
// outcome for these people rather than state the policy. Pure.
import { computeShares } from './split';
import { toCents } from './money';

export type FlagShare = {
  personId: string;
  personName: string;
  // The share as stored, the payments allocated to it, and the inputs it was
  // computed from.
  amountCents: number;
  allocatedCents: number;
  inputAmountCents: number | null;
  inputPercent: number | null;
};

export type FlagSplit = {
  method: 'equal' | 'amount' | 'percent' | 'item';
  taxCents: number;
  tipCents: number;
  // In person created_at order, as stored (the engine's participant order).
  shares: FlagShare[];
};

export type ResaveLine = {
  personId: string;
  personName: string;
  oldShareCents: number;
  newShareCents: number;
  // Paid toward this row so far.
  paidCents: number;
  // Taken from credit the person already carries from other payments.
  creditUsedCents: number;
  // Still owed for this row after the re-save.
  owesCents: number;
  // Paid toward this row but no longer needed by the smaller share.
  becomesCreditCents: number;
};

export type ResaveOutcome =
  | { kind: 'computed'; lines: ResaveLine[] }
  // The split cannot be recomputed from what is stored: hand-entered amounts
  // sum to the old total, and an item split follows its receipt.
  | { kind: 'manual'; reason: 'amount' | 'item' };

// Re-saving the split with the same method and inputs on the bank's new
// amount. The save drops the row's allocations and re-applies each person's
// credit, which then includes what they had paid toward this row, so a
// person's new standing is their new share against everything they have
// paid and not yet used. The owner's own share is never owed and is left out.
export function resaveOutcome(input: {
  newAmountCents: number;
  split: FlagSplit;
  ownerId: string | undefined;
  // Unallocated incoming credit each person already carries, by person id.
  creditByPerson: Readonly<Record<string, number>>;
}): ResaveOutcome {
  const { split } = input;
  if (split.method === 'item') return { kind: 'manual', reason: 'item' };
  if (split.method === 'amount') return { kind: 'manual', reason: 'amount' };
  let next;
  try {
    next = computeShares(
      toCents(input.newAmountCents),
      toCents(split.taxCents),
      toCents(split.tipCents),
      split.method,
      split.shares.map((s) => ({ personId: s.personId })),
      split.method === 'percent' ? split.shares.map((s) => s.inputPercent ?? 0) : undefined,
    );
  } catch {
    return { kind: 'manual', reason: 'amount' };
  }
  const newShare = new Map(next.map((s) => [s.personId, s.amountCents as number]));
  const lines = split.shares
    .filter((s) => s.personId !== input.ownerId)
    .map((s) => {
      const share = newShare.get(s.personId) ?? 0;
      const otherCredit = Math.max(0, input.creditByPerson[s.personId] ?? 0);
      const fromPaid = Math.min(share, s.allocatedCents);
      const creditUsed = Math.min(share - fromPaid, otherCredit);
      return {
        personId: s.personId,
        personName: s.personName,
        oldShareCents: s.amountCents,
        newShareCents: share,
        paidCents: s.allocatedCents,
        creditUsedCents: creditUsed,
        owesCents: share - fromPaid - creditUsed,
        becomesCreditCents: s.allocatedCents - fromPaid,
      };
    });
  return { kind: 'computed', lines };
}

// Removing the split, or deleting the row: what each person had paid toward
// it becomes their credit, and nothing for this row is owed any more.
export type DropLine = { personId: string; personName: string; paidCents: number; owedCents: number };

export function dropOutcome(split: FlagSplit, ownerId: string | undefined): {
  lines: DropLine[];
  creditTotalCents: number;
  forgivenTotalCents: number;
} {
  const lines = split.shares
    .filter((s) => s.personId !== ownerId)
    .map((s) => ({
      personId: s.personId,
      personName: s.personName,
      paidCents: Math.min(s.allocatedCents, s.amountCents),
      owedCents: Math.max(0, s.amountCents - s.allocatedCents),
    }));
  return {
    lines,
    creditTotalCents: lines.reduce((sum, l) => sum + l.paidCents, 0),
    forgivenTotalCents: lines.reduce((sum, l) => sum + l.owedCents, 0),
  };
}
