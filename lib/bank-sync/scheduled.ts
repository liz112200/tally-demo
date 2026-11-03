// The daily sync's loop (SCHEDULED-SYNC.md). Pure: it is handed the logins
// and the function that syncs one, so its isolation and its deadline are
// tested without a bank.
//
// Logins run one at a time, each on its own: a login that throws, or whose
// bank is down, is recorded and the next one runs. No login is started after
// the deadline; those not reached are said so, and the next day's run (or
// the stale line on Expenses) picks them up.

export type LoginToSync = { connectionId: string; label: string };

// What one login's sync returns (db/bank-sync.ts SyncReport, or why it did
// not run).
export type OneLoginResult =
  | { lines: string[]; complete: boolean }
  | { error: string }
  | { notRun: 'paused' | 'no_accounts' };

export type ScheduledOutcome = {
  connectionId: string;
  label: string;
  result: 'synced' | 'incomplete' | 'skipped' | 'failed' | 'not_reached';
  lines: string[];
};

export async function syncInTurn(
  logins: readonly LoginToSync[],
  syncOne: (connectionId: string) => Promise<OneLoginResult>,
  deadline: number,
  now: () => number = Date.now,
): Promise<ScheduledOutcome[]> {
  const outcomes: ScheduledOutcome[] = [];
  for (const login of logins) {
    const base = { connectionId: login.connectionId, label: login.label };
    if (now() >= deadline) {
      outcomes.push({ ...base, result: 'not_reached', lines: ['Not reached before the time limit; tomorrow’s run syncs it.'] });
      continue;
    }
    try {
      const r = await syncOne(login.connectionId);
      if ('notRun' in r) {
        outcomes.push({ ...base, result: 'skipped', lines: [r.notRun === 'paused' ? 'Paused.' : 'No account is set to sync.'] });
      } else if ('error' in r) {
        outcomes.push({ ...base, result: 'failed', lines: [r.error] });
      } else {
        outcomes.push({ ...base, result: r.complete ? 'synced' : 'incomplete', lines: r.lines });
      }
    } catch (err) {
      outcomes.push({ ...base, result: 'failed', lines: [err instanceof Error ? err.message : 'The sync failed.'] });
    }
  }
  return outcomes;
}
