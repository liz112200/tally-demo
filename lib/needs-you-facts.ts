// What one ledger account's statements and rows say needs the owner, for the
// Needs you band (lib/needs-you.ts). Pure.
import { currentCycle } from './statement-cycles';
import { groupByPeriod, statementComparison, type PeriodRow, type PeriodStatement } from './statement-periods';
import type { NeedsYouFacts } from './needs-you';

type LedgerFacts = Pick<NeedsYouFacts, 'disagreements' | 'withoutTotals' | 'missingStatements' | 'noStatements'>;

export function ledgerFacts(input: {
  ledger: { id: string; label: string; kind: 'card' | 'checking'; purchaseDatedCsv: boolean; statements: PeriodStatement[] };
  rows: readonly PeriodRow[];
  today: string;
}): LedgerFacts {
  const { ledger, rows, today } = input;
  const facts: LedgerFacts = { disagreements: [], withoutTotals: [], missingStatements: [], noStatements: [] };
  if (rows.length === 0) return facts;
  if (ledger.statements.length === 0) {
    facts.noStatements.push({ ledgerId: ledger.id, name: ledger.label });
    return facts;
  }
  const groups = groupByPeriod({ all: rows, visible: rows, statements: ledger.statements, purchaseDatedCsv: ledger.purchaseDatedCsv });
  // Every recorded statement whose totals differ from its period's rows.
  for (const g of groups) {
    const c = statementComparison(g);
    if (!c || (c.chargesDiff === 0 && c.creditsDiff === 0)) continue;
    facts.disagreements.push({
      ledgerId: ledger.id,
      name: ledger.label,
      kind: ledger.kind,
      closingDate: g.to!,
      charges: { statedCents: g.statement!.chargesCents!, listedCents: g.chargesCents },
      credits: { statedCents: g.statement!.creditsCents!, listedCents: g.creditsCents },
    });
  }
  // The latest recorded statement only: its period holds rows and its totals
  // are not recorded, so nothing compares them. Earlier ones without totals
  // are not raised, or the band would list every statement ever pasted.
  const latest = [...ledger.statements].sort((a, b) => b.closingDate.localeCompare(a.closingDate))[0];
  const latestGroup = groups.find((g) => g.kind === 'statement' && g.statement?.closingDate === latest.closingDate);
  if (latestGroup && latestGroup.count > 0 && (latest.chargesCents === null || latest.creditsCents === null)) {
    facts.withoutTotals.push({ ledgerId: ledger.id, name: ledger.label, closingDate: latest.closingDate });
  }
  const cycle = currentCycle(ledger.statements, today);
  if (cycle?.missingSince) facts.missingStatements.push({ ledgerId: ledger.id, name: ledger.label, since: cycle.missingSince });
  return facts;
}
