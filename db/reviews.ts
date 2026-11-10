import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, imports, raisedRowReviews, statementReviews, transactions } from './schema';
import { getTransactions } from './queries';
import { boundaryReview } from './ledger';
import { getLedgerTabs } from './statement-cycles';
import { filterByTab } from '@/lib/expense-filters';
import { groupByPeriod, statementComparison } from '@/lib/statement-periods';
import { importedAmountBelow } from '@/lib/conversion';
import { dedupHash } from '@/lib/parsers/dedup';
import type { HeldFact, RaisedFact } from '@/lib/difference-explain';

// Reviews (migration 0037, ACCOUNTS-BOARD.md): a difference or a raised row
// the owner has looked at and accepted, with a note. A review holds the exact
// figures it accepted and applies only while they are still the figures; the
// readers here return the latest review, and whether it applies is decided
// against the current figures every time (reviewApplies), never stored.

export type StatementReview = {
  ledgerAccountId: string;
  closingDate: string;
  chargesDiffCents: number;
  creditsDiffCents: number;
  note: string;
  reviewedAt: Date;
};

// The latest review of each statement, keyed `${ledgerAccountId}:${closingDate}`.
export async function latestStatementReviews(): Promise<Map<string, StatementReview>> {
  const rows = await db.select().from(statementReviews).orderBy(desc(statementReviews.reviewedAt), desc(statementReviews.id));
  const out = new Map<string, StatementReview>();
  for (const r of rows) {
    const key = `${r.ledgerAccountId}:${r.closingDate}`;
    if (!out.has(key)) out.set(key, r);
  }
  return out;
}

export { reviewApplies } from '@/lib/review';

// A statement's difference from its period's rows as the account's page and
// the band compute it now: rows minus statement, each side; null when the
// statement has no totals or is not recorded.
export async function currentDifference(ledgerAccountId: string, closingDate: string): Promise<{ chargesDiff: number; creditsDiff: number } | null> {
  const [ledger] = (await getLedgerTabs()).filter((l) => l.id === ledgerAccountId);
  if (!ledger) return null;
  const rows = filterByTab(await getTransactions(), { kind: 'ledger', id: ledgerAccountId });
  const group = groupByPeriod({ all: rows, visible: rows, statements: ledger.statements, purchaseDatedCsv: ledger.purchaseDatedCsv }).find(
    (g) => g.kind === 'statement' && g.statement?.closingDate === closingDate,
  );
  return group ? statementComparison(group) : null;
}

export async function insertStatementReview(input: {
  ledgerAccountId: string;
  closingDate: string;
  chargesDiffCents: number;
  creditsDiffCents: number;
  note: string;
}): Promise<void> {
  await db.insert(statementReviews).values(input);
}

export type RaisedReview = { transactionId: string; amountCents: number; note: string; reviewedAt: Date };

// The latest keep-it-raised review of each row.
export async function latestRaisedReviews(): Promise<Map<string, RaisedReview>> {
  const rows = await db.select().from(raisedRowReviews).orderBy(desc(raisedRowReviews.reviewedAt), desc(raisedRowReviews.id));
  const out = new Map<string, RaisedReview>();
  for (const r of rows) if (!out.has(r.transactionId)) out.set(r.transactionId, r);
  return out;
}

export async function insertRaisedReview(input: { transactionId: string; amountCents: number; note: string }): Promise<void> {
  await db.insert(raisedRowReviews).values(input);
}

// The facts that can explain a ledger account's statement differences: its
// held rows answered "same purchase", with where the bank posted each and the
// date of the CSV row it pairs with; and its CSV rows raised after import,
// with the amount each came in with where that can be recovered.
export async function differenceFacts(ledgerAccountId: string): Promise<{ held: HeldFact[]; raised: RaisedFact[] }> {
  const banks = await db.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.ledgerAccountId, ledgerAccountId));
  const held: HeldFact[] = [];
  for (const b of banks) {
    const review = await boundaryReview(b.id);
    for (const r of review?.rows ?? []) {
      if (r.kind !== 'possible_duplicate' || r.resolution !== 'same' || !r.postedDate || !r.twinDate || !r.resolvedAt) continue;
      held.push({ postedDate: r.postedDate, twinDate: r.twinDate, amountCents: r.amountCents, answeredOn: r.resolvedAt.toISOString().slice(0, 10) });
    }
  }
  const csv = await db
    .select({
      date: transactions.date,
      amountCents: transactions.amountCents,
      source: transactions.source,
      accountLabel: transactions.accountLabel,
      descriptionRaw: transactions.descriptionRaw,
      dedupHash: transactions.dedupHash,
    })
    .from(transactions)
    .innerJoin(imports, eq(imports.id, transactions.importId))
    .where(and(eq(imports.ledgerAccountId, ledgerAccountId), isNull(transactions.deletedAt), sql`${transactions.dedupHash} is not null`));
  const raised: RaisedFact[] = [];
  for (const row of csv) {
    // Only a row edited since it came in: recovering an amount hashes every
    // amount below the current one, too many to try on every row.
    if (dedupHash(row) === row.dedupHash) continue;
    const original = importedAmountBelow({ ...row, dedupHash: row.dedupHash! });
    if (original !== null) raised.push({ date: row.date, originalCents: original, currentCents: row.amountCents });
  }
  return { held, raised };
}

// A row's current amount, for a keep-it-raised review; null when gone.
export async function liveAmountOf(transactionId: string): Promise<number | null> {
  const [row] = await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), isNull(transactions.deletedAt)));
  return row ? row.amountCents : null;
}
