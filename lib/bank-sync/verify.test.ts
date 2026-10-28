import { describe, expect, it } from 'vitest';
import { compareToStatement, type FetchedRow } from './verify';

const r = (key: string, postedDate: string, amountCents: number): FetchedRow => ({ key, postedDate, amountCents, description: key });
const rows = [
  r('coffee', '2026-10-02', 4_750),
  r('groceries', '2026-10-05', 62_180),
  r('payment', '2026-10-10', -500_000),
  r('refund', '2026-10-12', -12_000),
  r('cinema', '2026-10-20', 27_000),
  r('hold', '2026-10-31', 9_990),
  r('next-month', '2026-11-01', 1_000),
];
const statement = { from: '2026-10-01', to: '2026-10-31', chargesCents: 93_930, creditsCents: 512_000 };

describe('compareToStatement', () => {
  it('passes when both totals match to the cent, after rows marked as not on the statement, and the owner confirms', () => {
    const result = compareToStatement({ rows, statement, excludedKeys: new Set(['hold']), confirmed: true });
    expect(result).toMatchObject({ fetchedChargesCents: 93_930, fetchedCreditsCents: 512_000, chargesMatch: true, creditsMatch: true, passed: true });
    expect(result.excluded.map((x) => x.key)).toEqual(['hold']);
  });

  it('fails on a single mill of difference, or without the confirmation', () => {
    expect(compareToStatement({ rows, statement: { ...statement, chargesCents: 93_931 }, excludedKeys: new Set(['hold']), confirmed: true }).passed).toBe(false);
    expect(compareToStatement({ rows, statement, excludedKeys: new Set(['hold']), confirmed: false }).passed).toBe(false);
  });

  it('catches a wrong sign: a payment arriving positive breaks both totals', () => {
    const flipped = rows.map((x) => (x.key === 'payment' ? { ...x, amountCents: 500_000 } : x));
    const result = compareToStatement({ rows: flipped, statement, excludedKeys: new Set(['hold']), confirmed: true });
    expect(result).toMatchObject({ chargesMatch: false, creditsMatch: false, passed: false });
  });

  it('lists every credit and the five largest charges to tick, and counts only the period', () => {
    const result = compareToStatement({ rows, statement, excludedKeys: new Set(), confirmed: true });
    expect(result.toCheck.map((x) => x.key)).toEqual(['payment', 'refund', 'groceries', 'cinema', 'hold', 'coffee']);
    expect(result.fetchedChargesCents).toBe(103_920);
  });

  it('verifies nothing from an empty period', () => {
    expect(compareToStatement({ rows: [], statement: { ...statement, chargesCents: 0, creditsCents: 0 }, excludedKeys: new Set(), confirmed: true }).passed).toBe(false);
  });
});
