// Statement cycles from the statements the bank issued (STATEMENT-CYCLES.md).
// Pure; dates are ISO calendar days (YYYY-MM-DD), no time zone involved.
//
// A recorded statement is the truth for its cycle. The current cycle starts
// the day after the latest recorded closing; its end is a recorded closing or
// the next closing date the last statement printed, and only otherwise a
// projection from the recorded closing days, which always says how many
// statements it rests on.

export type StatementRecord = {
  closingDate: string;
  periodStart: string | null;
  nextClosingDate: string | null;
  // The first statement after the issuer changed the closing day: closings
  // before it no longer count toward the projection.
  startsNewCycle: boolean;
};

// What the recorded closing days say about the next one, counted over the
// statements since the latest change of cycle. One closing on another day
// makes it a range again: no exception is quietly ignored.
export type ClosingPattern =
  | { kind: 'day'; day: number; count: number }
  | { kind: 'range'; minDay: number; maxDay: number; count: number }
  | { kind: 'few'; day: number; count: number };

// Statements needed, all on one day, before that day is stated without a range
// (owner's decision, 2026-11-03).
export const STATED_AFTER = 3;

export type CurrentCycle = {
  start: string | null;
  // False when the latest recorded closing is not the last one: a statement
  // closed since and is not recorded, so the start is projected too.
  startExact: boolean;
  missingSince: string | null;
  end: { from: string; to: string };
  endFrom: 'recorded' | 'printed' | 'projected';
  pattern: ClosingPattern | null;
};

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayOf = (iso: string) => Number(iso.slice(8, 10));

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Day `day` of the month after `iso`'s month, or that month's last day.
function nextMonthOn(iso: string, day: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 1));
  const [y, m] = [d.getUTCFullYear(), d.getUTCMonth() + 1];
  return `${y}-${pad(m)}-${pad(Math.min(day, daysIn(y, m)))}`;
}

export function closingPattern(statements: readonly StatementRecord[]): ClosingPattern | null {
  const sorted = [...statements].sort((a, b) => a.closingDate.localeCompare(b.closingDate));
  const from = sorted.map((s) => s.startsNewCycle).lastIndexOf(true);
  const days = sorted.slice(Math.max(from, 0)).map((s) => dayOf(s.closingDate));
  if (days.length === 0) return null;
  const [min, max] = [Math.min(...days), Math.max(...days)];
  if (min !== max) return { kind: 'range', minDay: min, maxDay: max, count: days.length };
  return days.length >= STATED_AFTER ? { kind: 'day', day: min, count: days.length } : { kind: 'few', day: min, count: days.length };
}

function projectAfter(closing: string, p: ClosingPattern): { from: string; to: string } {
  return p.kind === 'range'
    ? { from: nextMonthOn(closing, p.minDay), to: nextMonthOn(closing, p.maxDay) }
    : { from: nextMonthOn(closing, p.day), to: nextMonthOn(closing, p.day) };
}

// The cycle containing `today`, or null with no statement recorded.
export function currentCycle(statements: readonly StatementRecord[], today: string): CurrentCycle | null {
  const sorted = [...statements].sort((a, b) => a.closingDate.localeCompare(b.closingDate));
  if (sorted.length === 0) return null;
  const pattern = closingPattern(sorted);
  const recordedEnd = sorted.find((s) => s.closingDate >= today);
  const last = [...sorted].reverse().find((s) => s.closingDate < today) ?? null;

  if (recordedEnd) {
    const start = last ? addDays(last.closingDate, 1) : recordedEnd.periodStart;
    return { start, startExact: start !== null, missingSince: null, end: { from: recordedEnd.closingDate, to: recordedEnd.closingDate }, endFrom: 'recorded', pattern };
  }
  // Only statements before today from here on, so `last` exists.
  const latest = last!;
  if (latest.nextClosingDate && latest.nextClosingDate >= today) {
    return {
      start: addDays(latest.closingDate, 1),
      startExact: true,
      missingSince: null,
      end: { from: latest.nextClosingDate, to: latest.nextClosingDate },
      endFrom: 'printed',
      pattern,
    };
  }
  // Project month by month from the latest closing; any projected closing
  // already past means a statement closed since and is not recorded.
  let previous: { from: string; to: string } = { from: latest.closingDate, to: latest.closingDate };
  let missed = false;
  let next = latest.nextClosingDate
    ? { from: latest.nextClosingDate, to: latest.nextClosingDate }
    : projectAfter(latest.closingDate, pattern!);
  while (next.to < today) {
    missed = true;
    previous = next;
    next = projectAfter(next.to, pattern!);
  }
  return {
    start: addDays(missed ? previous.to : previous.from, 1),
    startExact: !missed,
    missingSince: missed ? latest.closingDate : null,
    end: next,
    endFrom: 'projected',
    pattern,
  };
}

