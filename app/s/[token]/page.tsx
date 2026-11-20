import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getShareLinkByToken } from '@/db/queries';
import { SharedBill } from '@/share/app/_components/shared-bill';
import { isDemoMode } from '@/lib/demo-mode';
import { demoSharingNote } from '@/lib/bill-design';

export const dynamic = 'force-dynamic';

// Keep snapshots out of search results. They are unguessable rather than
// secret, and a crawler that somehow saw a link should not index it.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function SharedListPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const snapshot = await getShareLinkByToken(token);
  if (!snapshot) notFound();

  return <SharedBill snapshot={snapshot} note={isDemoMode() ? demoSharingNote : undefined} />;
}
