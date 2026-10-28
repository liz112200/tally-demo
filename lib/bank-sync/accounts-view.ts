// What /accounts says about each login (BANK-SYNC.md, slice 4): the Item
// budget, accounts that appear under two logins, why an account is not
// syncing, and the sentence beside each action. Pure; every sentence names
// the login and what happens to its rows, as the flag panel does.
import { classifyItemError, type ItemHealthKind } from './item-health';

// Plaid's Trial plan: 10 production Items for the life of the account, and
// removing one does not return its slot (CLAUDE.md).
export const ITEM_BUDGET = 10;

export type ViewLogin = {
  id: string;
  institutionId: string | null;
  institutionName: string | null;
  createdAt: Date;
  status: 'active' | 'paused' | 'removed';
  // `syncable`: a type that can sync at all (depository, credit).
  accounts: { id: string; name: string; mask: string | null; syncable: boolean; syncEnabled: boolean }[];
};

// Items recorded as spent: every connection row, removed ones included. A
// lower bound on what Plaid counts (an Item whose exchange never completed
// is not recorded here), so the page says Plaid's dashboard is the authority.
export function itemsUsed(logins: readonly { status: string }[]): number {
  return logins.length;
}

export function itemsLeft(logins: readonly { status: string }[]): number {
  return Math.max(0, ITEM_BUDGET - itemsUsed(logins));
}

// Logins grouped by institution, one entry per institution in name order,
// with each login's date, so a list of four logins at one bank reads as one
// line rather than the bank's name four times.
export type InstitutionLogins = { institution: string; dates: string[] };

