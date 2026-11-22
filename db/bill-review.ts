import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from './index';
import { persons, settlements, settlementAllocations as allocations, shareLinks } from './schema';
import { getDebtShares, type Tx } from './queries';
import type { BillReview, PriorItem } from '@/lib/bill-review';
import type { ShareSnapshotLine } from '@/lib/bill-snapshot';
import { shareStatus } from '@/lib/allocations';

export async function readBillReview(tx: Tx, personId: string) {
  const [person] = await tx.select({ name: persons.name, owner: persons.isOwner }).from(persons).where(eq(persons.id, personId));
  if (!person || person.owner) return null;
  const rows = await getDebtShares(tx, personId);
  const paid = await tx.select({ id: allocations.splitShareId, cash: sql<number>`sum(${allocations.amountCents})`.mapWith(Number) })
    .from(allocations).innerJoin(settlements, eq(settlements.id, allocations.settlementId))
    .where(and(eq(settlements.personId, personId), eq(settlements.isOffset, false))).groupBy(allocations.splitShareId);
  const cash = new Map(paid.map(row => [row.id, row.cash]));
  const bills = await tx.select({
    id: shareLinks.id, date: shareLinks.createdAt, sources: shareLinks.reviewSources,
    owed: shareLinks.lines, owing: shareLinks.owingLines,
  }).from(shareLinks).where(or(eq(shareLinks.reviewPersonId, personId),
    and(isNull(shareLinks.reviewPersonId), eq(shareLinks.personName, person.name))))
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  const data: BillReview = {
    personId, name: person.name,
    items: rows.reverse().map(row => ({
      shareId: row.shareId, cash: cash.get(row.shareId) ?? 0, allocated: row.allocatedCents,
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
      return { id: bill.id, date: bill.date.toISOString(), tracked: bill.sources !== null, items };
    }),
  };
  const version = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return { data, version };
}

export function loadBillReview(personId: string) {
  return db.transaction(tx => readBillReview(tx, personId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
