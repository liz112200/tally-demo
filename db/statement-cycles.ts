import 'server-only';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, ledgerAccounts, ledgerStatements, transactions } from './schema';
import { verificationRows } from './ledger';
import { currentCycle, type CurrentCycle, type StatementRecord } from '@/lib/statement-cycles';

export type RecordedStatement = StatementRecord & { source: 'verification' | 'owner'; chargesCents: number | null; creditsCents: number | null };

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
      chargesCents: ledgerStatements.chargesCents,
      creditsCents: ledgerStatements.creditsCents,
    })
    .from(ledgerStatements)
    .where(inArray(ledgerStatements.ledgerAccountId, ledgerAccountIds))
    .orderBy(asc(ledgerStatements.closingDate));
  for (const { ledgerAccountId, ...s } of rows) out.set(ledgerAccountId, [...(out.get(ledgerAccountId) ?? []), s]);
  return out;
}

// One recorded statement, or null.
export async function statementOf(ledgerAccountId: string, closingDate: string): Promise<RecordedStatement | null> {
  const [row] = await db
    .select({
      closingDate: ledgerStatements.closingDate,
      periodStart: ledgerStatements.periodStart,
      nextClosingDate: ledgerStatements.nextClosingDate,
      startsNewCycle: ledgerStatements.startsNewCycle,
      source: ledgerStatements.source,
      chargesCents: ledgerStatements.chargesCents,
      creditsCents: ledgerStatements.creditsCents,
    })
    .from(ledgerStatements)
    .where(and(eq(ledgerStatements.ledgerAccountId, ledgerAccountId), eq(ledgerStatements.closingDate, closingDate)));
  return row ?? null;
}

// Edit a recorded statement in place (2026-11-11): every field as given, a
// blank clearing it, unlike recording, which only adds what was not known.
// The closing date is the statement and is not edited. A statement from a
// statement check keeps the check's period and totals: the check passed with
// its rows matching them to the cent, so they are the evidence it rests on,
// and an edit changing them is refused rather than applied or ignored.
export async function editStatement(
  ledgerAccountId: string,
  closingDate: string,
  next: { periodStart: string | null; nextClosingDate: string | null; startsNewCycle: boolean; chargesCents: number | null; creditsCents: number | null },
): Promise<'edited' | 'missing' | 'from-check'> {
  return db.transaction(async (tx) => {
    const where = and(eq(ledgerStatements.ledgerAccountId, ledgerAccountId), eq(ledgerStatements.closingDate, closingDate));
    const [current] = await tx
      .select({ source: ledgerStatements.source, periodStart: ledgerStatements.periodStart, chargesCents: ledgerStatements.chargesCents, creditsCents: ledgerStatements.creditsCents })
      .from(ledgerStatements)
      .where(where)
      .for('update');
    if (!current) return 'missing';
    if (
      current.source === 'verification' &&
      (current.periodStart !== next.periodStart || current.chargesCents !== next.chargesCents || current.creditsCents !== next.creditsCents)
    ) {
      return 'from-check';
    }
    await tx.update(ledgerStatements).set(next).where(where);
    return 'edited';
  });
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
  // Not on the statement until they post. Each side apart: a pending
  // withdrawal and a pending deposit netted into one figure hid both
  // (2026-11-03: $19.99 out and $338.00 in read as "-$318.01 pending").
  pendingOutCents: number;
  pendingInCents: number;
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
    creditsCents: rows.filter((r) => r.amountCents < 0).reduce((n, r) => n - r.amountCents, 0),
    pendingOutCents: pending.filter((r) => r.amountCents > 0).reduce((n, r) => n + r.amountCents, 0),
    pendingInCents: pending.filter((r) => r.amountCents < 0).reduce((n, r) => n - r.amountCents, 0),
    pendingCount: pending.length,
  };
}

// The ledger accounts Expenses gives a tab each (STATEMENT-CYCLES.md, the
// period view), by name, with what their periods need: the statement's words
// (card or checking), whether their CSV dates rows by purchase (the caveat),
// and their recorded statements.
export type LedgerTab = {
  id: string;
  label: string;
  csvSource: string | null;
  kind: 'card' | 'checking';
  purchaseDatedCsv: boolean;
  statements: RecordedStatement[];
  // The day the account closed, when recorded: no statement expected after.
  closedOn: string | null;
};

export async function getLedgerTabs(): Promise<LedgerTab[]> {
  const rows = await db
    .select({
      id: ledgerAccounts.id,
      label: ledgerAccounts.displayName,
      csvSource: ledgerAccounts.csvSource,
      basis: ledgerAccounts.cutoverBasis,
      closedOn: ledgerAccounts.closedOn,
      // Written out with table names: in a single-table select Drizzle renders
      // its columns unqualified, and a bare "id" inside this subquery would be
      // the bank account's (CLAUDE.md, Working style).
      bankType: sql<string | null>`(select b.type from bank_accounts b where b.ledger_account_id = ledger_accounts.id order by b.created_at limit 1)`,
    })
    .from(ledgerAccounts)
    .orderBy(asc(ledgerAccounts.displayName), asc(ledgerAccounts.id));
  const statements = await statementsFor(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    csvSource: r.csvSource,
    // Checking where the bank says so; a CSV-only Chase ledger is checking too
    // (its parser reads the checking export).
    kind: r.bankType === 'depository' || (r.bankType === null && r.csvSource === 'chase') ? 'checking' : 'card',
    // A ledger account dated on the transaction basis has a CSV that records
    // the purchase date (Amex, Discover); the posted basis records posting.
    purchaseDatedCsv: r.basis === 'transaction',
    statements: statements.get(r.id) ?? [],
    closedOn: r.closedOn,
  }));
}

// Record the day a ledger account closed, or clear it (null) when recorded by
// mistake. False when the account does not exist.
export async function setLedgerClosed(ledgerAccountId: string, closedOn: string | null): Promise<boolean> {
  const updated = await db
    .update(ledgerAccounts)
    .set({ closedOn })
    .where(eq(ledgerAccounts.id, ledgerAccountId))
    .returning({ id: ledgerAccounts.id });
  return updated.length > 0;
}
