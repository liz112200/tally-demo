// Paid alongside (PAID-ALONGSIDE.md): a purchase paid off-card next to a
// charge, and converting an amount raised after import into one. Above
// everything: nobody's owed, paid or credit moves, nor the spending total.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from './index';
import { settlementAllocations, settlements, splitShares, splits, transactions } from './schema';
import { getTransactions, insertTransaction, softDeleteTransactionById, updateTransactionDetailsById } from './queries';
import { account, category, owner, person, ptxn, split, sync } from './test/fixtures';
import { addPaidAlongside, convertToPaidAlongside, previewConversion } from '@/app/_actions/alongside';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// A CSV row that came in at `original` and was raised to `current`, split
// equally (halves to the mill, as splits saved before the whole-cents rule
// were), with the other person's half paid by a settlement.
async function raisedRow(original: number, current: number, paid = true) {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const descriptionRaw = `SYNTHETIC CAR HIRE ${tag}`;
  const categoryId = await category('Travel');
  await insertTransaction({ date: '2026-07-26', amountCents: original, descriptionRaw, categoryId, source: 'amex', categorySource: 'rule' });
  const [row] = await db.select().from(transactions).where(eq(transactions.descriptionRaw, descriptionRaw));
  await updateTransactionDetailsById(row.id, { date: '2026-07-26', amountCents: current, descriptionRaw });
  const ownerId = await owner();
  const friend = await person(`Friend ${tag}`);
  await split(row.id, current, [
    { personId: ownerId, amountCents: current / 2 },
    { personId: friend, amountCents: current / 2 },
  ]);
  const [share] = await db
    .select({ id: splitShares.id })
    .from(splitShares)
    .innerJoin(splits, eq(splits.id, splitShares.splitId))
    .where(and(eq(splits.transactionId, row.id), eq(splitShares.personId, friend)));
  let settlementId: string | null = null;
  if (paid) {
    const [st] = await db
      .insert(settlements)
      .values({ personId: friend, amountCents: current / 2, direction: 'incoming', date: '2026-09-08' })
      .returning({ id: settlements.id });
    settlementId = st.id;
    await db.insert(settlementAllocations).values({ settlementId: st.id, splitShareId: share.id, amountCents: current / 2 });
  }
  return { id: row.id, friend, ownerId, shareId: share.id, settlementId, categoryId };
}

