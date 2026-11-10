// One card on the accounts board (2026-11-05): an account's name first, where
// it is in its statement cycle and what that rests on, this cycle's figures
// as its statement will count them, and what is true about it at a glance:
// whether its last compared statement agrees, a question waiting, whether it
// is trusted yet. Pure.
import { currentCycle } from './statement-cycles';
import { cycleSummary, type CycleSummary } from './cycle-summary';
import { groupByPeriod, statementComparison, type PeriodRow, type PeriodStatement } from './statement-periods';

export type CardChip = { label: string; tone: 'ok' | 'warn' | 'info' | 'quiet' };

export type AccountCard = {
  id: string;
  name: string;
  // "Card · linked", "Checking · CSV only".
  kind: string;
  cycle: CycleSummary | null;
  // This cycle so far, both sides, in the statement's own words.
  figures: { label: string; mills: number }[];
  chips: CardChip[];
};

export function accountCard(input: {
  ledger: { id: string; label: string; kind: 'card' | 'checking'; purchaseDatedCsv: boolean; statements: PeriodStatement[]; closedOn?: string | null };
  // Whether a review accepted this statement's difference as it now is
  // (db/reviews.ts reviewApplies): the chip keeps the difference and says so.
  reviewed?: (closingDate: string, diff: { chargesDiff: number; creditsDiff: number }) => boolean;
  rows: readonly PeriodRow[];
  linked: boolean;
  // Unanswered held rows across its bank accounts.
  held: number;
  // A bank account syncing into it is not yet checked against a statement.
  unverified: boolean;
  today: string;
  formatDay: (iso: string) => string;
  formatMoney: (mills: number) => string;
}): AccountCard {
  const { ledger, today, formatDay: day, formatMoney: money } = input;
  // A closed account has no cycle: nothing more is expected of it.
  const cycle = ledger.closedOn ? null : currentCycle(ledger.statements, today);
  const groups = groupByPeriod({ all: input.rows, visible: input.rows, statements: ledger.statements, purchaseDatedCsv: ledger.purchaseDatedCsv });
  const current = groups.find((g) => g.kind === 'current');
  const [out, back] = ledger.kind === 'card' ? ['Charges', 'Payments and credits'] : ['Withdrawals', 'Deposits'];

  const chips: CardChip[] = [];
  // The latest statement with totals recorded, and whether its rows agree.
  const compared = groups.find((g) => g.kind === 'statement' && statementComparison(g) !== null);
  if (compared) {
    const c = statementComparison(compared)!;
    const closing = day(compared.to!);
    if (c.chargesDiff === 0 && c.creditsDiff === 0) chips.push({ label: `${closing} statement matches`, tone: 'ok' });
    else {
      const diffs = [c.chargesDiff, c.creditsDiff].filter((d) => d !== 0);
      const reviewed = input.reviewed?.(compared.to!, c) ?? false;
      // A reviewed difference is still shown, with the fact that it was.
      chips.push({
        label: `${closing}: ${diffs.map((d) => `${money(Math.abs(d))} ${d < 0 ? 'under' : 'over'}`).join(', ')}${reviewed ? ' · reviewed' : ''}`,
        tone: reviewed ? 'quiet' : 'warn',
      });
    }
  }
  if (input.held > 0) chips.push({ label: input.held === 1 ? '1 question' : `${input.held} questions`, tone: 'warn' });
  if (input.unverified) chips.push({ label: 'Not verified yet', tone: 'info' });
  if (ledger.closedOn) chips.push({ label: `Closed ${day(ledger.closedOn)}`, tone: 'quiet' });
  else if (ledger.statements.length === 0) chips.push({ label: 'No statements', tone: 'quiet' });

  return {
    id: ledger.id,
    name: ledger.label,
    kind: `${ledger.kind === 'card' ? 'Card' : 'Checking'} · ${input.linked ? 'linked' : 'CSV only'}`,
    cycle: cycle ? cycleSummary({ cycle, statements: ledger.statements, today, formatDay: day }) : null,
    figures: [
      { label: out, mills: current?.chargesCents ?? 0 },
      { label: back, mills: current?.creditsCents ?? 0 },
    ],
    chips,
  };
}

// A bank account whose synced rows count in no total yet: it syncs, or has
// rows or a held row, and no statement check has passed.
export function isUnverified(
  bank: { syncEnabled: boolean; rowCount: number },
  state: { verifiedAt: Date | null; heldCount: number; ledgerAccountId: string | null } | undefined,
): boolean {
  return !!state?.ledgerAccountId && state.verifiedAt === null && (bank.syncEnabled || bank.rowCount > 0 || state.heldCount > 0);
}
