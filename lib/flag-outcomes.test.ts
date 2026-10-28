import { describe, expect, it } from 'vitest';
import { dropOutcome, resaveOutcome, type FlagSplit } from './flag-outcomes';

// The dev case the wording was reviewed on: $54.07 split three ways (owner
// first in created_at order), saved before shares were divided in whole
// cents; A paid their whole share, B paid $9.00; the bank changed the amount
// to $58.07. A re-save divides in whole cents.
const split: FlagSplit = {
  method: 'equal',
  taxCents: 0,
  tipCents: 0,
  shares: [
    { personId: 'owner', personName: 'Me', amountCents: 18_024, allocatedCents: 0, inputAmountCents: null, inputPercent: null },
    { personId: 'a', personName: 'A', amountCents: 18_023, allocatedCents: 18_023, inputAmountCents: null, inputPercent: null },
    { personId: 'b', personName: 'B', amountCents: 18_023, allocatedCents: 9_000, inputAmountCents: null, inputPercent: null },
  ],
};

describe('resaveOutcome', () => {
  it('names each person\'s new share and what they would owe, exact to the mill', () => {
    expect(resaveOutcome({ newAmountCents: 58_070, split, ownerId: 'owner', creditByPerson: {} })).toEqual({
      kind: 'computed',
      lines: [
        { personId: 'a', personName: 'A', oldShareCents: 18_023, newShareCents: 19_360, paidCents: 18_023, creditUsedCents: 0, owesCents: 1_337, becomesCreditCents: 0 },
        { personId: 'b', personName: 'B', oldShareCents: 18_023, newShareCents: 19_350, paidCents: 9_000, creditUsedCents: 0, owesCents: 10_350, becomesCreditCents: 0 },
      ],
    });
  });

  it('uses credit a person already carries before counting anything owed', () => {
    const out = resaveOutcome({ newAmountCents: 58_070, split, ownerId: 'owner', creditByPerson: { a: 500, b: 50_000 } });
    if (out.kind !== 'computed') throw new Error('expected computed');
    expect(out.lines.map((l) => [l.creditUsedCents, l.owesCents])).toEqual([[500, 837], [10_350, 0]]);
  });

  it('a lower amount turns the overpaid part into credit', () => {
    const out = resaveOutcome({ newAmountCents: 45_000, split, ownerId: 'owner', creditByPerson: {} });
    if (out.kind !== 'computed') throw new Error('expected computed');
    expect(out.lines[0]).toMatchObject({ newShareCents: 15_000, owesCents: 0, becomesCreditCents: 3_023 });
  });

  it('cannot recompute hand-entered amounts or an item split', () => {
    expect(resaveOutcome({ newAmountCents: 58_070, split: { ...split, method: 'amount' }, ownerId: 'owner', creditByPerson: {} })).toEqual({ kind: 'manual', reason: 'amount' });
    expect(resaveOutcome({ newAmountCents: 58_070, split: { ...split, method: 'item' }, ownerId: 'owner', creditByPerson: {} })).toEqual({ kind: 'manual', reason: 'item' });
  });

  it('recomputes a percent split from its stored percents', () => {
    const percent: FlagSplit = {
      ...split,
      method: 'percent',
      shares: split.shares.map((s, i) => ({ ...s, inputPercent: [50, 25, 25][i] })),
    };
    const out = resaveOutcome({ newAmountCents: 60_000, split: percent, ownerId: 'owner', creditByPerson: {} });
    if (out.kind !== 'computed') throw new Error('expected computed');
    expect(out.lines.map((l) => l.newShareCents)).toEqual([15_000, 15_000]);
  });
});

describe('dropOutcome', () => {
  it('what was paid becomes credit, what was owed is no longer owed', () => {
    expect(dropOutcome(split, 'owner')).toEqual({
      lines: [
        { personId: 'a', personName: 'A', paidCents: 18_023, owedCents: 0 },
        { personId: 'b', personName: 'B', paidCents: 9_000, owedCents: 9_023 },
      ],
      creditTotalCents: 27_023,
      forgivenTotalCents: 9_023,
    });
  });
});
