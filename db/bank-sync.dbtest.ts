// Bank sync against a real Postgres (BANK-SYNC.md, slice 3). The rule under
// test: automatic sync produces a flag, never a balance change. Then each way
// of resolving a flag, with the balance change it is documented to make,
// exact to the mill.
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, settlements } from './schema';
import {
  clearBankFlag,
  deleteSplitByTransactionId,
  getDebtShares,
  getReplacementCandidates,
  getSyncTarget,
  insertExternalExpense,
  insertSettlementWithAllocations,
  moveBuiltOnToReplacement,
  recordSettlementGroup,
  softDeleteTransactionById,
  updateTransactionNoteById,
} from './queries';
import { syncAccounts } from './bank-sync';
import {
  account,
  balanceOf,
  creditOf,
  fakeProvider,
  moneySnapshot,
  owner,
  person,
  ptxn,
  removal,
  row,
  rowById,
  split,
  sync,
  type TestAccount,
} from './test/fixtures';
import { loadRecording, recordedTransactions, replay } from './test/replay';
import { AccessToken } from '@/lib/bank-sync/access-token';
import { createPlaidProvider } from '@/lib/bank-sync/plaid/provider';
import type { BankProvider } from '@/lib/bank-sync/provider';

async function settlementIdsOf(personId: string): Promise<string[]> {
  return (
    await db.select({ id: settlements.id }).from(settlements).where(eq(settlements.personId, personId))
  ).map((s) => s.id);
}

// Two split rows on one card, both fully settled: Alex paid cash for both;
// Sam's share of the first was settled by a netted payment against an
// expense Sam paid for the owner.
async function settledScenario() {
  const o = await owner();
  const alex = await person('Alex');
  const sam = await person('Sam');
  const acc = await account();
  const t1 = ptxn(acc, { amountCents: 90_000, authorizedDate: '2026-10-01', descriptionRaw: 'DINNER ONE' });
  const t3 = ptxn(acc, { amountCents: 25_000, authorizedDate: '2026-10-03', descriptionRaw: 'LUNCH THREE' });
  expect((await sync(acc, { added: [t1, t3] })).kind).toBe('applied');
  const r1 = await row(acc, t1.providerTransactionId);
  const r3 = await row(acc, t3.providerTransactionId);
  await split(r1.id, 90_000, [
    { personId: o, amountCents: 30_000 },
    { personId: alex, amountCents: 30_000 },
    { personId: sam, amountCents: 30_000 },
  ]);
  await split(r3.id, 25_000, [
    { personId: o, amountCents: 12_500 },
    { personId: alex, amountCents: 12_500 },
  ]);
  // FIFO by date: 30.000 to dinner one, 12.500 to lunch three.
  await insertSettlementWithAllocations({ personId: alex, amountCents: 42_500, direction: 'incoming', date: '2026-10-05', note: null });
  const { shareId: owedToSam } = await insertExternalExpense({
    payerPersonId: sam,
    ownerId: o,
    amountCents: 10_000,
    date: '2026-10-02',
    description: 'Tickets Sam bought',
  });
  const samShare = (await getDebtShares()).find((s) => s.counterpartyId === sam && s.transactionId === r1.id)!;
  await recordSettlementGroup({
    personId: sam,
    date: '2026-10-06',
    note: null,
    incoming: [{ shareId: samShare.shareId, amountCents: 30_000 }],
    outgoing: [{ shareId: owedToSam, amountCents: 10_000 }],
    pinnedCashCents: null,
    fallbackDirection: 'incoming',
    replaceId: null,
  });
  const before = await moneySnapshot();
  expect(balanceOf(before, alex)?.netCents).toBe(0);
  expect(balanceOf(before, sam)).toMatchObject({ theyOweMeCents: 0, iOweThemCents: 0, netCents: 0 });
  return { o, alex, sam, acc, t1, t3, r1, r3, before };
}

