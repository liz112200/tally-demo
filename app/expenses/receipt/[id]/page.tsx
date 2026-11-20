import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/app/_lib/session';
import { demoDinnerTransactionId } from '@/db/demo-bank';
import { getReceiptByTransactionId, getTransactionForSplit } from '@/db/queries';
import { isDemoMode } from '@/lib/demo-mode';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Split a receipt · Tally' };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const sample = id === 'sample-dinner' && isDemoMode();
  const transactionId = sample ? await demoDinnerTransactionId() : z.uuid().safeParse(id).data;
  if (!transactionId) {
    if (!sample) notFound();
    return <main className="mx-auto max-w-6xl space-y-3 px-4 py-6 sm:px-6"><Link href="/" className="text-sm underline">Back to demo</Link><h1 className="text-xl font-semibold">Sample dinner unavailable</h1>
      <p className="mt-2">Use Reset demo in the banner to restore the sample receipt.</p></main>;
  }
  const [row, receipt] = await Promise.all([getTransactionForSplit(transactionId), getReceiptByTransactionId(transactionId)]);
  if (!row || !receipt || !row.isSplittable) notFound();
  redirect(`/expenses?tx=${row.id}&split=item`);
}
