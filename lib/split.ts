// The split engine. Pure functions over integer cents; no dependency on
// Next.js, Drizzle, or the database. The UI preview and the Server Action
// save path both call computeShares, so what the user sees is exactly what
// is stored.
//
// REMAINDER DISTRIBUTION IS DETERMINISTIC — do not re-implement this with
// largest-remainder, random, or last-participant rules. When cents do not
// divide evenly (equal splits, percent splits, and the equal tax/tip
// division), the first k participants each receive one extra cent, in the
// caller-supplied participant order. Callers order participants by person
// created_at ascending, so the same split always resolves to the same
// shares. Locked in CLAUDE.md.
import { type Cents, toCents, sumCents, distributeRemainder } from './money';

export type SplitMethod = 'equal' | 'amount' | 'percent';

export type Participant = { personId: string };

export type ResolvedShare = { personId: string; amountCents: Cents };

export function splitEqual(totalCents: Cents, participantCount: number): Cents[] {
  return distributeRemainder(totalCents, participantCount);
}

// Exact amounts entered per participant. They must sum to the total being
// divided; anything else is a caller error surfaced before save.
export function splitByAmount(
  totalCents: Cents,
  amounts: readonly Cents[],
): Cents[] {
  if (amounts.length === 0) {
    throw new Error('At least one amount is required');
  }
  for (const a of amounts) {
    if (a < 0) throw new Error(`Amounts must not be negative, received: ${a}`);
  }
  const sum = sumCents(amounts);
  if (sum !== totalCents) {
    throw new Error(
      `Amounts sum to ${sum} cents but must sum to ${totalCents} cents`,
    );
  }
  return [...amounts];
}

// Whole-number percents summing to 100. Integer percents keep the product
// totalCents * percent exact, so the math never touches floats; each share
// floors and the remainder cents go to the first k participants.
export function splitByPercent(
  totalCents: Cents,
  percents: readonly number[],
): Cents[] {
  if (percents.length === 0) {
    throw new Error('At least one percent is required');
  }
  if (totalCents < 0) {
    throw new Error(`Cannot split a negative total: ${totalCents}`);
  }
  for (const p of percents) {
    if (!Number.isInteger(p) || p < 0) {
      throw new Error(`Percents must be non-negative whole numbers, received: ${p}`);
    }
  }
  const percentSum = percents.reduce((acc, p) => acc + p, 0);
  if (percentSum !== 100) {
    throw new Error(`Percents sum to ${percentSum} but must sum to 100`);
  }
  const shares = percents.map((p) => Math.floor((totalCents * p) / 100));
  let leftover = totalCents - shares.reduce((acc, s) => acc + s, 0);
  for (let i = 0; leftover > 0; i += 1, leftover -= 1) {
    shares[i] += 1;
  }
  return shares.map(toCents);
}

// Resolve a full split: divide abs(total) - tax - tip by the chosen method,
// divide tax + tip equally among all participants, and add the two per
// person. Shares always sum to abs(totalCents) exactly.
//
// `participants` must be ordered by person created_at ascending (see the
// remainder-distribution note above). `inputs` aligns with `participants`
// by index: entered cents for method 'amount', whole percents for
// method 'percent', unused for 'equal'.
export function computeShares(
  totalCents: Cents,
  taxCents: Cents,
  tipCents: Cents,
  method: SplitMethod,
  participants: readonly Participant[],
  inputs?: readonly number[],
): ResolvedShare[] {
  if (participants.length === 0) {
    throw new Error('At least one participant is required');
  }
  if (taxCents < 0 || tipCents < 0) {
    throw new Error('Tax and tip must not be negative');
  }
  // The engine splits magnitudes; the editor filters refunds/credits out,
  // but abs() here keeps the math well-defined regardless of sign.
  const absTotal = toCents(Math.abs(totalCents));
  const taxTip = toCents(taxCents + tipCents);
  if (taxTip > absTotal) {
    throw new Error(
      `Tax and tip (${taxTip} cents) exceed the transaction total (${absTotal} cents)`,
    );
  }
  const base = toCents(absTotal - taxTip);

  let methodShares: Cents[];
  switch (method) {
    case 'equal':
      methodShares = splitEqual(base, participants.length);
      break;
    case 'amount': {
      const amounts = requireInputs(inputs, participants.length, method);
      methodShares = splitByAmount(base, amounts.map(toCents));
      break;
    }
    case 'percent': {
      const percents = requireInputs(inputs, participants.length, method);
      methodShares = splitByPercent(base, percents);
      break;
    }
  }

  const taxTipShares = distributeRemainder(taxTip, participants.length);
  const shares = participants.map((p, i) => ({
    personId: p.personId,
    amountCents: toCents(methodShares[i] + taxTipShares[i]),
  }));

  // Engine-bug guard: the invariant the whole feature rests on.
  const total = sumCents(shares.map((s) => s.amountCents));
  if (total !== absTotal) {
    throw new Error(
      `Shares sum to ${total} cents but must sum to ${absTotal} cents`,
    );
  }
  return shares;
}

