// Reviews, point-out rules, closed accounts (migration 0037, ACCOUNTS-BOARD.md),
// and the statement check of an account that no longer syncs. Invented rows,
// dates and amounts throughout.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, imports, ledgerAccounts, ledgerStatements, transactions } from './schema';
import { applyRulesToExisting, insertImport, insertRule, insertTransaction, pointedOut } from './queries';
import { recordStatements } from './ledger';
import { account, category, owner, person, ptxn, row, split, sync } from './test/fixtures';
import { loadBoard, needsYouFacts } from '@/app/_lib/board';
import { needsYouItems } from '@/lib/needs-you';
import { recordRaisedRowReview, recordStatementReview, setAccountClosed } from '@/app/_actions/reviews';
import { recordStatementCheck } from '@/app/_actions/ledger';
import { confirmImport } from '@/app/_actions/import';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const band = async () => needsYouItems(needsYouFacts(await loadBoard()), { day: (iso) => iso, money: (n) => String(n) });
const keys = async (mine: string) => (await band()).map((i) => i.key).filter((k) => k.includes(mine));

// A ledger account with CSV rows, no bank.
async function csvLedger(rows: { date: string; amountCents: number; description?: string }[]) {
  const tag = `R${randomUUID().slice(0, 8)}`;
  const [ledger] = await db
    .insert(ledgerAccounts)
    .values({ displayName: `Card ${tag}`, csvSource: 'discover', csvAccountLabel: tag })
    .returning({ id: ledgerAccounts.id });
  const { importId } = await insertImport({ source: 'discover', filename: `${tag}.csv`, displayName: tag, rowCount: rows.length, ledgerAccountId: ledger.id });
  for (const [i, r] of rows.entries()) {
    await insertTransaction({ date: r.date, amountCents: r.amountCents, descriptionRaw: r.description ?? `${tag} ROW ${i}`, categoryId: null, source: 'discover', accountLabel: tag, importId });
  }
  const ids = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.accountLabel, tag)).orderBy(transactions.date)).map((r) => r.id);
  return { ledgerId: ledger.id, tag, ids };
}

describe('a statement review', () => {
  it('is refused on figures the page did not show, ends the line, and lapses when the rows move', async () => {
    const { ledgerId, tag } = await csvLedger([{ date: '2026-08-20', amountCents: 9_000 }]);
    await recordStatements(ledgerId, [
      { closingDate: '2026-08-31', periodStart: '2026-08-01', nextClosingDate: '2099-01-01', chargesCents: 10_000, creditsCents: 0 },
    ], 'owner');
    expect(await keys(ledgerId)).toEqual([`differs:${ledgerId}:2026-08-31`]);

    const review = { ledgerAccountId: ledgerId, closingDate: '2026-08-31', chargesDiff: -1_000, creditsDiff: 0, note: 'A refund the bank netted' };
    // Figures the page did not show: refused, nothing stored.
    expect(await recordStatementReview({ ...review, chargesDiff: -900 })).toMatchObject({ error: expect.stringMatching(/has changed since/) });
    expect(await recordStatementReview({ ...review, note: '   ' })).toMatchObject({ error: 'Say why, in a few words.' });
    expect(await keys(ledgerId)).toEqual([`differs:${ledgerId}:2026-08-31`]);

    expect(await recordStatementReview(review)).toMatchObject({ ok: true });
    expect(await keys(ledgerId)).toEqual([]);

    // A row moves the difference: the review no longer applies, and the
    // difference is raised again rather than staying accepted.
    const [imp] = await db.select({ id: imports.id }).from(imports).where(eq(imports.displayName, tag));
    await insertTransaction({ date: '2026-08-22', amountCents: 500, descriptionRaw: `${tag} LATER`, categoryId: null, source: 'discover', accountLabel: tag, importId: imp.id });
    expect(await keys(ledgerId)).toEqual([`differs:${ledgerId}:2026-08-31`]);
  });
});

describe('keeping a raised row raised', () => {
  it('ends its share of the Raised rows line while its amount stays, and lapses when it changes', async () => {
    const { ids } = await csvLedger([{ date: '2026-08-20', amountCents: 6_000, description: 'LAKESIDE HIRE' }]);
    const [id] = ids;
    const o = await owner();
    const friend = await person('Keep friend');
    await split(id, 6_000, [
      { personId: o, amountCents: 3_000 },
      { personId: friend, amountCents: 3_000 },
    ]);
    await db.update(transactions).set({ amountCents: 6_600 }).where(eq(transactions.id, id));
    const raised = async () => needsYouFacts(await loadBoard()).raisedRows;
    const before = await raised();
    expect(await recordRaisedRowReview({ transactionId: id, amountCents: 6_500, note: 'Keeping it' })).toMatchObject({ error: expect.stringMatching(/amount has changed/) });
    expect(await recordRaisedRowReview({ transactionId: id, amountCents: 6_600, note: 'The extra was ours together' })).toMatchObject({ ok: true });
    expect(await raised()).toBe(before - 1);
    await db.update(transactions).set({ amountCents: 6_800 }).where(eq(transactions.id, id));
    expect(await raised()).toBe(before);
  });
});

