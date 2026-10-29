// Slice 7 (REAL-ACCOUNTS.md): the cutover, the held possible duplicates, the
// boundary review, sign verification, re-issued accounts, and CSV imports
// after a bank is linked. Above everything: existing CSV rows are never
// deleted, modified, hidden from totals or duplicated.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, imports, ledgerAccounts, syncSkippedRows, transactions } from './schema';
import { getInsightRows, getTransactions, insertImport, insertTransaction, saveConnectionAccounts } from './queries';
import { boundaryReview, choicesFor, ledgerChoices, mapAccountToLedger } from './ledger';
import { account, owner, person, ptxn, row, split, sync, type TestAccount } from './test/fixtures';
import { adoptAccount, answerHeldRow, declineReissued, finishBoundaryReview, recordStatementCheck, setUpAccountSync } from '@/app/_actions/ledger';
import { setAccountSync } from '@/app/_actions/bank';
import { confirmImport } from '@/app/_actions/import';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
afterEach(() => vi.restoreAllMocks());

// A ledger account with CSV history: one import, rows on the given dates.
async function csvLedger(dates: { date: string; amountCents: number }[], basis: 'posted' | 'transaction' = 'transaction') {
  const tag = `L${randomUUID().slice(0, 8)}`;
  const [ledger] = await db
    .insert(ledgerAccounts)
    .values({ displayName: `Card ${tag}`, csvSource: 'discover', csvAccountLabel: tag, cutoverBasis: basis })
    .returning({ id: ledgerAccounts.id });
  const { importId } = await insertImport({ source: 'discover', filename: `${tag}.csv`, displayName: tag, rowCount: dates.length, ledgerAccountId: ledger.id });
  for (const [i, d] of dates.entries()) {
    await insertTransaction({ date: d.date, amountCents: d.amountCents, descriptionRaw: `${tag} CSV ${i}`, categoryId: null, source: 'discover', accountLabel: tag, importId });
  }
  return { ledgerId: ledger.id, tag };
}

// The CSV rows of a ledger account, every column, for before/after equality.
async function csvRowsOf(tag: string) {
  return db.select().from(transactions).where(eq(transactions.accountLabel, tag)).orderBy(transactions.date, transactions.descriptionRaw);
}

// A linked account, not yet mapped, sync off, unverified: as a new real one.
async function newAccount(): Promise<TestAccount> {
  const acc = await account();
  await db.update(bankAccounts).set({ syncEnabled: false, ledgerAccountId: null, verifiedAt: null }).where(eq(bankAccounts.id, acc.accountId));
  return acc;
}

