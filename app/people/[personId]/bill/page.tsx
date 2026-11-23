import { notFound } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { ArrowLeft } from 'lucide-react';
import { requireUser } from '@/app/_lib/session';
import { loadBillReview } from '@/db/bill-review';
import { isDemoMode } from '@/lib/demo-mode';
import { getBillLinkBase } from '@/app/_lib/bill-links';
import { ReviewEditor } from './review-editor';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Create bill · Tally' };

export default async function ReviewPage({ params, searchParams }: {
  params: Promise<{ personId: string }>; searchParams: Promise<{ group?: string }>;
}) {
  await requireUser();
  const { personId } = await params;
  if (!z.string().uuid().safeParse(personId).success) notFound();
  const [review, billBase] = await Promise.all([loadBillReview(personId), getBillLinkBase()]);
  if (!review) notFound();
  return <main className="mx-auto max-w-5xl px-4 py-7 sm:px-8">
    <Link className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" href="/people"><ArrowLeft size={15} /> People</Link>
    <ReviewEditor key={personId} {...review} billBase={billBase} demo={isDemoMode()} grouped={(await searchParams).group === 'category'} />
  </main>;
}
