// The cutover (REAL-ACCOUNTS.md): which fetched rows a sync may insert for an
// account whose ledger account has CSV history. Pure.
//
// A CSV row is identified by its content hash and a synced row by Plaid's id,
// so nothing else stops one purchase arriving from both sources. The rules:
//   - A row dated before the cutover, in the account's basis (the date its
//     CSV parser records), is never inserted: it is kept aside as skipped.
//   - A row in the first BOUNDARY_DAYS on or after the cutover that matches a
//     CSV row of the same ledger account (ledger dates within MATCH_DAYS, and
//     the same amount or the same merchant) is held as a possible duplicate
//     for the owner. Plaid often sends a row before its authorized date is
//     known and fills it in later, so a purchase the CSV has on the last day
//     before the cutover can first arrive dated on or after it. The amount
//     alone is not enough: the owner sometimes edits a CSV row's amount on
//     purpose, and a hold can settle at a different amount, so a same-merchant
//     row of another amount is held too. Holding too much costs the owner an
//     answer; holding too little counts a purchase twice.
//   - Everything else goes to the planner as before.
// Changes and removals of rows that were set aside update the skipped record;
// they never insert. Changes and removals of inserted rows go to the planner.
import { normalizeMerchant } from '../parsers/normalize';
import type { ProviderTransaction, RemovedTransaction } from './provider';

export const BOUNDARY_DAYS = 7;
export const MATCH_DAYS = 3;

export type Cutover = { date: string; basis: 'posted' | 'transaction' };

// The date a row is compared on: posted for a posted-basis account (Chase
// checking's CSV), else when the purchase happened when the bank says so.
export function basisDate(t: Pick<ProviderTransaction, 'date' | 'authorizedDate'>, basis: Cutover['basis']): string {
  return basis === 'posted' ? t.date : (t.authorizedDate ?? t.date);
}

// A merchant to compare a CSV row with a bank row by: the first word of the
// normalized description, past wallet and payment-processor prefixes, which
// the bank adds and a CSV export may not ("APLPAY TST* CORNER CAFE" and
// "CORNER CAFE"). Null when nothing of three characters or more is left. Loose
// on purpose: a false match is held for the owner, a missed one is counted
// twice.
const MERCHANT_PREFIXES = /^(?:(?:APLPAY|APPLE PAY|GOOGLE PAY|GPAY|TST\*|SQ ?\*|UEP\*|SP ?\*|PY ?\*|PAYPAL ?\*)\s*)+/;
export function merchantKey(description: string): string | null {
  const word = normalizeMerchant(description).replace(MERCHANT_PREFIXES, '').match(/[A-Z0-9]+/)?.[0] ?? '';
  return word.length >= 3 ? word : null;
}

// Whether two keys name the same merchant. One may start with the other: the
// bank cuts the merchant short and runs the city on ("CORNERNEW" beside
// the CSV's "CORNER").
export function sameMerchant(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && (a.startsWith(b) || b.startsWith(a));
}

// The ledger's own date for a synced row (as the planner stores it).
const ledgerDate = (t: Pick<ProviderTransaction, 'date' | 'authorizedDate'>) => t.authorizedDate ?? t.date;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export type SetAside = { row: ProviderTransaction; reason: 'before_cutover' | 'possible_duplicate' };

export type CutoverSplit = {
  // For the planner, unchanged in shape.
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: RemovedTransaction[];
  // Rows not inserted, new or updated.
  setAside: SetAside[];
  // Removals of rows that were set aside earlier.
  setAsideRemoved: string[];
};

export function splitAtCutover(input: {
  cutover: Cutover | null;
  added: readonly ProviderTransaction[];
  modified: readonly ProviderTransaction[];
  removed: readonly RemovedTransaction[];
  // Ids already set aside for this account (any reason).
  setAsideIds: ReadonlySet<string>;
  // The ledger account's CSV rows near the cutover: live, with their ledger
  // date, amount and description. Each may stand for one synced row only.
  csvRows: readonly { date: string; amountCents: number; description?: string }[];
}): CutoverSplit {
  const out: CutoverSplit = { added: [], modified: [], removed: [], setAside: [], setAsideRemoved: [] };
  const { cutover } = input;
  if (cutover === null) {
    return { ...out, added: [...input.added], modified: [...input.modified], removed: [...input.removed] };
  }
  const windowEnd = addDays(cutover.date, BOUNDARY_DAYS);
  const unmatched = input.csvRows.map((r) => ({ ...r, merchant: r.description ? merchantKey(r.description) : null, used: false }));
  // A CSV row matched by one synced row is not offered to another. The same
  // amount is tried first, then the same merchant at any amount.
  const matchCsv = (t: ProviderTransaction): boolean => {
    const near = unmatched.filter((c) => !c.used && daysBetween(c.date, ledgerDate(t)) <= MATCH_DAYS);
    const merchant = merchantKey(t.descriptionRaw);
    const hit =
      near.find((c) => c.amountCents === t.amountCents) ??
      near.find((c) => sameMerchant(c.merchant, merchant));
    if (hit) hit.used = true;
    return hit !== undefined;
  };
  const classify = (t: ProviderTransaction): SetAside['reason'] | null => {
    const d = basisDate(t, cutover.basis);
    if (d < cutover.date) return 'before_cutover';
    if (d < windowEnd && matchCsv(t)) return 'possible_duplicate';
    return null;
  };

  for (const t of input.added) {
    const reason = classify(t);
    if (reason) out.setAside.push({ row: t, reason });
    else out.added.push(t);
  }
  for (const t of input.modified) {
    if (input.setAsideIds.has(t.providerTransactionId)) {
      // Updated in place; whatever it was set aside for still holds until the
      // owner decides (a possible duplicate) or forever (before the cutover).
      out.setAside.push({ row: t, reason: classify(t) ?? 'possible_duplicate' });
    } else {
      out.modified.push(t);
    }
  }
  for (const r of input.removed) {
    if (input.setAsideIds.has(r.providerTransactionId)) out.setAsideRemoved.push(r.providerTransactionId);
    else out.removed.push(r);
  }
  return out;
}

// The default cutover: the day after the ledger account's last CSV row,
// counting rows in undone imports (a later Restore must not bring back a CSV
// row past the cutover). Null when it has no CSV rows.
export function defaultCutover(lastCsvDate: string | null): string | null {
  return lastCsvDate === null ? null : addDays(lastCsvDate, 1);
}

// Whether the owner may set this cutover: never on or before the last CSV
// row, which would let synced rows duplicate CSV ones.
export function cutoverProblem(chosen: string, lastCsvDate: string | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chosen)) return 'Enter a date.';
  if (lastCsvDate !== null && chosen <= lastCsvDate) {
    return `The CSV history runs to ${lastCsvDate}; a cutover on or before it would count those purchases twice.`;
  }
  return null;
}