describe('a sync that changes split, settled rows changes no balance', () => {
  it('modify and remove: rows updated and flagged; every split, share, settlement, allocation and balance identical', async () => {
    const s = await settledScenario();
    const outcome = await sync(s.acc, {
      modified: [{ ...s.t1, amountCents: 95_000 }],
      removed: [removal(s.acc, s.t3.providerTransactionId)],
    });
    expect(outcome).toMatchObject({ kind: 'applied', counts: { updated: 1, amountFlagged: 1, removedFlagged: 1, removedDeleted: 0 } });
    expect(await moneySnapshot()).toEqual(s.before);
    expect(await rowById(s.r1.id)).toMatchObject({ amountCents: 95_000, bankAmountBeforeCents: 90_000, deletedAt: null });
    const r3 = await rowById(s.r3.id);
    expect(r3.deletedAt).toBeNull();
    expect(r3.removedByBankAt).not.toBeNull();
  });
});

describe('resolving the flags', () => {
  it('re-saving the split at the new amount: each person owes exactly the difference, paid amounts re-applied', async () => {
    const s = await settledScenario();
    await sync(s.acc, { modified: [{ ...s.t1, amountCents: 95_000 }] });
    await split(s.r1.id, 95_000, [
      { personId: s.o, amountCents: 31_670 },
      { personId: s.alex, amountCents: 31_670 },
      { personId: s.sam, amountCents: 31_660 },
    ]);
    const after = await moneySnapshot();
    // The engine's whole-cent shares of $95.00, less the $30.00 each already
    // paid toward the old share: the old payments cover it; the rest is owed.
    expect(balanceOf(after, s.alex)).toMatchObject({ theyOweMeCents: 1_670, netCents: 1_670 });
    expect(balanceOf(after, s.sam)).toMatchObject({ theyOweMeCents: 1_660, iOweThemCents: 0, netCents: 1_660 });
    for (const id of [...(await settlementIdsOf(s.alex)), ...(await settlementIdsOf(s.sam))]) {
      expect(creditOf(after, id)).toBe(0);
    }
    expect((await rowById(s.r1.id)).bankAmountBeforeCents).toBeNull();
  });

  it('re-saving at a lower amount: the overpaid part becomes credit, nothing is owed', async () => {
    const s = await settledScenario();
    await sync(s.acc, { modified: [{ ...s.t1, amountCents: 75_000 }] });
    await split(s.r1.id, 75_000, [
      { personId: s.o, amountCents: 25_000 },
      { personId: s.alex, amountCents: 25_000 },
      { personId: s.sam, amountCents: 25_000 },
    ]);
    const after = await moneySnapshot();
    expect(balanceOf(after, s.alex)?.netCents).toBe(0);
    const [alexPayment] = await settlementIdsOf(s.alex);
    expect(creditOf(after, alexPayment)).toBe(5_000);
  });

  it('removing the split of a removed row: what was paid against it becomes credit', async () => {
    const s = await settledScenario();
    await sync(s.acc, { removed: [removal(s.acc, s.t3.providerTransactionId)] });
    await deleteSplitByTransactionId(s.r3.id);
    const after = await moneySnapshot();
    expect(balanceOf(after, s.alex)?.netCents).toBe(0);
    const [alexPayment] = await settlementIdsOf(s.alex);
    expect(creditOf(after, alexPayment)).toBe(12_500);
  });

  it('deleting a removed row: its allocations stop counting and return to credit; the bank marker is cleared', async () => {
    const s = await settledScenario();
    await sync(s.acc, { removed: [removal(s.acc, s.t3.providerTransactionId)] });
    await softDeleteTransactionById(s.r3.id);
    const after = await moneySnapshot();
    expect(balanceOf(after, s.alex)?.netCents).toBe(0);
    const [alexPayment] = await settlementIdsOf(s.alex);
    expect(creditOf(after, alexPayment)).toBe(12_500);
    const r3 = await rowById(s.r3.id);
    expect(r3.deletedAt).not.toBeNull();
    expect(r3.removedByBankAt).toBeNull();
  });

  it('dismissing a flag changes nothing but the flag, and is a no-op the second time', async () => {
    const s = await settledScenario();
    await sync(s.acc, { modified: [{ ...s.t1, amountCents: 95_000 }] });
    const flagged = await moneySnapshot();
    await clearBankFlag(s.r1.id, 'amount');
    await clearBankFlag(s.r1.id, 'amount');
    expect(await moneySnapshot()).toEqual(flagged);
    expect((await rowById(s.r1.id)).bankAmountBeforeCents).toBeNull();
  });

  it('remove and identical re-add in one sync: the row takes the new id; split and payments untouched', async () => {
    const s = await settledScenario();
    const readded = { ...s.t3, providerTransactionId: `${s.t3.providerTransactionId}-new`, raw: { transaction_id: 'new' } };
    const outcome = await sync(s.acc, { added: [readded], removed: [removal(s.acc, s.t3.providerTransactionId)] });
    expect(outcome).toMatchObject({ kind: 'applied', counts: { reidentified: 1, inserted: 0, removedFlagged: 0 } });
    expect(await moneySnapshot()).toEqual(s.before);
    expect(await rowById(s.r3.id)).toMatchObject({
      providerTransactionId: readded.providerTransactionId,
      deletedAt: null,
      removedByBankAt: null,
    });
  });

  it('moving the split to a re-added row sync could not pair: shares and payments untouched, old row deleted', async () => {
    const s = await settledScenario();
    await updateTransactionNoteById(s.r3.id, 'with the team');
    // Re-added with a changed description, so sync does not pair it.
    const readded = { ...s.t3, providerTransactionId: `${s.t3.providerTransactionId}-b`, descriptionRaw: 'LUNCH THREE #2' };
    const outcome = await sync(s.acc, { added: [readded], removed: [removal(s.acc, s.t3.providerTransactionId)] });
    expect(outcome).toMatchObject({ kind: 'applied', counts: { removedFlagged: 1, inserted: 1 } });
    const target = await row(s.acc, readded.providerTransactionId);
    const candidates = await getReplacementCandidates([s.r3.id]);
    expect(candidates.get(s.r3.id)?.map((c) => c.id)).toEqual([target.id]);

    expect(await moveBuiltOnToReplacement(s.r3.id, target.id)).toEqual({ ok: true });
    const after = await moneySnapshot();
    expect(after.tables.shares).toEqual(s.before.tables.shares);
    expect(after.tables.settlements).toEqual(s.before.tables.settlements);
    expect(after.tables.allocations).toEqual(s.before.tables.allocations);
    expect(after.balances).toEqual(s.before.balances);
    expect(after.credit).toEqual(s.before.credit);
    const movedSplit = (after.tables.splits as unknown as { transaction_id: string }[]).filter(
      (x) => x.transaction_id === target.id,
    );
    expect(movedSplit).toHaveLength(1);
    expect((await rowById(s.r3.id)).deletedAt).not.toBeNull();
    expect((await rowById(target.id)).note).toBe('with the team');
    // A second attempt finds nothing to move.
    expect(await moveBuiltOnToReplacement(s.r3.id, target.id)).toEqual({
      error: 'This row is no longer flagged as removed by the bank.',
    });
  });
});

