// Editing a recorded statement in place, and who a statement belongs to
// (2026-11-11). Invented accounts, dates and amounts throughout.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from './index';
import { ledgerAccounts, ledgerStatements } from './schema';
import { recordStatements } from './ledger';
import { account, ptxn, sync } from './test/fixtures';
import { editRecordedStatement, recordStatement, recordStatementCheck } from '@/app/_actions/ledger';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

async function ledger() {
  const tag = `S${randomUUID().slice(0, 8)}`;
  const [l] = await db.insert(ledgerAccounts).values({ displayName: `Card ${tag}`, csvSource: 'discover', csvAccountLabel: tag }).returning({ id: ledgerAccounts.id });
  return l.id;
}
const stored = async (ledgerAccountId: string, closingDate: string) =>
  (await db.select().from(ledgerStatements).where(and(eq(ledgerStatements.ledgerAccountId, ledgerAccountId), eq(ledgerStatements.closingDate, closingDate))))[0];
const form = (ledgerAccountId: string, over: Partial<Record<string, unknown>> = {}) => ({
  ledgerAccountId,
  closingDate: '2026-05-14',
  periodStart: '',
  nextClosingDate: '',
  startsNewCycle: false,
  charges: '',
  credits: '',
  ...over,
});

describe('a recorded statement', () => {
  it('is edited in place: totals added, corrected and cleared, the closing day change undone', async () => {
    const id = await ledger();
    expect(await recordStatement(form(id, { startsNewCycle: true }))).toMatchObject({ ok: true });
    expect(await editRecordedStatement(form(id, { periodStart: '2026-04-15', charges: '1,234.56', credits: '78.90', startsNewCycle: false }))).toMatchObject({
      ok: true,
      message: 'Statement closing 2026-05-14 updated.',
    });
    expect(await stored(id, '2026-05-14')).toMatchObject({ periodStart: '2026-04-15', chargesCents: 1_234_560, creditsCents: 78_900, startsNewCycle: false, source: 'owner' });
    // A mistyped total corrected, then cleared.
    expect(await editRecordedStatement(form(id, { periodStart: '2026-04-15', charges: '1,243.56', credits: '78.90' }))).toMatchObject({ ok: true });
    expect((await stored(id, '2026-05-14')).chargesCents).toBe(1_243_560);
    expect(await editRecordedStatement(form(id, { periodStart: '2026-04-15' }))).toMatchObject({ ok: true });
    expect(await stored(id, '2026-05-14')).toMatchObject({ chargesCents: null, creditsCents: null });
    expect((await db.select().from(ledgerStatements).where(eq(ledgerStatements.ledgerAccountId, id))).length).toBe(1);
  });

  it('is not recorded a second time: recording its closing date again is refused and changes nothing', async () => {
    const id = await ledger();
    await recordStatements(id, [{ closingDate: '2026-05-14', chargesCents: 10_000, creditsCents: 2_000 }], 'owner');
    expect(await recordStatement(form(id, { charges: '5.00' }))).toEqual({
      error: 'A statement closing 2026-05-14 is already recorded. Use Edit beside it in the list to change it.',
    });
    expect((await stored(id, '2026-05-14')).chargesCents).toBe(10_000);
  });

  it('that is gone is said to be gone', async () => {
    const id = await ledger();
    expect(await editRecordedStatement(form(id))).toEqual({ error: 'The statement closing 2026-05-14 is no longer recorded.' });
  });
});

describe('a statement from a statement check', () => {
  it('keeps the check’s period and totals, refusing an edit of them, and takes the rest', async () => {
    const acc = await account();
    await sync(acc, {
      added: [
        ptxn(acc, { date: '2026-03-04', authorizedDate: null, amountCents: 42_000 }),
        ptxn(acc, { date: '2026-03-18', authorizedDate: null, amountCents: -12_000, descriptionRaw: 'PAYMENT RECEIVED' }),
      ],
    });
    const id = acc.ledgerAccountId;
    // Recorded by hand first, with the wrong totals; the check then passes over it.
    await recordStatements(id, [{ closingDate: '2026-03-31', chargesCents: 41_000, creditsCents: 12_000 }], 'owner');
    expect(
      await recordStatementCheck(acc.accountId, { from: '2026-03-01', to: '2026-03-31', charges: '42.00', credits: '12.00', excludedKeys: [], confirmed: true }, 'pass'),
    ).toMatchObject({ ok: true });
    // The figures are now the check's, and so is the statement.
    expect(await stored(id, '2026-03-31')).toMatchObject({ source: 'verification', periodStart: '2026-03-01', chargesCents: 42_000, creditsCents: 12_000 });

    const same = { closingDate: '2026-03-31', periodStart: '2026-03-01', charges: '42.00', credits: '12.00' };
    expect(await editRecordedStatement(form(id, { ...same, charges: '43.00' }))).toMatchObject({ error: expect.stringMatching(/statement check’s/) });
    expect(await editRecordedStatement(form(id, { ...same, periodStart: '2026-02-28' }))).toMatchObject({ error: expect.stringMatching(/statement check’s/) });
    expect((await stored(id, '2026-03-31')).chargesCents).toBe(42_000);
    expect(await editRecordedStatement(form(id, { ...same, nextClosingDate: '2026-04-30' }))).toMatchObject({ ok: true });
    expect(await stored(id, '2026-03-31')).toMatchObject({ source: 'verification', nextClosingDate: '2026-04-30', chargesCents: 42_000 });
  });
});