// Resolve an item-level split (method='item'). Line items with the same
// assignee set are pooled before splitting so odd-cent remainders do not
// accumulate across items (e.g. four shared $X.99 lines between two
// people still resolve to equal shares when the pooled total divides
// evenly). REMAINDER RULE APPLIES PER POOL: the first k assignees in
// participant order get the extra cent. Items with no assignees belong to
// the owner. Tax and tip divide equally among all participants (everyone
// holding at least one item share, owner included), per the CLAUDE.md
// invariant, independent of item value.
//
// Shares sum to itemsTotal + tax + tip — the RECEIPT total, not the
// transaction amount. A tolerated total mismatch (warned in review, never
// blocking) is the one sanctioned case where an item split's shares do not
// sum to abs(transaction.amount_cents).
export function computeItemShares(input: {
  ownerId: string;
  taxCents: Cents;
  tipCents: Cents;
  // Every item on the receipt; assigneePersonIds may be empty (owner's).
  items: readonly { amountCents: Cents; assigneePersonIds: readonly string[] }[];
  // ALL known persons in created_at ascending order; participant order and
  // remainder distribution derive from it.
  personOrder: readonly string[];
}): ResolvedShare[] {
  const { ownerId, taxCents, tipCents, items, personOrder } = input;
  if (taxCents < 0 || tipCents < 0) {
    throw new Error('Tax and tip must not be negative');
  }
  const rank = new Map(personOrder.map((id, i) => [id, i]));
  if (!rank.has(ownerId)) {
    throw new Error('Owner must appear in personOrder');
  }

  const totals = new Map<string, number>();
  // Pool line items that share the same assignee set before splitting.
  // Per-item remainder on odd-cent prices accumulates (e.g. four $X.99
  // items between two people drifts $0.04) even when everyone shares
  // everything equally; one split per assignee group keeps shares fair.
  const groups = new Map<string, { assignees: string[]; amountCents: number }>();
  for (const item of items) {
    if (item.amountCents < 0) {
      throw new Error(`Item amounts must not be negative, received: ${item.amountCents}`);
    }
    const assignees =
      item.assigneePersonIds.length > 0 ? [...item.assigneePersonIds] : [ownerId];
    for (const id of assignees) {
      if (!rank.has(id)) throw new Error(`Unknown person in assignment: ${id}`);
    }
    assignees.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const key = assignees.join('\0');
    const group = groups.get(key);
    if (group) {
      group.amountCents += item.amountCents;
    } else {
      groups.set(key, { assignees, amountCents: item.amountCents });
    }
  }

  for (const group of groups.values()) {
    // group.amountCents is a running number sum; re-brand it (toCents also
    // re-asserts the integer invariant) before the remainder split.
    const shares = distributeRemainder(
      toCents(group.amountCents),
      group.assignees.length,
    );
    group.assignees.forEach((id, i) => {
      totals.set(id, (totals.get(id) ?? 0) + shares[i]);
    });
  }

  // Participants: everyone holding at least one item share, in person
  // order. Tax and tip divide equally among them.
  const participants = [...totals.keys()].sort(
    (a, b) => rank.get(a)! - rank.get(b)!,
  );
  if (participants.length === 0) {
    throw new Error('At least one item is required');
  }
  const taxTipTotal = toCents(taxCents + tipCents);
  const taxTipShares = distributeRemainder(taxTipTotal, participants.length);
  participants.forEach((id, i) => {
    totals.set(id, totals.get(id)! + taxTipShares[i]);
  });

  const shares = participants.map((personId) => ({
    personId,
    amountCents: toCents(totals.get(personId)!),
  }));

  // Engine-bug guard: shares must sum to items + tax + tip exactly.
  const expected = toCents(
    items.reduce((acc, i) => acc + i.amountCents, 0) + taxCents + tipCents,
  );
  const actual = sumCents(shares.map((s) => s.amountCents));
  if (actual !== expected) {
    throw new Error(`Shares sum to ${actual} cents but must sum to ${expected} cents`);
  }
  return shares;
}

function requireInputs(
  inputs: readonly number[] | undefined,
  count: number,
  method: SplitMethod,
): readonly number[] {
  if (!inputs || inputs.length !== count) {
    throw new Error(
      `Method '${method}' requires one input per participant (${count}), received ${inputs?.length ?? 0}`,
    );
  }
  return inputs;
}
