// ACTION-RESULTS.md: every action that used to return nothing now says what
// it did, refuses a change that matched nothing, and does nothing the
// second time. Driven through the real Server Actions.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from './index';
import { categories, persons, settlements, transactions } from './schema';
import {
  getDeletedImports,
  getTransactions,
  insertExternalExpense,
  insertImport,
  insertRule,
  insertSettlementWithAllocations,
  insertTransaction,
  softDeleteTransactionById,
} from './queries';
import { account, category, owner, person, ptxn, row, split, sync } from './test/fixtures';
import { attempt } from '@/app/_actions/attempt';
import { deletePerson, hardDeletePerson } from '@/app/_actions/people';
import { deleteRule } from '@/app/_actions/rules';
import { deleteSettlement } from '@/app/_actions/settlements';
import { deleteExternalExpense } from '@/app/_actions/external-expenses';
import { createTransaction } from '@/app/_actions/transactions';
import { removeSplit } from '@/app/_actions/splits';
import { bulkDeleteTransactions, deleteTransaction } from '@/app/_actions/transactions';
import { restoreImport, setImportHidden, undoImport } from '@/app/_actions/import';
import { removeReceipt } from '@/app/_actions/receipts';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

// Errors are logged; keep the test output clean and let a test read them.
async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; log: string }> {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await run();
    return { result, log: logged.mock.calls.flat().join(' ') };
  } finally {
    vi.restoreAllMocks();
  }
}

async function settlementIdOf(personId: string): Promise<string> {
  const [s] = await db.select({ id: settlements.id }).from(settlements).where(eq(settlements.personId, personId));
  return s.id;
}

async function manualRow(tag: string, n = 1, importId?: string) {
  await insertTransaction({
    date: `2026-09-0${n}`,
    amountCents: n * 1_000,
    descriptionRaw: `${tag} ROW ${n}`,
    categoryId: null,
    source: importId ? 'chase' : 'manual',
    ...(importId ? { importId } : {}),
  });
  return (await getTransactions()).find((t) => t.descriptionRaw === `${tag} ROW ${n}`)!;
}

const tagOf = () => `AR${randomUUID().slice(0, 8).toUpperCase()}`;

describe('people', () => {
  it('delete says who, then refuses a second delete and the owner', async () => {
    const id = await person('Robin');
    expect(await deletePerson(form({ id }))).toEqual({
      ok: true,
      message: 'Robin deleted. Their history stays; they no longer appear in new splits or settlements.',
    });
    const [{ deletedAt }] = await db.select({ deletedAt: persons.deletedAt }).from(persons).where(eq(persons.id, id));
    expect(await deletePerson(form({ id }))).toEqual({ error: 'That person was not found, or is already deleted.' });
    const [after] = await db.select({ deletedAt: persons.deletedAt }).from(persons).where(eq(persons.id, id));
    expect(after.deletedAt).toEqual(deletedAt);
    expect(await deletePerson(form({ id: await owner() }))).toEqual({ error: 'That person was not found, or is already deleted.' });
    expect(await deletePerson(form({ id: 'not-a-uuid' }))).toEqual({ error: 'Invalid person.' });
  });

  it('erase refuses a person not deleted first, then erases with their settlements', async () => {
    const id = await person('Sam');
    await insertSettlementWithAllocations({ personId: id, amountCents: 5_000, direction: 'incoming', date: '2026-10-01', note: null });
    expect(await hardDeletePerson(id)).toEqual({ error: 'That person was not found, or is not deleted yet.' });
    expect(await db.select().from(persons).where(eq(persons.id, id))).toHaveLength(1);
    await deletePerson(form({ id }));
    expect(await hardDeletePerson(id)).toEqual({ ok: true, message: 'Sam erased, with 1 settlement.' });
    expect(await hardDeletePerson(id)).toEqual({ error: 'That person was not found, or is not deleted yet.' });
  });
});

