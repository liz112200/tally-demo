// Builders for the database tests. Each test makes its own account and
// people, so tests share a database without depending on each other.
import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../index';
import { bankAccounts, bankConnections, categories, ledgerAccounts, persons, transactions } from '../schema';
import {
  commitAccountSync,
  getDebtShares,
  getSettlements,
  replaceSplit,
  type AccountSyncOutcome,
} from '../queries';
import { computeBidirectionalBalances } from '@/lib/balances';
import { toCents } from '@/lib/money';
import type { BankProvider, ProviderTransaction, RemovedTransaction } from '@/lib/bank-sync/provider';

export async function owner(): Promise<string> {
  const [existing] = await db.select({ id: persons.id }).from(persons).where(eq(persons.isOwner, true));
  if (existing) return existing.id;
  const [row] = await db.insert(persons).values({ name: 'Owner', isOwner: true }).returning({ id: persons.id });
  return row.id;
}

export async function person(name: string): Promise<string> {
  const [row] = await db.insert(persons).values({ name }).returning({ id: persons.id });
  return row.id;
}

export async function category(
  name: string,
  flags: { isSplittable: boolean; countsAsSpending: boolean } = { isSplittable: true, countsAsSpending: true },
): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({ name: `${name} ${randomUUID().slice(0, 8)}`, ...flags })
    .returning({ id: categories.id });
  return row.id;
}

export type TestAccount = {
  connectionId: string;
  providerItemId: string;
  accountId: string;
  providerAccountId: string;
  ledgerAccountId: string;
};

// A linked account with syncing on, in a ledger account of its own with no CSV
// history (no cutover, confirmed), as every account synced before slice 7, and
// verified against a statement, so its rows count; db/ledger.dbtest.ts makes
// unverified ones explicitly.
// The sealed token is a placeholder: these tests drive the commit directly or
// inject a provider, so it is never opened.
export async function account(providerAccountId = `acc-${randomUUID()}`): Promise<TestAccount> {
  const providerItemId = `item-${randomUUID()}`;
  const [connection] = await db
    .insert(bankConnections)
    .values({ provider: 'plaid', providerItemId, accessTokenSealed: 'v1:test:not:a-token' })
    .returning({ id: bankConnections.id });
  const [ledger] = await db
    .insert(ledgerAccounts)
    .values({ displayName: 'Test Card ••0000', cutoverConfirmedAt: new Date() })
    .returning({ id: ledgerAccounts.id });
  const [acc] = await db
    .insert(bankAccounts)
    .values({
      connectionId: connection.id,
      providerAccountId,
      name: 'Test Card',
      mask: '0000',
      type: 'credit',
      syncEnabled: true,
      ledgerAccountId: ledger.id,
      verifiedAt: new Date(),
    })
    .returning({ id: bankAccounts.id });
  return { connectionId: connection.id, providerItemId, accountId: acc.id, providerAccountId, ledgerAccountId: ledger.id };
}

let counter = 0;
export function ptxn(acc: TestAccount, overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  counter += 1;
  const id = overrides.providerTransactionId ?? `t-${counter}-${randomUUID().slice(0, 8)}`;
  return {
    providerTransactionId: id,
    providerAccountId: acc.providerAccountId,
    amountCents: 90_000,
    isoCurrencyCode: 'USD',
    unofficialCurrencyCode: null,
    date: '2026-10-10',
    authorizedDate: '2026-10-09',
    descriptionRaw: `DINER ${counter}`,
    pending: false,
    pendingTransactionId: null,
    raw: { transaction_id: id },
    ...overrides,
  };
}

export const removal = (acc: TestAccount, id: string): RemovedTransaction => ({
  providerTransactionId: id,
  providerAccountId: acc.providerAccountId,
});

