// Which non-owner people appear on /people, pure and framework-free.
//
// Active people always show (a fresh person reads $0.00). A soft-deleted
// person lingers only while they still carry activity — any remaining
// share or settlement — so their outstanding balance can be reconciled;
// once their transactions are gone and their settlements deleted, they
// have nothing left to show and drop off. Balance alone can't gate this: a
// deleted person with a $10 share and a matching $10 settlement nets to $0
// yet still has rows worth surfacing.

export type PersonActivity = {
  deleted: boolean;
  shareCount: number;
  settlementCount: number;
};

export function isPersonVisible(person: PersonActivity): boolean {
  if (!person.deleted) return true;
  return person.shareCount > 0 || person.settlementCount > 0;
}

// A soft-deleted person may be hard-deleted only once no active shares
// remain, so the permanent delete can never strip someone out of a live
// split. (Leftover settlements are the expected reason they're still
// visible; those are safe to erase with the person.)
export function canHardDeletePerson(person: PersonActivity): boolean {
  return person.deleted && person.shareCount === 0;
}
