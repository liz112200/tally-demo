import { describe, expect, it } from 'vitest';
import { flagHistoryLine } from './flag-history';

// Invented amounts and dates.
const money = (mills: number) => `$${(mills / 1000).toFixed(2)}`;
const day = (iso: string) => iso.slice(0, 10);

describe('flagHistoryLine', () => {
  it('states the bank amount before and after, and what was done', () => {
    expect(
      flagHistoryLine(
        { flag: 'amount', bankAmountBeforeCents: 41_250, amountCents: 43_900, removedByBankAt: null, resolution: 'kept', resolvedAt: '2026-08-14T12:00:00Z' },
        money,
        day,
      ),
    ).toBe('The bank changed the amount from $41.25 to $43.90; kept as it was on 2026-08-14.');
  });

  it('states the bank undoing its own change without a before and after', () => {
    expect(
      flagHistoryLine(
        { flag: 'amount', bankAmountBeforeCents: 41_250, amountCents: 41_250, removedByBankAt: null, resolution: 'bank_reverted', resolvedAt: '2026-08-16T12:00:00Z' },
        money,
        day,
      ),
    ).toBe('The bank changed the amount away from $41.25, then back on 2026-08-16.');
  });

  it('states when the bank removed a row', () => {
    expect(
      flagHistoryLine(
        { flag: 'removed', bankAmountBeforeCents: null, amountCents: 7_300, removedByBankAt: '2026-08-02T09:00:00Z', resolution: 'moved_to_replacement', resolvedAt: '2026-08-03T10:00:00Z' },
        money,
        day,
      ),
    ).toBe('The bank removed this row on 2026-08-02; moved onto the re-sent row on 2026-08-03.');
  });
});
