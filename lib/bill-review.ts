import type { BillSnapshot, PreviousBalance, ShareSnapshotLine } from './bill-snapshot';
import type { BillDesign } from './bill-design';

export type ReviewPayment = { id: string; date: string; amount: number; appliedAt: string };
export type ReviewSource = { shareId: string; cash: number; pickedCash?: number; allocated: number; paymentIds?: string[] };
export type ReviewItem = ReviewSource & ShareSnapshotLine & { side: 'owed' | 'owing'; payments?: ReviewPayment[] };
export type StoredReviewSource = ReviewSource | { skipped: true } | null;
export type PriorItem = ShareSnapshotLine & { side: ReviewItem['side']; source?: ReviewSource; skipped?: boolean; recognized?: boolean; candidates?: ReviewSource[] };
export type PriorBill = { id: string; token?: string; date: string; items: PriorItem[]; tracked: boolean };
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
  const held = new Set(data.bills.flatMap(bill => bill.items.flatMap(line => (line.candidates ?? []).map(c => c.shareId))));
  const open = data.items.filter(item => item.outstandingCents > 0);
  return { previous, current, known, open, held, fresh: open.filter(item => !known.has(item.shareId) && !held.has(item.shareId)) };
}

export function billLine(item: ReviewItem, prior?: { item: PriorItem; date: string }): ShareSnapshotLine {
  const { date, description, category, outstandingCents } = item;
  const result: ShareSnapshotLine = { date, description, category, outstandingCents };
  if (!prior && item.pickedCash) result.pickedPayment = item.pickedCash;
  if (prior?.item.source) {
    const previous = prior.item.outstandingCents;
    const cash = item.cash - prior.item.source.cash;
    result.carried = { date: prior.date.slice(0, 10), previous, cash,
      adjustment: outstandingCents - previous + cash };
  }
  return result;
}

// Older private snapshots contain only the opening cash total. For those,
// use the allocation timestamp to identify additions and reconcile the exact
// delta before attaching any dates. The displayed date is the settlement day.
function paymentsSince(source: ReviewSource, billDate: string, now: ReviewItem, delta: number) {
  const openingIds = source.paymentIds && new Set(source.paymentIds);
  const additions = (now.payments ?? []).filter(payment => openingIds
    ? !openingIds.has(payment.id)
    : source.cash === 0 || payment.appliedAt > billDate);
  return additions.reduce((total, payment) => total + payment.amount, 0) === delta ? additions : [];
}

// Work from the original bill, including its now-settled rows. Summing only
// today's open rows would lose payments that cleared an expense completely.
function previousBalances(data: BillReview, comparison: ReturnType<typeof compareBills>, selected: Set<string>) {
  const groups: PreviousBalance[] = [];
  for (const bill of data.bills) {
    for (const side of ['owed', 'owing'] as const) {
      const group: PreviousBalance = {
        date: bill.date.slice(0, 10), token: bill.token, side, previous: 0, payments: 0,
        adjustments: 0, omitted: 0, included: 0, assigned: [],
      };
      const dated = new Map<string, { date: string; amount: number }>();
      for (const line of bill.items) {
        const source = line.source;
        if (line.side !== side) continue;
        if (!source) {
          group.partialSource = true;
          continue;
        }
        if (comparison.known.get(source.shareId)?.billId !== bill.id) {
          group.partialSource = true;
          continue;
        }
        const now = comparison.current.get(source.shareId);
        const remaining = now?.outstandingCents ?? 0;
        const paid = now ? now.cash - source.cash : 0;
        const picked = now ? (now.pickedCash ?? 0) - (source.pickedCash ?? 0) : 0;
        group.previous += line.outstandingCents;
        group.payments += paid;
        if (now && paid > 0) {
          for (const payment of paymentsSince(source, bill.date, now, paid)) {
            const entry = dated.get(payment.id) ?? { date: payment.date, amount: 0 };
            entry.amount += payment.amount;
            dated.set(payment.id, entry);
          }
        }
        group.adjustments += remaining - line.outstandingCents + paid;
        if (selected.has(source.shareId)) group.included += remaining;
        else group.omitted += remaining;
        if (picked > 0 && (remaining === 0 || selected.has(source.shareId))) {
          group.assigned.push({ description: line.description, date: line.date, paid: picked,
            // A mix of picked and automatic cash has no item-specific remainder.
            remaining: paid === picked ? remaining : undefined });
        }
      }
      if (group.included > 0) {
        group.paymentDetails = [...dated.values()].sort((a, b) => a.date.localeCompare(b.date));
        groups.push(group);
      }
    }
  }
  return groups;
}

export function composeBill(data: BillReview, comparison: ReturnType<typeof compareBills>, selected: Set<string>, paper: BillDesign, grouped: boolean, createdAt: Date) {
  const snapshot: BillSnapshot = { personName: data.name, paper, groupedByCategory: grouped, createdAt,
    owed: [], owing: [], owedCents: 0, owingCents: 0, netCents: 0 };
  const sources: ReviewSource[] = [];
  for (const side of ['owed', 'owing'] as const) {
    for (const item of comparison.open) {
      if (item.side !== side || !selected.has(item.shareId) || comparison.held.has(item.shareId)) continue;
      snapshot[side].push(billLine(item, comparison.known.get(item.shareId)));
      snapshot[side === 'owed' ? 'owedCents' : 'owingCents'] += item.outstandingCents;
      sources.push({ shareId: item.shareId, cash: item.cash, pickedCash: item.pickedCash ?? 0, allocated: item.allocated, paymentIds: item.payments?.map(payment => payment.id) });
    }
  }
  snapshot.previousBalances = previousBalances(data, comparison, selected);
  snapshot.netCents = snapshot.owedCents - snapshot.owingCents;
  return { snapshot, sources };
}
