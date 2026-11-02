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


// Pairs bank rows with CSV rows dated within MATCH_DAYS, each CSV row with one
// bank row at most: every equal-amount pair first, then the same merchant at
// another amount among the rows left, nearest dates first within each pass.
// Pairing row by row let a same-merchant row take the CSV row another bank
// row had at the exact amount, which on a sync leaves that purchase to be
// added twice and in the boundary review named the wrong CSV row as the
// differing one (2026-10-29). Dates are on the account's basis. Returns the
// index of each bank row's CSV row, or null.
export function pairWithCsv(
  bank: readonly { date: string; amountCents: number; description: string }[],
  csv: readonly { date: string; amountCents: number; description?: string }[],
): (number | null)[] {
  const paired: (number | null)[] = bank.map(() => null);
  const used = new Set<number>();
  const bankMerchant = bank.map((t) => merchantKey(t.description));
  const csvMerchant = csv.map((c) => (c.description ? merchantKey(c.description) : null));
  const pass = (fits: (b: number, c: number) => boolean) => {
    const candidates: { b: number; c: number; gap: number }[] = [];
    bank.forEach((t, b) => {
      if (paired[b] !== null) return;
      csv.forEach((r, c) => {
        const gap = daysBetween(r.date, t.date);
        if (!used.has(c) && gap <= MATCH_DAYS && fits(b, c)) candidates.push({ b, c, gap });
      });
    });
    candidates.sort((x, y) => x.gap - y.gap || x.b - y.b || x.c - y.c);
    for (const { b, c } of candidates) {
      if (paired[b] === null && !used.has(c)) {
        paired[b] = c;
        used.add(c);
      }
    }
  };
  pass((b, c) => csv[c].amountCents === bank[b].amountCents);
  pass((b, c) => sameMerchant(csvMerchant[c], bankMerchant[b]));
  return paired;
}

export function addDays(iso: string, days: number): string {
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
  // Compared on the account's basis, the date its CSV rows carry: a posting
  // date beside a posting date. A Chase row's purchase date can be days
  // before its posting date (2026-10-29: up to eight).
  const dateOf = (t: ProviderTransaction) => basisDate(t, cutover.basis);
  const near = input.added.filter((t) => dateOf(t) >= cutover.date && dateOf(t) < windowEnd);
  const pairs = pairWithCsv(
    near.map((t) => ({ date: dateOf(t), amountCents: t.amountCents, description: t.descriptionRaw })),
    input.csvRows,
  );
  const held = new Set(near.filter((_, i) => pairs[i] !== null));

  for (const t of input.added) {
    if (dateOf(t) < cutover.date) out.setAside.push({ row: t, reason: 'before_cutover' });
    else if (held.has(t)) out.setAside.push({ row: t, reason: 'possible_duplicate' });
    else out.added.push(t);
  }
  for (const t of input.modified) {
    if (input.setAsideIds.has(t.providerTransactionId)) {
      // Updated in place; whatever it was set aside for still holds until the
      // owner decides (a possible duplicate) or forever (before the cutover).
      out.setAside.push({ row: t, reason: dateOf(t) < cutover.date ? 'before_cutover' : 'possible_duplicate' });
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
