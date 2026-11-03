import 'server-only';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts } from './schema';
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
