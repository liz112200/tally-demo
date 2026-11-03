// Statement cycles from the closing days the owner set (STATEMENT-CYCLES.md).
// Pure; dates are ISO calendar days (YYYY-MM-DD), no time zone involved.
//
// An entry says: statements closing on or after `effectiveFrom` close on
// `closingDay` of their month, or on the month's last day when it has fewer
// days. Each month's closing uses the latest entry in effect on that closing
// date, so a change of cycle starts with the first statement closing on or
// after it, and earlier statements keep the day they had.

export type ClosingDayEntry = { effectiveFrom: string; closingDay: number };

export type Cycle = {
  // First day of the cycle: the day after the previous closing, or the first
  // entry's effective date when no closing precedes it.
  start: string;
  // The closing date, inclusive.
  end: string;
};

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// The closing date of the statement for month (y, m), or null when no entry
// is in effect by then.
function closingIn(entries: readonly ClosingDayEntry[], y: number, m: number): string | null {
  let best: { effectiveFrom: string; date: string } | null = null;
  for (const e of entries) {
    const date = iso(y, m, Math.min(e.closingDay, daysIn(y, m)));
    if (e.effectiveFrom <= date && (best === null || e.effectiveFrom > best.effectiveFrom)) best = { effectiveFrom: e.effectiveFrom, date };
  }
  return best?.date ?? null;
}

// The cycle containing `day`: closes on the first closing date on or after
// it. Null when no entry is in effect for any closing within two months.
export function cycleContaining(entries: readonly ClosingDayEntry[], day: string): Cycle | null {
  if (entries.length === 0) return null;
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const month = (offset: number) => {
    const d = new Date(Date.UTC(y, m - 1 + offset, 1));
    return [d.getUTCFullYear(), d.getUTCMonth() + 1] as const;
  };
  const closings = [-3, -2, -1, 0, 1, 2]
    .map((o) => closingIn(entries, ...month(o)))
    .filter((c): c is string => c !== null)
    .sort();
  const end = closings.find((c) => c >= day);
  if (!end) return null;
  const previous = closings.filter((c) => c < day).pop();
  const earliest = entries.map((e) => e.effectiveFrom).sort()[0];
  return { start: previous ? addDays(previous, 1) : earliest > day ? day : earliest, end };
}

// The effective date of an entry that applies to every statement: the
// owner's first closing day, set without a date.
export const EVERY_STATEMENT = '2000-01-01';

// "1st", "2nd", "23rd", "31st".
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

// The cycle line on /accounts, in the account's own words. A card's statement
// closes on its day, so its dates are stated; a checking statement often
// closes on a nearby business day instead of the day set, so its dates are
// approximate and the close is expected, not stated. Card wording (charges,
// payments and credits) is never used for checking (withdrawals, deposits),
// where it would call a paycheck a credit.
export function cycleLine(input: {
  kind: 'card' | 'checking';
  start: string;
  end: string;
  today: string;
  verified: boolean;
  chargesCents: number;
  creditsCents: number;
  pendingCents: number;
  pendingCount: number;
  formatDay: (iso: string) => string;
  formatMoney: (minor: number) => string;
}): string {
  const { kind, formatDay: day, formatMoney: usd } = input;
  const left = daysBetween(input.today, input.end);
  const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
  const head =
    kind === 'card'
      ? `This cycle, ${day(input.start)} – ${day(input.end)}, closes ${when}`
      : `This statement period, about ${day(input.start)} – ${day(input.end)}, expected to close ${when} on the day you set ` +
        '(checking statements often close on a nearby business day instead)';
  if (!input.verified) return `${head}: no total until this account is verified.`;
  const [out, back] = kind === 'card' ? ['charges', 'payments and credits'] : ['withdrawals', 'deposits'];
  const pending = input.pendingCount > 0 ? `; ${usd(input.pendingCents)} pending (${input.pendingCount}), counted once posted` : '';
  return `${head}: ${usd(input.chargesCents)} in ${out}, ${usd(input.creditsCents)} in ${back}${pending}.`;
}
