'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  getPersons,
  getRules,
  getConnectionHealth,
  getLinkedLogins,
  getSealedAccessToken,
  getSyncTarget,
  insertBankConnection,
  setConnectionPaused,
  saveConnectionAccounts,
  setAccountSyncEnabled,
} from '@/db/queries';
import { isDemoMode } from '@/lib/demo-mode';
import { postgresCode } from '@/lib/postgres-error';
import { refreshItemHealth, removeConnection, syncAccounts, type SyncReport } from '@/db/bank-sync';
import { describeSyncError, syncErrorLogLine } from '@/lib/bank-sync/errors';
import { healthClause, healthSentence, isGone } from '@/lib/bank-sync/item-health';
import { updateResultMessage, type UpdateOutcome } from '@/lib/bank-sync/update-result';
import { duplicateOverrideAllowed, duplicateRefusal, findLinkedLogin } from '@/lib/bank-sync/link-guard';
import { openToken, parseTokenKey, sealToken } from '@/lib/token-crypto';
import { AccessToken } from '@/lib/bank-sync/access-token';
import type { BankProvider } from '@/lib/bank-sync/provider';
import { plaidConfigFromEnv } from '@/lib/bank-sync/plaid/client';
import { createPlaidProvider } from '@/lib/bank-sync/plaid/provider';
import { requireUser } from '@/app/_lib/session';

export type LinkTokenState = { linkToken: string } | { error: string };
// `message` says what a successful action did; `warning` replaces it when it
// only partly worked.
export type LinkResultState =
  | { ok: true; message?: string; warning?: string; details?: string[] }
  // `overridable` only ever comes back true in Sandbox (link-guard.ts).
  | { error: string; overridable?: boolean };
// One line per account synced, and whether every account finished.
export type SyncResultState = { ok: true; lines: string[]; complete: boolean } | { error: string };

// Time the sync may spend fetching before it stops on purpose, inside the
// 300 s function limit (Hobby's maximum; app/accounts/page.tsx sets it) with
// room left for the commits.
const SYNC_FETCH_BUDGET_MS = 240_000;

// Built per call from the environment. The deployment guard (db/index.ts)
// has already refused any Plaid environment that does not match the
// database by the time a query module is loaded.
function bankProvider(): BankProvider {
  return createPlaidProvider(plaidConfigFromEnv(process.env));
}

// Shown and logged the same way as a sync failure (lib/bank-sync/errors.ts).
const describeError = describeSyncError;
function logError(where: string, err: unknown): void {
  console.error(syncErrorLogLine(where, err));
}

// Open a connection's stored token. Null when the connection does not exist
// or was removed (its token is erased).
async function openConnection(
  connectionId: string,
): Promise<{ accessToken: AccessToken; providerItemId: string } | null> {
  const row = await getSealedAccessToken(connectionId);
  if (!row) return null;
  const key = parseTokenKey(process.env.BANK_TOKEN_KEY);
  return {
    accessToken: new AccessToken(openToken(row.accessTokenSealed, key, row.providerItemId)),
    providerItemId: row.providerItemId,
  };
}

// Fetch the connection's accounts from the provider and store them. Shared by
// the link completion and the retry button, so a failure here never strands
// an Item: the connection row already exists and the retry reruns this.
async function loadAccounts(
  connectionId: string,
): Promise<{ institutionName: string | null; accounts: number; added: number; unshared: number; reshared: number; reissued: number }> {
  const opened = await openConnection(connectionId);
  if (!opened) throw new Error('Connection not found.');
  const result = await bankProvider().getAccounts(opened.accessToken);
  if (result.itemId !== opened.providerItemId) {
    throw new Error('The provider returned accounts for a different Item.');
  }
  const saved = await saveConnectionAccounts({
    connectionId,
    institutionId: result.institutionId,
    institutionName: result.institutionName,
    accounts: result.accounts,
  });
  return { institutionName: result.institutionName, accounts: result.accounts.length, ...saved };
}

function accountsLoaded(n: number): string {
  return `${n} account${n === 1 ? '' : 's'}, each with sync off until you turn it on`;
}

export async function createLinkToken(): Promise<LinkTokenState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  try {
    const owner = (await getPersons()).find((p) => p.isOwner);
    if (!owner) return { error: 'Owner person missing.' };
    // The owner's person id: stable, and not personal information.
    const { linkToken } = await bankProvider().createLinkToken({ clientUserId: owner.id });
    return { linkToken };
  } catch (err) {
    logError('createLinkToken', err);
    return { error: describeError(err) };
  }
}

