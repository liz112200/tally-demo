import 'server-only';
import { getScheduledLogins } from '@/db/queries';
import { syncInTurn, type ScheduledOutcome } from '@/lib/bank-sync/scheduled';
import { runConnectionSync } from './bank-run';

// The daily sync (SCHEDULED-SYNC.md): every active login with an account set
// to sync, one at a time, each isolated, none started after the deadline.
// The same per-login sync as Sync now, so the same lock and cursor check
// apply when both run at once.
export async function runScheduledSync(deadline: number): Promise<ScheduledOutcome[]> {
  return syncInTurn(await getScheduledLogins(), (id) => runConnectionSync(id, deadline), deadline);
}