describe('rules, payments and expenses', () => {
  it('a rule delete names the rule, then refuses', async () => {
    const tag = tagOf();
    await insertRule({ matchPattern: tag, matchType: 'substring', categoryId: await category('Rides'), priority: 100 });
    const [{ id }] = (await db.execute(sql`select id from categorization_rules where match_pattern = ${tag}`)) as unknown as { id: string }[];
    expect(await deleteRule(form({ id }))).toEqual({ ok: true, message: `Rule ${tag} deleted. Rows it categorized keep their category.` });
    expect(await deleteRule(form({ id }))).toEqual({ error: 'That rule was not found; it may already be deleted.' });
  });

  it('a payment delete says how much, then refuses', async () => {
    const alex = await person('Alex');
    await insertSettlementWithAllocations({ personId: alex, amountCents: 12_340, direction: 'incoming', date: '2026-10-01', note: null });
    const id = await settlementIdOf(alex);
    expect(await deleteSettlement(id)).toEqual({ ok: true, message: 'Payment of $12.34 deleted. What it paid is outstanding again.' });
    expect(await deleteSettlement(id)).toEqual({ error: 'That payment was not found; it may already be deleted.' });
  });

  it('an expense-you-paid delete, then refuses', async () => {
    const kim = await person('Kim');
    const ownerId = await owner();
    await insertExternalExpense({ payerPersonId: kim, ownerId, amountCents: 8_000, date: '2026-10-02', description: 'Tickets' });
    const [{ id }] = (await db.execute(
      sql`select s.id from splits s where s.transaction_id is null and s.payer_person_id = ${kim}`,
    )) as unknown as { id: string }[];
    expect(await deleteExternalExpense(id)).toEqual({ ok: true, message: 'Expense deleted. Any payment applied to it is credit again.' });
    expect(await deleteExternalExpense(id)).toEqual({ error: 'That expense was not found; it may already be deleted.' });
  });
});

describe('splits and transactions', () => {
  it('removing a split says payments on it went back to credit, then refuses', async () => {
    const o = await owner();
    const alex = await person('Alex');
    const acc = await account();
    const t = ptxn(acc, { amountCents: 60_000 });
    await sync(acc, { added: [t] });
    const r = await row(acc, t.providerTransactionId);
    await split(r.id, 60_000, [
      { personId: o, amountCents: 30_000 },
      { personId: alex, amountCents: 30_000 },
    ]);
    await insertSettlementWithAllocations({ personId: alex, amountCents: 30_000, direction: 'incoming', date: '2026-10-03', note: null });
    expect(await removeSplit(form({ transactionId: r.id }))).toEqual({
      ok: true,
      message: 'Split removed; the charge is all yours. 1 payment allocation on it went back to credit.',
    });
    expect(await removeSplit(form({ transactionId: r.id }))).toEqual({
      error: 'This row has no split to remove; it may already be removed.',
    });
  });

  it('a transaction delete refuses a row already deleted and keeps its deletion time', async () => {
    const r = await manualRow(tagOf());
    expect(await deleteTransaction(form({ id: r.id }))).toEqual({ ok: true, message: 'Transaction deleted.' });
    const [first] = await db.select({ deletedAt: transactions.deletedAt }).from(transactions).where(eq(transactions.id, r.id));
    expect(await deleteTransaction(form({ id: r.id }))).toEqual({ error: 'That transaction was not found, or is already deleted.' });
    const [second] = await db.select({ deletedAt: transactions.deletedAt }).from(transactions).where(eq(transactions.id, r.id));
    expect(second.deletedAt).toEqual(first.deletedAt);
  });

  it('a bulk delete says how many, warns when some were already deleted, refuses when none matched', async () => {
    const tag = tagOf();
    const a = await manualRow(tag, 1);
    const b = await manualRow(tag, 2);
    await deleteTransaction(form({ id: b.id }));
    expect(await bulkDeleteTransactions([a.id, b.id])).toEqual({ ok: true, warning: '1 of 2 deleted; the rest were already deleted.' });
    expect(await bulkDeleteTransactions([a.id, b.id])).toEqual({ error: 'Nothing was deleted; those rows may already be deleted.' });
    const c = await manualRow(tag, 3);
    expect(await bulkDeleteTransactions([c.id])).toEqual({ ok: true, message: '1 row deleted.' });
  });
});