describe('the cutover', () => {
  it('syncs only rows on or after it, sets the rest aside, and leaves every CSV row exactly as it was', async () => {
    const { ledgerId, tag } = await csvLedger([
      { date: '2026-09-01', amountCents: 12_000 },
      { date: '2026-09-10', amountCents: 4_750 },
    ]);
    const before = await csvRowsOf(tag);
    const acc = await newAccount();
    expect(await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null })).toEqual({
      ok: true,
      message: `Test Card syncs into Card ${tag} from 2026-09-11. Its CSV rows, to 2026-09-10, stay exactly as they are. Press Sync now to fetch it.`,
    });
    const old = ptxn(acc, { date: '2026-09-02', authorizedDate: '2026-09-01', amountCents: 12_000 });
    const fresh = ptxn(acc, { date: '2026-09-20', authorizedDate: '2026-09-19', amountCents: 3_300 });
    const outcome = await sync(acc, { added: [old, fresh] });
    expect(outcome).toMatchObject({ kind: 'applied', counts: { inserted: 1, beforeCutover: 1, held: 0 } });
    expect(await row(acc, old.providerTransactionId)).toBeUndefined();
    expect(await row(acc, fresh.providerTransactionId)).toBeDefined();
    expect(await csvRowsOf(tag)).toEqual(before);
    // A second sync re-sending the old row (as `modified`) still adds nothing.
    await sync(acc, { modified: [{ ...old, descriptionRaw: 'CHANGED' }] });
    expect(await row(acc, old.providerTransactionId)).toBeUndefined();
    expect(await csvRowsOf(tag)).toEqual(before);
  });

  it('cannot be set on or before the last CSV row, counting rows in undone imports', async () => {
    const { ledgerId, tag } = await csvLedger([{ date: '2026-09-10', amountCents: 4_750 }]);
    // A later row, deleted with an undone import: a Restore could bring it back.
    const { importId } = await insertImport({ source: 'discover', filename: `${tag}-2.csv`, displayName: tag, rowCount: 1, ledgerAccountId: ledgerId });
    await insertTransaction({ date: '2026-09-15', amountCents: 1_000, descriptionRaw: `${tag} UNDONE`, categoryId: null, source: 'discover', accountLabel: tag, importId });
    await db.update(transactions).set({ deletedAt: sql`now()` }).where(eq(transactions.importId, importId));
    expect((await ledgerChoices()).find((c) => c.id === ledgerId)?.lastCsvDate).toBe('2026-09-15');
    const acc = await newAccount();
    expect(await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: '2026-09-12' })).toEqual({
      error: 'The CSV history runs to 2026-09-15; a cutover on or before it would count those purchases twice.',
    });
    expect(await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null })).toMatchObject({ ok: true });
    const [l] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, ledgerId));
    expect(l.cutoverDate).toBe('2026-09-16');
  });

  it('an account cannot sync without a confirmed ledger account, and a new one is refused while CSV history waits for a bank', async () => {
    await csvLedger([{ date: '2026-09-10', amountCents: 4_750 }]);
    const acc = await newAccount();
    expect(await setAccountSync(acc.accountId, true)).toEqual({ error: 'Choose which ledger account it syncs into first, with Set up.' });
    expect(await setUpAccountSync(acc.accountId, { kind: 'new', displayName: 'Venture X', noCsvHistory: false })).toMatchObject({
      error: expect.stringMatching(/^CSV history is waiting for a bank in .*If this is one of them, choose it/),
    });
    expect(await setUpAccountSync(acc.accountId, { kind: 'new', displayName: 'Venture X', noCsvHistory: true })).toMatchObject({ ok: true });
    // A ledger account whose cutover is not confirmed applies nothing.
    const other = await newAccount();
    const { ledgerId } = await csvLedger([{ date: '2026-09-10', amountCents: 1 }]);
    await db.update(bankAccounts).set({ ledgerAccountId: ledgerId, syncEnabled: true }).where(eq(bankAccounts.id, other.accountId));
    expect(await sync(other, { added: [ptxn(other)] })).toEqual({
      kind: 'stopped',
      reason: 'This account has no confirmed ledger account and cutover yet; nothing was added.',
    });
  });

  it('can be corrected before the first sync; a ledger account the mistake created is dropped', async () => {
    const { ledgerId, tag } = await csvLedger([{ date: '2026-09-10', amountCents: 4_750 }]);
    const acc = await newAccount();
    const ledgerOf = async () =>
      (await db.select({ id: bankAccounts.ledgerAccountId }).from(bankAccounts).where(eq(bankAccounts.id, acc.accountId)))[0].id;
    expect(await setUpAccountSync(acc.accountId, { kind: 'new', displayName: `Wrong ${tag}`, noCsvHistory: true })).toMatchObject({ ok: true });
    const mistaken = (await ledgerOf())!;
    expect(await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null })).toMatchObject({ ok: true });
    expect(await ledgerOf()).toBe(ledgerId);
    expect(await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, mistaken))).toEqual([]);
    // A CSV ledger account left behind is kept: its history waits for a bank.
    expect(await setUpAccountSync(acc.accountId, { kind: 'new', displayName: `Other ${tag}`, noCsvHistory: true })).toMatchObject({ ok: true });
    expect(await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(eq(ledgerAccounts.id, ledgerId))).toEqual([{ id: ledgerId }]);
  });

  it('is fixed once the account has synced', async () => {
    const { ledgerId } = await csvLedger([{ date: '2026-09-10', amountCents: 4_750 }]);
    const acc = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null });
    await sync(acc, { added: [ptxn(acc, { date: '2026-09-20', authorizedDate: null })] });
    expect(await mapAccountToLedger(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: '2026-09-30' })).toEqual({
      error: 'This account has synced into its ledger account already; that mapping is fixed.',
    });
  });
});

