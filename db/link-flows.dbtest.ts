// Slice 4 (BANK-SYNC.md): what reloading a login's accounts may change, which
// accounts may sync, and the duplicate-login guard on a new link, driven
// through the real Server Action.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, bankConnections } from './schema';
import { markConnectionRemoved, saveConnectionAccounts, setAccountSyncEnabled } from './queries';
import { account, ptxn, type TestAccount } from './test/fixtures';
import { sealToken } from '@/lib/token-crypto';
import type { BankProvider } from '@/lib/bank-sync/provider';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// The provider the actions build, when a test sets one; otherwise the real
// Plaid provider, as every other test here expects.
const injected = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('@/lib/bank-sync/plaid/provider', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/bank-sync/plaid/provider')>();
  return {
    ...actual,
    createPlaidProvider: (...args: Parameters<typeof actual.createPlaidProvider>) =>
      (injected.provider as BankProvider | null) ?? actual.createPlaidProvider(...args),
  };
});

const provided = (providerAccountId: string, over: Partial<{ persistentAccountId: string | null; name: string; mask: string }> = {}) => ({
  providerAccountId,
  persistentAccountId: null,
  name: 'Test Card',
  officialName: null,
  mask: '0000',
  type: 'credit',
  subtype: 'credit card',
  ...over,
});

async function accountsOf(acc: TestAccount) {
  return db
    .select({ providerAccountId: bankAccounts.providerAccountId, syncEnabled: bankAccounts.syncEnabled, unsharedAt: bankAccounts.unsharedAt })
    .from(bankAccounts)
    .where(eq(bankAccounts.connectionId, acc.connectionId))
    .orderBy(bankAccounts.providerAccountId);
}

describe('reloading a login\'s accounts', () => {
  it('marks an account no longer returned as unshared with sync off, and unmarks it when it returns', async () => {
    const acc = await account('acc-a');
    const save = (ids: string[]) =>
      saveConnectionAccounts({ connectionId: acc.connectionId, institutionId: 'ins_109508', institutionName: 'First Platypus Bank', accounts: ids.map((i) => provided(i)) });

    expect(await save(['acc-a', 'acc-b'])).toEqual({ ok: true, added: 1, unshared: 0, reshared: 0, reissued: 0 });
    expect(await save(['acc-b'])).toEqual({ ok: true, added: 0, unshared: 1, reshared: 0, reissued: 0 });
    const [a] = await accountsOf(acc);
    expect(a).toMatchObject({ providerAccountId: 'acc-a', syncEnabled: false });
    expect(a.unsharedAt).not.toBeNull();

    expect(await save(['acc-a', 'acc-b'])).toEqual({ ok: true, added: 0, unshared: 0, reshared: 1, reissued: 0 });
    expect((await accountsOf(acc))[0]).toMatchObject({ unsharedAt: null, syncEnabled: false });
  });

  it('does not read an empty list as nothing shared', async () => {
    const acc = await account('acc-only');
    expect(
      await saveConnectionAccounts({ connectionId: acc.connectionId, institutionId: null, institutionName: null, accounts: [] }),
    ).toEqual({ ok: true, added: 0, unshared: 0, reshared: 0, reissued: 0 });
    expect((await accountsOf(acc))[0]).toMatchObject({ syncEnabled: true, unsharedAt: null });
  });

  it('records an account the bank re-issued under a new id as replacing the old one, with sync off', async () => {
    const acc = await account('acc-old');
    await db.update(bankAccounts).set({ persistentAccountId: 'persist-1' }).where(eq(bankAccounts.id, acc.accountId));
    expect(
      await saveConnectionAccounts({
        connectionId: acc.connectionId,
        institutionId: 'ins_3',
        institutionName: 'Chase',
        accounts: [provided('acc-new', { persistentAccountId: 'persist-1' })],
      }),
    ).toEqual({ ok: true, added: 1, unshared: 1, reshared: 0, reissued: 1 });
    const rows = await db
      .select({ id: bankAccounts.id, providerAccountId: bankAccounts.providerAccountId, syncEnabled: bankAccounts.syncEnabled, replaces: bankAccounts.replacesAccountId, unsharedAt: bankAccounts.unsharedAt })
      .from(bankAccounts)
      .where(eq(bankAccounts.connectionId, acc.connectionId))
      .orderBy(bankAccounts.providerAccountId);
    expect(rows.map((r) => [r.providerAccountId, r.syncEnabled, r.replaces, r.unsharedAt !== null])).toEqual([
      ['acc-new', false, acc.accountId, false],
      ['acc-old', false, null, true],
    ]);
  });

  it('without a persistent id, marks only an exact type-and-mask match among accounts this reload unshares', async () => {
    const acc = await account('acc-card');
    const reload = (accounts: ReturnType<typeof provided>[]) =>
      saveConnectionAccounts({ connectionId: acc.connectionId, institutionId: 'ins_4', institutionName: 'Amex', accounts });
    expect(await reload([provided('acc-card-2')])).toMatchObject({ reissued: 1 });
    const other = await account('acc-x');
    expect(
      await saveConnectionAccounts({ connectionId: other.connectionId, institutionId: 'ins_4', institutionName: 'Amex', accounts: [provided('acc-y', { mask: '9999' })] }),
    ).toMatchObject({ reissued: 0 });
  });
});