describe('undo and restore', () => {
  it('a second Undo changes nothing, and Restore brings back exactly the rows the Undo deleted', async () => {
    const tag = tagOf();
    const { importId } = await insertImport({ source: 'chase', filename: `${tag}.csv`, displayName: tag, rowCount: 3 });
    const rows = [await manualRow(tag, 1, importId), await manualRow(tag, 2, importId), await manualRow(tag, 3, importId)];
    // Deleted on its own before the undo: stays deleted after a restore.
    await deleteTransaction(form({ id: rows[0].id }));

    expect(await undoImport(form({ importId }))).toEqual({
      ok: true,
      message: 'Import undone: 2 rows deleted. Restore brings them back.',
    });
    // The double click, or the stale tab.
    expect(await undoImport(form({ importId }))).toEqual({ error: 'That import is already undone.' });
    expect((await getDeletedImports()).find((i) => i.id === importId)?.restorableCount).toBe(2);

    expect(await restoreImport(importId)).toEqual({ ok: true, message: 'Restored 2 rows.' });
    const live = (await getTransactions()).filter((t) => t.descriptionRaw.startsWith(tag)).map((t) => t.id).sort();
    expect(live).toEqual([rows[1].id, rows[2].id].sort());
    expect(await restoreImport(importId)).toEqual({ error: 'That import is not undone; there is nothing to restore.' });

    // A second round works the same: nothing is left marked from the first.
    expect(await undoImport(form({ importId }))).toMatchObject({ ok: true });
    expect(await restoreImport(importId)).toEqual({ ok: true, message: 'Restored 2 rows.' });
  });

  it('the database refuses a row marked as deleted by an undo that is not deleted', async () => {
    const r = await manualRow(tagOf());
    const { result } = await quietly(() =>
      attempt('test', async () => {
        await db.update(transactions).set({ deletedByUndo: true }).where(eq(transactions.id, r.id));
        return { ok: true as const };
      }),
    );
    expect(result).toEqual({ error: 'The database refused the change; nothing was saved.' });
  });

  it('hiding an import that does not exist says so', async () => {
    expect(await setImportHidden(randomUUID(), true)).toEqual({ error: 'That import was not found.' });
  });
});

describe('receipts', () => {
  it('removing a receipt from a row without one says so', async () => {
    const r = await manualRow(tagOf());
    expect(await removeReceipt(form({ transactionId: r.id }))).toEqual({
      error: 'This row has no receipt to remove; it may already be removed.',
    });
  });
});

describe('attempt', () => {
  it("shows our own trigger's refusal as written, and logs only its code", async () => {
    const id = await category('Transfers', { isSplittable: false, countsAsSpending: false });
    await insertTransaction({ date: '2026-10-04', amountCents: 5_000, descriptionRaw: `${tagOf()} PAYMENT`, categoryId: id, source: 'manual' });
    const { result, log } = await quietly(() =>
      attempt('deleteCategory', async () => {
        await db.delete(categories).where(eq(categories.id, id));
        return { ok: true as const };
      }),
    );
    expect(result).toEqual({
      error: expect.stringMatching(/^Category "Transfers [0-9a-f]{8}" is not counted as spending and still has transactions; recategorize them before deleting it\.$/),
    });
    expect(log).toBe('deleteCategory: database error P0001');
  });

  it('never shows or logs the failed SQL', async () => {
    const { result, log } = await quietly(() =>
      attempt('insertBad', async () => {
        await db.execute(sql`insert into persons (id, name) values (${randomUUID()}, null)`);
        return { ok: true as const };
      }),
    );
    expect(result).toEqual({ error: 'The database refused the change; nothing was saved.' });
    expect(log).toBe('insertBad: database error 23502');
  });
});

// A row typed by hand was dropped by the dedup index when an identical manual
// row existed, live or deleted, while the form said "Transaction added."
describe('adding a transaction by hand', () => {
  const form = (description: string) => {
    const fd = new FormData();
    fd.set('date', '2026-08-02');
    fd.set('amount', '4.50');
    fd.set('description', description);
    fd.set('categoryId', '');
    return fd;
  };
  const rows = async (description: string) =>
    db.select({ deletedAt: transactions.deletedAt }).from(transactions).where(eq(transactions.descriptionRaw, description));

  it('adds a second identical row, and says the first exists', async () => {
    const d = `COFFEE ${randomUUID().slice(0, 6)}`;
    expect(await createTransaction({}, form(d))).toEqual({ ok: true, message: 'Transaction added.' });
    expect(await createTransaction({}, form(d))).toEqual({
      ok: true,
      message: 'Transaction added. You already had an identical row on that date (same amount and description); delete one if this was a slip.',
    });
    expect(await rows(d)).toHaveLength(2);
  });

  it('adds a row identical to a deleted one without mentioning it', async () => {
    const d = `COFFEE ${randomUUID().slice(0, 6)}`;
    await createTransaction({}, form(d));
    const [first] = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.descriptionRaw, d));
    await softDeleteTransactionById(first.id);
    expect(await createTransaction({}, form(d))).toEqual({ ok: true, message: 'Transaction added.' });
    expect((await rows(d)).filter((r) => r.deletedAt === null)).toHaveLength(1);
  });
});

