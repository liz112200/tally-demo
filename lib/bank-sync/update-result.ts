// The one message a finished Reconnect or Choose shared accounts shows
// (BANK-SYNC.md, slice 4). Update mode is "make this login work again", so
// the action finishes what the broken login interrupted: it reads the login's
// health, reloads its accounts and, when healthy, syncs, and this says what
// each step did. Success is said as plainly as failure. Pure.

export type UpdateOutcome = {
  accountSelection: boolean;
  // Plaid's error code after the update; null when healthy, undefined when
  // the health could not be read. Not healthy means no sync was attempted.
  health: string | null | undefined;
  reload:
    // `reissued`: of those added, how many look like a recorded account under
    // a new id; they cannot sync until adopted or declared different.
    | { ok: true; added: number; unshared: number; reshared: number; reissued: number }
    | { ok: false; message: string };
  sync:
    | { ran: true; lines: string[]; complete: boolean }
    | { ran: true; error: string }
    | { ran: false; reason: 'paused' | 'no_accounts' | 'unhealthy' };
};

// `details`: one line per account synced, listed under the message as Sync
// now lists them.
export type UpdateMessage = { kind: 'success' | 'warning'; text: string; details?: string[] };

function reloadSentence(reload: UpdateOutcome['reload'], accountSelection: boolean): string | null {
  if (!reload.ok) {
    return `Its accounts could not be reloaded: ${reload.message} Reconnect again to retry; it uses no new Item.`;
  }
  const parts = [
    reload.added > 0 ? `${reload.added} added, with sync off` : null,
    reload.reissued > 0
      ? `${reload.reissued} ${reload.reissued === 1 ? 'looks' : 'look'} like an account already here under a new id: adopt or decline on Accounts before it syncs`
      : null,
    reload.unshared > 0 ? `${reload.unshared} no longer shared, now not syncing; their rows stay` : null,
    reload.reshared > 0 ? `${reload.reshared} shared again, with sync off` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length > 0) return `Accounts: ${parts.join('; ')}.`;
  return accountSelection ? 'Which accounts are shared did not change.' : null;
}

export function updateResultMessage(o: UpdateOutcome): UpdateMessage {
  const head = o.accountSelection ? 'Shared accounts updated' : 'Reconnected';
  const reload = reloadSentence(o.reload, o.accountSelection);
  const join = (...parts: (string | null)[]) => parts.filter((p) => p !== null && p !== '').join(' ');

  if (o.health === undefined) {
    return { kind: 'warning', text: join(`${head}, but its status could not be read, so nothing was synced. Use Check shortly.`, reload) };
  }
  if (o.health !== null) {
    return { kind: 'warning', text: join(`${head}, but Plaid still reports ${o.health}, so nothing was synced.`, reload) };
  }

  const reloadFailed = !o.reload.ok;
  const sync = o.sync;
  if (!sync.ran) {
    const why =
      sync.reason === 'paused'
        ? 'Not synced: this login is paused; Resume to sync.'
        : 'Not synced: no account is set to sync.';
    return { kind: reloadFailed ? 'warning' : 'success', text: join(`${head}.`, reload, why) };
  }
  if ('error' in sync) {
    return { kind: 'warning', text: join(`${head}, but the sync failed: ${sync.error}`, reload) };
  }
  if (!sync.complete) {
    return { kind: 'warning', text: join(`${head}, but the sync did not finish.`, reload), details: sync.lines };
  }
  return { kind: reloadFailed ? 'warning' : 'success', text: join(`${head} and synced.`, reload), details: sync.lines };
}
