import 'server-only';
// One sync of a connection's enabled accounts: the loop behind "Sync now"
// (app/_actions/bank.ts) and, from slice 5, the cron. It starts by reading
// the Item's health; a login that needs the owner is not fetched at all.
// Per account: fetch all its changes with no transaction open, then commit
// rows and cursor together under the connection's lock (commitAccountSync).
// A failure on one account is recorded on it and the others still run,
// unless it belongs to the whole login (an Item or institution error), which
// is recorded on the connection and stops the rest. Separate from the Server
// Action so the database tests drive exactly this code with an injected
// provider. Also the removal of a login, for the same reason.
import {
  commitAccountSync,
  markConnectionRemoved,
  recordAccountSyncError,
  recordItemHealth,
  type SyncTarget,
} from './queries';
import type { AccessToken } from '@/lib/bank-sync/access-token';
import type { BankProvider } from '@/lib/bank-sync/provider';
import type { CategoryRule } from '@/lib/categorize';
import { describeCounts } from '@/lib/bank-sync/plan';
import { SyncBudgetExceededError } from '@/lib/bank-sync/provider';
import { connectionErrorCode, describeSyncError, providerErrorCode, syncErrorLogLine } from '@/lib/bank-sync/errors';
import { healthClause, isGone } from '@/lib/bank-sync/item-health';

// Read the Item's health from the provider and store it. Returns the error
// code (null = healthy), or undefined when the health could not be read for
// a reason that says nothing about the login (a timeout, an outage at
// Plaid): the stored health is then left as it was.
export async function refreshItemHealth(input: {
  connectionId: string;
  providerItemId: string;
  accessToken: AccessToken;
  provider: BankProvider;
}): Promise<string | null | undefined> {
  try {
    const item = await input.provider.getItem(input.accessToken);
    if (item.itemId !== input.providerItemId) {
      throw new Error('The provider returned a different Item.');
    }
    await recordItemHealth(input.connectionId, {
      errorCode: item.errorCode,
      consentExpiresAt: item.consentExpiresAt,
      institutionId: item.institutionId,
      institutionName: item.institutionName,
    });
    return item.errorCode;
  } catch (err) {
    const code = connectionErrorCode(err);
    if (code !== null) {
      await recordItemHealth(input.connectionId, { errorCode: code });
      return code;
    }
    console.error(syncErrorLogLine(`health: connection ${input.connectionId}`, err));
    return undefined;
  }
}

// One line per account synced, and whether every account finished (applied,
// or found another sync had already applied it). A login that cannot sync
// gets one line: why it cannot is said once, on the login, not per account.
export type SyncReport = { lines: string[]; complete: boolean };