describe('which ledger accounts an account can be set up into', () => {
  it('not one another live account syncs into; it becomes free once that login is removed', async () => {
    const live = await account();
    const acc = await newAccount();
    const offered = async (accountId: string) => choicesFor(await ledgerChoices(), accountId).map((c) => c.id);
    expect(await offered(acc.accountId)).not.toContain(live.ledgerAccountId);
    expect(await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: live.ledgerAccountId, cutoverDate: null })).toEqual({
      error: 'Test Card ••0000 belongs to another bank account.',
    });
    await db.execute(sql`update bank_connections set status = 'removed', removed_at = now(), access_token_sealed = null where id = ${live.connectionId}`);
    await db.update(bankAccounts).set({ syncEnabled: false }).where(eq(bankAccounts.id, live.accountId));
    expect(await offered(acc.accountId)).toContain(live.ledgerAccountId);
  });

  it('an account not yet synced is offered its own, to correct the cutover; no other account is', async () => {
    const { ledgerId } = await csvLedger([{ date: '2026-09-10', amountCents: 4_750 }]);
    const acc = await newAccount();
    const other = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: '2026-09-20' });
    const own = choicesFor(await ledgerChoices(), acc.accountId).find((c) => c.id === ledgerId);
    expect(own).toMatchObject({ cutoverDate: '2026-09-20', lastCsvDate: '2026-09-10', usedByAccountId: acc.accountId });
    expect(choicesFor(await ledgerChoices(), other.accountId).map((c) => c.id)).not.toContain(ledgerId);
    expect(await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: '2026-09-11' })).toMatchObject({ ok: true });
    expect((await db.select({ cutover: ledgerAccounts.cutoverDate }).from(ledgerAccounts).where(eq(ledgerAccounts.id, ledgerId)))[0].cutover).toBe('2026-09-11');
    // Once synced it is fixed, and no longer offered at all.
    await sync(acc, { added: [ptxn(acc, { date: '2026-09-20', authorizedDate: null })] });
    expect(choicesFor(await ledgerChoices(), acc.accountId).map((c) => c.id)).not.toContain(ledgerId);
  });
});

describe('possible duplicates near the cutover', () => {
  it('a purchase on the CSV that Plaid first sends dated after the cutover is held, not added; the owner decides', async () => {
    const { ledgerId, tag } = await csvLedger([{ date: '2026-09-10', amountCents: 4_750 }]);
    const before = await csvRowsOf(tag);
    const acc = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null });
    const same = ptxn(acc, { date: '2026-09-11', authorizedDate: null, amountCents: 4_750 });
    const other = ptxn(acc, { date: '2026-09-12', authorizedDate: null, amountCents: 4_750 });
    expect(await sync(acc, { added: [same, other] })).toMatchObject({ kind: 'applied', counts: { inserted: 1, held: 1 } });
    expect(await row(acc, same.providerTransactionId)).toBeUndefined();

    const review = await boundaryReview(acc.accountId);
    expect(review?.rows.map((r) => [r.kind, r.date, r.amountCents])).toEqual([
      ['csv', '2026-09-10', 4_750],
      ['possible_duplicate', '2026-09-11', 4_750],
    ]);
    expect(await answerHeldRow(acc.accountId, same.providerTransactionId, 'same')).toEqual({
      ok: true,
      message: 'Kept out: the same purchase as the CSV row.',
    });
    expect(await row(acc, same.providerTransactionId)).toBeUndefined();
    expect(await answerHeldRow(acc.accountId, same.providerTransactionId, 'released')).toEqual({ ok: true, message: 'Added as a purchase of its own.' });
    expect(await row(acc, same.providerTransactionId)).toMatchObject({ amountCents: 4_750, source: 'plaid' });
    expect(await answerHeldRow(acc.accountId, same.providerTransactionId, 'released')).toEqual({ error: 'That row was already added.' });
    expect(await csvRowsOf(tag)).toEqual(before);
  });
});