// One commit, from the account's current cursor to a fresh one.
export async function sync(
  acc: TestAccount,
  changes: { added?: ProviderTransaction[]; modified?: ProviderTransaction[]; removed?: RemovedTransaction[] },
): Promise<AccountSyncOutcome> {
  const [{ cursor }] = await db
    .select({ cursor: bankAccounts.syncCursor })
    .from(bankAccounts)
    .where(eq(bankAccounts.id, acc.accountId));
  return commitAccountSync({
    connectionId: acc.connectionId,
    accountId: acc.accountId,
    providerAccountId: acc.providerAccountId,
    startCursor: cursor,
    nextCursor: `cursor-${randomUUID()}`,
    added: changes.added ?? [],
    modified: changes.modified ?? [],
    removed: changes.removed ?? [],
    rules: [],
  });
}

export async function row(acc: TestAccount, providerTransactionId: string) {
  const [r] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.bankAccountId, acc.accountId), eq(transactions.providerTransactionId, providerTransactionId)));
  return r;
}

export async function rowById(id: string) {
  const [r] = await db.select().from(transactions).where(eq(transactions.id, id));
  return r;
}

// An equal split computed by hand: shares in the given order, summing to the
// row's amount exactly (the caller supplies amounts that do).
export async function split(
  transactionId: string,
  amountCents: number,
  shares: { personId: string; amountCents: number }[],
) {
  const result = await replaceSplit({
    transactionId,
    amountCents,
    payerPersonId: await owner(),
    method: 'equal',
    taxCents: 0,
    tipCents: 0,
    shares: shares.map((s) => ({ ...s, inputAmountCents: null, inputPercent: null })),
  });
  if ('error' in result) throw new Error(result.error);
}

// Everything that money between people is made of, in a comparable form:
// every split, share, settlement and allocation row, and each person's
// balance and unallocated credit as the app derives them.
export async function moneySnapshot() {
  const tables = {
    splits: await db.execute(sql`select id, transaction_id, payer_person_id, method, tax_cents, tip_cents from splits order by id`),
    shares: await db.execute(sql`select id, split_id, person_id, amount_cents from split_shares order by id`),
    settlements: await db.execute(sql`select id, person_id, amount_cents, direction, group_id, is_offset from settlements order by id`),
    allocations: await db.execute(sql`select settlement_id, split_share_id, amount_cents from settlement_allocations order by settlement_id, split_share_id`),
  };
  const balances = computeBidirectionalBalances(
    (await getDebtShares()).map((s) => ({
      shareId: s.shareId,
      counterpartyId: s.counterpartyId,
      direction: s.direction,
      amountCents: toCents(s.amountCents),
      allocatedCents: toCents(s.allocatedCents),
    })),
  ).sort((a, b) => a.personId.localeCompare(b.personId));
  const credit = (await getSettlements())
    .map((s) => ({ id: s.id, unallocatedCents: s.unallocatedCents }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { tables, balances, credit };
}

export function balanceOf(snapshot: Awaited<ReturnType<typeof moneySnapshot>>, personId: string) {
  return snapshot.balances.find((b) => b.personId === personId);
}

export function creditOf(snapshot: Awaited<ReturnType<typeof moneySnapshot>>, settlementId: string) {
  return snapshot.credit.find((c) => c.id === settlementId)?.unallocatedCents;
}

// A provider that reports the account's Item healthy and serves `fetched` (or
// fails) for each account; for tests that inject the sync's provider.
export function fakeProvider(
  acc: Pick<TestAccount, 'providerItemId'>,
  parts: Partial<Pick<BankProvider, 'getItem' | 'syncTransactions' | 'removeItem'>>,
): BankProvider {
  return {
    name: 'plaid',
    getItem: async () => ({ itemId: acc.providerItemId, institutionId: 'ins_109508', institutionName: 'First Platypus Bank', errorCode: null, consentExpiresAt: null }),
    syncTransactions: async () => {
      throw new Error('fakeProvider: no syncTransactions given');
    },
    removeItem: async () => {},
    ...parts,
  } as BankProvider;
}
