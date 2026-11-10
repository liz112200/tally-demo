import { describe, expect, it } from 'vitest';
import { explainDifference } from './difference-explain';

// Invented dates and amounts.
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const money = (mills: number) => `$${(mills / 1000).toFixed(2)}`;
const period = { from: '2026-08-12', to: '2026-09-11', day, money };

describe('explainDifference', () => {
  it('accounts for a held row whose bank posting is here and whose CSV twin is in the previous period', () => {
    const e = explainDifference({
      ...period,
      chargesDiff: -4_250,
      creditsDiff: 0,
      held: [{ postedDate: '2026-08-14', twinDate: '2026-08-10', amountCents: 4_250, answeredOn: '2026-09-20' }],
      raised: [],
    });
    expect(e.lines).toEqual([
      'A held bank row posted Aug 14, answered the same purchase on Sep 20, matches a CSV row dated Aug 10, in the previous period: $4.25 less here.',
    ]);
    expect([e.leftCharges, e.leftCredits]).toEqual([0, 0]);
  });

  it('accounts for a CSV twin here whose bank row posted after the close, and a raised row, together', () => {
    const e = explainDifference({
      ...period,
      chargesDiff: 9_000 + 2_500,
      creditsDiff: 0,
      held: [{ postedDate: '2026-09-13', twinDate: '2026-09-10', amountCents: 9_000, answeredOn: '2026-09-20' }],
      raised: [{ date: '2026-08-30', originalCents: 20_000, currentCents: 22_500 }],
    });
    expect(e.lines).toEqual([
      'A CSV row dated Sep 10 is the same purchase as a held bank row posted Sep 13, in the next period, answered on Sep 20: $9.00 more here.',
      'A CSV row dated Aug 30 was raised after import from $20.00 to $22.50: $2.50 more here.',
    ]);
    expect(e.leftCharges).toBe(0);
  });

  it('says what the facts leave unexplained, and ignores rows in other periods or within this one', () => {
    const e = explainDifference({
      ...period,
      chargesDiff: -5_000,
      creditsDiff: 1_000,
      held: [
        { postedDate: '2026-08-20', twinDate: '2026-08-18', amountCents: 3_000, answeredOn: '2026-09-20' },
        { postedDate: '2026-07-20', twinDate: '2026-07-18', amountCents: 3_000, answeredOn: '2026-09-20' },
      ],
      raised: [{ date: '2026-07-30', originalCents: 1_000, currentCents: 2_000 }],
    });
    expect(e.lines).toEqual([]);
    expect([e.leftCharges, e.leftCredits]).toEqual([-5_000, 1_000]);
  });

  it('puts a credit on the credits side', () => {
    const e = explainDifference({
      ...period,
      chargesDiff: 0,
      creditsDiff: -7_000,
      held: [{ postedDate: '2026-09-01', twinDate: '2026-08-11', amountCents: -7_000, answeredOn: '2026-09-20' }],
      raised: [],
    });
    expect([e.leftCharges, e.leftCredits]).toEqual([0, 0]);
  });
});
