import 'server-only';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, categories, receiptItems, receipts, transactions } from './schema';
import { SAMPLE_DINNER } from '@/lib/demo/catalog';
import { getAllPersons } from './queries';
import { buildDemoSeed, seedDayFromOwnerCreatedAt, type DemoSeed } from '@/lib/demo/seed';
import { createSyntheticProvider } from '@/lib/bank-sync/synthetic/provider';
import type { BankProvider } from '@/lib/bank-sync/provider';

// The demo's seed, rebuilt for the day its ledger was built (recovered from
// the owner row, as the sample statement is): the synthetic bank's feeds and
// the statements the verify page offers come from it. Null when the demo has
// no data (before its first reset).
export async function currentDemoSeed(): Promise<DemoSeed | null> {
  const owner = (await getAllPersons()).find((p) => p.isOwner);
  return owner ? buildDemoSeed(seedDayFromOwnerCreatedAt(owner.createdAt)) : null;
}

export async function demoBankProvider(): Promise<BankProvider> {
  const seed = await currentDemoSeed();
  if (!seed) throw new Error('The demo has no data yet; reset it.');
  return createSyntheticProvider({ day: seed.today, items: seed.bankItems });
}

// The demo account still awaiting its statement check, for the first-visit
// strip's link (Chase checking until a visitor verifies it). Null once none.
export async function demoUnverifiedAccountId(): Promise<string | null> {
  const [row] = await db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(and(isNull(bankAccounts.verifiedAt), eq(bankAccounts.syncEnabled, true)))
    .orderBy(asc(bankAccounts.createdAt), asc(bankAccounts.id))
    .limit(1);
  return row?.id ?? null;
}

// Older demo ledgers already contain restaurant receipts. Prefer the walkthrough
// as soon as a daily reset has seeded it, and still offer dinner if it was removed.
export async function demoDinnerTransactionId(): Promise<string | null> {
  const [row] = await db.select({ id: transactions.id }).from(transactions)
    .innerJoin(receipts, eq(receipts.transactionId, transactions.id))
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(
      eq(categories.name, 'Dining'), eq(categories.isSplittable, true),
      isNull(transactions.deletedAt), isNull(transactions.bankAccountId), eq(transactions.pending, false),
      sql`${transactions.amountCents} > 0`,
      sql`exists (select 1 from ${receiptItems} where ${receiptItems.receiptId} = ${receipts.id})`,
    ))
    .orderBy(desc(sql`${transactions.descriptionRaw} = ${SAMPLE_DINNER}`), desc(transactions.date), asc(transactions.id))
    .limit(1);
  return row?.id ?? null;
}