describe('which accounts may sync', () => {
  it('refuses an unshared account and every account of a removed login; turning sync off is always allowed', async () => {
    const acc = await account('acc-x');
    await setAccountSyncEnabled(acc.accountId, false);
    await db.update(bankAccounts).set({ unsharedAt: new Date() }).where(eq(bankAccounts.id, acc.accountId));
    expect(await setAccountSyncEnabled(acc.accountId, true)).toBe('unshared');

    const other = await account('acc-y');
    await markConnectionRemoved(other.connectionId);
    expect(await setAccountSyncEnabled(other.accountId, true)).toBe('removed');
    expect(await setAccountSyncEnabled(other.accountId, false)).toBe('ok');
    expect(await setAccountSyncEnabled('00000000-0000-0000-0000-000000000000', true)).toBe('not_found');
  });
});

describe('the duplicate-login guard on a new link', () => {
  const plaidEnv = process.env.PLAID_ENV;
  afterEach(() => {
    process.env.PLAID_ENV = plaidEnv;
  });
  // Past the guard the action's next step reads the token key, which the
  // test environment never has: reaching that error proves the guard let the
  // link through, and that nothing was exchanged.
  const pastTheGuard = { error: 'BANK_TOKEN_KEY is not set' };

  async function linkedAt(institutionId: string) {
    const acc = await account();
    await db
      .update(bankConnections)
      .set({ institutionId, institutionName: 'Guard Bank' })
      .where(eq(bankConnections.id, acc.connectionId));
    return acc;
  }

  it('in production: refuses without exchanging, never offers an override, and ignores a forged one', async () => {
    const institutionId = `ins_guard_${Math.random().toString(36).slice(2)}`;
    await linkedAt(institutionId);
    process.env.PLAID_ENV = 'production';
    const { completeLink } = await import('@/app/_actions/bank');
    const refused = await completeLink('public-production-1', institutionId);
    expect(refused).toEqual({ error: expect.stringMatching(/^Guard Bank is already linked \(since .+\)\. Nothing was linked/) });
    expect(refused).not.toHaveProperty('overridable');
    // A request claiming the override is refused the same way.
    expect(process.env.BANK_TOKEN_KEY).toBeUndefined();
    expect(await completeLink('public-production-1', institutionId, true)).toEqual(refused);
  });

  it('in Sandbox: refuses but offers the override, and honours it by going on to the exchange', async () => {
    const institutionId = `ins_guard_${Math.random().toString(36).slice(2)}`;
    await linkedAt(institutionId);
    process.env.PLAID_ENV = 'sandbox';
    const { completeLink } = await import('@/app/_actions/bank');
    expect(await completeLink('public-sandbox-1', institutionId)).toMatchObject({ overridable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await completeLink('public-sandbox-1', institutionId, true)).toEqual(pastTheGuard);
    vi.restoreAllMocks();
  });

  it('a login Plaid no longer recognises still blocks, and the refusal points at removal, not Reconnect', async () => {
    const institutionId = `ins_guard_${Math.random().toString(36).slice(2)}`;
    const acc = await linkedAt(institutionId);
    await db.update(bankConnections).set({ itemErrorCode: 'ITEM_NOT_FOUND' }).where(eq(bankConnections.id, acc.connectionId));
    process.env.PLAID_ENV = 'production';
    const { completeLink } = await import('@/app/_actions/bank');
    expect(await completeLink('public-production-2', institutionId)).toEqual({
      error: expect.stringMatching(/no longer recognises that login, so Reconnect cannot repair it\. Nothing was linked\. Remove that login first/),
    });
  });

  it('a login at another institution, or a removed one at this institution, does not block', async () => {
    const institutionId = `ins_guard_${Math.random().toString(36).slice(2)}`;
    const acc = await linkedAt(institutionId);
    await markConnectionRemoved(acc.connectionId);
    process.env.PLAID_ENV = 'production';
    const { completeLink } = await import('@/app/_actions/bank');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await completeLink('public-production-2', institutionId)).toEqual(pastTheGuard);
    expect(await completeLink('public-production-2', 'ins_elsewhere')).toEqual(pastTheGuard);
    vi.restoreAllMocks();
  });
});

