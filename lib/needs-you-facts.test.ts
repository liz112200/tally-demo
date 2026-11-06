import { describe, expect, it } from 'vitest';
import { ledgerFacts } from './needs-you-facts';
import type { PeriodRow, PeriodStatement } from './statement-periods';

// Invented accounts, days and amounts.
let n = 0;
const row = (date: string, amountCents: number): PeriodRow => ({
  id: `r${++n}`,
  date,
  postedDate: date,
  amountCents,
  source: 'plaid',
  pending: false,
  unverified: false,
  alongsideOfId: null,
});
const statement = (closingDate: string, over: Partial<PeriodStatement> = {}): PeriodStatement => ({
  closingDate,
  periodStart: null,
  nextClosingDate: null,
  startsNewCycle: false,
  chargesCents: null,
  creditsCents: null,
  ...over,
});
const facts = (statements: PeriodStatement[], rows: PeriodRow[], today = '2026-08-20') =>
  ledgerFacts({ ledger: { id: 'l', label: 'Card One', kind: 'card', purchaseDatedCsv: false, statements }, rows, today });

describe('ledgerFacts', () => {
  it('raises a statement whose totals differ from its rows, with both sides', () => {
    const f = facts(
      [statement('2026-06-11'), statement('2026-07-11', { chargesCents: 10_000, creditsCents: 3_000 }), statement('2026-08-11')],
      [row('2026-06-20', 9_000), row('2026-06-21', -3_000), row('2026-07-20', 1_000)],
    );
    expect(f.disagreements).toEqual([
      {
        ledgerId: 'l',
        name: 'Card One',
        kind: 'card',
        closingDate: '2026-07-11',
        charges: { statedCents: 10_000, listedCents: 9_000 },
        credits: { statedCents: 3_000, listedCents: 3_000 },
      },
    ]);
  });

  it('asks for totals on the latest statement only, and only when its period has rows', () => {
    const statements = [statement('2026-06-11'), statement('2026-07-11'), statement('2026-08-11')];
    expect(facts(statements, [row('2026-07-20', 1_000)]).withoutTotals).toEqual([{ ledgerId: 'l', name: 'Card One', closingDate: '2026-08-11' }]);
    expect(facts(statements, [row('2026-06-20', 1_000)]).withoutTotals).toEqual([]);
  });

  it('notices a closed statement not recorded, and an account with rows and no statement', () => {
    expect(facts([statement('2026-05-11'), statement('2026-06-11'), statement('2026-07-11')], [row('2026-07-20', 1_000)]).missingStatements).toEqual([
      { ledgerId: 'l', name: 'Card One', since: '2026-07-11' },
    ]);
    expect(facts([], [row('2026-07-20', 1_000)]).noStatements).toEqual([{ ledgerId: 'l', name: 'Card One' }]);
    expect(facts([], [])).toEqual({ disagreements: [], withoutTotals: [], missingStatements: [], noStatements: [] });
  });
});