const publicTokenSchema = z.string().trim().min(1).max(500);

function formatLinkedOn(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Called with the one-time public token Plaid Link hands back and the
// institution Link reports. If a login at that institution is already linked
// the token is not exchanged: the exchange is what creates the Item's
// connection here, and a second login at one bank is the budget mistake.
// Only in Sandbox can the owner link anyway (`linkAnyway`), and the action
// re-checks that itself rather than trusting the page.
//
// Once exchanged, the Item's slot is spent whether or not the rest
// succeeds, so the access token is stored before anything else that could
// fail.
export async function completeLink(
  publicToken: unknown,
  institutionId: unknown,
  linkAnyway: unknown = false,
): Promise<LinkResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const parsed = publicTokenSchema.safeParse(publicToken);
  if (!parsed.success) return { error: 'Missing public token.' };
  const institution = z.string().trim().min(1).max(100).nullable().safeParse(institutionId);
  const anyway = z.boolean().safeParse(linkAnyway);
  if (!institution.success || !anyway.success) return { error: 'Invalid request.' };

  const overridable = duplicateOverrideAllowed(process.env.PLAID_ENV);
  if (!(anyway.data && overridable)) {
    let existing;
    try {
      existing = findLinkedLogin(institution.data, await getLinkedLogins());
    } catch (err) {
      // Not knowing is not permission: nothing is exchanged.
      logError('completeLink: guard', err);
      return { error: `${describeError(err)} Nothing was linked; try again.` };
    }
    if (existing) {
      return {
        error: duplicateRefusal(existing, formatLinkedOn(existing.createdAt)),
        ...(overridable ? { overridable: true } : {}),
      };
    }
  }

  let connectionId: string;
  try {
    const key = parseTokenKey(process.env.BANK_TOKEN_KEY);
    const { itemId, accessToken } = await bankProvider().exchangePublicToken(parsed.data);
    // One of the two places the plaintext is revealed: to seal it.
    const sealed = sealToken(accessToken.reveal(), key, itemId);
    ({ id: connectionId } = await insertBankConnection({
      provider: 'plaid',
      providerItemId: itemId,
      accessTokenSealed: sealed,
    }));
  } catch (err) {
    logError('completeLink', err);
    return { error: describeError(err) };
  }

  let loaded;
  try {
    loaded = await loadAccounts(connectionId);
  } catch (err) {
    logError('completeLink: accounts', err);
    revalidatePath('/accounts');
    return {
      ok: true,
      warning: `Linked, but its accounts could not be loaded: ${describeError(err)} Use Retry on the connection.`,
    };
  }
  revalidatePath('/accounts');
  return { ok: true, message: `Linked ${loaded.institutionName ?? 'the bank'}: ${accountsLoaded(loaded.accounts)}.` };
}

export async function retryLoadAccounts(connectionId: unknown): Promise<LinkResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success) return { error: 'Invalid connection.' };
  let loaded;
  try {
    loaded = await loadAccounts(parsed.data);
  } catch (err) {
    logError('retryLoadAccounts', err);
    return { error: describeError(err) };
  }
  revalidatePath('/accounts');
  return { ok: true, message: `Loaded ${accountsLoaded(loaded.accounts)}.` };
}

const connectionIdSchema = z.string().uuid();

// A link token for Link's update mode on an existing login: Reconnect (sign
// in again, renew consent) or, with accountSelection, Choose shared
// accounts. Update mode never creates an Item. Refused for a login Plaid no
// longer recognises, where there is nothing left to update.
export async function createUpdateLinkToken(
  connectionId: unknown,
  accountSelection: unknown,
): Promise<LinkTokenState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const id = connectionIdSchema.safeParse(connectionId);
  const selection = z.boolean().safeParse(accountSelection);
  if (!id.success || !selection.success) return { error: 'Invalid request.' };
  try {
    const health = await getConnectionHealth(id.data);
    if (!health) return { error: 'Connection not found.' };
    if (isGone(health.itemErrorCode)) {
      return { error: healthSentence(health.itemErrorCode, health.institutionName ?? 'the bank') as string };
    }
    const opened = await openConnection(id.data);
    if (!opened) return { error: 'Connection not found.' };
    const owner = (await getPersons()).find((p) => p.isOwner);
    if (!owner) return { error: 'Owner person missing.' };
    const { linkToken } = await bankProvider().createUpdateLinkToken(opened.accessToken, {
      clientUserId: owner.id,
      accountSelection: selection.data,
    });
    return { linkToken };
  } catch (err) {
    logError('createUpdateLinkToken', err);
    return { error: describeError(err) };
  }
}

