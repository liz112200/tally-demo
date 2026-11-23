import 'server-only';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, or } from 'drizzle-orm';
import { db } from './index';
import { persons, settlements, settlementAllocations as allocations, shareLinks } from './schema';
import { getDebtShares, type Tx } from './queries';
import type { BillReview, PriorItem, ReviewPayment } from '@/lib/bill-review';
import type { ShareSnapshotLine } from '@/lib/bill-snapshot';
import { matchOlderBill, type ShareHistory } from '@/lib/older-bill-matches';
import { isDemoMode } from '@/lib/demo-mode';
import { shareStatus } from '@/lib/allocations';

export async function readBillReview(tx: Tx, personId: string) {
  const [person] = await tx.select({ name: persons.name, owner: persons.isOwner, createdAt: persons.createdAt }).from(persons).where(eq(persons.id, personId));
  if (!person || person.owner) return null;
  const rows = await getDebtShares(tx, personId);
  const demo = isDemoMode();
  const history = new Map<string, ShareHistory>(rows.map(row => [row.shareId, {
    createdAt: row.splitCreatedAt.toISOString(), allocations: [],
  }]));
  const paid = await tx.select({
    shareId: allocations.splitShareId, paymentId: settlements.id, amount: allocations.amountCents,
    offset: settlements.isOffset, picked: allocations.picked, date: settlements.date, appliedAt: allocations.createdAt,
  }).from(allocations).innerJoin(settlements, eq(settlements.id, allocations.settlementId))
    .where(eq(settlements.personId, personId))
    .orderBy(asc(settlements.date), asc(settlements.id), asc(allocations.splitShareId));
  const cash = new Map<string, { total: number; picked: number; payments: ReviewPayment[] }>();
  for (const row of paid) {
    history.get(row.shareId)?.allocations.push({ amount: row.amount, at: row.appliedAt.toISOString(),
      paymentId: row.paymentId, cash: !row.offset, picked: row.picked });
    if (row.offset) continue;
    const share = cash.get(row.shareId) ?? { total: 0, picked: 0, payments: [] };
    share.total += row.amount;
    if (row.picked) share.picked += row.amount;
    share.payments.push({ id: row.paymentId, date: row.date, amount: row.amount, appliedAt: row.appliedAt.toISOString() });
    cash.set(row.shareId, share);
  }
  // Legacy snapshots contain a name only. Never bind across namesakes.
  const namesakes = await tx.select({ id: persons.id }).from(persons).where(eq(persons.name, person.name)).limit(2);
  const bills = await tx.select({
    id: shareLinks.id, token: shareLinks.token, revoked: shareLinks.revokedAt, date: shareLinks.createdAt, sources: shareLinks.reviewSources,
    owed: shareLinks.lines, owing: shareLinks.owingLines,
  }).from(shareLinks).where(or(eq(shareLinks.reviewPersonId, personId),
    namesakes.length === 1 ? and(isNull(shareLinks.reviewPersonId), eq(shareLinks.personName, person.name), gte(shareLinks.createdAt, person.createdAt)) : undefined))
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
          const stored = bill.sources?.[items.length];
          items.push({ ...line, side, source: stored && 'shareId' in stored ? stored : undefined,
            skipped: stored && 'skipped' in stored ? true : undefined });
        }
      }
      return { id: bill.id, token: bill.revoked || (!demo && !bill.sources) ? undefined : bill.token, date: bill.date.toISOString(), tracked: items.every(line => Boolean(line.source)), items };
    }),
  };
  if (demo) data.bills = data.bills.map(bill => {
    if (bill.tracked) return bill;
    const matched = matchOlderBill(bill, data.items, history);
    // An earlier link discloses its entire receipt, including unresolved rows.
    return matched.tracked ? matched : { ...matched, token: undefined };
  });
  const version = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return { data, version };
}

export function loadBillReview(personId: string) {
  return db.transaction(tx => readBillReview(tx, personId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
