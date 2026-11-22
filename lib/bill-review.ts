import type { BillSnapshot, ShareSnapshotLine } from './bill-snapshot';
import type { BillDesign } from './bill-design';

export type ReviewSource = { shareId: string; cash: number; allocated: number };
export type ReviewItem = ReviewSource & ShareSnapshotLine & { side: 'owed' | 'owing' };
export type PriorItem = ShareSnapshotLine & { side: ReviewItem['side']; source?: ReviewSource };
export type PriorBill = { id: string; date: string; items: PriorItem[]; tracked: boolean };
export type BillReview = { personId: string; name: string; items: ReviewItem[]; bills: PriorBill[] };

export function compareBills(data: BillReview, billId: string) {
  const previous = data.bills.find(b => b.id === billId);
  const current = new Map(data.items.map(item => [item.shareId, item]));
  // Keep expenses from older, skipped bills out of the "new" selection too.
  const known = new Map<string, { item: PriorItem; date: string; billId: string }>();
  for (const bill of [previous, ...data.bills]) {
    if (!bill) continue;
    for (const item of bill.items) {
      if (item.source && !known.has(item.source.shareId)) {
        known.set(item.source.shareId, { item, date: bill.date, billId: bill.id });
      }
    }
  }
  const open = data.items.filter(item => item.outstandingCents > 0);
  return { previous, current, known, open, fresh: open.filter(item => !known.has(item.shareId)) };
}

export function billLine(item: ReviewItem, prior?: { item: PriorItem; date: string }): ShareSnapshotLine {
  const { date, description, category, outstandingCents } = item;
  const result: ShareSnapshotLine = { date, description, category, outstandingCents };
  if (prior?.item.source) {
    const previous = prior.item.outstandingCents;
    const cash = item.cash - prior.item.source.cash;
    result.carried = { date: prior.date.slice(0, 10), previous, cash,
      adjustment: outstandingCents - previous + cash };
  }
  return result;
}

export function composeBill(data: BillReview, comparison: ReturnType<typeof compareBills>, selected: Set<string>, paper: BillDesign, grouped: boolean, createdAt: Date) {
  const snapshot: BillSnapshot = { personName: data.name, paper, groupedByCategory: grouped, createdAt,
    owed: [], owing: [], owedCents: 0, owingCents: 0, netCents: 0 };
  const sources: ReviewSource[] = [];
  for (const side of ['owed', 'owing'] as const) {
    for (const item of comparison.open) {
      if (item.side !== side || !selected.has(item.shareId)) continue;
      snapshot[side].push(billLine(item, comparison.known.get(item.shareId)));
      snapshot[side === 'owed' ? 'owedCents' : 'owingCents'] += item.outstandingCents;
      sources.push({ shareId: item.shareId, cash: item.cash, allocated: item.allocated });
    }
  }
  snapshot.netCents = snapshot.owedCents - snapshot.owingCents;
  return { snapshot, sources };
}
