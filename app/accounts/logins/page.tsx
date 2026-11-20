import { getBankConnections, SYNCABLE_ACCOUNT_TYPES, type BankConnectionRow } from '@/db/queries';
import { isDemoMode } from '@/lib/demo-mode';
import { duplicateOverrideAllowed } from '@/lib/bank-sync/link-guard';
import { AlertTriangle, Info } from 'lucide-react';
import { classifyItemError, consentState, healthLabel, healthSentence, offersReconnect } from '@/lib/bank-sync/item-health';
import {
  actionSentence,
  institutionLine,
  ITEM_BUDGET,
  itemsLeft,
  itemsUsed,
  loginsByInstitution,
  rowsPhrase,
  twinAccounts,
  twinSentence,
  twinSummary,
} from '@/lib/bank-sync/accounts-view';
import { LinkBankButton, ReconnectButton, RetryAccountsButton } from '@/app/_components/link-bank-button';
import { AccountSyncToggle, SyncNowButton } from '@/app/_components/bank-sync-controls';
import { ManageLogin } from '@/app/_components/connection-controls';
import { choicesFor, lastCsvDates, ledgerChoices, ledgerStateFor } from '@/db/ledger';
import { defaultCutover } from '@/lib/bank-sync/cutover';
import { ReissuedChoice, SetUpSyncButton, type LedgerOption } from '@/app/_components/ledger-controls';
import { LoginResultLine, LoginResultProvider } from '@/app/_components/login-result';
import { requireUser } from '@/app/_lib/session';

// Sync runs as a Server Action on this page, so the page's function limit is
// the sync's: 300 s is Hobby's maximum (and default); Pro allows 800 s.
// The action stops its fetches on purpose at 240 s (app/_actions/bank.ts).
export const maxDuration = 300;

// Rendered per request: consent expiry is judged against the current time,
// and a page prerendered at build would keep the time of the last change.
export const dynamic = 'force-dynamic';

const SYNCABLE = new Set<string>(SYNCABLE_ACCOUNT_TYPES);

