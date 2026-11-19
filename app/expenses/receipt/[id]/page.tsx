import Link from 'next/link';
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
    return <main className="mx-auto max-w-3xl p-6"><h1 className="text-xl font-semibold">Sample dinner unavailable</h1>
      <p className="mt-2">Use Reset demo in the banner to restore the sample receipt.</p></main>;
  }
  const [row, receipt, persons] = await Promise.all([
    getTransactionForSplit(transactionId), getReceiptByTransactionId(transactionId), getPersons(),
  ]);
  if (!row || !receipt || !row.isSplittable) notFound();
  return (
    <main className="mx-auto max-w-4xl space-y-4 px-3 py-5 sm:px-6 sm:py-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link className="underline underline-offset-2" href={'/expenses?tx=' + row.id}>Expense detail</Link><span aria-hidden>/</span>
        <h1 className="font-medium text-foreground">Split a receipt</h1>
      </nav>
      <ReceiptSplit key={receipt.id} receipt={receipt} amountCents={row.amountCents}
        persons={persons.map(({ id, name, isOwner }) => ({ id, name, isOwner }))} />
    </main>
  );
}