describe('the boundary review', () => {
  it('states that a same-merchant bank row differs in amount from its CSV row, both amounts, no cause', async () => {
    const tag = `L${randomUUID().slice(0, 8)}`;
    const [ledger] = await db
      .insert(ledgerAccounts)
      .values({ displayName: `Card ${tag}`, csvSource: 'discover', csvAccountLabel: tag, cutoverBasis: 'transaction' })
      .returning({ id: ledgerAccounts.id });
    const { importId } = await insertImport({ source: 'discover', filename: `${tag}.csv`, displayName: tag, rowCount: 2, ledgerAccountId: ledger.id });
    await insertTransaction({ date: '2026-09-09', amountCents: 120_000, descriptionRaw: 'SYNTHETIC CAR HIRE    SPRINGFIELD          IL', categoryId: null, source: 'discover', accountLabel: tag, importId });
    await insertTransaction({ date: '2026-09-10', amountCents: 31_000, descriptionRaw: 'SYNTHETIC AIRLINE 0010', categoryId: null, source: 'discover', accountLabel: tag, importId });
    const acc = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledger.id, cutoverDate: null });
    const car = ptxn(acc, { date: '2026-09-09', authorizedDate: null, amountCents: 110_000, descriptionRaw: 'SYNTHETIC CAR HIRE SPRINGFIELD IL' });
    const flight = ptxn(acc, { date: '2026-09-10', authorizedDate: null, amountCents: 31_000, descriptionRaw: 'SYNTHETIC AIRLINE 0010' });
    expect(await sync(acc, { added: [car, flight] })).toMatchObject({ kind: 'applied', counts: { beforeCutover: 2 } });
    const review = await boundaryReview(acc.accountId);
    const bank = (id: string) => review?.rows.find((r) => r.providerTransactionId === id);
    expect(bank(car.providerTransactionId)?.differsFrom).toEqual({ date: '2026-09-09', amountCents: 120_000 });
    expect(bank(flight.providerTransactionId)?.differsFrom).toBeNull();
  });


  it('reopens when a later sync holds a row after it was closed', async () => {
    const { ledgerId } = await csvLedger([
      { date: '2026-09-10', amountCents: 6_125 },
      { date: '2026-09-09', amountCents: 2_375 },
    ]);
    const acc = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null });
    // Plaid's first 30 days: nothing near the cutover.
    expect(await sync(acc, { added: [ptxn(acc, { date: '2026-10-01', authorizedDate: null, amountCents: 900 })] })).toMatchObject({ kind: 'applied', counts: { held: 0 } });
    expect(await finishBoundaryReview(acc.accountId)).toMatchObject({ ok: true });
    const reviewedAt = async () =>
      (await db.select({ at: bankAccounts.boundaryReviewedAt }).from(bankAccounts).where(eq(bankAccounts.id, acc.accountId)))[0].at;
    expect(await reviewedAt()).not.toBeNull();
    // The older history arrives later, with a possible duplicate in it.
    const late = ptxn(acc, { date: '2026-09-11', authorizedDate: null, amountCents: 6_125 });
    expect(await sync(acc, { added: [late] })).toMatchObject({ kind: 'applied', counts: { held: 1 } });
    expect(await reviewedAt()).toBeNull();
    const review = await boundaryReview(acc.accountId);
    expect(review?.rows.filter((r) => r.kind === 'possible_duplicate').map((r) => r.providerTransactionId)).toEqual([late.providerTransactionId]);
  });
});