function formatSynced(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Three weights, so the page has a hierarchy: muted for information (an
// account also linked elsewhere but syncing in one place, a bank briefly
// down, a pause), amber for what needs the owner (a login to reconnect, an
// account counted twice, a failed sync), and red only for Remove, inside
// Manage, and for the reply to an action that failed.
// "Oct 20", with the year only when it is not this year's.
function formatShortDay(date: Date, now: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

function Badge({ tone, children }: { tone: 'action' | 'muted'; children: React.ReactNode }) {
  const tones = {
    action: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    muted: 'border-border bg-muted text-muted-foreground',
  };
  return <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function healthBadge(c: BankConnectionRow): React.ReactNode {
  if (c.status === 'removed') return <Badge tone="muted">Removed {c.removedAt ? formatDay(c.removedAt) : ''}</Badge>;
  if (c.status === 'paused') return <Badge tone="muted">Paused</Badge>;
  const label = healthLabel(c.itemErrorCode);
  if (label === null) return null;
  return <Badge tone={classifyItemError(c.itemErrorCode) === 'bank_unavailable' ? 'muted' : 'action'}>{label}</Badge>;
}

// Something the owner needs to do, said once for the whole login, with the
// action beside it.
function ActionCallout({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:text-amber-200"
    >
      <p className="flex items-start gap-1.5">
        <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>{children}</span>
      </p>
      {action}
    </div>
  );
}

function InfoLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

type LedgerState = Awaited<ReturnType<typeof ledgerStateFor>> extends Map<string, infer V> ? V : never;

function ConnectionDetails({ connection, ledger, lastCsv }: {
  connection: BankConnectionRow;
  ledger: Map<string, LedgerState>;
  lastCsv: ReadonlyMap<string, string>;
}) {
  return <details className="border-t px-4 py-2 text-xs text-muted-foreground">
    <summary className="w-fit cursor-pointer py-1 font-medium">Connection details</summary>
    <p className="mt-2">Linked {formatDay(connection.createdAt)}{connection.healthCheckedAt && <> · Checked {formatSynced(connection.healthCheckedAt)}</>}</p>
    {connection.accounts.map((account) => {
      const state = ledger.get(account.id);
      const last = state?.ledgerAccountId && lastCsv.get(state.ledgerAccountId);
      return <div key={account.id} className="my-2 space-y-1">
        <p>{account.name} · {account.subtype ?? account.type} · {rowsPhrase(account.rowCount)}</p>
        {last && <p>CSV history through {last}</p>}
        {state?.ledgerName && <p>Ledger · {state.ledgerName}</p>}
        {state?.cutoverDate && <p>Bank history from {state.cutoverDate}</p>}
        {state?.verifiedAt && <p>Statement verified {formatDay(state.verifiedAt)}</p>}
      </div>;
    })}
  </details>;
}

// What slice 7 adds under an account (REAL-ACCOUNTS.md): where it syncs into
// and from when, whether its rows count yet, and a re-issued account's
// question. Its cycle, statements and boundary review are on its ledger
// account's own page (the accounts board, 2026-11-05), linked from here, with
// any held row still to answer named.
function LedgerLines({
  accountId,
  state,
  hasRows,
  replacesName,
  linked,
}: {
  accountId: string;
  state: LedgerState | undefined;
  hasRows: boolean;
  replacesName: string | null;
  linked: boolean;
}) {
  if (!state) return null;
  if (state.replacesAccountId && replacesName && linked) return <ReissuedChoice accountId={accountId} replaces={replacesName} />;
  if (!state.ledgerAccountId) return null;
  const needsVerification = !state.verifiedAt && (hasRows || state.heldCount > 0);
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1 text-xs">
    {needsVerification && (linked
      ? <a href={`/accounts/verify/${accountId}`} className="font-medium text-warning underline underline-offset-2">Verify statement to count rows</a>
      : <span className="text-warning">Unverified · rows excluded</span>)}
    <a href={`/accounts/${state.ledgerAccountId}`} className="font-medium text-primary underline-offset-2 hover:underline">
      {state.heldCount > 0 ? `Review ${state.heldCount} held row${state.heldCount === 1 ? '' : 's'} →` : 'Open account →'}
    </a>
  </div>;
}

export default async function BankLoginsPage() {
  await requireUser();
  // The demo shows its synthetic logins (DEMO-SYNC.md): Sync now, the
  // boundary review and the statement check work; linking, reconnecting and
  // managing a login do not, since there is no real bank behind them.
  const demo = isDemoMode();

  const connections = await getBankConnections();
  const live = connections.filter((c) => c.status !== 'removed');
  const accountCount = live.reduce((n, c) => n + c.accounts.length, 0);
  const sandbox = process.env.PLAID_ENV === 'sandbox';
  // A deployment without Plaid credentials (a dev database, a preview) says
  // so instead of offering a button that fails.
  const configured = Boolean(
    process.env.PLAID_ENV && process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET,
  );
  const canSync = configured || demo;
  const left = sandbox ? null : itemsLeft(connections);
  const twins = twinAccounts(
    connections.map((c) => ({
      ...c,
      accounts: c.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        mask: a.mask,
        syncable: SYNCABLE.has(a.type),
        syncEnabled: a.syncEnabled,
      })),
    })),
  );
  const now = new Date();

  // Slice 7 (REAL-ACCOUNTS.md): each account's ledger account, cutover,
  // verification and boundary review.
  const allAccounts = connections.flatMap((c) => c.accounts);
  const [ledger, choices, lastCsv] = await Promise.all([
    ledgerStateFor(allAccounts.map((a) => a.id)),
    ledgerChoices(),
    lastCsvDates(),
  ]);
  const optionsFor = (accountId: string): LedgerOption[] =>
    choicesFor(choices, accountId).map((o) => ({
      id: o.id,
      displayName: o.displayName,
      lastCsvDate: o.lastCsvDate,
      defaultCutover: defaultCutover(o.lastCsvDate),
      cutoverDate: o.cutoverDate,
    }));
  const nameOf = (id: string) => {
    const a = allAccounts.find((x) => x.id === id);
    return a ? (a.mask ? `${a.name} ••${a.mask}` : a.name) : 'an earlier account';
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <a href="/" className="mb-2 inline-flex min-h-9 items-center text-sm text-blue-700 hover:underline dark:text-blue-400">
            ← All accounts
          </a>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            Bank logins
            {sandbox && (
              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                Sandbox
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {live.length === 0
              ? 'Link a bank login to list its accounts'
              : `${live.length} bank login${live.length === 1 ? '' : 's'} · ${accountCount} account${
                  accountCount === 1 ? '' : 's'
                }`}
          </p>
          {!demo && <p className="mt-0.5 text-xs text-muted-foreground">
            {sandbox
                ? 'Sandbox: Items are free here.'
                : `Items used: ${itemsUsed(connections)} of ${ITEM_BUDGET} on Plaid's Trial, removed logins included. Plaid's dashboard is the authority.`}
          </p>}
          {!demo && configured && (
            // What Sync now can bring (SCHEDULED-SYNC.md): /transactions/sync
            // reads what Plaid has stored; Plaid checks each bank on its own
            // schedule, so "no changes" soon after a sync is normal.
            <p className="mt-0.5 text-xs text-muted-foreground">
              Daily sync runs around 10:00 UTC. Sync now fetches updates already available from Plaid.
            </p>
          )}
        </div>
        {!demo && (configured ? (
          <LinkBankButton
            sandboxOverride={duplicateOverrideAllowed(process.env.PLAID_ENV)}
            linkedInstitutions={loginsByInstitution(live, (d) => formatShortDay(d, now)).map(institutionLine)}
            itemsLeft={left}
          />
        ) : (
          <p className="text-xs text-muted-foreground">Bank linking is not configured here.</p>
        ))}
      </div>

      <div className="space-y-4">
        {connections.map((c) => {
          const institution = c.institutionName ?? 'This bank';
          const kind = classifyItemError(c.itemErrorCode);
          const rows = c.accounts.reduce((n, a) => n + a.rowCount, 0);
          // Not removed: still a login, whatever its health.
          const linked = c.status !== 'removed';
          // A login Plaid no longer recognises has no consent left to renew,
          // and Reconnect is not offered for it.
          const consent = !linked || kind === 'gone' ? 'none' : consentState(c.consentExpiresAt, now);
          const needsOwner = kind === 'reconnect' || kind === 'fix_at_bank' || kind === 'unknown' || consent === 'expired';
          const actionNeeded = linked && (needsOwner || kind === 'gone');
          const reconnect =
            configured && offersReconnect(kind) ? <ReconnectButton connectionId={c.id} primary /> : null;
          const syncingHere = (a: (typeof c.accounts)[number]) => a.syncEnabled && c.status === 'active';
          const twinned = c.accounts.map((a) => ({ account: a, twins: twins.get(a.id) ?? [], syncingHere: syncingHere(a) }));
          const twinLine = linked ? twinSummary(twinned, formatDay) : null;
          return (
            <section key={c.id} className="overflow-hidden rounded-xl border bg-card">
              <LoginResultProvider>
                <div className="flex items-start justify-between gap-4 border-b px-4 py-2.5">
                  <div className="space-y-0.5">
                    <h2 className="flex items-center gap-2 text-sm font-medium">
                      {c.institutionName ?? 'Unknown institution'}
                      {healthBadge(c)}
                    </h2>
                    {!linked && (
                      <p className="text-xs text-muted-foreground">
                        Plaid&apos;s access ended and the token was erased. Its {rowsPhrase(rows)} stay in the ledger.
                      </p>
                    )}
                    {linked && kind === 'bank_unavailable' && <InfoLine>{healthSentence(c.itemErrorCode, institution)}</InfoLine>}
                    {linked && consent === 'soon' && c.consentExpiresAt && (
                      <InfoLine>
                        {institution} ends this login&apos;s consent on {formatDay(c.consentExpiresAt)}. Reconnect renews it, with
                        no new Item.
                      </InfoLine>
                    )}
                  </div>
                  {canSync && c.status === 'active' && c.accounts.length > 0 && kind !== 'gone' && (
                    <SyncNowButton connectionId={c.id} disabled={!c.accounts.some((a) => a.syncEnabled)} />
                  )}
                </div>
                <LoginResultLine />
                {actionNeeded && (
                  <ActionCallout action={kind === 'gone' ? null : reconnect}>
                    {kind === 'healthy' && consent === 'expired' && c.consentExpiresAt
                      ? `${institution} ended this login's consent on ${formatDay(c.consentExpiresAt)}. Reconnect renews it, with no new Item.`
                      : healthSentence(c.itemErrorCode, institution)}
                  </ActionCallout>
                )}
                {twinLine && (
                  <details
                    className={
                      twinLine.needsOwner
                        ? 'border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-900 dark:text-amber-200'
                        : 'border-b px-4 py-2 text-xs text-muted-foreground'
                    }
                  >
                    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                      <span className="inline-flex items-start gap-1.5">
                        {twinLine.needsOwner ? (
                          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
                        ) : (
                          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                        )}
                        <span>
                          {twinLine.text} <span className="underline underline-offset-2">Which accounts</span>
                        </span>
                      </span>
                    </summary>
                    <ul className="mt-1.5 space-y-1 pl-5">
                      {twinned
                        .filter((t) => t.twins.length > 0)
                        .map((t) => (
                          <li key={t.account.id}>
                            <span className="font-medium">
                              {t.account.mask ? `${t.account.name} ••${t.account.mask}` : t.account.name}
                            </span>
                            : {twinSentence(t.twins, t.syncingHere, formatDay)}
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
                {c.accounts.length === 0 ? (
                  linked && (
                    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm text-muted-foreground">
                      <span>Accounts not loaded yet.</span>
                      <RetryAccountsButton connectionId={c.id} />
                    </div>
                  )
                ) : (
                  <ul className="divide-y">
                    {c.accounts.map((a) => (
                      <li key={a.id} className="flex items-start justify-between gap-4 px-4 py-2 text-sm">
                        <div>
                          <span className={SYNCABLE.has(a.type) && !a.unsharedAt ? undefined : 'text-muted-foreground'}>
                            {a.name}
                          </span>
                          {a.mask && <span className="ml-2 font-mono text-xs text-muted-foreground">•• {a.mask}</span>}
                          <div className="text-xs text-muted-foreground">
                            {a.lastSyncedAt ? `Last synced ${formatSynced(a.lastSyncedAt)}` : 'No sync yet'}
                          </div>
                          {a.unsharedAt && (
                            <div className="text-xs text-muted-foreground">
                              No longer shared by the bank since {formatDay(a.unsharedAt)}; its rows stay.
                            </div>
                          )}
                          {a.lastSyncError && linked && (
                            <div role="alert" className="text-xs text-amber-700 dark:text-amber-400">
                              Last sync failed: {a.lastSyncError}
                            </div>
                          )}
                          <LedgerLines
                            accountId={a.id}
                            state={ledger.get(a.id)}
                            hasRows={a.rowCount > 0}
                            replacesName={ledger.get(a.id)?.replacesAccountId ? nameOf(ledger.get(a.id)!.replacesAccountId!) : null}
                            linked={linked && canSync}
                          />
                        </div>
                        {!linked ? null : SYNCABLE.has(a.type) ? (
                          a.unsharedAt ? (
                            <span className="text-xs text-muted-foreground">not shared</span>
                          ) : ledger.get(a.id)?.replacesAccountId ? (
                            <span className="text-xs text-muted-foreground">needs your answer</span>
                          ) : !ledger.get(a.id)?.ledgerAccountId && configured ? (
                            <SetUpSyncButton accountId={a.id} accountLabel={a.mask ? `${a.name} ••${a.mask}` : a.name} options={optionsFor(a.id)} />
                          ) : !a.lastSyncedAt && configured ? (
                            // Until its first sync, a mapping (and its cutover) can be corrected.
                            <div className="flex items-center gap-2">
                              <SetUpSyncButton
                                accountId={a.id}
                                accountLabel={a.mask ? `${a.name} ••${a.mask}` : a.name}
                                options={optionsFor(a.id)}
                                current={ledger.get(a.id)?.ledgerAccountId ?? null}
                              />
                              <AccountSyncToggle accountId={a.id} enabled={a.syncEnabled} label={a.name} />
                            </div>
                          ) : (
                            <AccountSyncToggle accountId={a.id} enabled={a.syncEnabled} label={a.name} />
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground">not an expense account</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <ConnectionDetails connection={c} ledger={ledger} lastCsv={lastCsv} />
                {configured && c.status !== 'removed' && (
                  <details className="border-t">
                    <summary className="cursor-pointer px-4 py-2 text-xs text-muted-foreground">Manage this login</summary>
                    <ManageLogin
                      connectionId={c.id}
                      institution={institution}
                      status={c.status}
                      reconnectable={offersReconnect(kind)}
                      needsOwner={needsOwner}
                      sentences={{
                        reconnect: actionSentence.reconnect(institution),
                        chooseAccounts: actionSentence.chooseAccounts(institution),
                        check: actionSentence.check(),
                        pauseOrResume:
                          c.status === 'active' ? actionSentence.pause(institution, rows) : actionSentence.resume(institution),
                        remove: actionSentence.remove(institution, rows, left),
                      }}
                    />
                  </details>
                )}
              </LoginResultProvider>
            </section>
          );
        })}
      </div>
    </main>
  );
}
