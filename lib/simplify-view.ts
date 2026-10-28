// Feeds the owner-centric ledger into the debt simplifier. Pure; the /people
// page passes rows it already loaded.
//
// Every debt here has the owner on one side (owner-paid splits: they owe the
// owner; external splits: the owner owes them), so the balance graph is a
// star. Three counts tell the story:
//   outstandingDebts — individual shares still owed, either direction
//   perPersonPayments — one payment per person with a nonzero net, which is
//                       what settling up person by person takes today
//   transfers        — the simplified set, where a debtor may pay a creditor
//                       directly and the owner drops out of the middle
// On a star, simplification only beats per-person payments when the owner is
// close to even or amounts happen to line up; otherwise the two counts match.
import { simplifyDebts, type Transfer } from './debt-simplify';
import { type Cents, toCents } from './money';

export type SimplifyInput = {
  ownerId: string;
  // Non-owner people with their net (positive => they owe the owner), in
  // display order; ties in the simplifier break by this order.
  people: readonly { personId: string; netCents: number }[];
  // Outstanding portion of every live debt share, either direction.
  shares: readonly { counterpartyId: string; outstandingCents: number }[];
};

export type PerPersonPayment = {
  fromPersonId: string;
  toPersonId: string;
  amountCents: Cents;
};

export type SimplifyView = {
  outstandingDebts: number;
  peopleInvolved: number;
  perPersonPayments: PerPersonPayment[];
  transfers: Transfer[];
};

export function buildSimplifyView(input: SimplifyInput): SimplifyView {
  const { ownerId, people, shares } = input;

  const open = shares.filter((s) => s.outstandingCents > 0);
  const involved = new Set(open.map((s) => s.counterpartyId));
  const peopleInvolved = involved.size === 0 ? 0 : involved.size + 1;

  // Settling up person by person: each nonzero net is one payment between
  // that person and the owner, in whichever direction the net points.
  const perPersonPayments: PerPersonPayment[] = people
    .filter((p) => p.netCents !== 0)
    .map((p) =>
      p.netCents > 0
        ? { fromPersonId: p.personId, toPersonId: ownerId, amountCents: toCents(p.netCents) }
        : { fromPersonId: ownerId, toPersonId: p.personId, amountCents: toCents(-p.netCents) },
    );

  // The owner's position is the mirror of everyone else's: what they owe
  // the owner is the owner's credit, and vice versa. Listed first so ties
  // resolve toward routing through the owner, the familiar default.
  const othersNet = people.reduce((acc, p) => acc + p.netCents, 0);
  const transfers = simplifyDebts([
    { personId: ownerId, netCents: toCents(0 - othersNet) },
    ...people.map((p) => ({ personId: p.personId, netCents: toCents(p.netCents) })),
  ]);

  return {
    outstandingDebts: open.length,
    peopleInvolved,
    perPersonPayments,
    transfers,
  };
}
