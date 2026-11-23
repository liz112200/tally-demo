import 'server-only';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from './index';
import { persons, settlements, settlementAllocations as allocations, shareLinks } from './schema';
import { getDebtShares, type Tx } from './queries';
import type { BillReview, PriorItem, ReviewPayment } from '@/lib/bill-review';
import type { ShareSnapshotLine } from '@/lib/bill-snapshot';
import { shareStatus } from '@/lib/allocations';

export async function readBillReview(tx: Tx, personId: string) {
  const [person] = await tx.select({ name: persons.name, owner: persons.isOwner }).from(persons).where(eq(persons.id, personId));
  if (!person || person.owner) return null;
  const rows = await getDebtShares(tx, personId);
  const paid = await tx.select({
    shareId: allocations.splitShareId, paymentId: settlements.id, amount: allocations.amountCents,
    picked: allocations.picked, date: settlements.date, appliedAt: allocations.createdAt,
  }).from(allocations).innerJoin(settlements, eq(settlements.id, allocations.settlementId))
    .where(and(eq(settlements.personId, personId), eq(settlements.isOffset, false)))
    .orderBy(asc(settlements.date), asc(settlements.id), asc(allocations.splitShareId));
  const cash = new Map<string, { total: number; picked: number; payments: ReviewPayment[] }>();
  for (const row of paid) {
    const share = cash.get(row.shareId) ?? { total: 0, picked: 0, payments: [] };
    share.total += row.amount;
    if (row.picked) share.picked += row.amount;
    share.payments.push({ id: row.paymentId, date: row.date, amount: row.amount, appliedAt: row.appliedAt.toISOString() });
    cash.set(row.shareId, share);
  }
  const bills = await tx.select({
    id: shareLinks.id, token: shareLinks.token, revoked: shareLinks.revokedAt, date: shareLinks.createdAt, sources: shareLinks.reviewSources,
    owed: shareLinks.lines, owing: shareLinks.owingLines,
  }).from(shareLinks).where(or(eq(shareLinks.reviewPersonId, personId),
    and(isNull(shareLinks.reviewPersonId), eq(shareLinks.personName, person.name))))
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  const data: BillReview = {
    personId, name: person.name,
    items: rows.reverse().map(row => ({
      shareId: row.shareId, payments: cash.get(row.shareId)?.payments ?? [],
      cash: cash.get(row.shareId)?.total ?? 0, pickedCash: cash.get(row.shareId)?.picked ?? 0, allocated: row.allocatedCents,
      date: row.date, description: row.merchantLabel || row.description, category: row.categoryName,
      outstandingCents: shareStatus(row).outstandingCents, side: row.direction === 'incoming' ? 'owed' : 'owing',
    })),
    bills: bills.map(bill => {
      const items: PriorItem[] = [];
      for (const side of ['owed', 'owing'] as const) {
        for (const line of bill[side] as ShareSnapshotLine[]) {
          items.push({ ...line, side, source: bill.sources?.[items.length] });
        }
      }
      return { id: bill.id, token: bill.revoked || !bill.sources ? undefined : bill.token, date: bill.date.toISOString(), tracked: bill.sources !== null, items };
    }),
  };
  const version = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return { data, version };
}

export function loadBillReview(personId: string) {
  return db.transaction(tx => readBillReview(tx, personId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