// Called when update-mode Link succeeds. Nothing is exchanged: the access
// token is unchanged. Update mode means "make this login work again", so this
// finishes what the broken login interrupted: it re-reads the login's health,
// reloads its accounts (an account no longer shared is marked and stops
// syncing) and, when healthy, syncs. One message says what each step did
// (lib/bank-sync/update-result.ts). Called from /accounts and from the OAuth
// redirect page, both of which allow the sync's 300 s.
export async function completeUpdate(connectionId: unknown, accountSelection: unknown = false): Promise<LinkResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const id = connectionIdSchema.safeParse(connectionId);
  const selection = z.boolean().safeParse(accountSelection);
  if (!id.success || !selection.success) return { error: 'Invalid request.' };
  const deadline = Date.now() + SYNC_FETCH_BUDGET_MS;

  let health: string | null | undefined;
  try {
    const opened = await openConnection(id.data);
    if (!opened) return { error: 'Connection not found.' };
    health = await refreshItemHealth({
      connectionId: id.data,
      providerItemId: opened.providerItemId,
      accessToken: opened.accessToken,
      provider: bankProvider(),
    });
  } catch (err) {
    logError('completeUpdate: health', err);
    return { error: describeError(err) };
  }

  let reload: UpdateOutcome['reload'];
  try {
    const loaded = await loadAccounts(id.data);
    reload = { ok: true, added: loaded.added, unshared: loaded.unshared, reshared: loaded.reshared, reissued: loaded.reissued };
  } catch (err) {
    logError('completeUpdate: accounts', err);
    reload = { ok: false, message: describeError(err) };
  }

  let sync: UpdateOutcome['sync'] = { ran: false, reason: 'unhealthy' };
  if (health === null) {
    const result = await runConnectionSync(id.data, deadline);
    sync =
      'notRun' in result
        ? { ran: false, reason: result.notRun }
        : 'error' in result
          ? { ran: true, error: result.error }
          : { ran: true, lines: result.lines, complete: result.complete };
  }

  revalidatePath('/accounts');
  revalidatePath('/');
  const message = updateResultMessage({ accountSelection: selection.data, health, reload, sync });
  return message.kind === 'success'
    ? { ok: true, message: message.text, details: message.details }
    : { ok: true, warning: message.text, details: message.details };
}

// Opt an account in or out of syncing. Only depository and credit accounts
// can be enabled; the database refuses anything else (CHECK constraint).
export async function setAccountSync(accountId: unknown, enabled: unknown): Promise<LinkResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const id = z.string().uuid().safeParse(accountId);
  const on = z.boolean().safeParse(enabled);
  if (!id.success || !on.success) return { error: 'Invalid request.' };
  try {
    const result = await setAccountSyncEnabled(id.data, on.data);
    if (result === 'not_found') return { error: 'Account not found.' };
    if (result === 'removed') return { error: 'This login was removed; its accounts cannot sync again.' };
    if (result === 'needs_ledger') return { error: 'Choose which ledger account it syncs into first, with Set up.' };
    if (result === 'reissued') {
      return { error: 'This looks like an account already here under a new id. Adopt it, or say it is different, first.' };
    }
    if (result === 'unshared') {
      return { error: 'The bank no longer shares this account. Use Choose shared accounts on the login to share it again.' };
    }
  } catch (err) {
    if (postgresCode(err) === '23514') {
      return { error: 'Only checking, savings, and credit card accounts can be synced.' };
    }
    logError('setAccountSync', err);
    return { error: describeError(err) };
  }
  revalidatePath('/accounts');
  revalidatePath('/');
  return { ok: true };
}

// Sync every enabled account of one connection (db/bank-sync.ts does the
// work; this checks the request, opens the token and refreshes the pages).
export async function syncConnection(connectionId: unknown): Promise<SyncResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success) return { error: 'Invalid connection.' };
  const result = await runConnectionSync(parsed.data, Date.now() + SYNC_FETCH_BUDGET_MS);
  if ('notRun' in result) {
    return {
      error: result.notRun === 'paused' ? 'This login is paused. Resume it to sync.' : 'Choose at least one account to sync.',
    };
  }
  if ('error' in result) return result;
  revalidatePath('/accounts');
  revalidatePath('/');
  return { ok: true, lines: result.lines, complete: result.complete };
}

