import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/app/_lib/session';
import { ReceiptSplit } from '@/app/_components/receipt-split';
import { demoDinnerTransactionId } from '@/db/demo-bank';
import { getPersons, getReceiptByTransactionId, getTransactionForSplit } from '@/db/queries';
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
  const [row, receipt, persons] = await Promise.all([
    getTransactionForSplit(transactionId), getReceiptByTransactionId(transactionId), getPersons(),
  ]);
  if (!row || !receipt || !row.isSplittable) notFound();
  return (
    <main className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <Link href={sample ? '/' : `/expenses?tx=${row.id}`}
          className="mb-2 inline-flex min-h-9 items-center gap-1.5 text-sm text-blue-700 hover:underline dark:text-blue-400">
          <ArrowLeft className="size-4" aria-hidden />{sample ? 'Back to demo' : 'Back to expense'}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Split a receipt</h1>
      </div>
      <ReceiptSplit key={receipt.id} sample={sample} receipt={receipt} amountCents={row.amountCents}
        persons={persons.map(({ id, name, isOwner }) => ({ id, name, isOwner }))} />
    </main>
  );
}
