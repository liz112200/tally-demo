// The guard against linking a bank login twice (BANK-SYNC.md, slice 4).
// Pure. Plaid's guidance is to compare the institution Link reports with the
// logins already linked and not exchange the public token when it matches:
// the exchange is what creates the duplicate. Whether an unexchanged public
// token still spends a Trial slot is not documented; the guard is worth it
// either way, because a second login on one institution is the budget
// mistake CLAUDE.md forbids, and a fixable login is repaired with Reconnect.
import { isGone } from './item-health';

export type LinkedLogin = {
  institutionId: string | null;
  institutionName: string | null;
  createdAt: Date;
  status: 'active' | 'paused' | 'removed';
  itemErrorCode: string | null;
};

// The login already linked at this institution, if any. A removed login does
// not count: re-linking after a deliberate removal is a decision the budget
// confirmation already put in front of the owner.
export function findLinkedLogin(institutionId: string | null, logins: readonly LinkedLogin[]): LinkedLogin | null {
  if (institutionId === null) return null;
  return logins.find((l) => l.status !== 'removed' && l.institutionId === institutionId) ?? null;
}

// Sandbox Items cost nothing, and dev holds several logins at one Sandbox
// institution (one per Sandbox test user), so there the refusal can be
// overridden. Decided by the server's Plaid environment alone: guard rule 3
// keeps Sandbox keys away from the production database, and both the button
// and the action ask this.
export function duplicateOverrideAllowed(plaidEnv: string | undefined): boolean {
  return plaidEnv === 'sandbox';
}

// A login Plaid no longer recognises cannot be reconnected, so the refusal
// names the one path that exists: remove it, then link.
export function duplicateRefusal(login: LinkedLogin, linkedOn: string): string {
  const name = login.institutionName ?? 'This institution';
  if (isGone(login.itemErrorCode)) {
    return (
      `${name} is already linked (since ${linkedOn}), but Plaid no longer recognises that login, so Reconnect cannot repair it. ` +
      `Nothing was linked. Remove that login first (that uses nothing at Plaid); linking ${name} then uses a new Item.`
    );
  }
  return (
    `${name} is already linked (since ${linkedOn}). Nothing was linked: the new login was not exchanged, as Plaid advises for a duplicate. ` +
    `To fix that login, use Reconnect on it; linking it again would spend an Item on the same login.`
  );
}