describe('finishing a Reconnect', () => {
  afterEach(() => {
    injected.provider = null;
    vi.unstubAllEnvs();
  });

  // A login whose stored health says it needs reconnecting, with a sealed
  // token the action can open, and a provider answering as Plaid would after
  // update mode: `errorCode` is the health it reports now.
  async function brokenLogin(over: { errorCode?: string | null; accounts?: ReturnType<typeof provided>[]; added?: number } = {}) {
    const key = Buffer.alloc(32, 7);
    vi.stubEnv('BANK_TOKEN_KEY', key.toString('base64'));
    vi.stubEnv('PLAID_ENV', 'sandbox');
    vi.stubEnv('PLAID_CLIENT_ID', 'test');
    vi.stubEnv('PLAID_SECRET', 'test');
    const acc = await account('acc-old');
    await db
      .update(bankConnections)
      .set({ accessTokenSealed: sealToken('access-sandbox-test', key, acc.providerItemId), itemErrorCode: 'ITEM_LOGIN_REQUIRED' })
      .where(eq(bankConnections.id, acc.connectionId));
    const fetches = vi.fn(async () => ({
      added: Array.from({ length: over.added ?? 0 }, () => ptxn(acc)),
      modified: [],
      removed: [],
      nextCursor: `cursor-${Math.random()}`,
      readiness: 'historical' as const,
      pages: 1,
      restarts: 0,
      ms: 1,
    }));
    injected.provider = {
      getItem: async () => ({
        itemId: acc.providerItemId,
        institutionId: 'ins_3',
        institutionName: 'Chase',
        errorCode: over.errorCode ?? null,
        consentExpiresAt: null,
      }),
      getAccounts: async () => ({
        itemId: acc.providerItemId,
        institutionId: 'ins_3',
        institutionName: 'Chase',
        accounts: over.accounts ?? [provided('acc-old')],
      }),
      syncTransactions: fetches,
    } as unknown as BankProvider;
    return { acc, fetches };
  }

  async function finish(connectionId: string, accountSelection = false) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { completeUpdate } = await import('@/app/_actions/bank');
    const result = await completeUpdate(connectionId, accountSelection);
    vi.restoreAllMocks();
    return result;
  }

  it('a healthy login is synced at once, and one message says it worked and what came in', async () => {
    const { acc, fetches } = await brokenLogin({ added: 1 });
    expect(await finish(acc.connectionId)).toEqual({ ok: true, message: 'Reconnected and synced.', details: ['Test Card ••0000: 1 new.'] });
    expect(fetches).toHaveBeenCalledTimes(1);
    const [c] = await db.select().from(bankConnections).where(eq(bankConnections.id, acc.connectionId));
    expect(c.itemErrorCode).toBeNull();
  });

  it('a login Plaid still reports broken is not synced, and the message says so', async () => {
    const { acc, fetches } = await brokenLogin({ errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(await finish(acc.connectionId)).toEqual({
      ok: true,
      warning: 'Reconnected, but Plaid still reports ITEM_LOGIN_REQUIRED, so nothing was synced.',
      details: undefined,
    });
    expect(fetches).not.toHaveBeenCalled();
  });

  it('a paused login is reconnected but not synced', async () => {
    const { acc, fetches } = await brokenLogin();
    await db.update(bankConnections).set({ status: 'paused' }).where(eq(bankConnections.id, acc.connectionId));
    expect(await finish(acc.connectionId)).toEqual({
      ok: true,
      message: 'Reconnected. Not synced: this login is paused; Resume to sync.',
      details: undefined,
    });
    expect(fetches).not.toHaveBeenCalled();
  });

  it('a re-issued account: recorded and named in the message, while the accounts already syncing sync', async () => {
    const { acc } = await brokenLogin({
      accounts: [provided('acc-old', { persistentAccountId: 'persist-1' }), provided('acc-new', { persistentAccountId: 'persist-1' })],
    });
    await db.update(bankAccounts).set({ persistentAccountId: 'persist-1' }).where(eq(bankAccounts.id, acc.accountId));
    expect(await finish(acc.connectionId)).toEqual({
      ok: true,
      message:
        'Reconnected and synced. Accounts: 1 added, with sync off; 1 looks like an account already here under a new id: ' +
        'adopt or decline on Accounts before it syncs.',
      details: ['Test Card ••0000: no changes.'],
    });
  });
});
