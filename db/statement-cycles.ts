import 'server-only';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, ledgerStatements, transactions } from './schema';
import { verificationRows } from './ledger';
import { currentCycle, type CurrentCycle, type StatementRecord } from '@/lib/statement-cycles';

export type RecordedStatement = StatementRecord & { source: 'verification' | 'owner' };

// The statements recorded for each ledger account (STATEMENT-CYCLES.md),
// oldest first.
export async function statementsFor(ledgerAccountIds: string[]): Promise<Map<string, RecordedStatement[]>> {
  const out = new Map<string, RecordedStatement[]>();
  if (ledgerAccountIds.length === 0) return out;
  const rows = await db
    .select({
      ledgerAccountId: ledgerStatements.ledgerAccountId,
      closingDate: ledgerStatements.closingDate,
      periodStart: ledgerStatements.periodStart,
      nextClosingDate: ledgerStatements.nextClosingDate,
      startsNewCycle: ledgerStatements.startsNewCycle,
      source: ledgerStatements.source,
    })
    .from(ledgerStatements)
    .where(inArray(ledgerStatements.ledgerAccountId, ledgerAccountIds))
    .orderBy(asc(ledgerStatements.closingDate));
  for (const { ledgerAccountId, ...s } of rows) out.set(ledgerAccountId, [...(out.get(ledgerAccountId) ?? []), s]);
  return out;
}

// Remove one recorded statement (a mistake). False when already gone.
export async function deleteStatement(ledgerAccountId: string, closingDate: string): Promise<boolean> {
  const removed = await db
    .delete(ledgerStatements)
    .where(and(eq(ledgerStatements.ledgerAccountId, ledgerAccountId), eq(ledgerStatements.closingDate, closingDate)))
    .returning({ closingDate: ledgerStatements.closingDate });
  return removed.length > 0;
}

export type CycleSoFar = {
  cycle: CurrentCycle;
  // As the statement counts them: the bank's posted rows by posting date.
  chargesCents: number;
  creditsCents: number;
  // Not on the statement until they post.
  pendingCents: number;
  pendingCount: number;
};

// The current cycle of a ledger account and what its bank has reported in it
// so far, through every bank account syncing into it. Null with no statement
// recorded. The bank's rows only: the same set statement verification
// compares (verificationRows), so no CSV row and no purchase-date caveat is
// involved.
export async function cycleSoFar(ledgerAccountId: string, statements: StatementRecord[], today: string): Promise<CycleSoFar | null> {
  const cycle = currentCycle(statements, today);
  if (!cycle) return null;
  const accounts = await db.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.ledgerAccountId, ledgerAccountId));
  const from = cycle.start ?? '1970-01-01';
  const rows = (await Promise.all(accounts.map((a) => verificationRows(a.id, from, cycle.end.to)))).flat();
  const pending =
    accounts.length === 0
      ? []
      : await db
          .select({ amountCents: transactions.amountCents })
          .from(transactions)
          .where(and(inArray(transactions.bankAccountId, accounts.map((a) => a.id)), eq(transactions.pending, true), isNull(transactions.deletedAt)));
  return {
    cycle,
    chargesCents: rows.filter((r) => r.amountCents > 0).reduce((n, r) => n + r.amountCents, 0),
    creditsCents: -rows.filter((r) => r.amountCents < 0).reduce((n, r) => n + r.amountCents, 0),
    pendingCents: pending.reduce((n, r) => n + r.amountCents, 0),
    pendingCount: pending.length,
  };
}