// "1st", "2nd", "23rd", "31st".
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The cycle line on /accounts, in the account's own words: charges and
// payments and credits on a card, withdrawals and deposits on checking (where
// "credit" would name a paycheck). Exact dates are stated; a projected close
// says what it rests on, every time, and a range when the days have varied.
export function cycleLine(input: {
  kind: 'card' | 'checking';
  cycle: CurrentCycle;
  today: string;
  verified: boolean;
  chargesCents: number;
  creditsCents: number;
  pendingCents: number;
  pendingCount: number;
  formatDay: (iso: string) => string;
  formatMoney: (minor: number) => string;
}): string {
  const { kind, cycle, formatDay: day, formatMoney: usd } = input;
  const left = (iso: string) => daysBetween(input.today, iso);
  const when = (iso: string) => (left(iso) === 0 ? 'today' : left(iso) === 1 ? 'tomorrow' : `in ${left(iso)} days`);
  const start = cycle.start === null ? 'its first day' : cycle.startExact ? day(cycle.start) : `about ${day(cycle.start)}`;
  const p = cycle.pattern;
  let close: string;
  if (cycle.endFrom === 'recorded') close = `closes ${day(cycle.end.to)}, ${when(cycle.end.to)}`;
  else if (cycle.endFrom === 'printed') close = `closes ${day(cycle.end.to)}, ${when(cycle.end.to)}, as the last statement printed`;
  else if (p?.kind === 'day') close = `closes ${day(cycle.end.to)}, ${when(cycle.end.to)}: the ${ordinal(p.day)}, from ${plural(p.count, 'statement')}`;
  else if (p?.kind === 'range')
    close =
      `expected to close ${day(cycle.end.from)}–${day(cycle.end.to)}, in ${left(cycle.end.from)}–${left(cycle.end.to)} days: ` +
      `between the ${ordinal(p.minDay)} and the ${ordinal(p.maxDay)} across ${plural(p.count, 'statement')}`;
  else close = `expected to close around ${day(cycle.end.to)}, ${when(cycle.end.to)}: from ${plural(p?.count ?? 0, 'statement')}`;
  const missing = cycle.missingSince
    ? ` The statement after the one closing ${day(cycle.missingSince)} is not recorded; record it for an exact start.`
    : '';
  const head = `${kind === 'card' ? 'This cycle' : 'This statement period'}, ${start} – ${close}`;
  if (!input.verified) return `${head}. No total until this account is verified.${missing}`;
  const [out, back] = kind === 'card' ? ['charges', 'payments and credits'] : ['withdrawals', 'deposits'];
  const pending = input.pendingCount > 0 ? `; ${usd(input.pendingCents)} pending (${input.pendingCount}), counted once posted` : '';
  return `${head}. So far: ${usd(input.chargesCents)} in ${out}, ${usd(input.creditsCents)} in ${back}${pending}.${missing}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/gi;

// Closing dates pasted from a bank's list ("Oct 14, Sep 13, Aug 14", one per
// line, 2026-10-14, 10/14/2026). A date without a year is its latest
// occurrence on or before `today`. Anything else is returned unread, never
// guessed at.
export function parseClosingDates(text: string, today: string): { dates: string[]; unread: string[] } {
  const dates = new Set<string>();
  const unread: string[] = [];
  const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
  const latest = (m: number, d: number) => {
    const y = Number(today.slice(0, 4));
    const thisYear = `${y}-${pad(m)}-${pad(d)}`;
    return thisYear <= today ? thisYear : `${y - 1}-${pad(m)}-${pad(d)}`;
  };
  let rest = text;
  for (const match of text.matchAll(DATE)) {
    rest = rest.replace(match[0], ' ');
    const [, iy, im, id, sm, sd, sy, mon, md, my] = match;
    let iso: string | null = null;
    if (iy) iso = valid(+iy, +im, +id) ? `${iy}-${im}-${id}` : null;
    else if (sm) {
      const y = sy ? (sy.length === 2 ? 2000 + Number(sy) : Number(sy)) : null;
      iso = y ? (valid(y, +sm, +sd) ? `${y}-${pad(+sm)}-${pad(+sd)}` : null) : valid(2000, +sm, +sd) ? latest(+sm, +sd) : null;
    } else if (mon) {
      const m = MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) + 1;
      iso = my ? (valid(+my, m, +md) ? `${my}-${pad(m)}-${pad(+md)}` : null) : valid(2000, m, +md) ? latest(m, +md) : null;
    }
    if (iso && iso <= today) dates.add(iso);
    else unread.push(match[0].trim());
  }
  for (const piece of rest.split(/[\s,;]+/)) if (/[a-z0-9]/i.test(piece) && !/^(and|to)$/i.test(piece)) unread.push(piece);
  return { dates: [...dates].sort(), unread };
}