describe('sign verification', () => {
  it('until verified, synced rows are not splittable and in no total; CSV rows count as always', async () => {
    // Amounts no other test uses: the database is shared by every test file.
    const { ledgerId, tag } = await csvLedger([{ date: '2026-09-10', amountCents: 4_731 }]);
    const acc = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null });
    const t = ptxn(acc, { date: '2026-09-20', authorizedDate: null, amountCents: 61_237 });
    await sync(acc, { added: [t] });
    const syncedId = (await row(acc, t.providerTransactionId)).id;
    const synced = (await getTransactions()).find((r) => r.id === syncedId)!;
    const csv = (await getTransactions()).find((r) => r.descriptionRaw.startsWith(`${tag} CSV`))!;
    expect(synced).toMatchObject({ unverified: true, isSplittable: false });
    expect(csv).toMatchObject({ unverified: false, isSplittable: true });
    const o = await owner();
    await expect(split(synced.id, 61_237, [{ personId: o, amountCents: 61_237 }])).rejects.toThrow(/not verified against a statement/);
    const insightAmounts = (await getInsightRows()).map((r) => r.amountCents);
    expect(insightAmounts).toContain(4_731);
    expect(insightAmounts).not.toContain(61_237);
  });

  it('is recorded only when the totals match to the cent; a failed check turns sync off', async () => {
    const acc = await account();
    await db.update(bankAccounts).set({ verifiedAt: null }).where(eq(bankAccounts.id, acc.accountId));
    await sync(acc, {
      added: [
        ptxn(acc, { date: '2026-10-03', amountCents: 25_000 }),
        ptxn(acc, { date: '2026-10-08', amountCents: -100_000, descriptionRaw: 'PAYMENT THANK YOU' }),
      ],
    });
    const statement = { from: '2026-10-01', to: '2026-10-31', charges: '25.00', credits: '100.00', excludedKeys: [], confirmed: true };
    expect(await recordStatementCheck(acc.accountId, { ...statement, charges: '25.01' }, 'pass')).toEqual({
      error: 'This does not match the statement yet; nothing was recorded.',
    });
    expect(await recordStatementCheck(acc.accountId, statement, 'pass')).toMatchObject({ ok: true });
    const [verified] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, acc.accountId));
    expect(verified.verifiedAt).not.toBeNull();
    expect(await recordStatementCheck(acc.accountId, statement, 'fail')).toMatchObject({ ok: true, warning: expect.stringMatching(/Sync is off/) });
    const [failed] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, acc.accountId));
    expect(failed).toMatchObject({ verifiedAt: null, syncEnabled: false });
  });
});

describe('sign verification on a checking account', () => {
  it('compares withdrawals and deposits; a statement read with the signs the other way round does not pass', async () => {
    const acc = await account();
    await db.update(bankAccounts).set({ verifiedAt: null, type: 'depository', subtype: 'checking' }).where(eq(bankAccounts.id, acc.accountId));
    await sync(acc, {
      added: [
        ptxn(acc, { date: '2026-10-02', amountCents: 41_250, descriptionRaw: 'DEBIT CARD PURCHASE' }),
        ptxn(acc, { date: '2026-10-05', amountCents: 150_000, descriptionRaw: 'ZELLE PAYMENT TO A FRIEND' }),
        ptxn(acc, { date: '2026-10-15', amountCents: -2_180_420, descriptionRaw: 'PAYROLL DIRECT DEPOSIT' }),
      ],
    });
    // Withdrawals: money out, positive from the bank. Deposits: money in, negative.
    const statement = { from: '2026-10-01', to: '2026-10-31', charges: '191.25', credits: '2180.42', excludedKeys: [], confirmed: true };
    // Totals entered the other way round, as a sign flip would make them match.
    expect(await recordStatementCheck(acc.accountId, { ...statement, charges: '2180.42', credits: '191.25' }, 'pass')).toEqual({
      error: 'This does not match the statement yet; nothing was recorded.',
    });
    expect(await recordStatementCheck(acc.accountId, statement, 'pass')).toMatchObject({ ok: true });
    const [verified] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, acc.accountId));
    expect(verified.verifiedAt).not.toBeNull();
  });
});