describe('a failure partway through a commit', () => {
  beforeAll(async () => {
    await db.execute(sql`
      create or replace function test_fail_insert() returns trigger language plpgsql as $$
      begin
        if new.description_raw = 'FAIL-INSERT' then
          raise exception 'test failure for %', new.description_raw using errcode = '23514';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger test_fail_insert before insert on transactions for each row execute function test_fail_insert()`);
  });
  afterAll(async () => {
    await db.execute(sql`drop trigger if exists test_fail_insert on transactions`);
    await db.execute(sql`drop function if exists test_fail_insert()`);
  });

  it('rolls back everything, keeps the cursor, and shows and logs no database text', async () => {
    const s = await settledScenario();
    const [{ cursor: cursorBefore }] = await db
      .select({ cursor: bankAccounts.syncCursor })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, s.acc.accountId));
    // The update to dinner one is applied before the failing insert.
    const fetched = {
      added: [ptxn(s.acc, { descriptionRaw: 'FAIL-INSERT' })],
      modified: [{ ...s.t1, amountCents: 95_000 }],
      removed: [],
      nextCursor: 'cursor-after-failure',
      readiness: 'historical' as const,
      pages: 1,
      restarts: 0,
      ms: 1,
    };
    const provider = fakeProvider(s.acc, { syncTransactions: async () => fetched });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { lines } = await syncAccounts({
      target: (await getSyncTarget(s.acc.connectionId))!,
      accessToken: new AccessToken('test'),
      provider,
      rules: [],
    });
    expect(lines).toEqual(['Test Card ••0000: failed. The database refused the change.']);
    const logText = logged.mock.calls.flat().join(' ');
    expect(logText).toContain('database error 23514');
    expect(logText).not.toMatch(/FAIL-INSERT|insert into|select|test failure/i);
    vi.restoreAllMocks();

    expect(await rowById(s.r1.id)).toMatchObject({ amountCents: 90_000, bankAmountBeforeCents: null });
    const [acc] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, s.acc.accountId));
    expect(acc.syncCursor).toBe(cursorBefore);
    expect(acc.lastSyncError).toBe('The database refused the change.');
    expect(await moneySnapshot()).toEqual(s.before);
  });
});