describe('a point-out rule', () => {
  it('never writes a category, on any path that applies rules, and points out what it matches until categorized', async () => {
    const settling = await category('Settling up', { isSplittable: false, countsAsSpending: false });
    const pattern = `PAYAPP ${randomUUID().slice(0, 6).toUpperCase()}`;
    await insertRule({ matchPattern: pattern, matchType: 'substring', categoryId: settling, priority: 1, mode: 'point_out' });

    // Import.
    const fd = new FormData();
    const text = ['Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #', `DEBIT,08/20/2026,"${pattern} TO A FRIEND",-20.00,DEBIT_CARD,0,,`].join('\n');
    fd.set('file', new File([text], `${pattern}.csv`, { type: 'text/csv' }));
    expect(await confirmImport({}, fd)).toMatchObject({ ok: true });
    const [imported] = await db.select().from(transactions).where(eq(transactions.descriptionRaw, `${pattern} TO A FRIEND`));
    expect(imported.categoryId).toBeNull();

    // Sync.
    const acc = await account();
    const synced = ptxn(acc, { descriptionRaw: `${pattern} FROM A FRIEND`, amountCents: -15_000 });
    await sync(acc, { added: [synced] });
    expect((await row(acc, synced.providerTransactionId)).categoryId).toBeNull();

    // Apply to existing.
    await applyRulesToExisting();
    const [after] = await db.select().from(transactions).where(eq(transactions.id, imported.id));
    expect(after.categoryId).toBeNull();

    // Pointed out, both; the line names the category and the rule.
    const mine = (await pointedOut()).find((p) => p.pattern === pattern)!;
    expect(mine.rowIds.sort()).toEqual([imported.id, (await row(acc, synced.providerTransactionId)).id].sort());
    const line = (await band()).find((i) => i.text.includes(pattern));
    expect(line).toMatchObject({ kind: 'task', action: 'Sort' });
    expect(line?.text).toBe(`2 rows match your "${pattern}" rule and have no category.`);

    // A row the owner categorizes, as anything, is decided: no longer pointed out.
    await db.update(transactions).set({ categoryId: settling, categorySource: 'manual' }).where(eq(transactions.id, imported.id));
    expect((await pointedOut()).find((p) => p.pattern === pattern)!.rowIds).toHaveLength(1);
  });
});

describe('a closed account', () => {
  it('ends the lines asking for statements, and only those', async () => {
    const { ledgerId } = await csvLedger([{ date: '2026-03-20', amountCents: 4_000 }]);
    await recordStatements(ledgerId, [{ closingDate: '2026-03-05' }, { closingDate: '2026-04-05' }, { closingDate: '2026-05-05' }], 'owner');
    expect(await keys(ledgerId)).toContain(`missing:${ledgerId}`);
    expect(await setAccountClosed(ledgerId, '2099-01-01')).toEqual({ error: 'That day is still to come.' });
    expect(await setAccountClosed(ledgerId, '2026-05-20')).toMatchObject({ ok: true });
    expect((await keys(ledgerId)).filter((k) => k.startsWith('missing:') || k.startsWith('nostatement:'))).toEqual([]);
    // Recorded by mistake: cleared, the expectation returns.
    expect(await setAccountClosed(ledgerId, null)).toMatchObject({ ok: true });
    expect(await keys(ledgerId)).toContain(`missing:${ledgerId}`);
  });
});

describe('the statement check of an account that no longer syncs', () => {
  it('passes on its stored rows when they cover the period, ending its Verify line', async () => {
    const acc = await account();
    await sync(acc, {
      // No separate purchase date: the fixture's default would date them in
      // another month than the statement's.
      added: [
        ptxn(acc, { date: '2026-06-04', authorizedDate: null, amountCents: 31_500 }),
        ptxn(acc, { date: '2026-06-18', authorizedDate: null, amountCents: -20_000, descriptionRaw: 'PAYMENT RECEIVED' }),
      ],
    });
    // Sync turned off, and the bank no longer shares it: nothing new arrives.
    await db.update(bankAccounts).set({ verifiedAt: null, syncEnabled: false, unsharedAt: new Date() }).where(eq(bankAccounts.id, acc.accountId));
    expect(await keys(acc.accountId)).toEqual([`verify:${acc.accountId}`]);
    const statement = { from: '2026-06-01', to: '2026-06-30', charges: '31.50', credits: '20.00', excludedKeys: [], confirmed: true };
    expect(await recordStatementCheck(acc.accountId, statement, 'pass')).toMatchObject({ ok: true });
    expect(await keys(acc.accountId)).toEqual([]);
    const [checked] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, acc.accountId));
    expect(checked.verifiedAt).not.toBeNull();
    // Its statement is recorded with the check's figures.
    const recorded = await db.select().from(ledgerStatements).where(eq(ledgerStatements.ledgerAccountId, acc.ledgerAccountId));
    expect(recorded.map((s) => [s.closingDate, s.chargesCents, s.creditsCents])).toEqual([['2026-06-30', 31_500, 20_000]]);
  });
});