describe('converting a raised amount into a paid-alongside purchase', () => {
  it('previews without writing, then converts with every balance and the spending total unchanged', async () => {
    const r = await raisedRow(100_330, 110_330);
    expect((await getTransactions()).find((t) => t.id === r.id)?.editedAfterImport).toBe(true);

    const preview = await previewConversion(r.id);
    if (!('plan' in preview)) throw new Error(preview.error);
    expect(preview.plan).toMatchObject({ originalCents: 100_330, currentCents: 110_330, extraCents: 10_000, partCents: 5_000, monthByCategoryUnchanged: true });
    for (const p of preview.plan.people) expect(p.after).toEqual(p.before);
    expect(preview.plan.spending.after).toBe(preview.plan.spending.before);
    // Nothing written by the preview.
    expect((await db.select().from(transactions).where(eq(transactions.id, r.id)))[0].amountCents).toBe(110_330);

    const result = await convertToPaidAlongside(r.id, 'gas and tolls, cash');
    expect(result).toMatchObject({ ok: true, message: 'Back to $100.33, with $10.00 "gas and tolls, cash" paid alongside it, $5.00 each.' });

    const [anchor] = await db.select().from(transactions).where(eq(transactions.id, r.id));
    expect(anchor.amountCents).toBe(100_330);
    expect((await getTransactions()).find((t) => t.id === r.id)?.editedAfterImport).toBe(false);
    const [extra] = await db.select().from(transactions).where(eq(transactions.alongsideTransactionId, r.id));
    expect(extra).toMatchObject({ amountCents: 10_000, source: 'manual', descriptionRaw: 'gas and tolls, cash', date: '2026-07-26', categoryId: r.categoryId });

    // The split is adjusted, not re-divided: halves to the mill, each down by $5.00.
    const anchorShares = await db.select().from(splitShares).innerJoin(splits, eq(splits.id, splitShares.splitId)).where(eq(splits.transactionId, r.id));
    expect(anchorShares.map((s) => s.split_shares.amountCents)).toEqual([50_165, 50_165]);
    const extraShares = await db.select().from(splitShares).innerJoin(splits, eq(splits.id, splitShares.splitId)).where(eq(splits.transactionId, extra.id));
    expect(extraShares.map((s) => s.split_shares.amountCents)).toEqual([5_000, 5_000]);

    // The payment is untouched; its allocation moved $5.00 to the friend's share of the extra.
    const [payment] = await db.select().from(settlements).where(eq(settlements.id, r.settlementId!));
    expect(payment.amountCents).toBe(55_165);
    const allocations = await db.select().from(settlementAllocations).where(eq(settlementAllocations.settlementId, r.settlementId!));
    expect(allocations.map((a) => a.amountCents).sort()).toEqual([5_000, 50_165]);
  });

  it('keeps a partly paid share owing exactly what it owed', async () => {
    const r = await raisedRow(100_330, 110_330, false);
    const preview = await previewConversion(r.id);
    if (!('plan' in preview)) throw new Error(preview.error);
    const friend = preview.plan.people.find((p) => p.personId === r.friend)!;
    expect(friend.before.owed).toBe(55_165);
    expect(friend.after).toEqual(friend.before);
  });

  it('refuses a row whose amount is as it came in, an uneven extra, and a synced row', async () => {
    const ok = await raisedRow(100_330, 110_330);
    await convertToPaidAlongside(ok.id, 'first');
    expect(await previewConversion(ok.id)).toEqual({ error: 'This row has the amount it came in with; there is nothing to move.' });

    const uneven = await raisedRow(100_330, 100_340);
    expect(await previewConversion(uneven.id)).toEqual({
      error: 'The extra does not divide evenly in whole cents among 2 people, so it is not converted.',
    });

    const acc = await account();
    const synced = ptxn(acc);
    await sync(acc, { added: [synced] });
    const [s] = await db.select().from(transactions).where(eq(transactions.providerTransactionId, synced.providerTransactionId));
    expect(await previewConversion(s.id)).toMatchObject({ error: expect.stringMatching(/synced row/) });
  });

  it('needs a description of what the extra was; nothing is guessed', async () => {
    const r = await raisedRow(100_330, 110_330);
    expect(await convertToPaidAlongside(r.id, '  ')).toEqual({ error: 'Say what it was.' });
  });
});

// What happened on dev (2026-10-29): the owner added "Gas $10.00" alongside a
// raised row, then converted it with the description "Gas". The conversion
// wrote the amount, hit the duplicate, returned its error inside the
// transaction, and so committed the amount alone.
describe('a refused conversion writes nothing, and asking again gives the same answer', () => {
  async function stateOf(r: { id: string }) {
    const [t] = await db.select({ amount: transactions.amountCents }).from(transactions).where(eq(transactions.id, r.id));
    const shares = await db.select({ amount: splitShares.amountCents }).from(splitShares).innerJoin(splits, eq(splits.id, splitShares.splitId)).where(eq(splits.transactionId, r.id));
    const alongside = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.alongsideTransactionId, r.id));
    return { amount: t.amount, shares: shares.map((x) => x.amount), alongside: alongside.length };
  }

  it('when the extra is already recorded alongside the row', async () => {
    const r = await raisedRow(100_330, 110_330);
    await addPaidAlongside(r.id, 'Gas', '10.00');
    const before = await stateOf(r);
    const refusal = '"Gas" for $10.00 is already recorded alongside this row, so converting would record the extra a second time. If that row is the extra, delete it, then convert.';
    expect(await previewConversion(r.id)).toEqual({ error: refusal });
    expect(await convertToPaidAlongside(r.id, 'Gas')).toEqual({ error: refusal });
    expect(await previewConversion(r.id)).toEqual({ error: refusal });
    expect(await stateOf(r)).toEqual(before);
  });

  it('when a manual row with the same date, amount and description exists elsewhere', async () => {
    const r = await raisedRow(100_330, 110_330);
    await insertTransaction({ date: '2026-07-26', amountCents: 10_000, descriptionRaw: 'Tolls', categoryId: null });
    const before = await stateOf(r);
    expect(await convertToPaidAlongside(r.id, 'Tolls')).toEqual({
      error: 'You already have a manual row "Tolls" for $10.00 on 2026-07-26. Describe this one differently, or delete that row first.',
    });
    expect(await stateOf(r)).toEqual(before);
    // Nothing changed, so the preview still offers it, and another description converts.
    expect(await previewConversion(r.id)).toMatchObject({ ok: true });
    expect(await convertToPaidAlongside(r.id, 'Tolls, cash')).toMatchObject({ ok: true });
  });
});