describe('re-issued accounts', () => {
  it('cannot sync until adopted; adopting continues the same ledger account after the old rows, with nothing counted twice', async () => {
    const acc = await account('acc-before');
    await db.update(bankAccounts).set({ persistentAccountId: 'persist-r' }).where(eq(bankAccounts.id, acc.accountId));
    const kept = ptxn(acc, { date: '2026-09-05', authorizedDate: null, amountCents: 5_000 });
    await sync(acc, { added: [kept] });
    await saveConnectionAccounts({
      connectionId: acc.connectionId,
      institutionId: 'ins_3',
      institutionName: 'Chase',
      accounts: [{ providerAccountId: 'acc-after', persistentAccountId: 'persist-r', name: 'Test Card', officialName: null, mask: '0000', type: 'credit', subtype: null }],
    });
    const [reissued] = await db.select().from(bankAccounts).where(eq(bankAccounts.providerAccountId, 'acc-after'));
    expect(await setAccountSync(reissued.id, true)).toMatchObject({ error: expect.stringMatching(/under a new id/) });
    expect(await adoptAccount(reissued.id)).toMatchObject({ ok: true, message: expect.stringMatching(/from 2026-09-06/) });
    const [after] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, reissued.id));
    expect(after).toMatchObject({ ledgerAccountId: acc.ledgerAccountId, syncEnabled: true, replacesAccountId: null });
    const next = { ...acc, accountId: reissued.id, providerAccountId: 'acc-after' };
    // The same history, under the new id: the old part is set aside.
    const again = ptxn(next, { date: '2026-09-05', authorizedDate: null, amountCents: 5_000 });
    const later = ptxn(next, { date: '2026-09-20', authorizedDate: null, amountCents: 7_000 });
    expect(await sync(next, { added: [again, later] })).toMatchObject({ counts: { inserted: 1, beforeCutover: 1 } });
    expect(await row(acc, kept.providerTransactionId)).toBeDefined();
  });

  it('the owner can say it is a different account; it is then set up like any other', async () => {
    const acc = await account('acc-a1');
    await saveConnectionAccounts({
      connectionId: acc.connectionId,
      institutionId: 'ins_4',
      institutionName: 'Amex',
      accounts: [{ providerAccountId: 'acc-a2', persistentAccountId: null, name: 'Test Card', officialName: null, mask: '0000', type: 'credit', subtype: null }],
    });
    const [candidate] = await db.select().from(bankAccounts).where(and(eq(bankAccounts.connectionId, acc.connectionId), eq(bankAccounts.providerAccountId, 'acc-a2')));
    expect(candidate.replacesAccountId).toBe(acc.accountId);
    expect(await declineReissued(candidate.id)).toMatchObject({ ok: true });
    expect(await setAccountSync(candidate.id, true)).toEqual({ error: 'Choose which ledger account it syncs into first, with Set up.' });
  });
});