describe('recorded Sandbox responses through the real Plaid client', () => {
  const recording = loadRecording('sandbox-dynamic.json');
  const recorded = recordedTransactions(recording);

  async function run(acc: TestAccount, provider: BankProvider) {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { lines } = await syncAccounts({
      target: (await getSyncTarget(acc.connectionId))!,
      accessToken: new AccessToken('access-sandbox-test'),
      provider,
      rules: [],
    });
    vi.restoreAllMocks();
    return lines;
  }

  it('history with pending rows, then posted rows taking them over in place; then a modified and removed posted row', async () => {
    const acc = await account(recording.account.account_id);
    const r = replay(recording, { itemId: acc.providerItemId });
    const provider = createPlaidProvider({ clientId: 'test', secret: 'test', env: 'sandbox', fetch: r.impl });

    // Round 1: the account's history, two of them pending.
    expect(await run(acc, provider)).toEqual(['Test Card ••0000: 64 new (2 pending).']);
    const firstPage = JSON.parse(recording.rounds[0][0].response);
    const pendingIds: string[] = firstPage.added.filter((t: { pending: boolean }) => t.pending).map((t: { transaction_id: string }) => t.transaction_id);
    const pendingRows = await Promise.all(pendingIds.map((id) => row(acc, id)));
    expect(pendingRows.every((p) => p.pending)).toBe(true);
    await updateTransactionNoteById(pendingRows[0].id, 'school lunch money');

    // Round 2: Plaid had nothing new.
    expect(await run(acc, provider)).toEqual(['Test Card ••0000: no changes.']);

    // Round 3: both pending rows post (same row id, note kept); three new pending.
    expect(await run(acc, provider)).toEqual(['Test Card ••0000: 3 new (3 pending), 2 posted.']);
    for (const p of pendingRows) {
      const now = await rowById(p.id);
      expect(now.pending).toBe(false);
      expect(now.deletedAt).toBeNull();
      expect(now.providerTransactionId).not.toBe(p.providerTransactionId);
    }
    expect((await rowById(pendingRows[0].id)).note).toBe('school lunch money');
    const live = (await db.execute(sql`
      select count(*)::int as n, count(*) filter (where pending)::int as pending
      from transactions where bank_account_id = ${acc.accountId} and deleted_at is null`)) as unknown as { n: number; pending: number }[];
    expect(live[0]).toEqual({ n: 67, pending: 3 });
    expect(r.remaining()).toBe(0);

    // What Sandbox cannot produce: the bank changes the amount of a posted row
    // that is split and settled, and removes two posted rows, one with a note.
    const posted = [...recorded.values()].filter((t) => !t.pending && Number(t.amount) > 0);
    const [toModify, toFlag, toDelete] = posted;
    const o = await owner();
    const alex = await person('Alex');
    const modRow = await row(acc, toModify.transaction_id as string);
    const half = modRow.amountCents / 2;
    expect(Number.isInteger(half)).toBe(true);
    await split(modRow.id, modRow.amountCents, [
      { personId: o, amountCents: half },
      { personId: alex, amountCents: half },
    ]);
    await insertSettlementWithAllocations({ personId: alex, amountCents: half, direction: 'incoming', date: '2026-10-20', note: null });
    await updateTransactionNoteById((await row(acc, toFlag.transaction_id as string)).id, 'kept');
    const before = await moneySnapshot();

    r.append({
      // Built as a decimal string first so the JSON carries exactly 1.00 more.
      modified: [{ ...toModify, amount: Number((Number(toModify.amount) + 1).toFixed(2)) }],
      removed: [toFlag, toDelete].map((t) => ({ transaction_id: t.transaction_id as string, account_id: recording.account.account_id })),
    });
    expect(await run(acc, provider)).toEqual(['Test Card ••0000: 1 updated, 1 removed by the bank, 2 need review.']);
    expect(await moneySnapshot()).toEqual(before);
    expect(await rowById(modRow.id)).toMatchObject({
      amountCents: modRow.amountCents + 1_000,
      bankAmountBeforeCents: modRow.amountCents,
    });
    const flagged = await row(acc, toFlag.transaction_id as string);
    expect(flagged.deletedAt).toBeNull();
    expect(flagged.removedByBankAt).not.toBeNull();
    const gone = await row(acc, toDelete.transaction_id as string);
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.removedByBankAt).not.toBeNull();
  });
});

