import 'server-only';
import { getRules, getSyncTarget } from '@/db/queries';
import { syncAccounts, type SyncReport } from '@/db/bank-sync';
import { demoBankProvider } from '@/db/demo-bank';
import { isDemoMode } from '@/lib/demo-mode';
import { describeSyncError, syncErrorLogLine } from '@/lib/bank-sync/errors';
import { openToken, parseTokenKey } from '@/lib/token-crypto';
import type { AccessToken } from '@/lib/bank-sync/access-token';
import type { BankProvider, BankProviderName } from '@/lib/bank-sync/provider';
import { plaidConfigFromEnv } from '@/lib/bank-sync/plaid/client';
import { createPlaidProvider } from '@/lib/bank-sync/plaid/provider';
import { chooseProvider, openStoredToken } from '@/lib/bank-sync/select-provider';

// What Sync now (app/_actions/bank.ts) and the daily sync (app/api/cron/sync)
// share: the provider, a connection's opened token, and one login's sync.
// Not a 'use server' module, so none of it is callable from the browser.

// Built per call from the environment: Plaid, or in the demo the synthetic
// provider and never Plaid (lib/bank-sync/select-provider.ts). The deployment
// guard (db/index.ts) has already refused any Plaid environment that does
// not match the database, and any bank credential on the demo, by the time a
// query module is loaded.
export async function bankProvider(): Promise<BankProvider> {
  const demo = isDemoMode();
  const synthetic = demo ? await demoBankProvider() : null;
  return chooseProvider(demo, {
    plaid: () => createPlaidProvider(plaidConfigFromEnv(process.env)),
    synthetic: () => synthetic!,
  });
}

// A stored connection's token: unsealed for Plaid, its own fixed value for a
// synthetic login, each only where it belongs.
export function openStored(row: { provider: BankProviderName; providerItemId: string; accessTokenSealed: string }): AccessToken {
  return openStoredToken(isDemoMode(), row, () =>
    openToken(row.accessTokenSealed, parseTokenKey(process.env.BANK_TOKEN_KEY), row.providerItemId),
  );
}

// Sync every enabled account of a login, for Sync now and for the sync a
// successful Reconnect finishes with.
export async function runConnectionSync(
  connectionId: string,
  deadline: number,
): Promise<SyncReport | { error: string } | { notRun: 'paused' | 'no_accounts' }> {
  const target = await getSyncTarget(connectionId);
  if (!target) return { error: 'Connection not found.' };
  if (target.status === 'paused') return { notRun: 'paused' };
  if (target.accounts.length === 0) return { notRun: 'no_accounts' };

  let accessToken: AccessToken;
  try {
    accessToken = openStored(target);
  } catch (err) {
    console.error(syncErrorLogLine('sync: token', err));
    return { error: describeSyncError(err) };
  }

  const rules = (await getRules()).map((r) => ({
    categoryId: r.categoryId,
    matchPattern: r.matchPattern,
    matchType: r.matchType,
    priority: r.priority,
    createdAt: r.createdAt,
  }));
  return syncAccounts({ target, accessToken, provider: await bankProvider(), rules, deadline });
}