describe('a CSV imported after a bank is linked', () => {
  it('leaves out the rows the bank already syncs, from the cutover on', async () => {
    // The import's own ledger account: Chase, no account label.
    const csv = (rows: [string, string, string][]) =>
      ['Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #', ...rows.map(([d, desc, amt]) => `DEBIT,${d},"${desc}",${amt},DEBIT_CARD,0,,`)].join('\n');
    const upload = (text: string) => {
      const fd = new FormData();
      fd.set('file', new File([text], 'chase-test.csv', { type: 'text/csv' }));
      return fd;
    };
    const tag = randomUUID().slice(0, 6).toUpperCase();
    expect(await confirmImport({}, upload(csv([['09/01/2026', `CHASE ${tag} A`, '-10.00']])))).toMatchObject({ ok: true });
    const [ledger] = await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.csvSource, 'chase'), sql`${ledgerAccounts.csvAccountLabel} is null`));
    expect(ledger.cutoverBasis).toBe('posted');
    const acc = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledger.id, cutoverDate: '2026-09-15' });
    const result = await confirmImport({}, upload(csv([['09/10/2026', `CHASE ${tag} B`, '-11.00'], ['09/15/2026', `CHASE ${tag} C`, '-12.00']])));
    expect(result).toEqual({ ok: true, result: { inserted: 1, skipped: 0, forced: 0, covered: 1 } });
    const mine = (await getTransactions()).filter((t) => t.descriptionRaw.startsWith(`CHASE ${tag}`)).map((t) => t.descriptionRaw).sort();
    expect(mine).toEqual([`CHASE ${tag} A`, `CHASE ${tag} B`]);
    // The batch is named and counted from what it imported, not the file.
    const [batch] = await db
      .select({ name: imports.displayName, rows: imports.rowCount })
      .from(imports)
      .innerJoin(transactions, eq(transactions.importId, imports.id))
      .where(eq(transactions.descriptionRaw, `CHASE ${tag} B`));
    expect(batch).toEqual({ name: 'Chase 09/10 – 09/10', rows: 1 });
    const batches = await db.select({ ledger: imports.ledgerAccountId }).from(imports).where(inArray(imports.filename, ['chase-test.csv']));
    expect(new Set(batches.map((b) => b.ledger))).toEqual(new Set([ledger.id]));
    // The Chase ledger account is shared by every test file's Chase imports;
    // leave it with no bank, so no later test's rows are left out as covered.
    await db.update(bankAccounts).set({ syncEnabled: false, ledgerAccountId: null }).where(eq(bankAccounts.id, acc.accountId));
  });
});

describe('a re-import that overlaps an earlier one', () => {
  it('is named after the rows it imported, not the duplicates it skipped', async () => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const file = (rows: [string, string, string][]) => {
      const text = ['Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #', ...rows.map(([d, desc, amt]) => `DEBIT,${d},"${desc}",${amt},DEBIT_CARD,0,,`)].join('\n');
      const fd = new FormData();
      fd.set('file', new File([text], `chase-${tag}.csv`, { type: 'text/csv' }));
      return fd;
    };
    await confirmImport({}, file([['08/01/2026', `CHASE ${tag} A`, '-21.00'], ['08/05/2026', `CHASE ${tag} B`, '-22.00']]));
    const result = await confirmImport({}, file([['08/05/2026', `CHASE ${tag} B`, '-22.00'], ['08/09/2026', `CHASE ${tag} C`, '-23.00']]));
    expect(result).toEqual({ ok: true, result: { inserted: 1, skipped: 1, forced: 0, covered: 0 } });
    const [batch] = await db
      .select({ name: imports.displayName, rows: imports.rowCount })
      .from(imports)
      .innerJoin(transactions, eq(transactions.importId, imports.id))
      .where(eq(transactions.descriptionRaw, `CHASE ${tag} C`));
    expect(batch).toEqual({ name: 'Chase 08/09 – 08/09', rows: 1 });
  });
});

describe('nothing here touches people or balances', () => {
  it('a sync with a cutover writes no split, share or settlement', async () => {
    await person('Unrelated');
    const { ledgerId } = await csvLedger([{ date: '2026-09-10', amountCents: 4_750 }]);
    const acc = await newAccount();
    await setUpAccountSync(acc.accountId, { kind: 'existing', ledgerAccountId: ledgerId, cutoverDate: null });
    const counts = async () => (await db.execute(sql`select (select count(*) from splits) s, (select count(*) from split_shares) sh, (select count(*) from settlements) st`)) as unknown;
    const before = await counts();
    await sync(acc, { added: [ptxn(acc, { date: '2026-09-02', authorizedDate: null }), ptxn(acc, { date: '2026-09-25', authorizedDate: null })] });
    expect(await counts()).toEqual(before);
    expect(await db.select().from(syncSkippedRows).where(eq(syncSkippedRows.bankAccountId, acc.accountId))).toHaveLength(1);
  });
});
