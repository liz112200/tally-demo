// Netting a payment against debts in both directions. Pure functions over
// integer minor units, no dependency on React, Next.js, or the database.
//
// When the owner and a person each owe the other, one real payment settles
// the difference and the overlap cancels out. That is recorded as up to three
// settlements sharing a group: the cash actually paid (in the net direction),
// plus an offset pair — an incoming and an outgoing settlement of the same
// amount that move no money and exist only to clear shares on both sides.
// Balances need no special case: each half is an ordinary settlement in its
// direction, and the pair cancels in the net.
export type SettlementDirection = 'incoming' | 'outgoing';

export type Alloc = { shareId: string; amountCents: number };

export type NettingPlan = {
  incomingCents: number; // selected "they owe you" total
  outgoingCents: number; // selected "you owe them" total
  netCents: number; // |incoming - outgoing|
  // Which way the cash moves. Null only when nothing but an offset is
  // recorded (both sides equal and no cash typed).
  cashDirection: SettlementDirection | null;
  cashCents: number;
  offsetCents: number;
  // Cash beyond the net: unallocated credit on the cash settlement.
  creditCents: number;
  cash: { direction: SettlementDirection; amountCents: number; allocations: Alloc[] } | null;
  offset: { amountCents: number; incoming: Alloc[]; outgoing: Alloc[] } | null;
};

export type NettingResult =
  | { ok: true; plan: NettingPlan }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'over'; overByCents: number; netCents: number };

const sum = (list: readonly Alloc[]) => list.reduce((acc, a) => acc + a.amountCents, 0);

// Split a FIFO-ordered allocation list at `cents`: the head takes the first
// `cents` (cutting one share in two if needed), the tail takes the rest.
export function splitAllocations(list: readonly Alloc[], cents: number): [Alloc[], Alloc[]] {
  const head: Alloc[] = [];
  const tail: Alloc[] = [];
  let budget = Math.max(0, cents);
  for (const a of list) {
    if (a.amountCents <= 0) continue;
    const take = Math.min(budget, a.amountCents);
    if (take > 0) head.push({ shareId: a.shareId, amountCents: take });
    if (a.amountCents - take > 0) tail.push({ shareId: a.shareId, amountCents: a.amountCents - take });
    budget -= take;
  }
  return [head, tail];
}

// Plan a netted settlement from the selected allocations on each side (each
// in FIFO order). `pinnedCashCents` is the payment the user typed, or null to
// follow the net. `fallbackDirection` places typed cash when the two sides
// cancel exactly (it can then only be credit).
//
// The smaller side is cleared entirely by the offset; on the larger side the
// cash covers the oldest selected amounts first and the offset the rest.
// Over-allocation stays a hard block: typed cash below the net is refused.
export function planNetting(
  incoming: readonly Alloc[],
  outgoing: readonly Alloc[],
  pinnedCashCents: number | null,
  fallbackDirection: SettlementDirection = 'incoming',
): NettingResult {
  const incomingCents = sum(incoming);
  const outgoingCents = sum(outgoing);
  const netCents = Math.abs(incomingCents - outgoingCents);
  const offsetCents = Math.min(incomingCents, outgoingCents);
  const cashCents = pinnedCashCents === null ? netCents : Math.max(0, pinnedCashCents);

  if (incomingCents === 0 && outgoingCents === 0 && cashCents === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (cashCents < netCents) {
    return { ok: false, reason: 'over', overByCents: netCents - cashCents, netCents };
  }

  const netDirection: SettlementDirection | null =
    incomingCents > outgoingCents ? 'incoming' : outgoingCents > incomingCents ? 'outgoing' : null;
  const cashDirection = cashCents > 0 ? (netDirection ?? fallbackDirection) : null;

  const larger = netDirection === 'outgoing' ? outgoing : incoming;
  const [cashAllocs, largerOffset] = splitAllocations(larger, netCents);
  const smaller = netDirection === 'outgoing' ? incoming : outgoing;

  const offset =
    offsetCents > 0
      ? {
          amountCents: offsetCents,
          incoming: netDirection === 'outgoing' ? [...smaller] : largerOffset,
          outgoing: netDirection === 'outgoing' ? largerOffset : [...smaller],
        }
      : null;

  return {
    ok: true,
    plan: {
      incomingCents,
      outgoingCents,
      netCents,
      cashDirection,
      cashCents,
      offsetCents,
      creditCents: cashCents - netCents,
      cash:
        cashDirection === null
          ? null
          : { direction: cashDirection, amountCents: cashCents, allocations: cashAllocs },
      offset,
    },
  };
}