export function loginsByInstitution(
  logins: readonly { institutionName: string | null; createdAt: Date }[],
  formatDay: (d: Date) => string,
): InstitutionLogins[] {
  const groups = new Map<string, Date[]>();
  for (const l of logins) {
    const name = l.institutionName ?? 'Unknown institution';
    groups.set(name, [...(groups.get(name) ?? []), l.createdAt]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([institution, dates]) => ({
      institution,
      dates: [...dates].sort((a, b) => a.getTime() - b.getTime()).map(formatDay),
    }));
}

// "First Platypus Bank — 4 logins (Oct 20, Oct 22, Oct 25, Oct 25)".
export function institutionLine(g: InstitutionLogins): string {
  return `${g.institution} — ${g.dates.length} login${g.dates.length === 1 ? '' : 's'} (${g.dates.join(', ')})`;
}

// Other logins named inside a sentence: "the Chase login from Oct 20", or
// "2 other First Platypus Bank logins (Oct 20, Oct 22)".
function otherLogins(logins: readonly ViewLogin[], formatDay: (d: Date) => string): string {
  return loginsByInstitution(logins, formatDay)
    .map((g) =>
      g.dates.length === 1
        ? `the ${g.institution} login from ${g.dates[0]}`
        : `${g.dates.length} other ${g.institution} logins (${g.dates.join(', ')})`,
    )
    .join(' and ');
}

// The same account under two logins: same institution, name and mask on
// another login that is not removed. That is one bank login linked twice,
// and if both sync, every transaction on it counts twice, so only accounts
// that can sync are reported. By account id: the other logins it also
// appears under, and whether it syncs there and here.
export type Twin = { login: ViewLogin; syncingThere: boolean };

export function twinAccounts(logins: readonly ViewLogin[]): Map<string, Twin[]> {
  const live = logins.filter((l) => l.status !== 'removed' && l.institutionId !== null);
  const out = new Map<string, Twin[]>();
  for (const login of live) {
    for (const account of login.accounts) {
      if (!account.syncable) continue;
      const twins: Twin[] = [];
      for (const other of live) {
        if (other.id === login.id || other.institutionId !== login.institutionId) continue;
        const same = other.accounts.find((a) => a.name === account.name && a.mask === account.mask);
        if (same) twins.push({ login: other, syncingThere: same.syncEnabled && other.status === 'active' });
      }
      if (twins.length > 0) out.set(account.id, twins);
    }
  }
  return out;
}

// The warning on an account that appears under another login too.
// "twice", or "3 times" when three logins sync the same account.
function times(copies: number): string {
  return copies === 2 ? 'twice' : `${copies} times`;
}

export function twinSentence(twins: readonly Twin[], syncingHere: boolean, formatDay: (d: Date) => string): string {
  const where = otherLogins(twins.map((t) => t.login), formatDay);
  const copies = 1 + twins.filter((t) => t.syncingThere).length;
  return syncingHere && copies > 1
    ? `Also linked and syncing under ${where}: every transaction on it is counted ${times(copies)}. ` +
        `Keep sync on for one copy only.`
    : `Also linked under ${where}. If more than one copy syncs, its transactions are counted more than once; ` +
        `keep sync on for one only.`;
}

// One line for a login whose accounts also appear under other logins, shown
// on the login; the per-account sentences are its expanded detail. Null
// when none do. Two severities: an account present under both logins but
// syncing under one is information; one syncing under both is counted twice
// right now, so the totals are wrong until the owner turns one copy off.
export function twinSummary(
  accounts: readonly { twins: readonly Twin[]; syncingHere: boolean }[],
  formatDay: (d: Date) => string,
): { needsOwner: boolean; text: string } | null {
  const withTwins = accounts.filter((a) => a.twins.length > 0);
  if (withTwins.length === 0) return null;
  const others = new Map<string, ViewLogin>();
  for (const a of withTwins) for (const t of a.twins) others.set(t.login.id, t.login);
  const where = otherLogins([...others.values()], formatDay);
  const n = withTwins.length;
  const doubled = withTwins.filter((a) => a.syncingHere && a.twins.some((t) => t.syncingThere));
  const k = doubled.length;
  const maxCopies = Math.max(0, ...doubled.map((a) => 1 + a.twins.filter((t) => t.syncingThere).length));
  if (k === 0) {
    return { needsOwner: false, text: `${n} ${n === 1 ? 'account here is' : 'accounts here are'} also linked under ${where}.` };
  }
  return {
    needsOwner: true,
    text:
      `${k} ${k === 1 ? 'account here also syncs' : 'accounts here also sync'} under ${where}, so ` +
      `${k === 1 ? 'its' : 'their'} transactions are counted ${maxCopies === 2 ? 'twice' : 'more than once'}. ` +
      `Keep sync on for one copy of ${k === 1 ? 'it' : 'each'} only.`,
  };
}

export function rowsPhrase(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`;
}

// Why an account of this login is not syncing, for its group header in
// Expenses; null when nothing stops it. `needsOwner` when the owner has
// something to do (a login to reconnect or replace); a pause, a removal or
// an account the bank stopped sharing is information, not a call to act.
export type NotSyncing = { text: string; needsOwner: boolean };

export function notSyncingReason(login: {
  status: 'active' | 'paused' | 'removed';
  itemErrorCode: string | null;
}, account: { unsharedAt: Date | null }): NotSyncing | null {
  if (login.status === 'removed') return { text: 'login removed; not syncing', needsOwner: false };
  if (login.status === 'paused') return { text: 'paused; not syncing', needsOwner: false };
  if (account.unsharedAt !== null) return { text: 'no longer shared by the bank; not syncing', needsOwner: false };
  const kind: ItemHealthKind = classifyItemError(login.itemErrorCode);
  if (kind === 'healthy' || kind === 'bank_unavailable') return null;
  return kind === 'gone'
    ? { text: 'Plaid no longer has this login; not syncing', needsOwner: true }
    : { text: 'not syncing: reconnect on Accounts', needsOwner: true };
}

export const actionSentence = {
  reconnect: (institution: string) =>
    `Opens ${institution}'s sign-in for this same login. No new Item is used, and nothing in the ledger changes.`,
  chooseAccounts: (institution: string) =>
    `Opens ${institution}'s account picker for this login. An account you stop sharing stops syncing and keeps its rows; ` +
    `one you add appears here with sync off. No new Item is used.`,
  check: () => 'Asks Plaid for this login\'s status now. Nothing syncs, and nothing in the ledger changes.',
  pause: (institution: string, rows: number) =>
    `Stops syncing ${institution}. Its ${rowsPhrase(rows)} stay and keep counting, and nothing changes at Plaid. ` +
    `Resume continues from where it stopped.`,
  resume: (institution: string) =>
    `Syncing ${institution} starts again from where it stopped; the next sync fetches what the bank has since.`,
  remove: (institution: string, rows: number, left: number | null) =>
    `Ends Plaid's access to ${institution} and erases the stored token, for good. Its ${rowsPhrase(rows)}, ` +
    `with their splits and settlements, stay; its pending rows, which never counted, are deleted. ` +
    (left === null
      ? `In Sandbox, Items are free.`
      : `The Item's slot is not returned: linking ${institution} again would use a new one (${left} of ${ITEM_BUDGET} left).`),
};
