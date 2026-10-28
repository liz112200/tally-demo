// Concurrency, through PgBouncer in transaction mode as on Neon. Each race is
// made deterministic by a third connection holding a table lock that one side
// needs partway through its transaction, after it already holds what the test
// is about; pg_stat_activity confirms each side is really waiting before the
// lock is released. Both sides are the app's own query code.
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { splits } from './schema';
import { commitAccountSync, replaceSplit } from './queries';
import { account, owner, person, ptxn, row, rowById, sync } from './test/fixtures';
import { waitForLockWait, whileHeld } from './test/locks';

async function splitInput(transactionId: string, amountCents: number) {
  const o = await owner();
  const alex = await person('Alex');
  return {
    transactionId,
    amountCents,
    payerPersonId: o,
    method: 'equal' as const,
    taxCents: 0,
    tipCents: 0,
    shares: [
      { personId: o, amountCents: amountCents / 2, inputAmountCents: null, inputPercent: null },
      { personId: alex, amountCents: amountCents / 2, inputAmountCents: null, inputPercent: null },
    ],
  };
}

describe('a split save and a sync on the same row', () => {
  it('split commits first: the sync waits on the row, then sees the split and flags the row', async () => {
    const acc = await account();
    const t = ptxn(acc, { amountCents: 60_000 });
    await sync(acc, { added: [t] });
    const r = await row(acc, t.providerTransactionId);

    // The save takes its row lock, then blocks inserting shares.
    const { saving, syncing } = await whileHeld('lock table split_shares in access exclusive mode', async () => {
      const saving = replaceSplit(await splitInput(r.id, 60_000));
      await waitForLockWait('%split_shares%');
      // The sync blocks on the row the save holds.
      const syncing = sync(acc, { modified: [{ ...t, amountCents: 64_000 }] });
      await waitForLockWait('%for update%');
      return { saving, syncing };
    });

    expect(await saving).toEqual({ ok: true });
    expect(await syncing).toMatchObject({ kind: 'applied', counts: { updated: 1, amountFlagged: 1 } });
    expect(await rowById(r.id)).toMatchObject({ amountCents: 64_000, bankAmountBeforeCents: 60_000 });
  });

  it('sync commits first: the save waits on the row, then refuses because the amount changed', async () => {
    const acc = await account();
    const t = ptxn(acc, { amountCents: 60_000 });
    await sync(acc, { added: [t] });
    const r = await row(acc, t.providerTransactionId);

    // The sync takes its row locks, then blocks reading receipts.
    const { syncing, saving } = await whileHeld('lock table receipts in access exclusive mode', async () => {
      const syncing = sync(acc, { modified: [{ ...t, amountCents: 64_000 }] });
      await waitForLockWait('%receipts%');
      // The save, computed from the old amount, blocks on the row.
      const saving = replaceSplit(await splitInput(r.id, 60_000));
      await waitForLockWait('%for update of t%');
      return { syncing, saving };
    });

    expect(await syncing).toMatchObject({ kind: 'applied', counts: { updated: 1, amountFlagged: 0 } });
    expect(await saving).toEqual({
      error: 'The bank changed this transaction while the split was open. Reopen it and save again.',
    });
    expect(await db.select().from(splits).where(eq(splits.transactionId, r.id))).toEqual([]);
    expect(await rowById(r.id)).toMatchObject({ amountCents: 64_000, bankAmountBeforeCents: null });
  });
});

describe('two syncs of one bank login', () => {
  it('a sync that cannot take the connection lock applies nothing (busy)', async () => {
    const acc = await account();
    const t = ptxn(acc);
    await whileHeld(`select pg_advisory_xact_lock(hashtextextended('${acc.connectionId}', 0))`, async () => {
      expect(await sync(acc, { added: [t] })).toEqual({ kind: 'busy' });
    });
    expect(await row(acc, t.providerTransactionId)).toBeUndefined();
    expect(await sync(acc, { added: [t] })).toMatchObject({ kind: 'applied', counts: { inserted: 1 } });
  });

  it('a sync fetched from an outdated cursor applies nothing (stale)', async () => {
    const acc = await account();
    await sync(acc, { added: [ptxn(acc)] });
    const t = ptxn(acc);
    const outcome = await commitAccountSync({
      connectionId: acc.connectionId,
      accountId: acc.accountId,
      providerAccountId: acc.providerAccountId,
      startCursor: null,
      nextCursor: 'later',
      added: [t],
      modified: [],
      removed: [],
      rules: [],
    });
    expect(outcome).toEqual({ kind: 'stale' });
    expect(await row(acc, t.providerTransactionId)).toBeUndefined();
  });
});
