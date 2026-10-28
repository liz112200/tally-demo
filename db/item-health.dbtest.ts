// Slice 4 (BANK-SYNC.md): the Item's health during a sync, pausing, and the
// deliberate removal of a login. Each path is driven through the app's own
// code with an injected provider; none of them may move money.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, bankConnections, ledgerAccounts } from './schema';
import {
  commitAccountSync,
  getSyncTarget,
  markConnectionRemoved,
  setConnectionPaused,
} from './queries';
import { refreshItemHealth, removeConnection, syncAccounts } from './bank-sync';
import {
  account,
  fakeProvider,
  moneySnapshot,
  owner,
  person,
  ptxn,
  row,
  rowById,
  split,
  sync,
  type TestAccount,
} from './test/fixtures';
import { waitForLockWait, whileHeld } from './test/locks';
import { loadRecording, replay } from './test/replay';
import { createPlaidProvider } from '@/lib/bank-sync/plaid/provider';
import { AccessToken } from '@/lib/bank-sync/access-token';
import { PlaidApiError } from '@/lib/bank-sync/plaid/client';
import { SyncBudgetExceededError, type BankProvider, type SyncFetch } from '@/lib/bank-sync/provider';

const token = new AccessToken('access-sandbox-test');

const plaidError = (errorType: string, errorCode: string) =>
  new PlaidApiError(400, { errorType, errorCode, message: 'test', displayMessage: null, requestId: null });

const fetchOf = (added: SyncFetch['added'], nextCursor = `cursor-${Math.random()}`): SyncFetch => ({
  added,
  modified: [],
  removed: [],
  nextCursor,
  readiness: 'historical',
  pages: 1,
  restarts: 0,
  ms: 1,
});

async function connection(id: string) {
  const [c] = await db.select().from(bankConnections).where(eq(bankConnections.id, id));
  return c;
}

async function accountRow(id: string) {
  const [a] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id));
  return a;
}

// A second enabled account on the same connection.
async function secondAccount(acc: TestAccount): Promise<TestAccount> {
  const providerAccountId = `acc-second-${Math.random().toString(36).slice(2)}`;
  const [ledger] = await db
    .insert(ledgerAccounts)
    .values({ displayName: 'Zed Checking ••1111', cutoverConfirmedAt: new Date() })
    .returning({ id: ledgerAccounts.id });
  const [a] = await db
    .insert(bankAccounts)
    .values({
      connectionId: acc.connectionId,
      providerAccountId,
      name: 'Zed Checking',
      mask: '1111',
      type: 'depository',
      syncEnabled: true,
      ledgerAccountId: ledger.id,
    })
    .returning({ id: bankAccounts.id });
  return { ...acc, accountId: a.id, providerAccountId, ledgerAccountId: ledger.id };
}

async function runSync(acc: TestAccount, provider: BankProvider) {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { lines, complete } = await syncAccounts({ target: (await getSyncTarget(acc.connectionId))!, accessToken: token, provider, rules: [] });
  const log = logged.mock.calls.flat().join(' ');
  vi.restoreAllMocks();
  return { lines, complete, log };
}

// A posted row with a settled-looking split and a pending row, so a test can
// see that nothing it does reaches either.
async function builtOnScenario() {
  const o = await owner();
  const alex = await person('Alex');
  const acc = await account();
  const posted = ptxn(acc, { amountCents: 60_000, descriptionRaw: 'DINNER' });
  const hold = ptxn(acc, { amountCents: 12_000, pending: true, descriptionRaw: 'HOLD' });
  await sync(acc, { added: [posted, hold] });
  const r = await row(acc, posted.providerTransactionId);
  await split(r.id, 60_000, [
    { personId: o, amountCents: 30_000 },
    { personId: alex, amountCents: 30_000 },
  ]);
  return { acc, r, pending: await row(acc, hold.providerTransactionId), before: await moneySnapshot() };
}

