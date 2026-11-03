import 'server-only';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, ledgerClosingDays, transactions } from './schema';
import { verificationRows } from './ledger';
import { cycleContaining, type ClosingDayEntry, type Cycle } from '@/lib/statement-cycles';

// The closing days the owner set (STATEMENT-CYCLES.md), per ledger account,
// oldest first.
export async function closingDaysFor(ledgerAccountIds: string[]): Promise<Map<string, ClosingDayEntry[]>> {
  const out = new Map<string, ClosingDayEntry[]>();
  if (ledgerAccountIds.length === 0) return out;
  const rows = await db
    .select({ ledgerAccountId: ledgerClosingDays.ledgerAccountId, effectiveFrom: ledgerClosingDays.effectiveFrom, closingDay: ledgerClosingDays.closingDay })
    .from(ledgerClosingDays)
    .where(inArray(ledgerClosingDays.ledgerAccountId, ledgerAccountIds))
    .orderBy(asc(ledgerClosingDays.effectiveFrom));
  for (const r of rows) out.set(r.ledgerAccountId, [...(out.get(r.ledgerAccountId) ?? []), { effectiveFrom: r.effectiveFrom, closingDay: r.closingDay }]);
  return out;
}

// Set a closing day from a date. The same date again corrects that entry; a
// later date is a change of cycle, kept beside the earlier one.
export async function upsertClosingDay(ledgerAccountId: string, entry: ClosingDayEntry): Promise<void> {
  await db
    .insert(ledgerClosingDays)
    .values({ ledgerAccountId, ...entry })
    .onConflictDoUpdate({
      target: [ledgerClosingDays.ledgerAccountId, ledgerClosingDays.effectiveFrom],
      set: { closingDay: entry.closingDay },
    });
}

// Remove one entry (a mistake). False when it was already gone.
export async function deleteClosingDay(ledgerAccountId: string, effectiveFrom: string): Promise<boolean> {
  const removed = await db
    .delete(ledgerClosingDays)
    .where(and(eq(ledgerClosingDays.ledgerAccountId, ledgerAccountId), eq(ledgerClosingDays.effectiveFrom, effectiveFrom)))
    .returning({ day: ledgerClosingDays.closingDay });
  return removed.length > 0;
}

export type CycleSoFar = {
  cycle: Cycle;
  // As the statement counts them: the bank's posted rows by posting date.
  chargesCents: number;
  creditsCents: number;
  // Not on the statement until they post.
  pendingCents: number;
  pendingCount: number;
};

// The current cycle of a ledger account and what its bank has reported in it
// so far, through every bank account syncing into it. Null without a closing
// day. The bank's rows only: the same set statement verification compares
// (verificationRows), so no CSV row and no purchase-date caveat is involved.
export async function cycleSoFar(ledgerAccountId: string, entries: ClosingDayEntry[], today: string): Promise<CycleSoFar | null> {
  const cycle = cycleContaining(entries, today);
  if (!cycle) return null;
  const accounts = await db.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.ledgerAccountId, ledgerAccountId));
  const rows = (await Promise.all(accounts.map((a) => verificationRows(a.id, cycle.start, cycle.end)))).flat();
  const pending =
    accounts.length === 0
      ? []
      : await db
          .select({ amountCents: transactions.amountCents })
          .from(transactions)
          .where(
            and(
              inArray(transactions.bankAccountId, accounts.map((a) => a.id)),
              eq(transactions.pending, true),
              isNull(transactions.deletedAt),
            ),
          );
  return {
    cycle,
    chargesCents: rows.filter((r) => r.amountCents > 0).reduce((n, r) => n + r.amountCents, 0),
    creditsCents: -rows.filter((r) => r.amountCents < 0).reduce((n, r) => n + r.amountCents, 0),
    pendingCents: pending.reduce((n, r) => n + r.amountCents, 0),
    pendingCount: pending.length,
  };
}
