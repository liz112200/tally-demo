import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSnapshot } from '@/db';
import { SharedBill } from '@/app/_components/shared-bill';

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
  const snapshot = await getSnapshot(token);
  if (!snapshot) notFound();

  return <SharedBill snapshot={snapshot} />;
}
