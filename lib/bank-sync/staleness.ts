// The line Expenses shows for an account that has gone quiet
// (SCHEDULED-SYNC.md). Pure. One line per account that syncs (enabled, on an
// active login, still shared) and has not synced for STALE_AFTER_MS, saying
// which account, since when, and which of three cases it is:
//   - needs_you: the login needs the owner (sign in again, something at the
//     bank, consent ended, a login Plaid no longer knows). It will not fix
//     itself.
//   - transient: the bank was not answering, or the last sync failed on a
//     healthy login. The next daily sync retries.
//   - not_run: a healthy login, no error, and still nothing: the daily sync
//     itself has not run, which neither of the others would show.
import { classifyItemError, healthSentence } from './item-health';

export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export type StaleAccount = {
  label: string;
  institution: string;
  connectionStatus: 'active' | 'paused' | 'removed';
  itemErrorCode: string | null;
  consentExpiresAt: Date | null;
  syncEnabled: boolean;
  unshared: boolean;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
};

export type StaleLine = { kind: 'needs_you' | 'transient' | 'not_run'; text: string };

const RETRY = 'The daily sync tries again; look again if this is still here tomorrow.';

function since(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}

export function staleLines(accounts: readonly StaleAccount[], now: Date): StaleLine[] {
  const lines: StaleLine[] = [];
  for (const a of accounts) {
    if (!a.syncEnabled || a.connectionStatus !== 'active' || a.unshared || a.lastSyncedAt === null) continue;
    if (now.getTime() - a.lastSyncedAt.getTime() < STALE_AFTER_MS) continue;
    const head = `${a.label} has not synced since ${since(a.lastSyncedAt)}`;
    const kind = classifyItemError(a.itemErrorCode);
    const consentEnded = a.consentExpiresAt !== null && a.consentExpiresAt.getTime() <= now.getTime();
    if (kind === 'reconnect' || kind === 'fix_at_bank' || kind === 'gone' || kind === 'unknown') {
      lines.push({ kind: 'needs_you', text: `${head}. ${healthSentence(a.itemErrorCode, a.institution)} This will not fix itself.` });
    } else if (consentEnded) {
      lines.push({
        kind: 'needs_you',
        text: `${head}. ${a.institution} ended this login's consent; Reconnect renews it, with no new Item. This will not fix itself.`,
      });
    } else if (kind === 'bank_unavailable') {
      lines.push({ kind: 'transient', text: `${head}: ${a.institution} was not answering through Plaid. ${RETRY}` });
    } else if (a.lastSyncError) {
      lines.push({ kind: 'transient', text: `${head}: its last sync failed (${a.lastSyncError}). ${RETRY}` });
    } else {
      lines.push({
        kind: 'not_run',
        text:
          `${head}, and no error was recorded: the daily sync has not run. Sync now on Accounts brings it up to date; ` +
          'the daily sync itself needs looking at in Vercel (its cron and CRON_SECRET).',
      });
    }
  }
  const order = { needs_you: 0, transient: 1, not_run: 2 };
  return lines.sort((x, y) => order[x.kind] - order[y.kind]);
}
