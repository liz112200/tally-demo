import type { PriorBill, PriorItem, ReviewItem, ReviewSource } from './bill-review';

export type PastAllocation = { amount: number; at: string; paymentId: string; cash: boolean; picked: boolean };
export type ShareHistory = { createdAt: string; allocations: PastAllocation[] };

function normalize(label: string) {
  return label.normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Reconstruct the baseline at publication. The settlement day can be backdated,
// so membership in the earlier balance follows when the allocation was made.
function atPublication(item: ReviewItem, history: ShareHistory, at: string) {
  const source: ReviewSource = { shareId: item.shareId, cash: 0, pickedCash: 0, allocated: 0, paymentIds: [] };
  for (const a of history.allocations) {
    if (a.at > at) continue;
    source.allocated += a.amount;
    if (a.cash) {
      source.cash += a.amount;
      source.paymentIds!.push(a.paymentId);
      if (a.picked) source.pickedCash! += a.amount;
    }
  }
  return { source, amount: item.outstandingCents + item.allocated - source.allocated };
}

export function matchOlderBill(bill: PriorBill, ledger: ReviewItem[], history: Map<string, ShareHistory>): PriorBill {
  const taken = new Set(bill.items.flatMap(line => line.source ? [line.source.shareId] : []));
  const entries = ledger.flatMap(item => {
    const h = history.get(item.shareId);
    if (!h || h.createdAt > bill.date || taken.has(item.shareId)) return [];
    const opening = atPublication(item, h, bill.date);
    return [{ item, ...opening, label: normalize(item.description) }];
  });
  const demand = new Map<string, number>();
  const choices = bill.items.map(line => {
    if (line.source) return [];
    const label = normalize(line.description);
    return entries.flatMap(({ item, source, amount, label: merchant }) => {
      if (line.side !== item.side) return [];
      const sameDate = item.date === line.date;
      const sameLabel = Boolean(label) && label === merchant;
      const sameAmount = amount === line.outstandingCents;
      const nearby = Math.abs(Date.parse(line.date) - Date.parse(item.date)) <= 7 * 86400000;
      if (!(sameDate && (sameLabel || sameAmount) || nearby && sameLabel && sameAmount)) return [];
      if (!line.skipped) demand.set(item.shareId, (demand.get(item.shareId) ?? 0) + 1);
      return [{ source, exact: sameDate && sameLabel && sameAmount }];
    });
  });
  const items = bill.items.map((line, i): PriorItem => {
    const possible = choices[i];
    if (line.skipped || !possible.length) return line;
    const [only] = possible;
    if (!line.reconsider && possible.length === 1 && only.exact && demand.get(only.source.shareId) === 1) {
      taken.add(only.source.shareId);
      return { ...line, source: only.source, recognized: true };
    }
    return { ...line, candidates: possible.map(c => c.source) };
  });
  // A previously dismissed suggestion can be chosen again without holding it
  // out of a draft or offering an expense already assigned on this bill.
  for (const [i, line] of items.entries()) {
    if (line.skipped) {
      items[i] = { ...line, alternatives: choices[i].map(c => c.source).filter(c => !taken.has(c.shareId)) };
    }
  }
  return { ...bill, items, tracked: items.every(line => Boolean(line.source)) };
}
