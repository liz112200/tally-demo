import { isCronRequest } from '@/lib/auth/session-token';
import { isDemoMode } from '@/lib/demo-mode';
import { runScheduledSync } from '@/app/_lib/scheduled-sync';

// The daily bank sync (SCHEDULED-SYNC.md), called by Vercel Cron at 10:00
// UTC with `Authorization: Bearer $CRON_SECRET` (vercel.ts, the app only).
// Sync now stays; this runs in addition to it.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// No login is started after this, leaving room within the 300 s limit for
// the last one's commits.
const START_BUDGET_MS = 240_000;

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }
  // The demo's data resets daily and has no scheduled sync.
  if (isDemoMode()) return new Response('Not found', { status: 404 });
  const outcomes = await runScheduledSync(Date.now() + START_BUDGET_MS);
  // One line per login for Vercel's log: the login, how it went, and the
  // counts (never a token, a query or an amount).
  for (const o of outcomes) console.info(`scheduled sync ${o.label} (${o.connectionId}): ${o.result}; ${o.lines.join(' ')}`);
  return Response.json({ logins: outcomes });
}
