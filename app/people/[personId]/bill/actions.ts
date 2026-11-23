'use server';

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/app/_lib/session';
import { getBillLinkBase } from '@/app/_lib/bill-links';
import { billHref } from '@/lib/share-summary';
import { compareBills, composeBill } from '@/lib/bill-review';
import { billDesigns, type BillDesign } from '@/lib/bill-design';
import { db } from '@/db';
import { readBillReview } from '@/db/bill-review';
import { insertShareLink } from '@/db/queries';
import { shareLinks } from '@/db/schema';

const inputSchema = z.object({
  personId: z.uuid(), requestId: z.uuid(), compareId: z.union([z.uuid(), z.literal('')]),
  selected: z.array(z.uuid()).min(1).max(1000), version: z.string().length(64),
  paper: z.enum(Object.keys(billDesigns) as [BillDesign, ...BillDesign[]]), grouped: z.boolean(),
});

export async function publishReviewedBill(input: unknown) {
  await requireUser();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: 'Choose between 1 and 1,000 open items.' };
  const base = await getBillLinkBase();
  if (base === null) return { error: 'Bill site unavailable.' };
  const draft = parsed.data;
  const existing = () => db.select({ token: shareLinks.token }).from(shareLinks)
    .where(and(eq(shareLinks.id, draft.requestId), eq(shareLinks.reviewPersonId, draft.personId))).limit(1);
  const saved = async (token: string) => {
    revalidatePath('/people/shared-bills');
    return { href: billHref(base, token) };
  };
  try {
    const [prior] = await existing();
    if (prior) return saved(prior.token);
    const result = await db.transaction(async tx => {
      const latest = await readBillReview(tx, draft.personId);
      if (!latest || latest.version !== draft.version) return { stale: true as const };
      const comparison = compareBills(latest.data, draft.compareId);
      const selected = new Set(draft.selected);
      const { snapshot, sources } = composeBill(latest.data, comparison, selected, draft.paper, draft.grouped, new Date());
      if (sources.length !== selected.size || (draft.compareId && !comparison.previous)) return { stale: true as const };
      return insertShareLink({ ...snapshot, review: { personId: draft.personId, sources, requestId: draft.requestId } }, tx);
    }, { isolationLevel: 'repeatable read' });
    if ('stale' in result) return { stale: true as const, error: 'The balance or bill history changed. Refresh the draft to review it.' };
    return saved(result.token);
  } catch {
    const [retry] = await existing();
    if (retry) return saved(retry.token);
    return { error: 'Couldn’t create the link. Your selection is still here.' };
  }
}