export async function syncAccounts(input: {
  target: SyncTarget;
  accessToken: AccessToken;
  provider: BankProvider;
  rules: CategoryRule[];
  // Epoch ms after which no further page is fetched.
  deadline?: number;
}): Promise<SyncReport> {
  const { target, accessToken, provider, rules, deadline } = input;
  const lines: string[] = [];
  let complete = true;

  const health = await refreshItemHealth({
    connectionId: target.connectionId,
    providerItemId: target.providerItemId,
    accessToken,
    provider,
  });
  if (health) return { lines: [`Nothing synced: ${healthClause(health)}.`], complete: false };

  for (const [i, account] of target.accounts.entries()) {
    try {
      const fetched = await provider.syncTransactions(accessToken, {
        providerAccountId: account.providerAccountId,
        cursor: account.syncCursor,
        deadline,
      });
      console.info(
        `sync ${account.id}: ${fetched.pages} page(s), ${fetched.restarts} restart(s), ${fetched.ms} ms, ` +
          `${fetched.added.length} added, ${fetched.modified.length} modified, ${fetched.removed.length} removed`,
      );
      if (fetched.nextCursor === null) {
        complete = false;
        lines.push(`${account.label}: the bank is still preparing its history; try again shortly.`);
        continue;
      }
      const outcome = await commitAccountSync({
        connectionId: target.connectionId,
        accountId: account.id,
        providerAccountId: account.providerAccountId,
        startCursor: account.syncCursor,
        nextCursor: fetched.nextCursor,
        added: fetched.added,
        modified: fetched.modified,
        removed: fetched.removed,
        rules,
      });
      if (outcome.kind !== 'applied' && outcome.kind !== 'stale') complete = false;
      switch (outcome.kind) {
        case 'applied':
          lines.push(
            `${account.label}: ${describeCounts(outcome.counts)}.` +
              // A new login's first 30 days come first; the rest arrives on a
              // later sync, so totals for older periods are not final yet.
              (fetched.readiness === 'initial' ? ' Plaid has sent only the last 30 days so far; sync again later for the rest.' : ''),
          );
          break;
        case 'stopped':
          await recordAccountSyncError(account.id, outcome.reason);
          lines.push(`${account.label}: stopped. ${outcome.reason}`);
          break;
        case 'busy':
          lines.push(`${account.label}: another sync of this bank is running; nothing applied.`);
          break;
        case 'stale':
          lines.push(`${account.label}: another sync finished first; nothing more to apply.`);
          break;
        case 'inactive': {
          // Every account after this one would say the same; say it once.
          const rest = target.accounts.slice(i).map((a) => a.label);
          lines.push(
            `Nothing more applied; the login was ${outcome.status === 'paused' ? 'paused' : 'removed'} while it synced: ${rest.join(', ')}.`,
          );
          return { lines, complete };
        }
      }
    } catch (err) {
      console.error(syncErrorLogLine(`sync: account ${account.id}`, err));
      complete = false;
      // Past the fetch budget: sync fetches an account's pages and then
      // commits them, so nothing from this run was saved and its position is
      // unchanged. Not a failure of the account, so not recorded as one; the
      // accounts before it kept what they fetched (REAL-ACCOUNTS.md).
      if (err instanceof SyncBudgetExceededError) {
        lines.push(
          `${account.label}: stopped after 4 minutes, before its history finished arriving. Nothing from this run was ` +
            `saved and its place is unchanged, so Sync now starts this account over; accounts above kept what they fetched.`,
        );
        const rest = target.accounts.slice(i + 1).map((a) => a.label);
        if (rest.length > 0) lines.push(`Not reached this run: ${rest.join(', ')}.`);
        break;
      }
      const code = connectionErrorCode(err);
      if (code !== null) {
        await recordItemHealth(target.connectionId, { errorCode: code });
        const rest = target.accounts.slice(i).map((a) => a.label);
        lines.push(`Not synced (${healthClause(code)}): ${rest.join(', ')}.`);
        break;
      }
      const message = describeSyncError(err);
      await recordAccountSyncError(account.id, message);
      lines.push(`${account.label}: failed. ${message}`);
    }
  }
  return { lines, complete };
}

// Remove a login: the provider first, then the database. If the provider
// refuses, nothing has changed. If the provider succeeded and the database
// write failed, running this again finds the login already gone at the
// provider and finishes the database half. Any other provider error stops
// with nothing changed.
export async function removeConnection(input: {
  connectionId: string;
  accessToken: AccessToken;
  provider: BankProvider;
}): Promise<{ ok: true; pendingDeleted: number } | { error: string; providerDone?: boolean }> {
  try {
    await input.provider.removeItem(input.accessToken);
  } catch (err) {
    if (!isGone(providerErrorCode(err))) {
      console.error(syncErrorLogLine(`remove: connection ${input.connectionId}`, err));
      return { error: describeSyncError(err) };
    }
  }
  try {
    const result = await markConnectionRemoved(input.connectionId);
    if ('error' in result) return result;
    return { ok: true, pendingDeleted: result.pendingDeleted };
  } catch (err) {
    console.error(syncErrorLogLine(`remove: connection ${input.connectionId} (database half)`, err));
    return {
      error: "Plaid's access to this login has ended, but recording that here failed. Remove it again to finish; that uses nothing at Plaid.",
      providerDone: true,
    };
  }
}