describe('a real Plaid `modified` entry for a split, settled posted row', () => {
  // Recorded from Sandbox, nothing rewritten: the first sync returned ten
  // posted rows without an authorized date; after a refresh Plaid re-sent all
  // 64 as `modified`, those ten with the authorized date filled in. Here it
  // equals the posted date, so nothing the ledger stores changes. This covers
  // Plaid sending `modified` for a split row; it does not cover a changed
  // amount or a removal, which no Sandbox run has produced.
  const recording = loadRecording('sandbox-modified.json');
  const [first, second] = recording.rounds.map((round) => round.flatMap((p) => JSON.parse(p.response)));
  const firstAdded = first.flatMap((p: { added: unknown[] }) => p.added) as Record<string, unknown>[];
  const changed = (second.flatMap((p: { modified: unknown[] }) => p.modified) as Record<string, unknown>[]).filter(
    (m) => firstAdded.find((t) => t.transaction_id === m.transaction_id)?.authorized_date !== m.authorized_date,
  );

  it('writes nothing when nothing the ledger stores changed: same row, no flag, every balance identical', async () => {
    expect(changed.length).toBe(10);
    const acc = await account(recording.account.account_id);
    const provider = createPlaidProvider({ clientId: 'test', secret: 'test', env: 'sandbox', fetch: replay(recording, { itemId: acc.providerItemId }).impl });
    const syncNow = async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const { lines } = await syncAccounts({
        target: (await getSyncTarget(acc.connectionId))!,
        accessToken: new AccessToken('access-sandbox-test'),
        provider,
        rules: [],
      });
      vi.restoreAllMocks();
      return lines;
    };
    const pending = firstAdded.filter((t) => t.pending).length;
    expect(await syncNow()).toEqual([
      `Test Card ••0000: ${firstAdded.length} new${pending > 0 ? ` (${pending} pending)` : ''}.`,
    ]);

    const target = changed.find((m) => Number(m.amount) > 0 && (Math.round(Number(m.amount) * 1000) / 2) % 1 === 0)!;
    const stored = await row(acc, target.transaction_id as string);
    // No authorized date yet: the posted date, which the filled-in one equals.
    expect(stored.date).toBe(target.date);
    expect(target.authorized_date).toBe(target.date);
    const o = await owner();
    const alex = await person('Alex');
    const half = stored.amountCents / 2;
    await split(stored.id, stored.amountCents, [
      { personId: o, amountCents: half },
      { personId: alex, amountCents: half },
    ]);
    await insertSettlementWithAllocations({ personId: alex, amountCents: half, direction: 'incoming', date: '2026-10-20', note: null });
    const before = await moneySnapshot();

    const rowBefore = await rowById(stored.id);
    expect(await syncNow()).toEqual(['Test Card ••0000: no changes.']);
    expect(await moneySnapshot()).toEqual(before);
    expect(await rowById(stored.id)).toEqual(rowBefore);
    expect(rowBefore).toMatchObject({
      date: target.date,
      amountCents: stored.amountCents,
      bankAmountBeforeCents: null,
      removedByBankAt: null,
    });
  });
});

