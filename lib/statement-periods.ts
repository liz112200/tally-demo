// One ledger account's rows grouped by statement period, for its tab in
// Expenses (STATEMENT-CYCLES.md, the period view). Pure.
//
// A row sits in the period its statement counts it in: by the bank's posting
// date for a synced row (shown with its purchase date), by its own date for a
// CSV row (the purchase date for the Amex and Discover CSVs, which carry no
// posting date, so a row near a closing may sit beside its statement; the
// period says so), and with the row it was paid alongside for a manual
// purchase linked to one. No row is left out: rows before the earliest
// recorded statement, or between statements when one is missing, get groups
// of their own, with no boundary invented.
import { addDays, type StatementRecord } from './statement-cycles';

export type PeriodRow = {
  id: string;
  date: string;
  postedDate: string;
  amountCents: number;
  source: string;
  pending: boolean;
  unverified: boolean;
  alongsideOfId: string | null;
};

export type PeriodStatement = StatementRecord & { chargesCents: number | null; creditsCents: number | null };

export type PeriodGroup<T> = {
  key: string;
  // current: after the latest recorded closing. statement: a recorded one.
  // gap: dates between two statements that no recorded statement covers.
  // before: dates before the earliest recorded statement's period.
  kind: 'current' | 'statement' | 'gap' | 'before';
  from: string | null;
  to: string | null;
  statement: PeriodStatement | null;
  // Visible rows, in the caller's order.
  rows: T[];
  // Over every row of the period, unfiltered, so the header reads as the
  // statement while filters narrow the rows. Counted as a statement counts
  // them: posted rows of any category; pending rows and manual purchases
  // paid alongside apart, since no statement lists them.
  count: number;
  chargesCents: number;
  creditsCents: number;
  pendingCount: number;
  alongsideCount: number;
  unverifiedCount: number;
  // Holds CSV rows dated by purchase (the caveat), and synced rows whose
  // purchase date falls outside the period they are counted in.
  purchaseDatedCsvRows: number;
  postedOutsideRows: number;
};

const SYNCED = 'plaid';
const MANUAL = 'manual';

export function groupByPeriod<T extends PeriodRow>(input: {
  all: readonly T[];
  visible: readonly T[];
  statements: readonly PeriodStatement[];
  // The account's CSV records the purchase date, not the posting date.
  purchaseDatedCsv: boolean;
}): PeriodGroup<T>[] {
  const byId = new Map(input.all.map((r) => [r.id, r]));
  const placement = (r: T): string => {
    const anchor = r.alongsideOfId ? byId.get(r.alongsideOfId) : undefined;
    return anchor ? anchor.postedDate : r.postedDate;
  };

  // Periods oldest first; each has an inclusive date range.
  const sorted = [...input.statements].sort((a, b) => a.closingDate.localeCompare(b.closingDate));
  type Slot = Omit<PeriodGroup<T>, 'rows' | 'count' | 'chargesCents' | 'creditsCents' | 'pendingCount' | 'alongsideCount' | 'unverifiedCount' | 'purchaseDatedCsvRows' | 'postedOutsideRows'>;
  const slots: Slot[] = [];
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    const start = s.periodStart ?? (prev ? addDays(prev.closingDate, 1) : null);
    if (start === null) {
      slots.push({ key: `before:${s.closingDate}`, kind: 'before', from: null, to: s.closingDate, statement: null });
      return;
    }
    if (!prev) slots.push({ key: `before:${start}`, kind: 'before', from: null, to: addDays(start, -1), statement: null });
    else if (start > addDays(prev.closingDate, 1)) {
      slots.push({ key: `gap:${prev.closingDate}`, kind: 'gap', from: addDays(prev.closingDate, 1), to: addDays(start, -1), statement: null });
    }
    slots.push({ key: `statement:${s.closingDate}`, kind: 'statement', from: start, to: s.closingDate, statement: s });
  });
  const last = sorted[sorted.length - 1];
  slots.push({ key: 'current', kind: 'current', from: last ? addDays(last.closingDate, 1) : null, to: null, statement: null });

  const slotOf = (day: string) =>
    slots.find((sl) => (sl.from === null || day >= sl.from) && (sl.to === null || day <= sl.to)) ?? slots[slots.length - 1];

  const groups = new Map(
    slots.map((sl) => [
      sl.key,
      {
        ...sl,
        rows: [] as T[],
        count: 0,
        chargesCents: 0,
        creditsCents: 0,
        pendingCount: 0,
        alongsideCount: 0,
        unverifiedCount: 0,
        purchaseDatedCsvRows: 0,
        postedOutsideRows: 0,
      },
    ]),
  );
  for (const r of input.all) {
    const g = groups.get(slotOf(placement(r)).key)!;
    g.count += 1;
    if (r.alongsideOfId && r.source === MANUAL) {
      g.alongsideCount += 1;
      continue;
    }
    if (r.pending) {
      g.pendingCount += 1;
      continue;
    }
    if (r.unverified) g.unverifiedCount += 1;
    if (r.amountCents > 0) g.chargesCents += r.amountCents;
    else g.creditsCents -= r.amountCents;
    if (r.source !== SYNCED && r.source !== MANUAL && input.purchaseDatedCsv) g.purchaseDatedCsvRows += 1;
    if (r.source === SYNCED && ((g.from !== null && r.date < g.from) || (g.to !== null && r.date > g.to))) g.postedOutsideRows += 1;
  }
  for (const r of input.visible) groups.get(slotOf(placement(r)).key)!.rows.push(r);

  // Newest first, and only periods that hold a row or a recorded statement.
  return [...groups.values()].reverse().filter((g) => g.count > 0 || g.kind === 'statement' || g.kind === 'current');
}

// A recorded statement's totals beside its period's rows: null without
// totals recorded, else each side's difference (rows minus statement).
export function statementComparison(g: PeriodGroup<unknown>): { chargesDiff: number; creditsDiff: number } | null {
  const s = g.statement;
  if (!s || s.chargesCents === null || s.creditsCents === null) return null;
  return { chargesDiff: g.chargesCents - s.chargesCents, creditsDiff: g.creditsCents - s.creditsCents };
}