// Sync every enabled account of a login, for Sync now and for the sync a
// successful Reconnect finishes with.
async function runConnectionSync(
  connectionId: string,
  deadline: number,
): Promise<SyncReport | { error: string } | { notRun: 'paused' | 'no_accounts' }> {
  const target = await getSyncTarget(connectionId);
  if (!target) return { error: 'Connection not found.' };
  if (target.status === 'paused') return { notRun: 'paused' };
  if (target.accounts.length === 0) return { notRun: 'no_accounts' };

  let accessToken: AccessToken;
  try {
    const key = parseTokenKey(process.env.BANK_TOKEN_KEY);
    accessToken = new AccessToken(openToken(target.accessTokenSealed, key, target.providerItemId));
  } catch (err) {
    logError('syncConnection: token', err);
    return { error: describeError(err) };
  }

  const rules = (await getRules()).map((r) => ({
    categoryId: r.categoryId,
    matchPattern: r.matchPattern,
    matchType: r.matchType,
    priority: r.priority,
    createdAt: r.createdAt,
  }));
  return syncAccounts({ target, accessToken, provider: bankProvider(), rules, deadline });
}

// "Check": read the login's health from Plaid now. Nothing syncs.
export async function checkConnection(connectionId: unknown): Promise<LinkResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const id = connectionIdSchema.safeParse(connectionId);
  if (!id.success) return { error: 'Invalid connection.' };
  try {
    const opened = await openConnection(id.data);
    if (!opened) return { error: 'Connection not found.' };
    const code = await refreshItemHealth({
      connectionId: id.data,
      providerItemId: opened.providerItemId,
      accessToken: opened.accessToken,
      provider: bankProvider(),
    });
    revalidatePath('/accounts');
    revalidatePath('/');
    if (code === undefined) return { error: 'Plaid could not be asked just now; nothing changed. Try again shortly.' };
    return { ok: true, message: code === null ? 'Checked: the login is healthy.' : `Checked: ${healthClause(code)}.` };
  } catch (err) {
    logError('checkConnection', err);
    return { error: describeError(err) };
  }
}

// Pause or resume syncing a login. Reversible; nothing at Plaid changes.
export async function setLoginPaused(connectionId: unknown, paused: unknown): Promise<LinkResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const id = connectionIdSchema.safeParse(connectionId);
  const flag = z.boolean().safeParse(paused);
  if (!id.success || !flag.success) return { error: 'Invalid request.' };
  try {
    const result = await setConnectionPaused(id.data, flag.data);
    if ('error' in result) return result;
  } catch (err) {
    logError('setLoginPaused', err);
    return { error: describeError(err) };
  }
  revalidatePath('/accounts');
  revalidatePath('/');
  return {
    ok: true,
    message: flag.data ? 'Paused. Nothing syncs until you resume it.' : 'Resumed. Sync now fetches what the bank has since.',
  };
}

// Remove a login: a deliberate disconnect, never a repair. The owner types
// the institution's name, and the server compares it, so a stray or forged
// request removes nothing. Irreversible, and the Item's slot is not
// returned. db/bank-sync.ts orders the provider and database halves.
export async function removeLogin(connectionId: unknown, typedName: unknown): Promise<LinkResultState> {
  await requireUser();
  if (isDemoMode()) return { error: 'Bank linking is not available in the demo.' };
  const id = connectionIdSchema.safeParse(connectionId);
  const typed = z.string().max(200).safeParse(typedName);
  if (!id.success || !typed.success) return { error: 'Invalid request.' };
  let pendingDeleted = 0;
  try {
    const health = await getConnectionHealth(id.data);
    if (!health) return { error: 'Connection not found.' };
    if (health.status === 'removed') return { error: 'This login is already removed.' };
    const expected = (health.institutionName ?? 'remove').trim().toLowerCase();
    if (typed.data.trim().toLowerCase() !== expected) {
      return { error: `Type ${health.institutionName ?? 'remove'} to confirm. Nothing was removed.` };
    }
    const opened = await openConnection(id.data);
    if (!opened) return { error: 'Connection not found.' };
    const result = await removeConnection({ connectionId: id.data, accessToken: opened.accessToken, provider: bankProvider() });
    if ('error' in result) return { error: result.providerDone ? result.error : `${result.error} Nothing was removed.` };
    pendingDeleted = result.pendingDeleted;
  } catch (err) {
    logError('removeLogin', err);
    return { error: describeError(err) };
  }
  revalidatePath('/accounts');
  revalidatePath('/');
  return {
    ok: true,
    message:
      `Removed. Plaid's access ended and the token was erased` +
      (pendingDeleted > 0 ? `; ${pendingDeleted} pending ${pendingDeleted === 1 ? 'row was' : 'rows were'} deleted.` : '.'),
  };
}
