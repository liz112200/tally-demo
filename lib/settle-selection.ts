// Share selection for the manual settlement allocator. Pure functions over
// integer minor units, no dependency on React, Next.js, or the database.
//
// A selection maps shareId -> the amount this payment applies to that share.
// Presence means "selected"; ticking a share applies its full outstanding, and
// a smaller typed amount makes it a partial payment. Shares are always passed
// in FIFO order (effective date, then created_at, then id — the order
// getDebtShares returns), and every function here preserves it, so the
// allocation payload reads in the same order the server would fill.
import { allocateFifo } from './allocations';
import { tryParseDollars } from './money';

export type SelectableShare = {
  shareId: string;
  date: string;
  outstandingCents: number;
};

export type Selection = Readonly<Record<string, number>>;

export type MonthGroup<T extends SelectableShare> = {
  key: string; // YYYY-MM
  label: string; // "Jun 2026"
  shares: T[];
  totalCents: number;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

// Consecutive months in first-appearance order. Shares arrive in FIFO order,
// which is date-ascending, so the groups come out oldest month first.
export function groupByMonth<T extends SelectableShare>(shares: readonly T[]): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = [];
  const byKey = new Map<string, MonthGroup<T>>();
  for (const s of shares) {
    const key = monthKey(s.date);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: monthLabel(key), shares: [], totalCents: 0 };
      byKey.set(key, group);
      groups.push(group);
    }
    group.shares.push(s);
    group.totalCents += s.outstandingCents;
  }
  return groups;
}

export function totalOutstanding(shares: readonly SelectableShare[]): number {
  return shares.reduce((acc, s) => acc + s.outstandingCents, 0);
}

export function selectionTotal(selection: Selection): number {
  let total = 0;
  for (const cents of Object.values(selection)) total += cents;
  return total;
}

// Select (each at its full outstanding) or deselect a set of shares, leaving
// every other entry untouched. Re-selecting an already selected share resets a
// partial amount back to the full outstanding.
export function setShares(
  selection: Selection,
  shares: readonly SelectableShare[],
  selected: boolean,
): Selection {
  const next: Record<string, number> = { ...selection };
  for (const s of shares) {
    if (selected) next[s.shareId] = s.outstandingCents;
    else delete next[s.shareId];
  }
  return next;
}

// Inclusive date range; an empty bound is open. Dates are ISO YYYY-MM-DD, so
// string comparison is chronological.
export function sharesInRange<T extends SelectableShare>(
  shares: readonly T[],
  from: string,
  to: string,
): T[] {
  return shares.filter((s) => (!from || s.date >= from) && (!to || s.date <= to));
}

// Shift-click: every share between the anchor and the target, inclusive, in
// the order they are displayed. A missing anchor degrades to just the target.
export function rangeBetween<T extends SelectableShare>(
  shares: readonly T[],
  anchorId: string | null,
  targetId: string,
): T[] {
  const target = shares.findIndex((s) => s.shareId === targetId);
  if (target < 0) return [];
  const anchor = anchorId === null ? -1 : shares.findIndex((s) => s.shareId === anchorId);
  if (anchor < 0) return [shares[target]];
  const [lo, hi] = anchor <= target ? [anchor, target] : [target, anchor];
  return shares.slice(lo, hi + 1);
}

export type GroupState = 'none' | 'some' | 'all';

// Tri-state for a group checkbox: membership only, so a partially paid share
// still counts as selected.
export function groupState(selection: Selection, shares: readonly SelectableShare[]): GroupState {
  let count = 0;
  for (const s of shares) if (s.shareId in selection) count++;
  if (count === 0) return 'none';
  return count === shares.length ? 'all' : 'some';
}

// The FIFO fill of a payment, as a selection: what auto mode would do, made
// visible when the allocator opens with an amount already typed.
export function fifoSelection(paymentCents: number, shares: readonly SelectableShare[]): Selection {
  const { allocations } = allocateFifo(Math.max(0, paymentCents), shares);
  return Object.fromEntries(allocations.map((a) => [a.splitShareId, a.amountCents]));
}

// A typed per-share amount: parsed, then clamped into [0, outstanding] (a
// share can never take more than it still owes). Null when unparseable.
export function parseApplied(text: string, outstandingCents: number): number | null {
  const cents = tryParseDollars(text);
  if (cents === null) return null;
  return Math.min(Math.max(0, cents), outstandingCents);
}

// The allocations to submit, in FIFO order, zero entries dropped.
export function toAllocationPayload(
  selection: Selection,
  shares: readonly SelectableShare[],
): { shareId: string; amountCents: number }[] {
  return shares
    .filter((s) => (selection[s.shareId] ?? 0) > 0)
    .map((s) => ({ shareId: s.shareId, amountCents: selection[s.shareId] }));
}

export type AllocationCheck =
  | { ok: true; allocatedCents: number; creditCents: number }
  | { ok: false; allocatedCents: number; overByCents: number };

// Over-allocation is a hard block: requested allocations may not sum past the
// payment. Under-allocation is fine — the remainder is unallocated credit that
// carries forward. Shared by the dialog (disables Record) and the Server
// Action (rejects the submit), so the two can never disagree.
export function checkAllocations(
  paymentCents: number,
  allocations: readonly { amountCents: number }[],
): AllocationCheck {
  const allocatedCents = allocations.reduce((acc, a) => acc + a.amountCents, 0);
  if (allocatedCents > paymentCents) {
    return { ok: false, allocatedCents, overByCents: allocatedCents - paymentCents };
  }
  return { ok: true, allocatedCents, creditCents: paymentCents - allocatedCents };
}
