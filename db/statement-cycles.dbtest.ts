import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { transactions } from './schema';
import { closingDaysFor, cycleSoFar } from './statement-cycles';
import { account, ptxn, removal, row, sync } from './test/fixtures';
import { removeClosingDay, setClosingDay } from '@/app/_actions/ledger';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// Statement cycles (STATEMENT-CYCLES.md): closing days the owner sets, and the
// current cycle's totals as the statement will count them.
const posted = (acc: Awaited<ReturnType<typeof account>>, date: string, amountCents: number, pending = false) => {
  const t = ptxn(acc, { date, authorizedDate: date, amountCents, pending });
  return { ...t, raw: { transaction_id: t.providerTransactionId, date } };
};

describe('closing days', () => {
  it('are set, changed from a date, and removed, through the actions', async () => {
    const acc = await account();
    expect(await setClosingDay({ ledgerAccountId: acc.ledgerAccountId, closingDay: '6', effectiveFrom: '' })).toEqual({
      ok: true,
      message: 'Closes on the 6th.',
    });
    expect(await setClosingDay({ ledgerAccountId: acc.ledgerAccountId, closingDay: 20, effectiveFrom: '2026-12-01' })).toEqual({
      ok: true,
      message: 'Closes on the 20th for statements closing on or after 2026-12-01.',
    });
    expect((await closingDaysFor([acc.ledgerAccountId])).get(acc.ledgerAccountId)).toEqual([
      { effectiveFrom: '2000-01-01', closingDay: 6 },
      { effectiveFrom: '2026-12-01', closingDay: 20 },
    ]);
    // The same date again corrects that entry rather than adding one.
    await setClosingDay({ ledgerAccountId: acc.ledgerAccountId, closingDay: 21, effectiveFrom: '2026-12-01' });
    expect((await closingDaysFor([acc.ledgerAccountId])).get(acc.ledgerAccountId)).toHaveLength(2);
    expect(await setClosingDay({ ledgerAccountId: acc.ledgerAccountId, closingDay: 32, effectiveFrom: '' })).toEqual({
      error: 'A closing day is 1 to 31.',
    });
    expect(await removeClosingDay(acc.ledgerAccountId, '2026-12-01')).toEqual({ ok: true, message: 'Closing day removed.' });
    expect(await removeClosingDay(acc.ledgerAccountId, '2026-12-01')).toEqual({ error: 'That closing day was already removed.' });
  });
});

describe('the cycle so far', () => {
  it('counts the bank rows posted in the cycle as the statement does, pending apart', async () => {
    const acc = await account();
    const inCycle = posted(acc, '2026-10-07', 40_000);
    const before = posted(acc, '2026-10-06', 9_000);
    const credit = posted(acc, '2026-11-02', -15_000);
    const pending = posted(acc, '2026-11-03', 7_500, true);
    const deletedByOwner = posted(acc, '2026-10-20', 12_000);
    const removedByBank = posted(acc, '2026-10-21', 3_000);
    await sync(acc, { added: [inCycle, before, credit, pending, deletedByOwner, removedByBank] });
    // Deleted by the owner: still on the statement. Removed by the bank: not.
    await db.update(transactions).set({ deletedAt: new Date() }).where(eq(transactions.id, (await row(acc, deletedByOwner.providerTransactionId))!.id));
    await sync(acc, { removed: [removal(acc, removedByBank.providerTransactionId)] });

    const entries = [{ effectiveFrom: '2000-01-01', closingDay: 6 }];
    expect(await cycleSoFar(acc.ledgerAccountId, entries, '2026-11-03')).toEqual({
      cycle: { start: '2026-10-07', end: '2026-11-06' },
      chargesCents: 52_000,
      creditsCents: 15_000,
      pendingCents: 7_500,
      pendingCount: 1,
    });
    expect(await cycleSoFar(acc.ledgerAccountId, [], '2026-11-03')).toBeNull();
  });
});
