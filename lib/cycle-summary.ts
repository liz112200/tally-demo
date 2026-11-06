// The current cycle as an account's card and page show it (the accounts
// board, 2026-11-05): a short range, the statement count it rests on, the time
// left, and one plain sentence saying how the close is known. Pure.
//
// The count is the owner's condition on the whole feature: it is always
// shown beside the range, never only in a hover. The sentence is the
// explanation, kept on the account's page whatever else is trimmed.
import { daysBetween, ordinal, STATED_AFTER, type CurrentCycle, type StatementRecord } from './statement-cycles';

export type CycleSummary = {
  // "Oct 22 – closes Nov 21", "Oct 4 – closes Nov 2–4", "about Oct 22 – …"
  range: string;
  // "5 statements": what the close rests on.
  count: string;
  // "17 days left", "closes tomorrow", "closes today at the latest".
  left: string;
  // "Every one of the 5 recorded statements closed on the 21st, so the day is
  // stated."
  reason: string;
  // How far through the cycle today is, 0 to 100.
  progress: number;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function cycleSummary(input: {
  cycle: CurrentCycle;
  statements: readonly StatementRecord[];
  today: string;
  formatDay: (iso: string) => string;
}): CycleSummary {
  const { cycle, today, formatDay: day } = input;
  const p = cycle.pattern;
  const sameMonth = cycle.end.from.slice(0, 7) === cycle.end.to.slice(0, 7);
  const span =
    cycle.end.from === cycle.end.to
      ? day(cycle.end.to)
      : sameMonth
        ? `${day(cycle.end.from)}–${Number(cycle.end.to.slice(8, 10))}`
        : `${day(cycle.end.from)} – ${day(cycle.end.to)}`;
  const start = cycle.start === null ? 'first day' : cycle.startExact ? day(cycle.start) : `about ${day(cycle.start)}`;
  const projectedFew = cycle.endFrom === 'projected' && p?.kind === 'few';
  const range = `${start} – closes ${projectedFew ? 'about ' : ''}${span}`;

  // Statements the close rests on: those since the closing day last changed.
  const n = p?.count ?? input.statements.length;
  const count = plural(n, 'statement');

  const toEnd = daysBetween(today, cycle.end.to);
  const toFrom = daysBetween(today, cycle.end.from);
  let left: string;
  if (cycle.end.from !== cycle.end.to && toFrom > 0) left = `${toFrom}–${toEnd} days left`;
  else if (cycle.end.from !== cycle.end.to) left = toEnd === 0 ? 'closes today at the latest' : `closes by ${day(cycle.end.to)}`;
  else if (toEnd === 0) left = 'closes today';
  else if (toEnd === 1) left = 'closes tomorrow';
  else left = `${projectedFew ? 'about ' : ''}${toEnd} days left`;

  const changed = input.statements.some((s) => s.startsNewCycle);
  const since = changed ? ' since the closing day changed' : '';
  let reason: string;
  if (cycle.endFrom === 'recorded') reason = `The statement closing ${day(cycle.end.to)} is recorded.`;
  else if (cycle.endFrom === 'printed') reason = `The last statement printed its next closing date, ${day(cycle.end.to)}.`;
  else if (p?.kind === 'day') reason = `Every one of the ${n} recorded statements${since} closed on the ${ordinal(p.day)}, so the day is stated.`;
  else if (p?.kind === 'range')
    reason = `The ${n === 2 ? 'two' : n} recorded statements${since} closed between the ${ordinal(p.minDay)} and the ${ordinal(p.maxDay)}, so the close is a range.`;
  else if (p?.kind === 'few')
    reason = `${n === 1 ? 'One statement is' : `Only ${n} statements are`} recorded${since}, closing on the ${ordinal(p.day)}; the day is stated once ${STATED_AFTER} agree.`;
  else reason = 'No statement recorded.';
  if (cycle.missingSince) {
    reason += ` The statement after the one closing ${day(cycle.missingSince)} is not recorded, so this cycle's start is estimated.`;
  }

  const length = cycle.start === null ? null : daysBetween(cycle.start, cycle.end.to);
  const progress =
    length === null || length <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((daysBetween(cycle.start!, today) / length) * 100)));

  return { range, count, left, reason, progress };
}