// The re-test on dev (2026-10-29): told to delete the clashing row, the owner
// did, and the conversion still refused, naming the row they had deleted.
describe('a deleted row does not block', () => {
  it('converting with the description of a row the owner deleted', async () => {
    const r = await raisedRow(100_330, 110_330);
    const gasText = `Gas ${randomUUID().slice(0, 6)}`;
    expect(await addPaidAlongside(r.id, gasText, '10.00')).toMatchObject({ ok: true });
    const [gas] = await db.select().from(transactions).where(eq(transactions.alongsideTransactionId, r.id));
    expect(await softDeleteTransactionById(gas.id)).toBe(true);

    const preview = await previewConversion(r.id);
    if (!('plan' in preview)) throw new Error(preview.error);
    expect(await convertToPaidAlongside(r.id, gasText)).toMatchObject({ ok: true });
    const live = await db.select().from(transactions).where(and(eq(transactions.alongsideTransactionId, r.id), eq(transactions.descriptionRaw, gasText)));
    expect(live.map((t) => [t.deletedAt === null, t.dedupExempt]).sort()).toEqual([[false, false], [true, true]]);
    const [anchor] = await db.select().from(transactions).where(eq(transactions.id, r.id));
    expect(anchor.amountCents).toBe(100_330);
  });

  it('adding alongside with the description of a deleted row; a live one is still refused, named', async () => {
    const r = await raisedRow(100_330, 100_330);
    const parking = `Parking ${randomUUID().slice(0, 6)}`;
    expect(await addPaidAlongside(r.id, parking, '7.00')).toMatchObject({ ok: true });
    expect(await addPaidAlongside(r.id, parking, '7.00')).toEqual({
      error: `You already have a manual row "${parking}" for $7.00 on 2026-07-26. Describe this one differently, or delete that row first.`,
    });
    const [first] = await db.select().from(transactions).where(eq(transactions.alongsideTransactionId, r.id));
    await softDeleteTransactionById(first.id);
    expect(await addPaidAlongside(r.id, parking, '7.00')).toMatchObject({ ok: true });
  });
});

describe('adding what was paid alongside a charge', () => {
  it('is a manual purchase on its date and category, split equally among the same people, and counts as spending', async () => {
    const r = await raisedRow(100_330, 100_330);
    expect(await addPaidAlongside(r.id, 'parking, cash', '7.00')).toMatchObject({ ok: true, message: expect.stringMatching(/^Added \$7\.00 paid alongside it, split equally with Friend/) });
    const [extra] = await db.select().from(transactions).where(eq(transactions.alongsideTransactionId, r.id));
    expect(extra).toMatchObject({ amountCents: 7_000, source: 'manual', date: '2026-07-26', categoryId: r.categoryId, categorySource: 'manual' });
    const shares = await db.select().from(splitShares).innerJoin(splits, eq(splits.id, splitShares.splitId)).where(eq(splits.transactionId, extra.id));
    expect(shares.map((s) => s.split_shares.amountCents)).toEqual([3_500, 3_500]);
    expect((await getTransactions()).find((t) => t.id === extra.id)).toMatchObject({ alongsideOfId: r.id, countsAsSpending: true });
  });

  it('refuses without a description or an amount', async () => {
    const r = await raisedRow(100_330, 100_330);
    expect(await addPaidAlongside(r.id, '', '7.00')).toEqual({ error: 'Say what it was.' });
    expect(await addPaidAlongside(r.id, 'parking', '0')).toEqual({ error: 'Enter the amount you paid.' });
  });
});
