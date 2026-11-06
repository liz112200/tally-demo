import { describe, expect, it } from 'vitest';
import { conversionCheck } from './conversion';
import { dedupHash } from './parsers/dedup';

// Invented rows and amounts. A CSV row imported at $60.00 and raised to $66.00.
const imported = { source: 'amex', accountLabel: null, date: '2026-08-14', amountCents: 60_000, descriptionRaw: 'LAKESIDE CAR HIRE' };
const raised = { ...imported, amountCents: 66_000, dedupHash: dedupHash(imported), providerTransactionId: null, deleted: false };
const check = (over: Partial<Parameters<typeof conversionCheck>[0]> = {}) =>
  conversionCheck({
    row: raised,
    split: { paidByOwner: true, method: 'equal' },
    shareAmounts: [33_000, 33_000],
    alongsideForExtra: () => null,
    ...over,
  });

describe('conversionCheck', () => {
  it('accepts a raised row with an equal split the owner paid, and states the extra and each part', () => {
    expect(check()).toEqual({ ok: true, originalCents: 60_000, extraCents: 6_000, partCents: 3_000 });
  });

  it('refuses, saying why, everything the conversion refuses', () => {
    const refusal = (over: Partial<Parameters<typeof conversionCheck>[0]>) => {
      const r = check(over);
      return 'error' in r ? r.error : null;
    };
    expect(refusal({ row: null })).toBe('That transaction no longer exists.');
    expect(refusal({ row: { ...raised, providerTransactionId: 'p1' } })).toMatch(/^Only a CSV or manual row/);
    expect(refusal({ row: { ...raised, amountCents: 60_000 } })).toBe('This row has the amount it came in with; there is nothing to move.');
    expect(refusal({ row: { ...raised, descriptionRaw: 'RENAMED' } })).toMatch(/cannot be recovered/);
    // Split by amount, as the demo's car hire is: refused, not offered.
    expect(refusal({ split: { paidByOwner: true, method: 'amount' } })).toBe('Only a row with an equal split you paid is converted.');
    expect(refusal({ split: { paidByOwner: false, method: 'equal' } })).toBe('Only a row with an equal split you paid is converted.');
    expect(refusal({ split: null })).toBe('Only a row with an equal split you paid is converted.');
    expect(refusal({ shareAmounts: Array(7).fill(9_430) })).toBe('The extra does not divide evenly in whole cents among 7 people, so it is not converted.');
    expect(refusal({ shareAmounts: [64_000, 2_000] })).toBe('A share is smaller than its part of the extra; not converted.');
    expect(refusal({ alongsideForExtra: (extra) => (extra === 6_000 ? 'Gas, cash' : null) })).toMatch(/^"Gas, cash" for \$6\.00 is already recorded/);
  });
});
