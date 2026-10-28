// What the server refuses whatever the page sent: a stale page or a forged
// request gets a message, never a raw error and never a change.
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from './index';
import { bankAccounts, bankConnections, categorizationRules, receipts, transactions } from './schema';
import {
  applyRulesToExisting,
  bulkUpdateTransactionCategory,
  clearBankFlag,
  getInsightRows,
  getTransactionForSplit,
  getTransactions,
  insertRule,
  insertTransaction,
  moveBuiltOnToReplacement,
  replaceSplit,
  softDeleteTransactionById,
  updateTransactionCategory,
  updateTransactionDetailsById,
} from './queries';
import { postgresCode } from '@/lib/postgres-error';
import { account, category, owner, person, ptxn, removal, row, rowById, split, sync } from './test/fixtures';

async function syncedRow(amountCents = 40_000, overrides: Parameters<typeof ptxn>[1] = {}) {
  const acc = await account();
  const t = ptxn(acc, { amountCents, ...overrides });
  await sync(acc, { added: [t] });
  return { acc, t, r: await row(acc, t.providerTransactionId) };
}

async function halves(id: string, amountCents: number) {
  const o = await owner();
  const alex = await person('Alex');
  await split(id, amountCents, [
    { personId: o, amountCents: amountCents / 2 },
    { personId: alex, amountCents: amountCents / 2 },
  ]);
}

describe('split saves', () => {
  const input = async (transactionId: string, amountCents: number) => ({
    transactionId,
    amountCents,
    payerPersonId: await owner(),
    method: 'equal' as const,
    taxCents: 0,
    tipCents: 0,
    shares: [{ personId: await owner(), amountCents, inputAmountCents: null, inputPercent: null }],
  });

  it('refuse a pending row, and the read path calls it unsplittable', async () => {
    const { r } = await syncedRow(40_000, { pending: true });
    expect(await getTransactionForSplit(r.id)).toMatchObject({ pending: true, isSplittable: false });
    expect(await replaceSplit(await input(r.id, 40_000))).toEqual({
      error: 'Pending transactions can be split once they post.',
    });
  });

  it('refuse shares computed from an amount the row no longer has', async () => {
    const { r } = await syncedRow(40_000);
    expect(await replaceSplit(await input(r.id, 39_000))).toEqual({
      error: 'The bank changed this transaction while the split was open. Reopen it and save again.',
    });
  });

  it('refuse a deleted row', async () => {
    const { r } = await syncedRow(40_000);
    await softDeleteTransactionById(r.id);
    expect(await replaceSplit(await input(r.id, 40_000))).toEqual({ error: 'Transaction not found' });
  });
});

describe('synced rows are the bank\'s', () => {
  it('date, amount and description cannot be edited; a CSV or manual row still can', async () => {
    const { r } = await syncedRow(40_000);
    expect(await updateTransactionDetailsById(r.id, { date: '2026-01-01', amountCents: 1, descriptionRaw: 'X' })).toBe(false);
    expect(await rowById(r.id)).toMatchObject({ amountCents: 40_000, date: r.date, descriptionRaw: r.descriptionRaw });

    // Found by its own description: the database is shared by every test file,
    // and another file's rows can have the same amount.
    const description = `MANUAL ${randomUUID()}`;
    await insertTransaction({ date: '2026-10-01', amountCents: 5_000, descriptionRaw: description, categoryId: null });
    const [manual] = await db.select().from(transactions).where(eq(transactions.descriptionRaw, description));
    expect(await updateTransactionDetailsById(manual.id, { date: '2026-10-02', amountCents: 6_000, descriptionRaw: 'EDITED' })).toBe(true);
  });

  it('only synced rows can carry bank state (CHECK)', async () => {
    let code: string | null = null;
    try {
      await db.insert(transactions).values({
        date: '2026-10-01',
        amountCents: 1_000,
        descriptionRaw: 'MANUAL PENDING',
        merchantNormalized: 'MANUAL PENDING',
        dedupHash: randomUUID(),
        pending: true,
      });
    } catch (err) {
      code = postgresCode(err);
    }
    expect(code).toBe('23514');
  });
});

