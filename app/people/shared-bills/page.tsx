import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { z } from 'zod';
import { requireUser } from '@/app/_lib/session';
import { getSharedBillHistory } from '@/db/queries';
import { getBillLinkBase } from '@/app/_lib/bill-links';
import { billHref } from '@/lib/share-summary';
import { billDesigns, readBillDesign } from '@/lib/bill-design';
import { formatUSD, toCents } from '@/lib/money';
import { BillLinkActions } from './bill-link-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Shared bill history · Tally' };

const historyPath = '/people/shared-bills';
const sharedAt = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York',
});

export default async function SharedBillHistoryPage({ searchParams }: {
  searchParams: Promise<{ before?: string }>;
}) {
  await requireUser();
  const { before } = await searchParams;
  if (before !== undefined && !z.string().uuid().safeParse(before).success) notFound();
  const [{ bills, olderThan }, base] = await Promise.all([getSharedBillHistory(before), getBillLinkBase()]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/people" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft size={15} aria-hidden /> People
      </Link>
      <h1 className="mt-4">Shared bill history</h1>
      <p className="mt-1 text-sm text-muted-foreground">Balances as they appeared when each link was created.</p>
      {bills.length === 0 ? (
        <div className="mt-6 border-y py-8">
          <h2>{before ? 'No older bills' : 'No bill links yet'}</h2>
          {!before && <p className="mt-1 text-sm">Open someone in People and choose <b>Create bill</b> to save your first bill here.</p>}
        </div>
      ) : (
        <ul className="mt-6 divide-y border-y" aria-label="Shared bills">
          {bills.map(bill => {
            const paper = readBillDesign(bill.paper);
            return (
              <li key={bill.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" data-paper={paper} className="bill-swatch-art hidden w-12 shrink-0 rounded-sm border sm:block" />
                  <div className="min-w-0">
                    <h2 className="break-words">{bill.personName}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <time dateTime={bill.createdAt.toISOString()}>{sharedAt.format(bill.createdAt)} ET</time>
                      <span aria-hidden>·</span><span>{billDesigns[paper]}</span>
                    </div>
                  </div>
                </div>
                <p className="text-right">
                  <strong className="font-mono">{formatUSD(toCents(Math.abs(bill.netCents)))}</strong>
                  <small className="block text-muted-foreground">
                    {bill.netCents > 0 ? 'owed to you' : bill.netCents < 0 ? 'you owed' : 'even'}
                  </small>
                </p>
                <div className="col-span-2">
                  {bill.revokedAt ? <span className="text-xs text-muted-foreground">Link off</span> :
                    <BillLinkActions id={bill.id} href={base === null ? null : billHref(base, bill.token)} personName={bill.personName} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {(before || olderThan) && (
        <nav aria-label="Bill history pages" className="mt-4 flex justify-between gap-4 text-sm underline">
          {before && <Link href={historyPath}>Newest bills</Link>}
          {olderThan && <Link className="ml-auto" href={historyPath + '?before=' + olderThan}>Older bills</Link>}
        </nav>
      )}
    </main>
  );
}