describe('health during a sync', () => {
  it('a healthy Item is recorded, its institution and consent refreshed, and the accounts sync', async () => {
    const acc = await account();
    const provider = fakeProvider(acc, {
      getItem: async () => ({
        itemId: acc.providerItemId,
        institutionId: 'ins_127287',
        institutionName: 'Platypus OAuth Bank',
        errorCode: null,
        consentExpiresAt: '2027-01-20T00:00:00Z',
      }),
      syncTransactions: async () => fetchOf([ptxn(acc)]),
    });
    const { lines } = await runSync(acc, provider);
    expect(lines).toEqual(['Test Card ••0000: 1 new.']);
    expect(await connection(acc.connectionId)).toMatchObject({
      itemErrorCode: null,
      institutionId: 'ins_127287',
      institutionName: 'Platypus OAuth Bank',
      consentExpiresAt: new Date('2027-01-20T00:00:00Z'),
    });
    expect((await connection(acc.connectionId)).healthCheckedAt).not.toBeNull();
  });

  it('an Item that needs the owner is not fetched at all: the error is recorded and nothing moves', async () => {
    const { acc, before } = await builtOnScenario();
    const cursor = (await accountRow(acc.accountId)).syncCursor;
    const fetches = vi.fn();
    const provider = fakeProvider(acc, {
      getItem: async () => ({ itemId: acc.providerItemId, institutionId: null, institutionName: null, errorCode: 'ITEM_LOGIN_REQUIRED', consentExpiresAt: null }),
      syncTransactions: fetches,
    });
    const { lines, complete } = await runSync(acc, provider);
    expect(fetches).not.toHaveBeenCalled();
    expect(lines).toEqual(['Nothing synced: the login needs reconnecting.']);
    expect(complete).toBe(false);
    expect((await connection(acc.connectionId)).itemErrorCode).toBe('ITEM_LOGIN_REQUIRED');
    expect((await accountRow(acc.accountId)).syncCursor).toBe(cursor);
    expect(await moneySnapshot()).toEqual(before);
  });

  it("on Plaid's recorded response after reset_login, the real client reads the code and nothing is fetched", async () => {
    const recording = loadRecording('sandbox-dynamic.json');
    const acc = await account(recording.account.account_id);
    const r = replay(recording, { itemId: acc.providerItemId, itemHealth: 'login_required' });
    const pages = r.remaining();
    const provider = createPlaidProvider({ clientId: 'test', secret: 'test', env: 'sandbox', fetch: r.impl });
    const before = await moneySnapshot();
    const { lines } = await runSync(acc, provider);
    expect(lines).toEqual(['Nothing synced: the login needs reconnecting.']);
    expect(r.remaining()).toBe(pages);
    expect((await connection(acc.connectionId)).itemErrorCode).toBe('ITEM_LOGIN_REQUIRED');
    expect(await moneySnapshot()).toEqual(before);
  });

  it('a login error on the first account stops the rest; the error belongs to the connection, not the account', async () => {
    const acc = await account();
    const second = await secondAccount(acc);
    const fetched: string[] = [];
    const provider = fakeProvider(acc, {
      syncTransactions: async (_t, { providerAccountId }) => {
        fetched.push(providerAccountId);
        throw plaidError('ITEM_ERROR', 'ITEM_LOGIN_REQUIRED');
      },
    });
    const { lines, complete } = await runSync(acc, provider);
    // Accounts sync in name order: Test Card, then Zed Checking.
    expect(fetched).toEqual([acc.providerAccountId]);
    expect(lines).toEqual(['Not synced (the login needs reconnecting): Test Card ••0000, Zed Checking ••1111.']);
    expect(complete).toBe(false);
    expect((await connection(acc.connectionId)).itemErrorCode).toBe('ITEM_LOGIN_REQUIRED');
    expect((await accountRow(acc.accountId)).lastSyncError).toBeNull();
    expect((await accountRow(second.accountId)).lastSyncError).toBeNull();
  });

  it('a login paused while it syncs says so once, naming every account left, not once per account', async () => {
    const acc = await account();
    await secondAccount(acc);
    const fetched: string[] = [];
    const provider = fakeProvider(acc, {
      syncTransactions: async (_t, { providerAccountId }) => {
        fetched.push(providerAccountId);
        await setConnectionPaused(acc.connectionId, true);
        return fetchOf([]);
      },
    });
    const { lines, complete } = await runSync(acc, provider);
    expect(fetched).toEqual([acc.providerAccountId]);
    expect(lines).toEqual(['Nothing more applied; the login was paused while it synced: Test Card ••0000, Zed Checking ••1111.']);
    expect(complete).toBe(false);
  });

  it('says when Plaid has sent only a new login\'s first 30 days, so older totals are not final', async () => {
    const acc = await account();
    const provider = fakeProvider(acc, { syncTransactions: async () => ({ ...fetchOf([ptxn(acc)]), readiness: 'initial' }) });
    const { lines } = await runSync(acc, provider);
    expect(lines).toEqual(['Test Card ••0000: 1 new. Plaid has sent only the last 30 days so far; sync again later for the rest.']);
  });

  it('an Item error the classifier does not know stays with its account, and the next account still syncs', async () => {
    const acc = await account();
    const second = await secondAccount(acc);
    const provider = fakeProvider(acc, {
      syncTransactions: async (_t, { providerAccountId }) => {
        if (providerAccountId === acc.providerAccountId) throw plaidError('ITEM_ERROR', 'PRODUCT_NOT_READY');
        return fetchOf([ptxn(second)]);
      },
    });
    const { lines } = await runSync(acc, provider);
    expect(lines).toEqual(['Test Card ••0000: failed. The bank provider returned PRODUCT_NOT_READY.', 'Zed Checking ••1111: 1 new.']);
    expect((await connection(acc.connectionId)).itemErrorCode).toBeNull();
    expect((await accountRow(acc.accountId)).lastSyncError).toBe('The bank provider returned PRODUCT_NOT_READY.');
  });

  it('health that cannot be read leaves the stored health alone and the sync goes on; a later healthy read clears it', async () => {
    const acc = await account();
    await db.update(bankConnections).set({ itemErrorCode: 'INSTITUTION_DOWN' }).where(eq(bankConnections.id, acc.connectionId));
    const unreadable = fakeProvider(acc, {
      getItem: async () => {
        throw new Error('fetch failed');
      },
      syncTransactions: async () => fetchOf([ptxn(acc)]),
    });
    const { lines, log } = await runSync(acc, unreadable);
    expect(lines).toEqual(['Test Card ••0000: 1 new.']);
    expect(log).toContain(`health: connection ${acc.connectionId}: fetch failed`);
    expect((await connection(acc.connectionId)).itemErrorCode).toBe('INSTITUTION_DOWN');

    expect(await refreshItemHealth({ connectionId: acc.connectionId, providerItemId: acc.providerItemId, accessToken: token, provider: fakeProvider(acc, {}) })).toBeNull();
    expect((await connection(acc.connectionId)).itemErrorCode).toBeNull();
  });

  it('a health read for a different Item is refused, not recorded', async () => {
    const acc = await account();
    const other = fakeProvider({ providerItemId: 'item-someone-else' }, {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await refreshItemHealth({ connectionId: acc.connectionId, providerItemId: acc.providerItemId, accessToken: token, provider: other })).toBeUndefined();
    vi.restoreAllMocks();
    expect((await connection(acc.connectionId)).healthCheckedAt).toBeNull();
  });
});

describe('pausing', () => {
  it('a paused login applies nothing and keeps its cursor; resuming continues from it', async () => {
    const acc = await account();
    await sync(acc, { added: [ptxn(acc)] });
    const cursor = (await accountRow(acc.accountId)).syncCursor;
    expect(await setConnectionPaused(acc.connectionId, true)).toEqual({ ok: true });
    expect((await getSyncTarget(acc.connectionId))!.status).toBe('paused');

    const late = ptxn(acc, { descriptionRaw: 'FETCHED BEFORE THE PAUSE' });
    const outcome = await commitAccountSync({
      connectionId: acc.connectionId,
      accountId: acc.accountId,
      providerAccountId: acc.providerAccountId,
      startCursor: cursor,
      nextCursor: 'cursor-after',
      added: [late],
      modified: [],
      removed: [],
      rules: [],
    });
    expect(outcome).toEqual({ kind: 'inactive', status: 'paused' });
    expect((await accountRow(acc.accountId)).syncCursor).toBe(cursor);
    expect(await row(acc, late.providerTransactionId)).toBeUndefined();

    expect(await setConnectionPaused(acc.connectionId, false)).toEqual({ ok: true });
    expect((await sync(acc, { added: [late] })).kind).toBe('applied');
  });

  it('a pause waits for a commit already holding the lock, which applies first', async () => {
    const acc = await account();
    const t = ptxn(acc, { descriptionRaw: 'IN FLIGHT' });
    // The commit takes the connection lock and reads "active", then blocks
    // locking the rows it may touch; the pause must queue behind it.
    const { commit, pause } = await whileHeld('lock table transactions in exclusive mode', async () => {
      const commit = sync(acc, { added: [t] });
      await waitForLockWait('%for update%');
      const pause = setConnectionPaused(acc.connectionId, true);
      await waitForLockWait('%pg_advisory_xact_lock%');
      return { commit, pause };
    });
    expect((await commit).kind).toBe('applied');
    expect(await pause).toEqual({ ok: true });
    expect(await row(acc, t.providerTransactionId)).toBeDefined();
    expect((await connection(acc.connectionId)).status).toBe('paused');
  });
});

describe('removing a login', () => {
  it('erases the token, stops every account and deletes only pending rows; posted rows, splits and balances stay', async () => {
    const { acc, r, pending, before } = await builtOnScenario();
    const removeItem = vi.fn(async () => {});
    expect(await removeConnection({ connectionId: acc.connectionId, accessToken: token, provider: fakeProvider(acc, { removeItem }) })).toEqual({
      ok: true,
      pendingDeleted: 1,
    });
    expect(removeItem).toHaveBeenCalledTimes(1);
    const c = await connection(acc.connectionId);
    expect(c).toMatchObject({ status: 'removed', accessTokenSealed: null });
    expect(c.removedAt).not.toBeNull();
    expect((await accountRow(acc.accountId)).syncEnabled).toBe(false);
    expect((await rowById(pending.id)).deletedAt).not.toBeNull();
    expect(await rowById(r.id)).toMatchObject({ deletedAt: null, amountCents: 60_000 });
    expect(await moneySnapshot()).toEqual(before);

    expect(await getSyncTarget(acc.connectionId)).toBeNull();
    expect(await setConnectionPaused(acc.connectionId, false)).toEqual({ error: 'This login was removed; it cannot sync again.' });
    expect(await markConnectionRemoved(acc.connectionId)).toEqual({ ok: true, pendingDeleted: 0, alreadyRemoved: true });
  });

  it('a provider refusal changes nothing', async () => {
    const { acc, pending, before } = await builtOnScenario();
    const provider = fakeProvider(acc, {
      removeItem: async () => {
        throw plaidError('API_ERROR', 'INTERNAL_SERVER_ERROR');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await removeConnection({ connectionId: acc.connectionId, accessToken: token, provider })).toEqual({
      error: 'The bank provider returned INTERNAL_SERVER_ERROR.',
    });
    vi.restoreAllMocks();
    expect(await connection(acc.connectionId)).toMatchObject({ status: 'active', accessTokenSealed: 'v1:test:not:a-token' });
    expect((await accountRow(acc.accountId)).syncEnabled).toBe(true);
    expect((await rowById(pending.id)).deletedAt).toBeNull();
    expect(await moneySnapshot()).toEqual(before);
  });

  it('after the provider half succeeded and the database half failed: says so, changed nothing here, and a retry finishes', async () => {
    const { acc, pending, before } = await builtOnScenario();
    // Make the database half fail for this connection only.
    await db.execute(sql.raw(`
      create function refuse_test_removal() returns trigger language plpgsql as $$
      begin raise exception 'test: database half fails'; end; $$;
      create trigger refuse_test_removal before update on bank_connections
      for each row when (old.id = '${acc.connectionId}') execute function refuse_test_removal();`));
    // Plaid's own answers, recorded on one Sandbox Item: the first
    // /item/remove ends it, the second gets ITEM_NOT_FOUND.
    const recorded: { calls: { path: string; status: number; response: string }[] } = JSON.parse(
      readFileSync(join(process.cwd(), 'tests/fixtures/plaid/sandbox-item-remove.json'), 'utf8'),
    );
    let removed = 0;
    const provider = createPlaidProvider({
      clientId: 'test',
      secret: 'test',
      env: 'sandbox',
      fetch: (async (url: string | URL | Request) => {
        if (new URL(String(url)).pathname !== '/item/remove') throw new Error(`unexpected request to ${url}`);
        const call = recorded.calls[Math.min(removed++, 1)];
        return new Response(call.response, { status: call.status, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await removeConnection({ connectionId: acc.connectionId, accessToken: token, provider })).toEqual({
        error: "Plaid's access to this login has ended, but recording that here failed. Remove it again to finish; that uses nothing at Plaid.",
        providerDone: true,
      });
    } finally {
      vi.restoreAllMocks();
      await db.execute(sql.raw('drop trigger refuse_test_removal on bank_connections; drop function refuse_test_removal();'));
    }
    expect(await connection(acc.connectionId)).toMatchObject({ status: 'active', accessTokenSealed: 'v1:test:not:a-token' });
    expect((await rowById(pending.id)).deletedAt).toBeNull();

    expect(await removeConnection({ connectionId: acc.connectionId, accessToken: token, provider })).toEqual({ ok: true, pendingDeleted: 1 });
    expect(removed).toBe(2);
    expect((await connection(acc.connectionId)).status).toBe('removed');
    expect(await moneySnapshot()).toEqual(before);
  });

  it('a commit in flight applies first; a commit after the removal applies nothing', async () => {
    const acc = await account();
    const t = ptxn(acc, { descriptionRaw: 'BEFORE REMOVAL' });
    const { commit, removal } = await whileHeld('lock table transactions in exclusive mode', async () => {
      const commit = sync(acc, { added: [t] });
      await waitForLockWait('%for update%');
      const removal = markConnectionRemoved(acc.connectionId);
      await waitForLockWait('%pg_advisory_xact_lock%');
      return { commit, removal };
    });
    expect((await commit).kind).toBe('applied');
    expect(await removal).toMatchObject({ ok: true, alreadyRemoved: false });
    expect(await row(acc, t.providerTransactionId)).toBeDefined();

    const after = await commitAccountSync({
      connectionId: acc.connectionId,
      accountId: acc.accountId,
      providerAccountId: acc.providerAccountId,
      startCursor: (await accountRow(acc.accountId)).syncCursor,
      nextCursor: 'cursor-after-removal',
      added: [ptxn(acc)],
      modified: [],
      removed: [],
      rules: [],
    });
    expect(after).toEqual({ kind: 'inactive', status: 'removed' });
  });
});

describe('the fetch time budget', () => {
  it('says nothing from that run was saved and the place is unchanged, names the accounts not reached, and records no failure', async () => {
    const acc = await account();
    const second = await secondAccount(acc);
    const cursor = (await accountRow(acc.accountId)).syncCursor;
    const provider = fakeProvider(acc, {
      syncTransactions: async () => {
        throw new SyncBudgetExceededError(3, 241_000);
      },
    });
    const { lines, complete } = await runSync(acc, provider);
    expect(lines).toEqual([
      'Test Card ••0000: stopped after 4 minutes, before its history finished arriving. Nothing from this run was saved and its ' +
        'place is unchanged, so Sync now starts this account over; accounts above kept what they fetched.',
      'Not reached this run: Zed Checking ••1111.',
    ]);
    expect(complete).toBe(false);
    expect(await accountRow(acc.accountId)).toMatchObject({ syncCursor: cursor, lastSyncError: null });
    expect((await accountRow(second.accountId)).lastSyncError).toBeNull();
  });
});