describe('a split row stays splittable', () => {
  it('a manual category change into a non-splittable category is refused on a split row, allowed elsewhere', async () => {
    const xfer = await category('Xfer', { isSplittable: false, countsAsSpending: false });
    const dining = await category('Dining');
    const { r: splitRow } = await syncedRow(40_000);
    await halves(splitRow.id, 40_000);
    const { r: plain } = await syncedRow(40_000);

    const refused = await updateTransactionCategory(splitRow.id, xfer);
    expect(refused).toEqual({ error: expect.stringMatching(/^Xfer .* can't hold a split\. Remove the split first\.$/) });
    expect((await rowById(splitRow.id)).categoryId).toBeNull();
    expect(await updateTransactionCategory(splitRow.id, dining)).toEqual({ ok: true });
    expect(await updateTransactionCategory(plain.id, xfer)).toEqual({ ok: true });
    expect(await rowById(plain.id)).toMatchObject({ categoryId: xfer, categorySource: 'manual' });
  });

  it('bulk: refused as a whole when any selected row has a split', async () => {
    const xfer = await category('Xfer', { isSplittable: false, countsAsSpending: false });
    const { r: splitRow } = await syncedRow(40_000);
    await halves(splitRow.id, 40_000);
    const { r: plain } = await syncedRow(40_000);
    expect(await bulkUpdateTransactionCategory([splitRow.id, plain.id], xfer)).toEqual({
      error: expect.stringMatching(/^1 of the selected rows have a split/),
    });
    expect((await rowById(plain.id)).categoryId).toBeNull();
  });

  it('the retroactive rule apply leaves a split row out of a non-splittable category and moves the rest', async () => {
    const xfer = await category('Xfer', { isSplittable: false, countsAsSpending: false });
    const tag = `RULEGAP${randomUUID().slice(0, 8).toUpperCase()}`;
    const { r: splitRow } = await syncedRow(40_000, { descriptionRaw: `${tag} PAYMENT A` });
    await halves(splitRow.id, 40_000);
    const { r: plain } = await syncedRow(40_000, { descriptionRaw: `${tag} PAYMENT B` });
    await insertRule({ matchPattern: tag, matchType: 'substring', categoryId: xfer, priority: 1 });
    try {
      await applyRulesToExisting();
      expect(await rowById(splitRow.id)).toMatchObject({ categoryId: null, categorySource: null });
      expect(await rowById(plain.id)).toMatchObject({ categoryId: xfer, categorySource: 'rule' });
    } finally {
      await db.delete(categorizationRules).where(eq(categorizationRules.matchPattern, tag));
    }
  });
});

describe('resolving flags on rows that changed since the page loaded', () => {
  async function removedSplitRow() {
    const { acc, t, r } = await syncedRow(40_000);
    await halves(r.id, 40_000);
    await sync(acc, { removed: [removal(acc, t.providerTransactionId)] });
    return { acc, t, r };
  }

  it('move refuses every unfit target, and a source no longer flagged', async () => {
    const { acc, r } = await removedSplitRow();
    const sibling = async (o: Parameters<typeof ptxn>[1] = {}) => {
      const t = ptxn(acc, { amountCents: 40_000, ...o });
      await sync(acc, { added: [t] });
      return row(acc, t.providerTransactionId);
    };
    const other = (await syncedRow(40_000)).r;
    const pending = await sibling({ pending: true });
    const differentAmount = await sibling({ amountCents: 41_000 });
    const farAway = await sibling({ authorizedDate: '2026-11-30' });
    const alreadySplit = await sibling();
    await halves(alreadySplit.id, 40_000);
    const withReceipt = await sibling();
    await db.insert(receipts).values({ transactionId: withReceipt.id, blobUrl: 'https://example.invalid/r.jpg' });
    const deleted = await sibling();
    await softDeleteTransactionById(deleted.id);

    const reason = async (to: string) => {
      const result = await moveBuiltOnToReplacement(r.id, to);
      return 'error' in result ? result.error : 'ok';
    };
    expect(await reason(other.id)).toMatch(/in a different account/);
    expect(await reason(pending.id)).toMatch(/still pending/);
    expect(await reason(differentAmount.id)).toMatch(/amount differs/);
    expect(await reason(farAway.id)).toMatch(/more than 7 days away/);
    expect(await reason(alreadySplit.id)).toMatch(/already has a split/);
    expect(await reason(withReceipt.id)).toMatch(/already has a receipt/);
    expect(await reason(deleted.id)).toBe('That transaction no longer exists.');
    expect(await reason(r.id)).toBe('Choose a different transaction.');

    await clearBankFlag(r.id, 'removed');
    const fine = await sibling();
    expect(await reason(fine.id)).toBe('This row is no longer flagged as removed by the bank.');
  });

  it('move refuses a target categorized as non-splittable', async () => {
    const xfer = await category('Xfer', { isSplittable: false, countsAsSpending: false });
    const { acc, r } = await removedSplitRow();
    const t = ptxn(acc, { amountCents: 40_000 });
    await sync(acc, { added: [t] });
    const target = await row(acc, t.providerTransactionId);
    await updateTransactionCategory(target.id, xfer);
    expect(await moveBuiltOnToReplacement(r.id, target.id)).toEqual({
      error: expect.stringMatching(/categorized Xfer .*, which can't hold a split\./),
    });
  });

  it('dismissing on a deleted row changes nothing', async () => {
    const { acc, t, r } = await syncedRow(40_000);
    await halves(r.id, 40_000);
    await sync(acc, { modified: [{ ...t, amountCents: 50_000 }] });
    await softDeleteTransactionById(r.id);
    await clearBankFlag(r.id, 'amount');
    expect((await rowById(r.id)).bankAmountBeforeCents).toBe(40_000);
  });
});

describe('pending rows are provisional', () => {
  it('are left out of Insights, listed in Expenses as pending and unsplittable, and counted once posted', async () => {
    const tag = `PENDINGCHECK${randomUUID().slice(0, 8).toUpperCase()}`;
    const acc = await account();
    const hold = ptxn(acc, { pending: true, descriptionRaw: `${tag} HOLD` });
    await sync(acc, { added: [hold] });
    const inInsights = async () => (await getInsightRows()).filter((r) => r.merchantNormalized.startsWith(tag)).length;
    expect(await inInsights()).toBe(0);
    const listed = (await getTransactions()).find((t) => t.descriptionRaw.startsWith(tag));
    expect(listed).toMatchObject({ pending: true, isSplittable: false });

    await sync(acc, {
      added: [ptxn(acc, { descriptionRaw: `${tag} POSTED`, pendingTransactionId: hold.providerTransactionId })],
      removed: [removal(acc, hold.providerTransactionId)],
    });
    expect(await inInsights()).toBe(1);
    expect((await getTransactions()).find((t) => t.id === listed!.id)).toMatchObject({ pending: false, isSplittable: true });
  });
});


describe('connection state (migration 0024)', () => {
  const refused = async (p: Promise<unknown>) => postgresCode(await p.then(() => null, (e: unknown) => e));

  it('a removed connection has no token and a removal time, and an active one has a token', async () => {
    const { connectionId: id } = await account();
    const conn = eq(bankConnections.id, id);
    expect(await refused(db.update(bankConnections).set({ status: 'removed' }).where(conn))).toBe('23514');
    expect(await refused(db.update(bankConnections).set({ accessTokenSealed: null }).where(conn))).toBe('23514');
    expect(
      await refused(db.update(bankConnections).set({ status: 'removed', accessTokenSealed: null }).where(conn)),
    ).toBe('23514');
    await db.update(bankConnections).set({ status: 'removed', accessTokenSealed: null, removedAt: new Date() }).where(conn);
  });

  it('a removed connection cannot come back, and no connection row can be deleted', async () => {
    const { connectionId: id } = await account();
    const conn = eq(bankConnections.id, id);
    await db.update(bankConnections).set({ status: 'removed', accessTokenSealed: null, removedAt: new Date() }).where(conn);
    expect(await refused(db.update(bankConnections).set({ status: 'active' }).where(conn))).toBe('23514');
    expect(await refused(db.update(bankConnections).set({ status: 'paused' }).where(conn))).toBe('23514');
    await db.delete(bankAccounts).where(eq(bankAccounts.connectionId, id));
    expect(await refused(db.delete(bankConnections).where(conn))).toBe('P0001');
  });

  it('an account the provider no longer returns cannot sync', async () => {
    const { accountId } = await account();
    expect(
      await refused(db.update(bankAccounts).set({ unsharedAt: new Date() }).where(eq(bankAccounts.id, accountId))),
    ).toBe('23514');
    await db.update(bankAccounts).set({ unsharedAt: new Date(), syncEnabled: false }).where(eq(bankAccounts.id, accountId));
    expect(
      await refused(db.update(bankAccounts).set({ syncEnabled: true }).where(eq(bankAccounts.id, accountId))),
    ).toBe('23514');
  });
});
