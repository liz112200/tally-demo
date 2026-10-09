import { getAllPersons } from '@/db/queries';
import { isDemoMode } from '@/lib/demo-mode';
import { buildDemoSeed, seedDayFromOwnerCreatedAt } from '@/lib/demo/seed';

// The demo's sample Discover statement: the newest activity, not yet
// imported, whose oldest rows overlap the last seeded statement. Built from
// the same seed as the ledger, against the day that ledger was built for.
export async function GET(): Promise<Response> {
  if (!isDemoMode()) return new Response('Not found', { status: 404 });
  const owner = (await getAllPersons()).find((p) => p.isOwner);
  if (!owner) return new Response('Demo data is missing; reset the demo.', { status: 409 });
  const { filename, csv } = buildDemoSeed(seedDayFromOwnerCreatedAt(owner.createdAt)).sampleStatement;
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
