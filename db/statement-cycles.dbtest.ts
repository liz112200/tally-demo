import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { transactions } from './schema';
import { cycleSoFar, statementsFor } from './statement-cycles';
import { account, ptxn, removal, row, sync } from './test/fixtures';
import { recordClosingDates, recordStatement, recordStatementCheck, removeStatement } from '@/app/_actions/ledger';
import { formatCents, toCents } from '@/lib/money';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// Statement cycles (STATEMENT-CYCLES.md): statements recorded from the owner's
// own and from statement checks, and the current cycle's totals as the
// statement will count them. Invented dates throughout.
const posted = (acc: Awaited<ReturnType<typeof account>>, date: string, amountCents: number, pending = false) => {
  const t = ptxn(acc, { date, authorizedDate: date, amountCents, pending });
  return { ...t, raw: { transaction_id: t.providerTransactionId, date } };
};
const recorded = async (ledgerAccountId: string) => (await statementsFor([ledgerAccountId])).get(ledgerAccountId) ?? [];

describe('recording statements', () => {
  it('records one with its printed dates, and a pasted list without erasing what is known', async () => {
    const acc = await account();
    const one = { ledgerAccountId: acc.ledgerAccountId, closingDate: '2026-10-06', periodStart: '2026-09-07', nextClosingDate: '2026-11-05', startsNewCycle: false };
    expect(await recordStatement(one)).toEqual({ ok: true, message: 'Statement closing 2026-10-06 recorded.' });
    expect(await recordClosingDates(acc.ledgerAccountId, 'Oct 6, Sep 7\nAug 6')).toEqual({
      ok: true,
      message: 'Recorded 3 closing dates, 2026-08-06 to 2026-10-06.',
    });
    expect(await recorded(acc.ledgerAccountId)).toEqual([
      { closingDate: '2026-08-06', periodStart: null, nextClosingDate: null, startsNewCycle: false, source: 'owner' },
      { closingDate: '2026-09-07', periodStart: null, nextClosingDate: null, startsNewCycle: false, source: 'owner' },
      // The list carried only its closing date: the start and next date stay.
      { closingDate: '2026-10-06', periodStart: '2026-09-07', nextClosingDate: '2026-11-05', startsNewCycle: false, source: 'owner' },
    ]);
  });

  it('refuses a closing still to come, an unreadable list, and a second removal', async () => {
    const acc = await account();
    expect(await recordStatement({ ledgerAccountId: acc.ledgerAccountId, closingDate: '2999-01-01', periodStart: '', nextClosingDate: '', startsNewCycle: false })).toEqual({
      error: 'That closing date is still to come; record a statement once it has closed.',
    });
    expect(await recordStatement({ ledgerAccountId: acc.ledgerAccountId, closingDate: '', periodStart: '', nextClosingDate: '', startsNewCycle: false })).toEqual({
      error: 'Enter the closing date.',
    });
    expect(await recordClosingDates(acc.ledgerAccountId, 'Oct 6, Sept 31')).toEqual({ error: 'Nothing recorded: could not read “Sept 31”.' });
    expect(await recorded(acc.ledgerAccountId)).toEqual([]);
    await recordClosingDates(acc.ledgerAccountId, '2026-10-06');
    expect(await removeStatement(acc.ledgerAccountId, '2026-10-06')).toEqual({ ok: true, message: 'Statement closing 2026-10-06 removed.' });
    expect(await removeStatement(acc.ledgerAccountId, '2026-10-06')).toEqual({ error: 'That statement was already removed.' });
  });

  it('a passing statement check adds its period, and a later check adds another', async () => {
    const acc = await account();
    await sync(acc, { added: [posted(acc, '2026-09-10', 4_000), posted(acc, '2026-10-10', 6_000)] });
    const check = (from: string, to: string, chargesCents: number) =>
      recordStatementCheck(acc.accountId, { from, to, charges: formatCents(toCents(chargesCents)), credits: '0.00', excludedKeys: [], confirmed: true }, 'pass');
    expect(await check('2026-09-07', '2026-10-06', 4_000)).toMatchObject({ ok: true });
    expect(await check('2026-10-07', '2026-11-05', 6_000)).toMatchObject({ ok: true });
    expect((await recorded(acc.ledgerAccountId)).map((s) => [s.periodStart, s.closingDate, s.source])).toEqual([
      ['2026-09-07', '2026-10-06', 'verification'],
      ['2026-10-07', '2026-11-05', 'verification'],
    ]);
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

    const statements = [{ closingDate: '2026-10-06', periodStart: '2026-09-07', nextClosingDate: null, startsNewCycle: false }];
    expect(await cycleSoFar(acc.ledgerAccountId, statements, '2026-11-03')).toMatchObject({
      cycle: { start: '2026-10-07', startExact: true, end: { from: '2026-11-06', to: '2026-11-06' }, endFrom: 'projected' },
      chargesCents: 52_000,
      creditsCents: 15_000,
      pendingCents: 7_500,
      pendingCount: 1,
    });
    expect(await cycleSoFar(acc.ledgerAccountId, [], '2026-11-03')).toBeNull();
  });
});
